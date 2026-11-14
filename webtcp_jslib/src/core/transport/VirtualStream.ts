import { NodeId, SequenceNumber, VirtualPort, WebTCPPacket } from '../types/index.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { RetransmitQueue } from './RetransmitQueue.js';
import { ManagedStream, streamKey } from './SessionManager.js';

/**
 * 仮想ストリームの状態（specification.md §8.2）。
 */
export type VirtualStreamState =
    | 'CLOSED'
    | 'SYN_SENT'
    | 'SYN_RCVD'
    | 'ESTABLISHED'
    | 'FIN_WAIT_1'
    | 'FIN_WAIT_2'
    | 'CLOSING';

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
    /** 送信ウィンドウ（未ACKパケット数）。既定 10。 */
    windowSize?: number;
    /** 再送タイムアウト（ms）。既定 1000。 */
    rtoMs?: number;
    /** 最大再送回数。既定 5。 */
    maxRetransmissions?: number;
    /** 送信パケットの初期TTL。既定 64。 */
    defaultTtl?: number;
}

/**
 * WebTCP における単一の仮想TCPセッション。
 *
 * 状態機械、シーケンス番号、再送、順序制御を担う。
 * シーケンス番号は M1 ではパケット単位である（specification.md §8.3）。
 *
 * イベント:
 * - `connect`: 接続確立
 * - `data` (Uint8Array): アプリケーションデータ受信
 * - `drain`: 未ACKキューが空になった
 * - `close`: ストリーム終了（一度だけ）
 * - `error` (Error): 異常終了
 */
export class VirtualStream extends EventEmitter implements ManagedStream {
    public readonly sessionId: string;
    public readonly remoteNodeId: NodeId;
    public readonly localPort: VirtualPort;
    public readonly remotePort: VirtualPort;
    public readonly isInitiator: boolean;
    public lastActivity: number;
    public state: VirtualStreamState;

    private readonly transport: TransportContext;
    private readonly windowSize: number;
    private readonly maxRetransmissions: number;
    private readonly defaultTtl: number;
    private readonly rtoMs: number;
    private readonly unackedQueue: RetransmitQueue;

    private nextSendSeqNum: SequenceNumber = 0;
    private expectedRecvSeqNum: SequenceNumber = 0;

    /** 順序外で到着したデータパケット。 */
    private readonly pendingData = new Map<SequenceNumber, WebTCPPacket>();

    private retransmissionTimer: ReturnType<typeof setInterval> | null = null;
    private closeEmitted = false;
    private connectEmitted = false;

    constructor(
        transport: TransportContext,
        remoteNodeId: NodeId,
        localPort: VirtualPort,
        remotePort: VirtualPort,
        isInitiator: boolean,
        options: VirtualStreamOptions = {},
    ) {
        super();
        this.transport = transport;
        this.remoteNodeId = remoteNodeId;
        this.localPort = localPort;
        this.remotePort = remotePort;
        this.isInitiator = isInitiator;
        this.sessionId = streamKey(remoteNodeId, localPort, remotePort);
        this.lastActivity = Date.now();
        this.windowSize = options.windowSize ?? 10;
        this.maxRetransmissions = options.maxRetransmissions ?? 5;
        this.defaultTtl = options.defaultTtl ?? 64;
        this.rtoMs = options.rtoMs ?? 1000;
        this.unackedQueue = new RetransmitQueue({ rtoMs: this.rtoMs });

        // 受動オープン側は SYN 受信後に生成されるため SYN_RCVD から始まる
        this.state = isInitiator ? 'CLOSED' : 'SYN_RCVD';
    }

    // ===============================================
    // 接続確立・切断（アプリケーション向けAPI）
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

