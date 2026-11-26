import { NodeId, SequenceNumber, StreamState, VirtualPort, WebTCPPacket } from '../types/index.js';
import { EventEmitter, EventListener } from '../util/EventEmitter.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { RetransmitQueue } from './RetransmitQueue.js';
import { ManagedStream, streamKey } from './SessionManager.js';
import {
    MAX_SACK_BLOCKS,
    SackBlock,
    decodeSackBlocks,
    encodeSackBlocks,
    generateInitialSeqNum,
    seqAdd,
    seqDiff,
    seqGt,
    seqGte,
    seqLte,
} from './seq.js';

/**
 * 仮想ストリームの状態（`StreamState` の別名、specification.md §8.2）。
 */
export type VirtualStreamState = StreamState;

/**
 * VirtualStream がトランスポート層に要求する機能。
 * 具象クラスに依存しないことで循環依存を避ける。
 */
export interface TransportContext {
    readonly localNodeId: NodeId;
    sendPacket(packet: WebTCPPacket): Promise<void>;
    deregisterStream(stream: ManagedStream): void;
}

export interface VirtualStreamOptions {
    /** 1 セグメントの最大アプリケーションデータ長（MSS、バイト）。既定 16384（上限 61440）。 */
    mss?: number;
    /** 初期輻輳ウィンドウ（バイト）。既定 `min(maxWindowBytes, 4 * mss)`。 */
    initialCwndBytes?: number;
    /** 最大送信ウィンドウ（バイト）。既定 1 MiB。 */
    maxWindowBytes?: number;
    /** 送信バッファの上限（バイト）。既定 4 MiB。 */
    maxSendBufferBytes?: number;
    /**
     * 受信バッファの上限（バイト）。連続未読バイトと順序外保持バイトの合計をこの値以内に保つ。
     * 既定 1 MiB。MSS 未満の値は MSS に切り上げる（specification.md §8.3.4）。
     */
    maxRecvBufferBytes?: number;
    /**
     * 受信ウィンドウの交渉（フラグの `WIN` ビット、specification.md §8.3.4）を申し出るか。既定 `true`。
     * `false` にすると窓を交渉しない（旧実装と同じ送信側の挙動）。受信側の上限は常に適用される。
     */
    windowNegotiation?: boolean;
    /** 初期再送タイムアウト（ms）。既定 1000。 */
    initialRtoMs?: number;
    /** 後方互換用: `initialRtoMs` の別名。 */
    rtoMs?: number;
    /** 最小 RTO（ms）。既定 200。 */
    minRtoMs?: number;
    /** 最大 RTO（ms）。既定 60000。 */
    maxRtoMs?: number;
    /** 最大再送回数。既定 5。 */
    maxRetransmissions?: number;
    /** 送信パケットの初期 TTL。既定 64。 */
    defaultTtl?: number;
    /**
     * 片方向クローズ（half-close）を許可するか。既定 `true`（RFC 793 準拠）。
     * `false` の場合、相手の FIN を受信したら自動的にローカルからも FIN を送信する。
     */
    allowHalfOpen?: boolean;
    /** `TIME_WAIT` 状態の待機時間（ms）。既定 200（0 で即座に CLOSED）。 */
    timeWaitMs?: number;
    /** 初期シーケンス番号（テスト用の決定論的オーバーライド。通常は省略しランダム生成）。 */
    initialSeqNum?: SequenceNumber;
    /** ロガー（任意）。 */
    logger?: Logger;
}

/** ストリームの内部統計・輻輳制御状態（観測・デバッグ・テスト用）。 */
export interface VirtualStreamStats {
    state: StreamState;
    initialSendSeqNum: SequenceNumber;
    nextSendSeqNum: SequenceNumber;
    expectedRecvSeqNum: SequenceNumber;
    mss: number;
    rtoMs: number;
    srttMs: number | null;
    rttvarMs: number | null;
    cwndBytes: number;
    ssthreshBytes: number;
    inFlightBytes: number;
    sendBufferBytes: number;
    readableBytes: number;
    retransmissions: number;
    fastRetransmits: number;
    sackBlocksReceived: number;
    sackBlocksSent: number;
    /** 受信側が現在広告できる空き（バイト）。`maxRecvBufferBytes - 未読 - 順序外保持`。 */
    recvWindowBytes: number;
    /** 受信バッファの上限（バイト、MSS 切り上げ後）。 */
    maxRecvBufferBytes: number;
    /** 送信側が相手の窓で送れる残り（バイト）。窓を交渉していなければ `null`。 */
    peerWindowBytes: number | null;
    /** 受信ウィンドウを交渉したか（`WIN` ビット）。 */
    windowNegotiated: boolean;
}

interface PendingSendEntry {
    data: Uint8Array;
    offset: number;
    resolve: () => void;
    reject: (error: Error) => void;
}

interface OutOfOrderSegment {
    seq: SequenceNumber;
    data: Uint8Array;
}

interface ReadExactWaiter {
    bytes: number;
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
}

const DEFAULT_MSS = 16 * 1024;
const MAX_ALLOWED_MSS = 60 * 1024;
const DEFAULT_MAX_WINDOW_BYTES = 1024 * 1024;
const DEFAULT_MAX_SEND_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECV_BUFFER_BYTES = 1024 * 1024;
/** ウィンドウ付き ACK の payload 先頭に置く受信ウィンドウ（uint32、ビッグエンディアン）の長さ。 */
const WINDOW_FIELD_BYTES = 4;
const MAX_WINDOW_FIELD = 0xffffffff;

/** ウィンドウ付き ACK の payload 先頭から受信ウィンドウ（uint32）を読む。長さが足りなければ `null`。 */
function readWindowPrefix(payload: Uint8Array): number | null {
    if (payload.byteLength < WINDOW_FIELD_BYTES) return null;
    return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
}

/**
 * WebTCP における単一の仮想 TCP セッション（M2: フル TCP セマンティクス）。
 *
 * - バイト単位の Seq/Ack と 32 ビットラップアラウンド（RFC 1982）
 * - ランダム初期シーケンス番号（ISN）
 * - 60 KiB 超メッセージの自動分割（MSS）と送信バッファ
 * - 順序外再結合と部分読み取り（`read` / `readExact` / `data` イベント）
 * - 動的 RTO 計算（RFC 6298 Jacobson / Karn + 指数バックオフ）
 * - 輻輳制御（RFC 5681 Slow Start / Congestion Avoidance / Fast Recovery）
 * - Fast Retransmit（3 重複 ACK）と SACK（RFC 2018 サブセット）
 * - Half-Close（`CLOSE_WAIT` / `FIN_WAIT_1` / `FIN_WAIT_2` / `LAST_ACK` / `TIME_WAIT`）
 *
 * イベント:
 * - `connect`: 接続確立
 * - `data` (Uint8Array): アプリケーションデータ受信（フローイングモード）
 * - `readable`: 受信バッファに読み取り可能データがある（プルモード）
 * - `end`: 相手の FIN により受信ストリームが EOF に達した（一度だけ）
 * - `drain`: 送信バッファおよび未 ACK キューが空になった
 * - `close`: ストリーム終了（一度だけ）
 * - `error` (Error): 異常終了
 */
export class VirtualStream extends EventEmitter implements ManagedStream {
    public readonly sessionId: string;
    public readonly remoteNodeId: NodeId;
    public readonly localPort: VirtualPort;
    public readonly remotePort: VirtualPort;
    public readonly isInitiator: boolean;
    public readonly initialSendSeqNum: SequenceNumber;
    public lastActivity: number;
    public state: VirtualStreamState;

    private readonly transport: TransportContext;
    private readonly logger: Logger;
    private readonly mss: number;
    private readonly maxWindowBytes: number;
    private readonly maxSendBufferBytes: number;
    private readonly maxRecvBufferBytes: number;
    private readonly windowNegotiationEnabled: boolean;
    private readonly maxRetransmissions: number;
    private readonly defaultTtl: number;
    private readonly initialRtoMs: number;
    private readonly allowHalfOpen: boolean;
    private readonly timeWaitMs: number;
    private readonly unackedQueue: RetransmitQueue;

    // シーケンス管理
    private nextSendSeqNum: SequenceNumber;
    private expectedRecvSeqNum: SequenceNumber = 0;
    private synAckSent = false;
    private synAckEndSeq: SequenceNumber = 0;
    private finQueued = false;
    private finSentSeq: SequenceNumber | null = null;
    private remoteFinReceived = false;
    private pendingFinSeq: SequenceNumber | null = null;

    // 輻輳制御（RFC 5681）
    private cwndBytes: number;
    private ssthreshBytes: number;
    private dupAckCount = 0;
    private inFastRecovery = false;
    private recoverSeq: SequenceNumber = 0;
    private fastRetransmittedInRecovery = new Set<SequenceNumber>();

    // 送信バッファ
    private readonly sendBuffer: PendingSendEntry[] = [];
    private sendBufferBytes = 0;

    // 順序外受信バッファ
    private readonly pendingSegments: OutOfOrderSegment[] = [];

    // 受信ウィンドウ（specification.md §8.3.4）
    /** 能動側: SYN で `WIN` を申し出たか。 */
    private windowOffered = false;
    /** 両側が `WIN` を交渉したか。交渉しない接続は窓を使わない（従来動作）。 */
    private windowNegotiated = false;
    /** 相手の窓から求めた送信可能な右端（シーケンス番号）。単調非減少。交渉時のみ使う。 */
    private peerWindowEdge: SequenceNumber | null = null;
    /** 最後に広告した受信ウィンドウ（バイト）。窓更新の要否の判定に使う。 */
    private lastAdvertisedWindow: number;
    /** 最後に窓の問い合わせを送った時刻（ms）。 */
    private lastWindowProbeAt = 0;

    // 連続受信バイトバッファ（部分読み取り用）
    private readonly recvChunks: Uint8Array[] = [];
    private recvHeadOffset = 0;
    private recvTotalBytes = 0;
    private paused = false;
    private readonly readExactWaiters: ReadExactWaiter[] = [];

    // タイマーと一回限りフラグ
    private retransmissionTimer: ReturnType<typeof setInterval> | null = null;
    private timeWaitTimer: ReturnType<typeof setTimeout> | null = null;
    private closeEmitted = false;
    private connectEmitted = false;
    private endEmitted = false;

    // 統計カウンタ
    private retransmissionsCount = 0;
    private fastRetransmitsCount = 0;
    private sackBlocksReceivedCount = 0;
    private sackBlocksSentCount = 0;

    constructor(
        transport: TransportContext,
        remoteNodeId: NodeId,
        localPort: VirtualPort,
        remotePort: VirtualPort,
        isInitiator: boolean,
        options: VirtualStreamOptions = {},
    ) {
        const baseLogger = options.logger ?? defaultLogger;
        super(baseLogger);
        this.transport = transport;
        this.logger = createScopedLogger(baseLogger, `VS:${localPort}`);
        this.remoteNodeId = remoteNodeId;
        this.localPort = localPort;
        this.remotePort = remotePort;
        this.isInitiator = isInitiator;
        this.sessionId = streamKey(remoteNodeId, localPort, remotePort);
        this.lastActivity = Date.now();

        const rawMss = options.mss ?? DEFAULT_MSS;
        if (!Number.isInteger(rawMss) || rawMss < 1 || rawMss > MAX_ALLOWED_MSS) {
            throw new Error(`mss must be an integer between 1 and ${MAX_ALLOWED_MSS} (got ${rawMss})`);
        }
        this.mss = rawMss;
        this.maxWindowBytes = Math.max(this.mss, options.maxWindowBytes ?? DEFAULT_MAX_WINDOW_BYTES);
        this.maxSendBufferBytes = Math.max(
            this.mss,
            options.maxSendBufferBytes ?? DEFAULT_MAX_SEND_BUFFER_BYTES,
        );
        const rawRecvBuffer = options.maxRecvBufferBytes ?? DEFAULT_MAX_RECV_BUFFER_BYTES;
        if (!Number.isInteger(rawRecvBuffer) || rawRecvBuffer < 1) {
            throw new Error(`maxRecvBufferBytes must be a positive integer (got ${rawRecvBuffer})`);
        }
        // 1 セグメントは必ず空の受信バッファに収まること（進捗のため）
        this.maxRecvBufferBytes = Math.max(this.mss, rawRecvBuffer);
        this.windowNegotiationEnabled = options.windowNegotiation ?? true;
        this.lastAdvertisedWindow = this.maxRecvBufferBytes;
        this.maxRetransmissions = options.maxRetransmissions ?? 5;
        this.defaultTtl = options.defaultTtl ?? 64;
        this.initialRtoMs = options.initialRtoMs ?? options.rtoMs ?? 1000;
        this.allowHalfOpen = options.allowHalfOpen ?? true;
        this.timeWaitMs = Math.max(0, options.timeWaitMs ?? 200);

        this.unackedQueue = new RetransmitQueue({
            initialRtoMs: this.initialRtoMs,
            ...(options.minRtoMs !== undefined ? { minRtoMs: options.minRtoMs } : {}),
            ...(options.maxRtoMs !== undefined ? { maxRtoMs: options.maxRtoMs } : {}),
        });

        this.cwndBytes = Math.min(
            this.maxWindowBytes,
            Math.max(this.mss, options.initialCwndBytes ?? 4 * this.mss),
        );
        this.ssthreshBytes = this.maxWindowBytes;

        this.initialSendSeqNum =
            options.initialSeqNum !== undefined
                ? options.initialSeqNum >>> 0
                : generateInitialSeqNum();
        this.nextSendSeqNum = this.initialSendSeqNum;

        // 受動オープン側は SYN 受信後に生成されるため SYN_RCVD から始まる
        this.state = isInitiator ? 'CLOSED' : 'SYN_RCVD';
    }

    /** 受信バッファに現在溜まっている未読バイト数。 */
    public get readableLength(): number {
        return this.recvTotalBytes;
    }