        const syn = this.createPacket('SYN', this.nextSendSeqNum, this.nextSendSeqNum + 1);
        this.nextSendSeqNum = this.advance(this.nextSendSeqNum);
        this.state = 'SYN_SENT';
        this.startRetransmissionTimer();
        await this.queueAndSend(syn);
    }

    /**
     * ストリームを閉じる。
     * - ESTABLISHED: FIN を送り FIN_WAIT_1 へ
     * - SYN_SENT / SYN_RCVD: RST を送って即座に終了
     * - すでに CLOSED: 何もしない（close イベントは一度だけ）
     */
    public close(): void {
        switch (this.state) {
            case 'ESTABLISHED': {
                const fin = this.createPacket('FIN', this.nextSendSeqNum, this.expectedRecvSeqNum);
                this.nextSendSeqNum = this.advance(this.nextSendSeqNum);
                this.state = 'FIN_WAIT_1';
                void this.queueAndSend(fin).catch((error) => {
                    console.warn(`[VS:${this.localPort}] Failed to send FIN:`, error);
                });
                return;
            }
            case 'SYN_SENT':
            case 'SYN_RCVD':
                void this.sendRst();
                this.finalize();
                return;
            case 'FIN_WAIT_2':
                // 相手の FIN を待つ（無通信タイムアウトで回収される）
                return;
            case 'FIN_WAIT_1':
            case 'CLOSING':
                // すでに FIN を送信済み。ACK を待つ（タイマーが面倒を見る）
                return;
            case 'CLOSED':
            default:
                this.finalize();
                return;
        }
    }

    /**
     * パケットを送らずに即座に破棄する。
     * ネットワーク自体を停止するときに使う（`close()` は FIN を送って相手の応答を待つため）。
     */
    public destroy(): void {
        this.finalize();
    }

    // ===============================================
    // アプリケーションデータの送信
    // ===============================================

    /**
     * データを送信する。
     * @throws 接続が ESTABLISHED でない場合、または送信ウィンドウが満杯の場合
     */
    public async send(data: Uint8Array | string): Promise<void> {
        if (this.state !== 'ESTABLISHED') {
            throw new Error(`Cannot send data. State is ${this.state}.`);
        }
        if (this.unackedQueue.size() >= this.windowSize) {
            throw new Error('Send window full');
        }

        const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const packet = this.createPacket('DATA', this.nextSendSeqNum, this.expectedRecvSeqNum, payload);
        this.nextSendSeqNum = this.advance(this.nextSendSeqNum);
        await this.queueAndSend(packet);
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
                console.warn(`[VS:${this.localPort}] Ignoring unexpected flag ${packet.flags}`);
        }
    }

    private handleSyn(packet: WebTCPPacket): void {
        if (this.state !== 'SYN_RCVD') {
            // 再送された SYN など。SYN_ACK は再送タイマーに任せる。
            return;
        }

        this.expectedRecvSeqNum = this.advance(packet.seqNum);
        const synAck = this.createPacket(
            'SYN_ACK',
            this.nextSendSeqNum,
            this.expectedRecvSeqNum,
        );
        this.nextSendSeqNum = this.advance(this.nextSendSeqNum);
        this.startRetransmissionTimer();
        void this.queueAndSend(synAck).catch((error) => {
            console.warn(`[VS:${this.localPort}] Failed to send SYN_ACK:`, error);
        });
    }

    private handleSynAck(packet: WebTCPPacket): void {
        if (this.state === 'ESTABLISHED') {
            // 再送された SYN_ACK には ACK を返し直す
            this.sendAck();
            return;
        }
        if (this.state !== 'SYN_SENT') {
            console.warn(`[VS:${this.localPort}] Unexpected SYN_ACK in state ${this.state}`);
            return;
        }

        this.expectedRecvSeqNum = this.advance(packet.seqNum);
        this.applyAckNumber(packet.ackNum);

        if (packet.ackNum === this.nextSendSeqNum) {
            this.establish();
            this.sendAck();
        }
    }

    private handleAck(packet: WebTCPPacket): void {
        this.applyAckNumber(packet.ackNum);

        if (this.state === 'SYN_RCVD' && packet.ackNum >= this.nextSendSeqNum) {
            this.establish();
        } else if (this.state === 'SYN_SENT' && packet.ackNum >= this.nextSendSeqNum) {
            // SYN_ACK を経ずに ACK が来るのは異常だが、接続は成立している
            this.establish();
        } else if (this.state === 'FIN_WAIT_1' && this.unackedQueue.size() === 0) {
            this.state = 'FIN_WAIT_2';
        } else if (this.state === 'CLOSING' && this.unackedQueue.size() === 0) {
            this.finalize();
        }
    }

    private handleData(packet: WebTCPPacket): void {
        if (
            this.state !== 'ESTABLISHED' &&
            this.state !== 'FIN_WAIT_1' &&
            this.state !== 'FIN_WAIT_2'
        ) {
            return;
        }

        if (packet.seqNum === this.expectedRecvSeqNum) {
            this.deliver(packet);
            this.flushPendingData();
            this.sendAck();
        } else if (packet.seqNum > this.expectedRecvSeqNum) {
            // 順序外。バッファして重複ACKで再送を促す。
            this.pendingData.set(packet.seqNum, packet);
            this.sendAck();
        } else {
            // 重複パケット。ACK を返し直す。
            this.sendAck();
        }
    }

    private handleFin(packet: WebTCPPacket): void {
        this.expectedRecvSeqNum = this.advance(packet.seqNum);
        this.sendAck();

        switch (this.state) {
            case 'ESTABLISHED': {
                // 相手から切断要求。こちらからも FIN を送る。
                const fin = this.createPacket('FIN', this.nextSendSeqNum, this.expectedRecvSeqNum);
                this.nextSendSeqNum = this.advance(this.nextSendSeqNum);
                this.state = 'CLOSING';
                void this.queueAndSend(fin).catch((error) => {
                    console.warn(`[VS:${this.localPort}] Failed to send FIN:`, error);
                });
                return;
            }
            case 'FIN_WAIT_2':
                this.finalize();
                return;
            case 'FIN_WAIT_1':
                this.state = 'CLOSING';
                return;
            default:
                return;
        }
    }

    private handleRst(): void {
        this.emit('error', new Error('Connection reset by remote peer (RST)'));
        this.finalize();
    }

    private deliver(packet: WebTCPPacket): void {
        this.expectedRecvSeqNum = this.advance(packet.seqNum);
        this.emit('data', packet.payload);
    }

    private flushPendingData(): void {
        let packet = this.pendingData.get(this.expectedRecvSeqNum);
        while (packet) {
            this.pendingData.delete(this.expectedRecvSeqNum);
            this.deliver(packet);
            packet = this.pendingData.get(this.expectedRecvSeqNum);
        }
    }

    // ===============================================
    // 状態遷移ヘルパー
    // ===============================================

    private establish(): void {
        this.state = 'ESTABLISHED';
        if (!this.connectEmitted) {
            this.connectEmitted = true;
            this.emit('connect');
        }
    }

    private applyAckNumber(ackNum: SequenceNumber): void {
        if (this.unackedQueue.size() === 0) return;
        this.unackedQueue.dequeueCumulative(ackNum);
        if (this.unackedQueue.size() === 0) {
            this.emit('drain');
        }
    }

    /**
     * ストリームを終了状態にし、リソースを解放して `close` を一度だけ発火する。
     */
    private finalize(): void {
        if (this.closeEmitted) return;

        this.state = 'CLOSED';
        this.stopRetransmissionTimer();
        this.unackedQueue.clear();
        this.pendingData.clear();
        this.closeEmitted = true;

        this.transport.deregisterStream(this);
        this.emit('close');
    }

    // ===============================================
    // 送信ヘルパー
    // ===============================================

    private async queueAndSend(packet: WebTCPPacket): Promise<void> {
        if (packet.flags === 'SYN' || packet.flags === 'SYN_ACK' || packet.flags === 'DATA' || packet.flags === 'FIN') {
            this.unackedQueue.enqueue(packet, packet.seqNum);
        }
        await this.transport.sendPacket(packet);
        this.lastActivity = Date.now();
    }

    private sendAck(): void {
        const ack = this.createPacket('ACK', this.nextSendSeqNum, this.expectedRecvSeqNum);
        void this.transport.sendPacket(ack).catch((error) => {
            console.warn(`[VS:${this.localPort}] Failed to send ACK:`, error);
        });
    }

    private async sendRst(): Promise<void> {
        const rst = this.createPacket('RST', this.nextSendSeqNum, this.expectedRecvSeqNum);
        try {
            await this.transport.sendPacket(rst);
        } catch (error) {
            console.warn(`[VS:${this.localPort}] Failed to send RST:`, error);
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
            seqNum,
            ackNum,
            payload,
            signature: new Uint8Array(0),
        };
    }

    // ===============================================
    // 再送タイマー
    // ===============================================

    private startRetransmissionTimer(): void {
        if (this.retransmissionTimer !== null) return;
        // RTO の確認粒度。RTO が短い場合に備えて上限を設ける。
        const interval = Math.max(50, Math.min(this.rtoMs, 1000));
        this.retransmissionTimer = setInterval(() => this.retransmissionLoop(), interval);
    }

    private stopRetransmissionTimer(): void {
        if (this.retransmissionTimer !== null) {
            clearInterval(this.retransmissionTimer);
            this.retransmissionTimer = null;
        }
    }

    private retransmissionLoop(): void {
        const packets = this.unackedQueue.getPacketsForRetransmission();

        for (const item of packets) {
            if (item.retransmissionCount >= this.maxRetransmissions) {
                const error = new Error('Max retransmissions reached');
                this.emit('error', error);
                this.finalize();
                return;
            }

            void this.transport.sendPacket(item.packet).catch((error) => {
                console.warn(`[VS:${this.localPort}] Retransmission failed:`, error);
            });
            this.unackedQueue.markAsRetransmitted(item.sequenceNumber);
        }
    }

    /** シーケンス番号を mod 2^32 で進める。 */
    private advance(sequenceNumber: SequenceNumber): SequenceNumber {
        return (sequenceNumber + 1) >>> 0;
    }
}