    /** 現在の統計情報と輻輳制御状態を返す。 */
    public getStats(): VirtualStreamStats {
        return {
            state: this.state,
            initialSendSeqNum: this.initialSendSeqNum,
            nextSendSeqNum: this.nextSendSeqNum,
            expectedRecvSeqNum: this.expectedRecvSeqNum,
            mss: this.mss,
            rtoMs: this.unackedQueue.getRtoMs(),
            srttMs: this.unackedQueue.rttEstimator.getSrttMs(),
            rttvarMs: this.unackedQueue.rttEstimator.getRttvarMs(),
            cwndBytes: this.cwndBytes,
            ssthreshBytes: this.ssthreshBytes,
            inFlightBytes: this.unackedQueue.getInFlightBytes(),
            sendBufferBytes: this.sendBufferBytes,
            readableBytes: this.recvTotalBytes,
            retransmissions: this.retransmissionsCount,
            fastRetransmits: this.fastRetransmitsCount,
            sackBlocksReceived: this.sackBlocksReceivedCount,
            sackBlocksSent: this.sackBlocksSentCount,
            recvWindowBytes: this.recvWindowBytes(),
            maxRecvBufferBytes: this.maxRecvBufferBytes,
            peerWindowBytes: this.windowNegotiated ? this.peerWindowAvailable() : null,
            windowNegotiated: this.windowNegotiated,
        };
    }

    /**
     * リスナーを登録する。
     * `'data'` リスナー追加時、プルバッファに未読データがあればフローイング配送する。
     */
    public override on(event: string, listener: EventListener): this {
        super.on(event, listener);
        if (event === 'data' && !this.paused && this.recvTotalBytes > 0) {
            queueMicrotask(() => this.flushRecvToDataListeners());
        }
        return this;
    }

    public override once(event: string, listener: EventListener): this {
        super.once(event, listener);
        if (event === 'data' && !this.paused && this.recvTotalBytes > 0) {
            queueMicrotask(() => this.flushRecvToDataListeners());
        }
        return this;
    }

    // ===============================================
    // 接続確立・切断（アプリケーション向け API）
    // ===============================================

    /**
     * 能動オープン: SYN を送信して接続を開始する。
     */
    public async initiateConnection(): Promise<void> {
        if (!this.isInitiator) {
            throw new Error('initiateConnection() is only available for the initiating side');
        }
        if (this.state !== 'CLOSED') {
            throw new Error(`Cannot initiate connection in state ${this.state}`);
        }

        // SYN の ackNum は 0（RFC 793 / #31）
        const syn = this.createPacket('SYN', this.nextSendSeqNum, 0);
        this.windowOffered = this.windowNegotiationEnabled;
        if (this.windowOffered) syn.windowFlag = true;
        this.nextSendSeqNum = seqAdd(this.nextSendSeqNum, 1);
        this.state = 'SYN_SENT';
        this.startRetransmissionTimer();
        await this.queueAndSend(syn, 1);
    }

    /**
     * 片方向の送信を終了する（graceful half-close）。
     * 送信バッファに残っているデータをすべて送出した後に `FIN` を送信する。
     * - `ESTABLISHED` -> `FIN_WAIT_1`（相手からのデータ受信は継続可能）
     * - `CLOSE_WAIT` -> `LAST_ACK`
     * - `SYN_SENT` / `SYN_RCVD` -> RST を送って即座に `CLOSED`
     */
    public end(): void {
        switch (this.state) {
            case 'ESTABLISHED':
            case 'CLOSE_WAIT':
                if (this.finQueued) return;
                this.finQueued = true;
                this.flushSendBuffer();
                return;
            case 'SYN_SENT':
            case 'SYN_RCVD':
                void this.sendRst();
                this.finalize();
                return;
            case 'FIN_WAIT_1':
            case 'FIN_WAIT_2':
            case 'CLOSING':
            case 'LAST_ACK':
            case 'TIME_WAIT':
                return;
            case 'CLOSED':
            default:
                this.finalize();
                return;
        }
    }

    /**
     * `end()` の別名（M1 API 互換）。
     */
    public close(): void {
        this.end();
    }

    /**
     * 接続を異常終了（abort）する（#54）。
     * 相手へ `RST` を送ってから即座に `CLOSED` へ遷移する。`FIN` の交換や `TIME_WAIT` は待たない。
     * 相手側のストリームは `RST` を受けて `CLOSED` になり、`error` を発火する（リスナーがある場合）。
     * 正常終了には `end()` を使う。`destroy()` 後の送信は失敗する。
     */
    public destroy(): void {
        if (this.state !== 'CLOSED') void this.sendRst();
        this.finalize();
    }

    // ===============================================
    // アプリケーションデータの送信・読み取り
    // ===============================================

    /**
     * データを送信する（60 KiB 超も MSS 以下へ自動分割される）。
     * `ESTABLISHED` および `CLOSE_WAIT`（half-close のローカル送信継続）で呼び出せる。
     * 渡された全バイトがセグメント化されて送信キューへ投入された時点で解決する。
     */
    public send(data: Uint8Array | string): Promise<void> {
        if ((this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT') || this.finQueued) {
            return Promise.reject(new Error(`Cannot send data. State is ${this.state}.`));
        }

        const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (payload.byteLength === 0) {
            return Promise.resolve();
        }
        if (this.sendBufferBytes + payload.byteLength > this.maxSendBufferBytes) {
            return Promise.reject(new Error('Send buffer full'));
        }

        // 呼び出し側による後からの破壊を防ぐためスライスを保持する
        const copy = new Uint8Array(payload);

        return new Promise<void>((resolve, reject) => {
            this.sendBuffer.push({
                data: copy,
                offset: 0,
                resolve,
                reject,
            });
            this.sendBufferBytes += copy.byteLength;
            this.flushSendBuffer();
        });
    }

    /**
     * 受信バッファからバイト列を部分読み取りする（プルモード、specification.md §8.3.3）。
     * @param maxBytes 読み取る最大バイト数。省略時はバッファ全体を返す。
     * @returns データが無い場合は `null`。
     */
    public read(maxBytes?: number): Uint8Array | null {
        if (maxBytes !== undefined) {
            if (!Number.isInteger(maxBytes) || maxBytes < 0) {
                throw new RangeError(`maxBytes must be a non-negative integer (got ${maxBytes})`);
            }
            if (maxBytes === 0) return new Uint8Array(0);
        }

        if (this.recvTotalBytes === 0) return null;

        const toRead =
            maxBytes === undefined ? this.recvTotalBytes : Math.min(maxBytes, this.recvTotalBytes);
        return this.consumeRecvBytes(toRead);
    }

    /**
     * 指定バイト数が揃うまで複数セグメントにまたがって待機し、厳密に `bytes` バイト返す。
     * 揃う前に EOF またはクローズになった場合は reject する。
     */
    public readExact(bytes: number): Promise<Uint8Array> {
        if (!Number.isInteger(bytes) || bytes < 0) {
            return Promise.reject(
                new RangeError(`bytes must be a non-negative integer (got ${bytes})`),
            );
        }
        if (bytes === 0) return Promise.resolve(new Uint8Array(0));
        if (bytes > this.maxRecvBufferBytes) {
            // 受信バッファに収まらないため、待ち続けると必ず固まる（specification.md §8.3.3）
            return Promise.reject(
                new RangeError(
                    `readExact(${bytes}) exceeds maxRecvBufferBytes (${this.maxRecvBufferBytes})`,
                ),
            );
        }

        if (this.readExactWaiters.length === 0 && this.recvTotalBytes >= bytes) {
            return Promise.resolve(this.consumeRecvBytes(bytes));
        }

        if (this.remoteFinReceived || this.state === 'CLOSED') {
            return Promise.reject(
                new Error(
                    `Stream ended before ${bytes} bytes could be read (available: ${this.recvTotalBytes})`,
                ),
            );
        }

        return new Promise<Uint8Array>((resolve, reject) => {
            this.readExactWaiters.push({ bytes, resolve, reject });
        });
    }

    /** `'data'` イベントによる自動配送を一時停止し、受信バッファへ蓄積する。 */
    public pause(): this {
        this.paused = true;
        return this;
    }

    /** `'data'` イベントによる自動配送を再開し、バッファ済みデータを配送する。 */
    public resume(): this {
        this.paused = false;
        this.flushRecvToDataListeners();
        return this;
    }

    // ===============================================
    // 受信処理
    // ===============================================

    /**
     * TransportLayer からパケットを受け取り、フラグに応じて処理する。
     */
    public handleIncomingPacket(packet: WebTCPPacket): void {
        if (this.state === 'CLOSED') return;
        this.lastActivity = Date.now();

        switch (packet.flags) {
            case 'RST':
                this.handleRst();
                return;
            case 'SYN':
                this.handleSyn(packet);
                return;
            case 'SYN_ACK':
                this.handleSynAck(packet);
                return;
            case 'ACK':
                this.handleAck(packet);
                return;
            case 'DATA':
                this.handleData(packet);
                return;
            case 'FIN':
                this.handleFin(packet);
                return;
            default:
                this.logger.warn(`Ignoring unexpected flag ${packet.flags}`);
        }
    }

    private handleSyn(packet: WebTCPPacket): void {
        if (this.state !== 'SYN_RCVD') {
            return;
        }

        if (this.synAckSent) {
            // 重複 SYN を受信した場合、既にキューにある SYN_ACK を再送する（seqNum を増やさない）
            const existing = this.unackedQueue.getOldestPacket();
            if (existing && existing.packet.flags === 'SYN_ACK') {
                void this.transport.sendPacket(existing.packet).catch((error) => {
                    this.logger.warn('Failed to resend SYN_ACK:', error);
                });
            }
            return;
        }

        this.expectedRecvSeqNum = seqAdd(packet.seqNum, 1);
        this.windowNegotiated = this.windowNegotiationEnabled && packet.windowFlag === true;
        const synAck = this.createPacket(
            'SYN_ACK',
            this.nextSendSeqNum,
            this.expectedRecvSeqNum,
            this.windowNegotiated ? this.windowPrefix() : undefined,
        );
        if (this.windowNegotiated) synAck.windowFlag = true;
        this.nextSendSeqNum = seqAdd(this.nextSendSeqNum, 1);
        this.synAckEndSeq = this.nextSendSeqNum;
        this.synAckSent = true;
        this.startRetransmissionTimer();
        void this.queueAndSend(synAck, 1).catch((error) => {
            this.logger.warn('Failed to send SYN_ACK:', error);
        });
    }

    private handleSynAck(packet: WebTCPPacket): void {
        if (this.state === 'ESTABLISHED') {
            this.sendAck();
            return;
        }
        if (this.state !== 'SYN_SENT') {
            this.logger.warn(`Unexpected SYN_ACK in state ${this.state}`);
            return;
        }

        if (packet.ackNum !== this.nextSendSeqNum) {
            this.logger.warn(
                `Ignoring SYN_ACK with unexpected ackNum=${packet.ackNum} (expected ${this.nextSendSeqNum})`,
            );
            return;
        }

        this.windowNegotiated = this.windowOffered && packet.windowFlag === true;
        if (this.windowNegotiated) {
            const window = readWindowPrefix(packet.payload);
            if (window === null) {
                this.logger.warn('Ignoring SYN_ACK without a window field');
                return;
            }
            // 窓は確立より前に反映する（確立直後の送信がこの窓に従うように）
            this.updatePeerWindow(packet.ackNum, window);
        }

        this.expectedRecvSeqNum = seqAdd(packet.seqNum, 1);
        this.processAck(packet.ackNum, [], false);
        this.establish();
        this.sendAck();
    }

    private handleAck(packet: WebTCPPacket): void {
        let sackPayload = packet.payload;
        if (this.windowNegotiated) {
            const window = readWindowPrefix(packet.payload);
            if (window === null) {
                this.logger.warn('Dropping ACK without a window field');
                return;
            }
            // 窓は ACK 処理より前に反映する（新しく開いた窓で、同じ ACK の後の送信が進むように）
            this.updatePeerWindow(packet.ackNum, window);
            sackPayload = packet.payload.subarray(WINDOW_FIELD_BYTES);
        }

        const sackBlocks = decodeSackBlocks(sackPayload);
        if (sackBlocks.length > 0) {
            this.sackBlocksReceivedCount += sackBlocks.length;
        }
        this.processAck(packet.ackNum, sackBlocks, true);

        if (this.windowNegotiated) {
            this.flushSendBuffer();
            // 窓の問い合わせ（WIN 付き ACK）には現在の窓で必ず答える。答えには WIN を立てない（無限往復を防ぐ）。
            if (packet.windowFlag === true) this.sendAck();
        }
    }

    private handleData(packet: WebTCPPacket): void {
        // ピギーバック ACK を処理する（SYN_RCVD 状態ならこれで ESTABLISHED へ遷移する #31）
        if (this.state !== 'SYN_SENT') {
            this.processAck(packet.ackNum, [], false);
        }

        if (
            this.state !== 'ESTABLISHED' &&
            this.state !== 'FIN_WAIT_1' &&
            this.state !== 'FIN_WAIT_2'
        ) {
            return;
        }

        if (packet.payload.byteLength === 0) {
            return;
        }

        const segSeq = packet.seqNum >>> 0;
        const segLen = packet.payload.byteLength;
        const segEnd = seqAdd(segSeq, segLen);

        if (seqLte(segEnd, this.expectedRecvSeqNum)) {
            // 完全に重複した古いセグメント
            this.sendAck();
            return;
        }

        // 受信バッファの上限（specification.md §8.3.4）。交渉の有無によらず適用する。
        // 破棄したデータは未確認のままなので、送信側が再送する。
        const newBytes = seqDiff(
            segEnd,
            seqGt(segSeq, this.expectedRecvSeqNum) ? segSeq : this.expectedRecvSeqNum,
        );
        if (seqLte(segSeq, this.expectedRecvSeqNum)) {
            // 先頭の欠損を埋めるデータ: 連続未読の空きに収まる限り格納する。順序外保持の分は押し出す
            // （押し出さないと先頭の欠損が埋まらず、順序外バイトも配送・解放されないまま止まる）。
            if (newBytes > this.maxRecvBufferBytes - this.recvTotalBytes) {
                this.logger.debug(`Dropping DATA seq=${segSeq} (${newBytes} bytes): unread buffer full`);
                this.sendAck();
                return;
            }
            this.evictOutOfOrderFor(newBytes);
        } else if (newBytes > this.recvWindowBytes()) {
            // 順序外のデータは空きに収まる場合だけ格納する
            this.logger.debug(`Dropping DATA seq=${segSeq} (${newBytes} bytes): receive buffer full`);
            this.sendAck();
            return;
        }

        if (seqLte(segSeq, this.expectedRecvSeqNum)) {
            // 順序通り（または先頭が重複するオーバーラップ）
            const trim = seqDiff(this.expectedRecvSeqNum, segSeq);
            const fresh = trim > 0 ? packet.payload.subarray(trim) : packet.payload;
            this.expectedRecvSeqNum = segEnd;
            this.deliverBytes(fresh);
            this.flushPendingSegments();
            this.checkPendingFin();
            this.sendAck();
            return;
        }

        // 順序外セグメント: バッファして SACK 付き重複 ACK を返す
        this.insertPendingSegment(segSeq, packet.payload);
        this.sendAck();
    }

    private handleFin(packet: WebTCPPacket): void {
        // ピギーバック ACK を先に処理する
        if (this.state !== 'SYN_SENT') {
            this.processAck(packet.ackNum, [], false);
        }

        if (this.state === 'TIME_WAIT') {
            this.sendAck();
            this.restartTimeWaitTimer();
            return;
        }

        if (this.remoteFinReceived) {
            this.sendAck();
            return;
        }

        const finSeq = packet.seqNum >>> 0;
        if (finSeq === this.expectedRecvSeqNum) {
            this.completeRemoteFin(finSeq);
        } else if (seqGt(finSeq, this.expectedRecvSeqNum)) {
            // 先行データに欠損がある状態で FIN が届いたため保留する
            this.pendingFinSeq = finSeq;
            this.sendAck();
        } else {
            this.sendAck();
        }
    }

    private handleRst(): void {
        const error = new Error('Connection reset by remote peer (RST)');
        this.rejectPendingOperations(error);
        // `error` にリスナーが無いと EventEmitter は例外を投げ、パケット受信経路を壊す。
        // リスナーが無い場合は状態だけを閉じる（相手が destroy() した正当な結果のため）。
        if (this.listenerCount('error') > 0) this.emit('error', error);
        this.finalize();
    }

    // ===============================================
    // ACK・輻輳制御・Fast Retransmit / SACK
    // ===============================================

    private processAck(
        ackNum: SequenceNumber,
        sackBlocks: readonly SackBlock[],
        isPureAck: boolean,
    ): void {
        const ack = ackNum >>> 0;
        const oldest = this.unackedQueue.getOldestPacket();

        // 有効な新規 ACK（sndUna < ack <= sndNxt）
        if (oldest && seqGt(ack, oldest.sequenceNumber) && seqLte(ack, this.nextSendSeqNum)) {
            const newlyAckedBytes = seqDiff(ack, oldest.sequenceNumber);
            const result = this.unackedQueue.dequeueCumulative(ack);
            if (sackBlocks.length > 0) {
                this.unackedQueue.applySackBlocks(sackBlocks);
            }

            this.onNewAck(ack, Math.max(newlyAckedBytes, result.ackedBytes));

            // 状態遷移の判定
            if (this.state === 'SYN_RCVD' && seqGte(ack, this.synAckEndSeq)) {
                this.establish();
            } else if (
                this.state === 'FIN_WAIT_1' &&
                this.finSentSeq !== null &&
                seqGte(ack, seqAdd(this.finSentSeq, 1))
            ) {
                this.state = 'FIN_WAIT_2';
            } else if (
                this.state === 'CLOSING' &&
                this.finSentSeq !== null &&
                seqGte(ack, seqAdd(this.finSentSeq, 1))
            ) {
                this.enterTimeWait();
                return;
            } else if (
                this.state === 'LAST_ACK' &&
                this.finSentSeq !== null &&
                seqGte(ack, seqAdd(this.finSentSeq, 1))
            ) {
                this.finalize();
                return;
            }

            this.flushSendBuffer();

            if (
                result.ackedSegments > 0 &&
                this.unackedQueue.size() === 0 &&
                this.sendBufferBytes === 0
            ) {
                this.emit('drain');
            }
            return;
        }

        // 重複 ACK の検出（Fast Retransmit / Fast Recovery / SACK）
        if (
            isPureAck &&
            oldest &&
            ack === oldest.sequenceNumber &&
            this.unackedQueue.size() > 0 &&
            (this.state === 'ESTABLISHED' ||
                this.state === 'FIN_WAIT_1' ||
                this.state === 'CLOSE_WAIT')
        ) {
            if (sackBlocks.length > 0) {
                this.unackedQueue.applySackBlocks(sackBlocks);
            }
            this.handleDuplicateAck();
            return;
        }

        // 既に全セグメントが ACK 済みだが状態遷移だけ未完了な場合の保険
        if (this.state === 'SYN_RCVD' && seqGte(ack, this.synAckEndSeq)) {
            this.establish();
        } else if (
            this.state === 'FIN_WAIT_1' &&
            this.finSentSeq !== null &&
            seqGte(ack, seqAdd(this.finSentSeq, 1))
        ) {
            this.state = 'FIN_WAIT_2';
        } else if (
            this.state === 'CLOSING' &&
            this.finSentSeq !== null &&
            seqGte(ack, seqAdd(this.finSentSeq, 1))
        ) {
            this.enterTimeWait();
        } else if (
            this.state === 'LAST_ACK' &&
            this.finSentSeq !== null &&
            seqGte(ack, seqAdd(this.finSentSeq, 1))
        ) {
            this.finalize();
        }
    }

    private onNewAck(ackNum: SequenceNumber, newlyAckedBytes: number): void {
        if (this.inFastRecovery) {
            if (seqGte(ackNum, this.recoverSeq)) {
                // Full ACK: Fast Recovery 終了（RFC 5681 / NewReno）
                this.cwndBytes = Math.max(this.mss, this.ssthreshBytes);
                this.inFastRecovery = false;
                this.dupAckCount = 0;
                this.fastRetransmittedInRecovery.clear();
            } else {
                // Partial ACK: 次の未 SACK 欠損セグメントを即座に再送（NewReno + SACK）
                const deflated = this.cwndBytes - newlyAckedBytes + (newlyAckedBytes >= this.mss ? this.mss : 0);
                this.cwndBytes = Math.max(this.mss, Math.min(this.maxWindowBytes, deflated));
                const hole = this.unackedQueue.getOldestUnsackedPacket();
                if (hole) {
                    this.retransmitSegment(hole, true);
                }
            }
            return;
        }

        this.dupAckCount = 0;

        if (this.cwndBytes < this.ssthreshBytes) {
            // Slow Start: ACK ごとに最大 1 MSS 増加（RFC 3465 / RFC 5681）
            const increment = Math.min(newlyAckedBytes, this.mss);
            this.cwndBytes = Math.min(this.maxWindowBytes, this.cwndBytes + increment);
        } else {
            // Congestion Avoidance (AIMD): 1 RTT あたり約 1 MSS 増加
            const increment = Math.max(1, Math.floor((this.mss * newlyAckedBytes) / this.cwndBytes));
            this.cwndBytes = Math.min(this.maxWindowBytes, this.cwndBytes + increment);
        }
    }

    private handleDuplicateAck(): void {
        this.dupAckCount += 1;

        if (!this.inFastRecovery) {
            if (this.dupAckCount === 3) {
                // Fast Retransmit & Fast Recovery 開始（RFC 5681）
                const inFlight = this.unackedQueue.getEffectiveInFlightBytes();
                this.ssthreshBytes = Math.max(2 * this.mss, Math.floor(inFlight / 2));
                this.cwndBytes = Math.min(this.maxWindowBytes, this.ssthreshBytes + 3 * this.mss);
                this.inFastRecovery = true;
                this.recoverSeq = this.nextSendSeqNum;
                this.fastRetransmittedInRecovery.clear();

                const hole = this.unackedQueue.getOldestUnsackedPacket();
                if (hole) {
                    this.fastRetransmittedInRecovery.add(hole.sequenceNumber);
                    this.retransmitSegment(hole, true);
                }
            }
            return;
        }

        // Fast Recovery 中の追加重複 ACK: ウィンドウを 1 MSS 膨張させる
        this.cwndBytes = Math.min(this.maxWindowBytes, this.cwndBytes + this.mss);

        // SACK によって他に未再送の欠損セグメントが判明していれば優先して再送する
        const unsacked = this.unackedQueue.getUnsackedPackets();
        const nextHole = unsacked.find(
            (item) => !this.fastRetransmittedInRecovery.has(item.sequenceNumber),
        );
        if (nextHole && this.unackedQueue.getEffectiveInFlightBytes() < this.effectiveWindowBytes()) {
            this.fastRetransmittedInRecovery.add(nextHole.sequenceNumber);
            this.retransmitSegment(nextHole, true);
            return;
        }

        this.flushSendBuffer();
    }

    private retransmitSegment(item: { packet: WebTCPPacket; sequenceNumber: SequenceNumber }, isFast: boolean): void {
        if (isFast) {
            this.fastRetransmitsCount += 1;
        }
        this.retransmissionsCount += 1;
        this.unackedQueue.markAsRetransmitted(item.sequenceNumber);
        this.logger.debug(
            `${isFast ? 'Fast retransmitting' : 'Retransmitting'} seq=${item.sequenceNumber} (flags=${item.packet.flags})`,
        );
        void this.transport.sendPacket(item.packet).catch((error) => {
            this.logger.warn('Retransmission failed:', error);
        });
    }

    // ===============================================
    // 送信バッファのフラッシュと自動分割
    // ===============================================

    private effectiveWindowBytes(): number {
        return Math.min(this.cwndBytes, this.maxWindowBytes);
    }

    private flushSendBuffer(): void {
        if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT') {
            return;
        }

        while (this.sendBuffer.length > 0) {
            const windowAvailable = this.peerWindowAvailable();
            const available = Math.min(
                this.effectiveWindowBytes() - this.unackedQueue.getEffectiveInFlightBytes(),
                windowAvailable,
            );
            if (available <= 0) {
                break;
            }

            const head = this.sendBuffer[0]!;
            const remaining = head.data.byteLength - head.offset;
            // 少なくとも 1 セグメントは送信できるよう、inFlight==0 なら MSS まで許可する
            const maxChunk =
                this.unackedQueue.getEffectiveInFlightBytes() === 0
                    ? this.mss
                    : Math.min(this.mss, available);
            const chunkLen = Math.min(remaining, maxChunk, windowAvailable);
            if (chunkLen <= 0) {
                break;
            }
            // 相手の窓で切られた小さすぎる断片は送らず、窓が広がるまで待つ（SWS 回避）
            if (windowAvailable < remaining && chunkLen < Math.min(this.mss, remaining)) {
                break;
            }

            const chunk = head.data.subarray(head.offset, head.offset + chunkLen);
            head.offset += chunkLen;
            this.sendBufferBytes -= chunkLen;

            const packet = this.createPacket(
                'DATA',
                this.nextSendSeqNum,
                this.expectedRecvSeqNum,
                chunk,
            );
            this.nextSendSeqNum = seqAdd(this.nextSendSeqNum, chunkLen);

            this.unackedQueue.enqueue(packet, packet.seqNum, chunkLen);
            this.lastActivity = Date.now();

            void this.transport.sendPacket(packet).catch((error) => {
                this.logger.warn('Failed to send DATA segment:', error);
            });

            if (head.offset >= head.data.byteLength) {
                this.sendBuffer.shift();
                head.resolve();
            }
        }

        // 送信バッファをすべて送り終えた後で、保留中の FIN があれば送信する
        if (this.finQueued && this.finSentSeq === null && this.sendBuffer.length === 0) {
            this.sendQueuedFin();
        }
    }

    private sendQueuedFin(): void {
        const finSeq = this.nextSendSeqNum;
        const fin = this.createPacket('FIN', finSeq, this.expectedRecvSeqNum);
        this.nextSendSeqNum = seqAdd(this.nextSendSeqNum, 1);
        this.finSentSeq = finSeq;
        this.state = this.state === 'CLOSE_WAIT' ? 'LAST_ACK' : 'FIN_WAIT_1';

        void this.queueAndSend(fin, 1).catch((error) => {
            this.logger.warn('Failed to send FIN:', error);
        });
    }

    // ===============================================
    // 受信側: 順序外再結合・SACK ブロック・部分読み取りバッファ
    // ===============================================

    private insertPendingSegment(seq: SequenceNumber, data: Uint8Array): void {
        const existingIndex = this.pendingSegments.findIndex((seg) => seg.seq === seq);
        if (existingIndex >= 0) {
            if (data.byteLength > this.pendingSegments[existingIndex]!.data.byteLength) {
                this.pendingSegments[existingIndex] = { seq, data };
            }
            return;
        }
        this.pendingSegments.push({ seq, data });
    }

    private flushPendingSegments(): void {
        if (this.pendingSegments.length === 0) return;

        this.pendingSegments.sort(
            (a, b) => seqDiff(a.seq, this.expectedRecvSeqNum) - seqDiff(b.seq, this.expectedRecvSeqNum),
        );

        let progressed = true;
        while (progressed && this.pendingSegments.length > 0) {
            progressed = false;
            const head = this.pendingSegments[0]!;
            const segEnd = seqAdd(head.seq, head.data.byteLength);

            if (seqLte(segEnd, this.expectedRecvSeqNum)) {
                this.pendingSegments.shift();
                progressed = true;
            } else if (seqLte(head.seq, this.expectedRecvSeqNum)) {
                this.pendingSegments.shift();
                const trim = seqDiff(this.expectedRecvSeqNum, head.seq);
                const fresh = trim > 0 ? head.data.subarray(trim) : head.data;
                this.expectedRecvSeqNum = segEnd;
                this.deliverBytes(fresh);
                progressed = true;
            }
        }
    }

    private checkPendingFin(): void {
        if (this.pendingFinSeq !== null && this.pendingFinSeq === this.expectedRecvSeqNum) {
            this.completeRemoteFin(this.pendingFinSeq);
        }
    }

    private computeSackBlocks(): SackBlock[] {
        if (this.pendingSegments.length === 0) return [];

        const intervals: SackBlock[] = [];
        for (const seg of this.pendingSegments) {
            const left = seg.seq;
            const right = seqAdd(seg.seq, seg.data.byteLength);
            if (seqGt(right, this.expectedRecvSeqNum) && seqGt(left, this.expectedRecvSeqNum)) {
                intervals.push({ leftEdge: left, rightEdge: right });
            }
        }
        if (intervals.length === 0) return [];

        intervals.sort(
            (a, b) =>
                seqDiff(a.leftEdge, this.expectedRecvSeqNum) -
                seqDiff(b.leftEdge, this.expectedRecvSeqNum),
        );

        const merged: SackBlock[] = [intervals[0]!];
        for (let i = 1; i < intervals.length; i += 1) {
            const next = intervals[i]!;
            const last = merged[merged.length - 1]!;
            if (seqLte(next.leftEdge, last.rightEdge)) {
                if (seqGt(next.rightEdge, last.rightEdge)) {
                    last.rightEdge = next.rightEdge;
                }
            } else {
                merged.push({ ...next });
            }
        }

        return merged.slice(0, MAX_SACK_BLOCKS);
    }

    private deliverBytes(chunk: Uint8Array): void {
        if (chunk.byteLength === 0) return;

        // 受信バッファへ積む
        this.recvChunks.push(chunk);
        this.recvTotalBytes += chunk.byteLength;

        // 1. `readExact()` 待機者を優先的に満たす
        while (this.readExactWaiters.length > 0) {
            const waiter = this.readExactWaiters[0]!;
            if (this.recvTotalBytes < waiter.bytes) {
                break;
            }
            this.readExactWaiters.shift();
            waiter.resolve(this.consumeRecvBytes(waiter.bytes));
        }

        if (this.recvTotalBytes === 0) return;

        // 2. フローイングモード（`'data'` リスナーあり & 未一時停止）なら即座に配送
        if (!this.paused && this.listenerCount('data') > 0 && this.readExactWaiters.length === 0) {
            this.flushRecvToDataListeners();
            return;
        }

        // 3. プルモードなら `'readable'` を通知
        this.emit('readable');
    }

    private flushRecvToDataListeners(): void {
        if (
            this.paused ||
            this.recvTotalBytes === 0 ||
            this.listenerCount('data') === 0 ||
            this.readExactWaiters.length > 0
        ) {
            return;
        }
        const data = this.consumeRecvBytes(this.recvTotalBytes);
        this.emit('data', data);
    }

    private consumeRecvBytes(count: number): Uint8Array {
        const result = new Uint8Array(count);
        let written = 0;

        while (written < count && this.recvChunks.length > 0) {
            const chunk = this.recvChunks[0]!;
            const available = chunk.byteLength - this.recvHeadOffset;
            const take = Math.min(available, count - written);

            result.set(chunk.subarray(this.recvHeadOffset, this.recvHeadOffset + take), written);
            written += take;
            this.recvHeadOffset += take;
            this.recvTotalBytes -= take;

            if (this.recvHeadOffset >= chunk.byteLength) {
                this.recvChunks.shift();
                this.recvHeadOffset = 0;
            }
        }

        this.maybeSendWindowUpdate();
        return result;
    }

    private completeRemoteFin(finSeq: SequenceNumber): void {
        this.remoteFinReceived = true;
        this.pendingFinSeq = null;
        this.expectedRecvSeqNum = seqAdd(finSeq, 1);
        this.sendAck();

        // 残っている readExact 待機者はこれ以上データが届かないため reject する
        this.rejectReadExactWaiters(new Error('Stream ended (EOF) before requested bytes arrived'));

        // 状態を先に遷移させてから end を通知する（#38）。
        let autoEnd = false;
        let enteredTimeWait = false;
        switch (this.state) {
            case 'ESTABLISHED':
                this.state = 'CLOSE_WAIT';
                autoEnd = !this.allowHalfOpen;
                break;
            case 'FIN_WAIT_1':
                if (this.finSentSeq !== null && this.unackedQueue.size() === 0) {
                    this.state = 'TIME_WAIT';
                    enteredTimeWait = true;
                } else {
                    this.state = 'CLOSING';
                }
                break;
            case 'FIN_WAIT_2':
                this.state = 'TIME_WAIT';
                enteredTimeWait = true;
                break;
            default:
                break;
        }

        if (!this.endEmitted) {
            this.endEmitted = true;
            this.emit('end');
        }

        if (autoEnd) this.end();
        if (enteredTimeWait && this.state === 'TIME_WAIT') {
            this.stopRetransmissionTimer();
            this.unackedQueue.clear();
            if (this.timeWaitMs <= 0) this.finalize();
            else this.restartTimeWaitTimer();
        }
    }

    // ===============================================
    // 受信ウィンドウ（specification.md §8.3.4）
    // ===============================================

    /** 受信側が現在広告できる空き（バイト）。 */
    private recvWindowBytes(): number {
        return Math.max(0, this.maxRecvBufferBytes - this.recvTotalBytes - this.outOfOrderBytes());
    }

    private outOfOrderBytes(): number {
        let total = 0;
        for (const seg of this.pendingSegments) total += seg.data.byteLength;
        return total;
    }

    /**
     * 先頭の欠損を埋めるデータを `need` バイト格納できるよう、順序外保持のセグメントを
     * 後ろ（期待位置から遠いもの）から押し出す。押し出したデータは未確認のままなので送信側が再送する。
     */
    private evictOutOfOrderFor(need: number): void {
        while (
            this.pendingSegments.length > 0 &&
            this.recvTotalBytes + this.outOfOrderBytes() + need > this.maxRecvBufferBytes
        ) {
            let farthest = 0;
            for (let i = 1; i < this.pendingSegments.length; i += 1) {
                const distance = seqDiff(this.pendingSegments[i]!.seq, this.expectedRecvSeqNum);
                const current = seqDiff(this.pendingSegments[farthest]!.seq, this.expectedRecvSeqNum);
                if (distance > current) farthest = i;
            }
            const evicted = this.pendingSegments.splice(farthest, 1)[0]!;
            this.logger.debug(`Evicting out-of-order DATA seq=${evicted.seq} (${evicted.data.byteLength} bytes) to admit the head gap`);
        }
    }

    /** 窓の値を 4 バイトの先頭フィールドにし、広告済みの値として記録する。 */
    private windowPrefix(): Uint8Array {
        const window = this.recvWindowBytes();
        this.lastAdvertisedWindow = window;
        const out = new Uint8Array(WINDOW_FIELD_BYTES);
        new DataView(out.buffer).setUint32(0, Math.min(window, MAX_WINDOW_FIELD), false);
        return out;
    }

    /** 相手の窓から送信可能な右端を更新する。右端は後退させない（最大値を使う）。 */
    private updatePeerWindow(ackNum: SequenceNumber, window: number): void {
        const edge = seqAdd(ackNum, window);
        if (this.peerWindowEdge === null || seqGt(edge, this.peerWindowEdge)) {
            this.peerWindowEdge = edge;
        }
    }

    /** 相手の窓で、新規データをあと何バイト送れるか。交渉しない接続では無制限。 */
    private peerWindowAvailable(): number {
        if (!this.windowNegotiated) return Number.POSITIVE_INFINITY;
        if (this.peerWindowEdge === null) return 0;
        return Math.max(0, seqDiff(this.peerWindowEdge, this.nextSendSeqNum));
    }

    /** 送信データが相手の窓で止まっているか。 */
    private windowBlocked(): boolean {
        if (!this.windowNegotiated || this.sendBuffer.length === 0) return false;
        if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT') return false;
        const head = this.sendBuffer[0]!;
        const remaining = head.data.byteLength - head.offset;
        return this.peerWindowAvailable() < Math.min(this.mss, remaining);
    }

    /**
     * 窓で止まっている間、RTO 間隔で `WIN` 付きの問い合わせ ACK を送る（window probe）。
     * 窓更新が失われても送信が止まったままにならないようにする。
     */
    private maybeSendWindowProbe(): void {
        if (!this.windowBlocked()) return;
        const now = Date.now();
        if (now - this.lastWindowProbeAt < this.unackedQueue.getRtoMs()) return;
        this.lastWindowProbeAt = now;

        const probe = this.createPacket(
            'ACK',
            this.nextSendSeqNum,
            this.expectedRecvSeqNum,
            this.windowPrefix(),
        );
        probe.windowFlag = true;
        void this.transport.sendPacket(probe).catch((error) => {
            this.logger.warn('Failed to send window probe:', error);
        });
    }

    /** 読み取りで空きが十分に増えたら、窓を載せた ACK を送って送信側を再開させる。 */
    private maybeSendWindowUpdate(): void {
        if (!this.windowNegotiated || this.state === 'CLOSED') return;
        const threshold = Math.min(this.mss, Math.floor(this.maxRecvBufferBytes / 2));
        if (this.recvWindowBytes() - this.lastAdvertisedWindow >= threshold) {
            this.sendAck();
        }
    }

    // ===============================================
    // 状態遷移ヘルパー
    // ===============================================

    private establish(): void {
        if (this.state === 'ESTABLISHED') return;
        this.state = 'ESTABLISHED';
        if (!this.connectEmitted) {
            this.connectEmitted = true;
            this.emit('connect');
        }
    }

    private enterTimeWait(): void {
        this.state = 'TIME_WAIT';
        this.stopRetransmissionTimer();
        this.unackedQueue.clear();

        if (this.timeWaitMs <= 0) {
            this.finalize();
            return;
        }
        this.restartTimeWaitTimer();
    }

    private restartTimeWaitTimer(): void {
        if (this.timeWaitTimer !== null) {
            clearTimeout(this.timeWaitTimer);
        }
        this.timeWaitTimer = setTimeout(() => {
            this.timeWaitTimer = null;
            this.finalize();
        }, this.timeWaitMs);
    }

    /**
     * ストリームを終了状態にし、リソースを解放して `close` を一度だけ発火する。
     */
    private finalize(): void {
        if (this.closeEmitted) return;

        this.state = 'CLOSED';
        this.stopRetransmissionTimer();
        if (this.timeWaitTimer !== null) {
            clearTimeout(this.timeWaitTimer);
            this.timeWaitTimer = null;
        }
        this.unackedQueue.clear();
        this.pendingSegments.length = 0;
        this.rejectPendingOperations(new Error('Stream closed'));
        this.closeEmitted = true;

        this.transport.deregisterStream(this);
        this.emit('close');
    }

    private rejectPendingOperations(error: Error): void {
        while (this.sendBuffer.length > 0) {
            const entry = this.sendBuffer.shift()!;
            this.sendBufferBytes -= entry.data.byteLength - entry.offset;
            entry.reject(error);
        }
        this.sendBufferBytes = 0;
        this.rejectReadExactWaiters(error);
    }

    private rejectReadExactWaiters(error: Error): void {
        while (this.readExactWaiters.length > 0) {
            const waiter = this.readExactWaiters.shift()!;
            waiter.reject(error);
        }
    }

    // ===============================================
    // 送信ヘルパー
    // ===============================================

    private async queueAndSend(packet: WebTCPPacket, seqLength: number): Promise<void> {
        if (
            packet.flags === 'SYN' ||
            packet.flags === 'SYN_ACK' ||
            packet.flags === 'DATA' ||
            packet.flags === 'FIN'
        ) {
            this.unackedQueue.enqueue(packet, packet.seqNum, seqLength);
        }
        await this.transport.sendPacket(packet);
        this.lastActivity = Date.now();
    }

    private sendAck(): void {
        const sackBlocks = this.computeSackBlocks();
        let sackPayload: Uint8Array = new Uint8Array(0);
        if (sackBlocks.length > 0) {
            sackPayload = encodeSackBlocks(sackBlocks);
            this.sackBlocksSentCount += sackBlocks.length;
        }

        let payload = sackPayload;
        if (this.windowNegotiated) {
            // 交渉した接続では、payload の先頭に受信ウィンドウを載せ、その後ろに SACK を続ける
            const windowField = this.windowPrefix();
            payload = new Uint8Array(WINDOW_FIELD_BYTES + sackPayload.byteLength);
            payload.set(windowField, 0);
            payload.set(sackPayload, WINDOW_FIELD_BYTES);
        }

        const ack = this.createPacket('ACK', this.nextSendSeqNum, this.expectedRecvSeqNum, payload);
        void this.transport.sendPacket(ack).catch((error) => {
            this.logger.warn('Failed to send ACK:', error);
        });
    }

    private async sendRst(): Promise<void> {
        const rst = this.createPacket('RST', this.nextSendSeqNum, this.expectedRecvSeqNum);
        try {
            await this.transport.sendPacket(rst);
        } catch (error) {
            this.logger.warn('Failed to send RST:', error);
        }
    }

    private createPacket(
        flags: WebTCPPacket['flags'],
        seqNum: SequenceNumber,
        ackNum: SequenceNumber,
        payload: Uint8Array = new Uint8Array(0),
    ): WebTCPPacket {
        return {
            senderId: this.transport.localNodeId,
            destinationId: this.remoteNodeId,
            sourcePort: this.localPort,
            destinationPort: this.remotePort,
            ttl: this.defaultTtl,
            flags,
            seqNum: seqNum >>> 0,
            ackNum: ackNum >>> 0,
            payload,
            signature: new Uint8Array(0),
        };
    }

    // ===============================================
    // 再送タイマー
    // ===============================================

    private startRetransmissionTimer(): void {
        if (this.retransmissionTimer !== null) return;
        const interval = Math.max(10, Math.min(50, Math.floor(this.initialRtoMs / 2)));
        this.retransmissionTimer = setInterval(() => this.retransmissionLoop(), interval);
    }

    private stopRetransmissionTimer(): void {
        if (this.retransmissionTimer !== null) {
            clearInterval(this.retransmissionTimer);
            this.retransmissionTimer = null;
        }
    }

    private retransmissionLoop(): void {
        this.maybeSendWindowProbe();

        const timedOut = this.unackedQueue.getPacketsForRetransmission();
        if (timedOut.length === 0) return;

        // 最も古いタイムアウトセグメントが上限に達していれば異常終了
        const oldest = timedOut[0]!;
        if (oldest.retransmissionCount >= this.maxRetransmissions) {
            const error = new Error('Max retransmissions reached');
            this.rejectPendingOperations(error);
            this.emit('error', error);
            this.finalize();
            return;
        }

        // RFC 5681 / RFC 6298 / RFC 6675: RTO タイムアウト時の輻輳制御・バックオフ・SACK クリア
        const inFlight = this.unackedQueue.getInFlightBytes();
        this.ssthreshBytes = Math.max(2 * this.mss, Math.floor(inFlight / 2));
        this.cwndBytes = this.mss;
        this.inFastRecovery = false;
        this.dupAckCount = 0;
        this.fastRetransmittedInRecovery.clear();
        this.unackedQueue.clearSackMarks();
        this.unackedQueue.rttEstimator.backoff();

        this.retransmitSegment(oldest, false);
    }
}
