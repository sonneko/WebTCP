import { ChannelConnectOptions, IChannel } from '../../core/link/IChannel.js';
import { createAbortError, raceAbort, throwIfAborted } from '../../core/util/abort.js';
import {
    ISignalingAdapter,
    isPublicKeyPayload,
} from '../../core/link/ISignalingAdapter.js';
import { NodeId } from '../../core/types/protocol.js';
import { encodePublicKey, decodePublicKey } from '../../core/routing/keys.js';
import type { Ed25519KeyManager } from '../../core/routing/keys.js';
import type { KeyDirectory } from '../../core/routing/KeyDirectory.js';
import { EventEmitter } from '../../core/util/EventEmitter.js';
import { LogLevel, Logger, createScopedLogger, resolveLogger } from '../../core/util/Logger.js';

/**
 * STUN/TURN サーバー設定（短期 TURN 資格情報を含む）を動的に取得するためのフック（#24）。
 * ピア接続の生成時および ICE 再起動時に呼ばれる。
 */
export type IceServersProvider = () => RTCIceServer[] | Promise<RTCIceServer[]>;

/**
 * インターネット越えの動作確認に使えるパブリック STUN サーバーの参考例。
 * ライブラリ既定値は空配列であり、自動的には使用しない。
 */
export const EXAMPLE_STUN_ICE_SERVERS: readonly RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export interface WebRTCChannelOptions {
    /**
     * STUN/TURN サーバーの静的リスト。既定は空（同一ホスト・同一 LAN 向け）。
     * `iceServersProvider` が指定されている場合はそちらが優先される。
     */
    iceServers?: RTCIceServer[];
    /**
     * ピア接続の生成時および ICE 再起動時に `RTCIceServer[]` を動的に取得するフック。
     * TURN の短期資格情報（HMAC REST API 等）を安全に更新したい場合に使う。
     */
    iceServersProvider?: IceServersProvider;
    /** データチャネルのラベル。既定 `webtcp`。 */
    dataChannelLabel?: string;
    /** 接続確立のタイムアウト（ms）。既定 15000。 */
    connectTimeoutMs?: number;
    /** 1メッセージの最大バイト数。既定 65536。 */
    maxMessageBytes?: number;
    /**
     * ICE 接続失敗時に自動で試みる ICE 再起動の最大回数。既定 2（0 で無効）。
     */
    maxIceRestarts?: number;
    /**
     * `iceConnectionState === 'disconnected'` が継続した場合に ICE 再起動を開始するまでの
     * 猶予時間（ms）。既定 3000。
     */
    iceRestartDelayMs?: number;
    /**
     * Ed25519 鍵管理（任意、#28）。
     *
     * 指定すると、ピアとの DataChannel が開いた時点で `public-key`
     * シグナリングメッセージを交換し、公開鍵ディレクトリへ自動登録する。
     */
    keyManager?: Ed25519KeyManager;
    /**
     * 公開鍵ディレクトリ（任意）。
     * `keyManager` と併用して、交換した公開鍵を格納する。
     */
    keyDirectory?: KeyDirectory;
    /** ロガー（任意）。 */
    logger?: Logger;
    /** 既定コンソールロガーのログレベル（任意。既定 `'warn'`）。 */
    logLevel?: LogLevel;
}

interface PeerState {
    connection: RTCPeerConnection;
    dataChannel: RTCDataChannel | null;
    isInitiator: boolean;
    remoteDescriptionSet: boolean;
    awaitingAnswer: boolean;
    opened: boolean;
    iceRestartCount: number;
    restartingIce: boolean;
    openTimer: ReturnType<typeof setTimeout> | null;
    iceDisconnectTimer: ReturnType<typeof setTimeout> | null;
    openResolvers: Array<() => void>;
    openRejecters: Array<(error: Error) => void>;
    /** 開通前にこの接続へ届いた相手の ICE 候補。identity の失敗で作り直すとき、新しい接続へ渡す（#97）。 */
    remoteCandidates: RTCIceCandidateInit[];
}

/** 応答側の接続で、DTLS identity が準備できていない失敗か（#92 / #97）。 */
function isDtlsIdentityNotReady(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('no identity available');
}

/** 応答側の接続を作り直す最大回数（最初の試行を含む）（仕様 §10.3 の 7、設計 §3.46）。 */
const DTLS_IDENTITY_MAX_ATTEMPTS = 3;
/** 作り直しの前に待つ時間（ms）。待たずに作り直しても回復しなかった（設計 §3.46、測定 2）。 */
const DTLS_IDENTITY_REBUILD_DELAY_MS = 1000;

/**
 * WebRTC DataChannel を用いた `IChannel` の共通実装。
 *
 * Offer/Answer/ICE の交換、同時接続（glare）解決、ICE 再起動、
 * TURN 資格情報の動的取得フック、データチャネルの開設・監視をすべてここで行い、
 * サブクラスは `createPeerConnection(iceServers)` だけを提供する。
 */
export abstract class WebRTCChannel extends EventEmitter implements IChannel {
    public readonly connectedPeers = new Map<NodeId, boolean>();

    protected readonly signaling: ISignalingAdapter;
    protected readonly options: WebRTCChannelOptions;
    protected readonly logger: Logger;

    private readonly peers = new Map<NodeId, PeerState>();
    private readonly orphanCandidates = new Map<NodeId, RTCIceCandidateInit[]>();

    private started = false;
    private closed = false;

    constructor(signaling: ISignalingAdapter, options: WebRTCChannelOptions = {}) {
        const baseLogger = resolveLogger(options.logger, options.logLevel);
        super(baseLogger);
        this.signaling = signaling;
        this.options = options;
        this.logger = createScopedLogger(baseLogger, 'WRTC');
    }

    /** プラットフォーム固有の RTCPeerConnection を生成する。 */
    protected abstract createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection;

    /**
     * 接続がタイムアウトしたときのエラーメッセージに付け足す原因の説明（既定は空）。
     * 実装ごとの既知の原因（例: node-datachannel の ICE 候補 0 件、#61）を利用者へ示すために使う。
     */
    protected describeConnectTimeout(_connection: RTCPeerConnection): string {
        return '';
    }

    public get localNodeId(): NodeId {
        return this.signaling.getLocalNodeId();
    }

    public async start(): Promise<void> {
        if (this.started) return;
        if (this.closed) throw new Error('WebRTCChannel is closed');
        this.started = true;

        await this.signaling.listen((fromId, message) => {
            if (isPublicKeyPayload(message.content) || message.type === 'public-key') {
                void this.handlePublicKeyMessage(fromId, message.content).catch((error) => {
                    this.logger.warn(`Failed to handle public-key from ${fromId}:`, error);
                });
                return;
            }
            void this.handleSignal(fromId, message).catch((error) => {
                this.logger.error(`Failed to handle ${message.type} from ${fromId}:`, error);
            });
        });
    }

    public async connect(peerId: NodeId, options: ChannelConnectOptions = {}): Promise<void> {
        if (this.closed) throw new Error('WebRTCChannel is closed');
        if (!this.started) throw new Error('WebRTCChannel.start() must be called before connect()');
        if (peerId === this.localNodeId) throw new Error('Cannot connect to self');
        if (this.connectedPeers.get(peerId) === true) return;
        const signal = options.signal;
        throwIfAborted(signal, `WebRTC connection to ${peerId} aborted`);

        // 既にネゴシエーション中のピアがあれば、その確立完了を共有待機する
        const existing = this.peers.get(peerId);
        if (existing) {
            if (existing.opened) return;
            return this.awaitPeerOpen(peerId, existing, signal);
        }

        const iceServers = await raceAbort(
            this.resolveIceServers(),
            signal,
            `WebRTC connection to ${peerId} aborted`,
        );
        if (this.closed) throw new Error('WebRTCChannel is closed');
        if (this.connectedPeers.get(peerId) === true) return;

        // resolveIceServers 待機中に相手から offer が到着していた場合はそれに乗る
        const raced = this.peers.get(peerId);
        if (raced) {
            if (raced.opened) return;
            return this.awaitPeerOpen(peerId, raced, signal);
        }

        const state = this.createPeer(peerId, true, iceServers);
        const opened = this.awaitPeerOpen(peerId, state, signal);
        // 中断などで `await opened` に到達しない経路でも、未処理の拒否にしない
        opened.catch(() => undefined);

        try {
            await raceAbort(this.startOffer(peerId, state), signal, `WebRTC connection to ${peerId} aborted`);
        } catch (error) {
            // 中断時のネゴシエーション破棄は awaitPeerOpen 側が待機者の有無を見て行う
            // （他の待機者が残っていれば共有を保つ）。それ以外の失敗はここで破棄する。
            if (!signal?.aborted && this.peers.get(peerId) === state) {
                this.destroyPeer(peerId, state, false);
            }
            throw error instanceof Error ? error : new Error(String(error));
        }

        await opened;
    }

    /** 発信側の offer を作って送る（`connect()` から中断付きで呼ぶ）。 */
    private async startOffer(peerId: NodeId, state: PeerState): Promise<void> {
        const dataChannel = state.connection.createDataChannel(
            this.options.dataChannelLabel ?? 'webtcp',
            { ordered: true },
        );
        this.attachDataChannel(peerId, state, dataChannel);

        state.awaitingAnswer = true;
        const offer = await state.connection.createOffer();
        await state.connection.setLocalDescription(offer);
        await this.sendSignal(peerId, 'offer', state.connection.localDescription ?? offer);
    }

    /**
     * ピアの確立を待つ（待機者を 1 件追加する）。
     *
     * `signal` が中断されたら、この待機者だけを外して `AbortError` で reject する。
     * 待機者が 0 件になり、かつこの接続を発信したピアが未確立なら、ネゴシエーションを破棄する
     * （タイマー・ICE・データチャネルを解放する）。受信側から始まったネゴシエーションは残す。
     */
    private awaitPeerOpen(peerId: NodeId, state: PeerState, signal?: AbortSignal): Promise<void> {
        if (!signal) {
            return new Promise<void>((resolve, reject) => {
                state.openResolvers.push(resolve);
                state.openRejecters.push(reject);
            });
        }
        if (signal.aborted) {
            return Promise.reject(createAbortError(`WebRTC connection to ${peerId} aborted`));
        }

        return new Promise<void>((resolve, reject) => {
            const onResolve = (): void => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            const onReject = (error: Error): void => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            };
            const onAbort = (): void => {
                this.removeWaiter(state, onResolve, onReject);
                this.logger.debug(`WebRTC connection to ${peerId} aborted by the caller`);
                reject(createAbortError(`WebRTC connection to ${peerId} aborted`));
                if (
                    !state.opened &&
                    state.isInitiator &&
                    state.openResolvers.length === 0 &&
                    this.peers.get(peerId) === state
                ) {
                    this.logger.debug(`Closing the pending negotiation with ${peerId} (no waiters left)`);
                    this.destroyPeer(peerId, state, false);
                }
            };

            state.openResolvers.push(onResolve);
            state.openRejecters.push(onReject);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /** 待機者を取り除く（resolve / reject の両配列から、同一の関数参照を外す）。 */
    private removeWaiter(
        state: PeerState,
        resolve: () => void,
        reject: (error: Error) => void,
    ): void {
        const resolveIndex = state.openResolvers.indexOf(resolve);
        if (resolveIndex !== -1) state.openResolvers.splice(resolveIndex, 1);
        const rejectIndex = state.openRejecters.indexOf(reject);
        if (rejectIndex !== -1) state.openRejecters.splice(rejectIndex, 1);
    }

    /**
     * 指定ピアに対して明示的に ICE 再起動を実行する（#24）。
     * `iceServersProvider` が設定されている場合は最新の TURN 資格情報も再適用する。
     */
    public async restartIce(peerId: NodeId): Promise<void> {
        if (this.closed) throw new Error('WebRTCChannel is closed');
        const state = this.peers.get(peerId);
        if (!state) {
            throw new Error(`No active peer connection for ${peerId}`);
        }
        await this.restartIceForPeer(peerId, state);
    }

    public async send(targetId: NodeId, data: Uint8Array): Promise<void> {
        const state = this.peers.get(targetId);
        const channel = state?.dataChannel;
        if (!state || !channel || channel.readyState !== 'open') {
            throw new Error(`DataChannel to ${targetId} is not open`);
        }

        const max = this.options.maxMessageBytes ?? 65_536;
        if (data.byteLength > max) {
            throw new Error(
                `Message of ${data.byteLength} bytes exceeds maxMessageBytes (${max})`,
            );
        }

        // TS 5.9 の ArrayBufferView ジェネリクスに合わせてキャストする
        channel.send(data as unknown as ArrayBufferView<ArrayBuffer>);
    }

    public disconnect(targetId: NodeId): void {
        const state = this.peers.get(targetId);
        if (!state) return;
        this.destroyPeer(targetId, state, true);
    }

    public close(): void {
        if (this.closed) return;
        this.closed = true;

        for (const [peerId, state] of [...this.peers.entries()]) {
            this.destroyPeer(peerId, state, true);
        }
        this.peers.clear();
        this.orphanCandidates.clear();
        this.signaling.close?.();
        this.removeAllListeners();
    }

    // ===============================================
    // ICE サーバー解決とピア生成・破棄
    // ===============================================

    private async resolveIceServers(): Promise<RTCIceServer[]> {
        if (this.options.iceServersProvider) {
            const provided = await this.options.iceServersProvider();
            return Array.isArray(provided) ? provided : [];
        }
        return this.options.iceServers ?? [];
    }

    private createPeer(
        peerId: NodeId,
        isInitiator: boolean,
        iceServers: RTCIceServer[],
    ): PeerState {
        const connection = this.createPeerConnection(iceServers);
        const state: PeerState = {
            connection,
            dataChannel: null,
            isInitiator,
            remoteDescriptionSet: false,
            awaitingAnswer: false,
            opened: false,
            iceRestartCount: 0,
            restartingIce: false,
            openTimer: null,
            iceDisconnectTimer: null,
            openResolvers: [],
            openRejecters: [],
            remoteCandidates: [],
        };
        this.peers.set(peerId, state);
        this.connectedPeers.set(peerId, false);

        const timeoutMs = this.options.connectTimeoutMs ?? 15_000;
        state.openTimer = setTimeout(() => {
            this.rejectOpenWaiters(
                state,
                new Error(
                    `WebRTC connection to ${peerId} timed out after ${timeoutMs}ms${this.describeConnectTimeout(state.connection)}`,
                ),
            );
            this.destroyPeer(peerId, state, true);
        }, timeoutMs);

        connection.onicecandidate = (event) => {
            if (!event.candidate) return;
            const candidateInit =
                typeof event.candidate.toJSON === 'function'
                    ? event.candidate.toJSON()
                    : (event.candidate as unknown as RTCIceCandidateInit);
            void this.sendSignal(peerId, 'candidate', candidateInit).catch((error) => {
                this.logger.warn(`Failed to send ICE candidate to ${peerId}:`, error);
            });
        };

        connection.oniceconnectionstatechange = () => {
            this.handleIceConnectionStateChange(peerId, state);
        };

        connection.onconnectionstatechange = () => {
            const connectionState = connection.connectionState;
            if (connectionState === 'connected') {
                this.clearIceDisconnectTimer(state);
                state.iceRestartCount = 0;
                state.restartingIce = false;
            } else if (connectionState === 'failed') {
                void this.handleIceFailure(peerId, state);
            } else if (connectionState === 'closed') {
                this.destroyPeer(peerId, state, true);
            }
        };

        return state;
    }

    private handleIceConnectionStateChange(peerId: NodeId, state: PeerState): void {
        if (this.closed || this.peers.get(peerId) !== state) return;
        const iceState = state.connection.iceConnectionState;

        if (iceState === 'connected' || iceState === 'completed') {
            this.clearIceDisconnectTimer(state);
            state.iceRestartCount = 0;
            state.restartingIce = false;
            return;
        }

        if (iceState === 'disconnected') {
            if (state.iceDisconnectTimer !== null || state.restartingIce) return;
            const delayMs = this.options.iceRestartDelayMs ?? 3000;
            this.logger.debug(
                `ICE disconnected with ${peerId}; scheduling restart check in ${delayMs}ms`,
            );
            state.iceDisconnectTimer = setTimeout(() => {
                state.iceDisconnectTimer = null;
                if (this.closed || this.peers.get(peerId) !== state) return;
                const current = state.connection.iceConnectionState;
                if (current === 'disconnected' || current === 'failed') {
                    void this.handleIceFailure(peerId, state);
                }
            }, delayMs);
            return;
        }

        if (iceState === 'failed') {
            this.clearIceDisconnectTimer(state);
            void this.handleIceFailure(peerId, state);
            return;
        }

        if (iceState === 'closed') {
            this.destroyPeer(peerId, state, true);
        }
    }

    private async handleIceFailure(peerId: NodeId, state: PeerState): Promise<void> {
        if (this.closed || this.peers.get(peerId) !== state) return;
        if (state.restartingIce) return;

        const maxRestarts = this.options.maxIceRestarts ?? 2;
        if (maxRestarts <= 0 || state.iceRestartCount >= maxRestarts) {
            this.logger.warn(
                `ICE failed with ${peerId} after ${state.iceRestartCount} restart attempt(s); closing peer`,
            );
            this.destroyPeer(peerId, state, true);
            return;
        }

        try {
            await this.restartIceForPeer(peerId, state);
        } catch (error) {
            this.logger.warn(`ICE restart failed for ${peerId}:`, error);
            state.restartingIce = false;
            if (this.peers.get(peerId) !== state) return;
            if (state.iceRestartCount >= maxRestarts) {
                this.destroyPeer(peerId, state, true);
            }
        }
    }

    private async restartIceForPeer(peerId: NodeId, state: PeerState): Promise<void> {
        state.restartingIce = true;
        state.iceRestartCount += 1;
        this.logger.info(
            `Initiating ICE restart #${state.iceRestartCount} for peer ${peerId}`,
        );

        // 動的 TURN 資格情報フックがあれば最新設定を反映する
        if (this.options.iceServersProvider) {
            const freshServers = await this.resolveIceServers();
            if (this.closed || this.peers.get(peerId) !== state) return;
            if (typeof state.connection.setConfiguration === 'function') {
                state.connection.setConfiguration({ iceServers: freshServers });
            }
        }

        if (typeof state.connection.restartIce === 'function') {
            state.connection.restartIce();
        }

        state.awaitingAnswer = true;
        const offer = await state.connection.createOffer({ iceRestart: true });
        if (this.closed || this.peers.get(peerId) !== state) return;

        await state.connection.setLocalDescription(offer);
        await this.sendSignal(peerId, 'offer', state.connection.localDescription ?? offer);
    }

    private attachDataChannel(
        peerId: NodeId,
        state: PeerState,
        dataChannel: RTCDataChannel,
    ): void {
        state.dataChannel = dataChannel;
        dataChannel.binaryType = 'arraybuffer';

        dataChannel.onopen = () => {
            if (this.peers.get(peerId) !== state) return;
            state.opened = true;
            if (state.openTimer !== null) {
                clearTimeout(state.openTimer);
                state.openTimer = null;
            }
            this.connectedPeers.set(peerId, true);
            this.resolveOpenWaiters(state);
            this.emit('connection-status', peerId, true);
            // 公開鍵の交換（#28, §11.4.1）。ピアのリンク確立直後に行う。
            void this.sendPublicKey(peerId).catch((error) => {
                this.logger.warn(`Failed to exchange public key with ${peerId}:`, error);
            });
        };

        dataChannel.onclose = () => {
            this.destroyPeer(peerId, state, true);
        };

        dataChannel.onerror = (event) => {
            this.logger.error(`DataChannel error with ${peerId}:`, event);
        };

        dataChannel.onmessage = (event: MessageEvent) => {
            void this.handleMessage(peerId, event.data).catch((error) => {
                this.logger.warn(`Failed to read message from ${peerId}:`, error);
            });
        };
    }

    /**
     * 自身の Ed25519 公開鍵をピアへ送る（シグナリング経由、§11.4.1）。
     *
     * 鍵管理が未設定の場合は何もしない（v1 相当の動作）。
     */
    public async sendPublicKey(peerId: NodeId): Promise<void> {
        const keyManager = this.options.keyManager;
        if (!keyManager) return;
        await this.signaling.sendMessage(peerId, {
            type: 'public-key',
            content: {
                type: 'public-key',
                publicKey: encodePublicKey(keyManager.publicKey),
                nodeId: keyManager.nodeId,
            },
            fromId: this.localNodeId,
        });
    }

    /**
     * `public-key` メッセージを処理する（§11.4.1）。
     *
     * 受信した公開鍵が `fromId` の指紋と一致することを確認してから、
     * 公開鍵ディレクトリへ登録する。指紋が一致しない鍵は破棄する。
     */
    private async handlePublicKeyMessage(fromId: NodeId, content: unknown): Promise<void> {
        if (this.closed) return;
        if (!isPublicKeyPayload(content)) {
            this.logger.warn(`Malformed public-key message from ${fromId}`);
            return;
        }

        const publicKey = decodePublicKey(content.publicKey);
        if (!publicKey) {
            this.logger.warn(`Invalid Ed25519 public key from ${fromId}`);
            return;
        }
        if (content.nodeId && content.nodeId !== fromId) {
            this.logger.warn(
                `Ignoring public key from ${fromId}: claimed nodeId ${content.nodeId} differs from sender`,
            );
            return;
        }

        const directory = this.options.keyDirectory;
        if (!directory) return;
        const accepted = await directory.addPublicKey(fromId, publicKey);
        if (accepted) {
            this.logger.debug(`Learned Ed25519 public key for ${fromId} via signaling`);
        }
    }

    private destroyPeer(peerId: NodeId, state: PeerState, notify: boolean): void {
        if (this.peers.get(peerId) === state) {
            this.peers.delete(peerId);
        }

        if (state.openTimer !== null) {
            clearTimeout(state.openTimer);
            state.openTimer = null;
        }
        this.clearIceDisconnectTimer(state);

        this.rejectOpenWaiters(state, new Error(`WebRTC connection to ${peerId} was closed`));

        const wasConnected = this.connectedPeers.get(peerId) === true;
        this.connectedPeers.set(peerId, false);

        try {
            state.dataChannel?.close();
        } catch {
            // already closed
        }
        try {
            state.connection.close();
        } catch {
            // already closed
        }

        if (notify && wasConnected) {
            this.emit('connection-status', peerId, false);
        }
    }

    private clearIceDisconnectTimer(state: PeerState): void {
        if (state.iceDisconnectTimer !== null) {
            clearTimeout(state.iceDisconnectTimer);
            state.iceDisconnectTimer = null;
        }
    }

    private resolveOpenWaiters(state: PeerState): void {
        const resolvers = state.openResolvers.splice(0);
        state.openRejecters.length = 0;
        for (const resolve of resolvers) {
            resolve();
        }
    }

    private rejectOpenWaiters(state: PeerState, error: Error): void {
        const rejecters = state.openRejecters.splice(0);
        state.openResolvers.length = 0;
        for (const reject of rejecters) {
            reject(error);
        }
    }

    // ===============================================
    // シグナリング
    // ===============================================

    private async sendSignal(
        recipientId: NodeId,
        type: 'offer' | 'answer' | 'candidate',
        content: unknown,
    ): Promise<void> {
        await this.signaling.sendMessage(recipientId, {
            type,
            content,
            fromId: this.localNodeId,
        });
    }

    private async handleSignal(
        fromId: NodeId,
        message: { type: string; content: unknown },
    ): Promise<void> {
        if (this.closed) return;

        switch (message.type) {
            case 'offer':
                await this.handleOffer(fromId, message.content as RTCSessionDescriptionInit);
                return;
            case 'answer':
                await this.handleAnswer(fromId, message.content as RTCSessionDescriptionInit);
                return;
            case 'candidate':
                await this.handleCandidate(fromId, message.content as RTCIceCandidateInit);
                return;
            default:
                this.logger.warn(`Unknown signaling message type: ${message.type}`);
        }
    }

    private async handleOffer(
        fromId: NodeId,
        description: RTCSessionDescriptionInit,
    ): Promise<void> {
        const polite = this.localNodeId < fromId;
        const existing = this.peers.get(fromId);

        // 既に接続済みのピアからの offer: インプレース再ネゴシエーション（ICE 再起動など、#24）
        if (existing && existing.opened) {
            if (existing.awaitingAnswer && !polite) {
                this.logger.debug(
                    `Ignoring colliding renegotiation offer from ${fromId} (impolite peer)`,
                );
                return;
            }
            existing.awaitingAnswer = false;
            this.logger.info(`Handling renegotiation / ICE restart offer from ${fromId}`);

            if (this.options.iceServersProvider) {
                const freshServers = await this.resolveIceServers();
                if (this.closed || this.peers.get(fromId) !== existing) return;
                if (typeof existing.connection.setConfiguration === 'function') {
                    existing.connection.setConfiguration({ iceServers: freshServers });
                }
            }

            await existing.connection.setRemoteDescription(description);
            existing.remoteDescriptionSet = true;
            await this.flushCandidates(fromId, existing);

            const answer = await existing.connection.createAnswer();
            await existing.connection.setLocalDescription(answer);
            await this.sendSignal(
                fromId,
                'answer',
                existing.connection.localDescription ?? answer,
            );
            existing.restartingIce = false;
            return;
        }

        // 未確立ピアとの同時接続（glare）: polite / impolite ルールで解決する（#32）
        let inheritedResolvers: Array<() => void> = [];
        let inheritedRejecters: Array<(error: Error) => void> = [];

        if (existing) {
            if (existing.isInitiator && !polite) {
                this.logger.debug(
                    `Ignoring colliding initial offer from ${fromId} (impolite peer)`,
                );
                return;
            }
            // polite 側: 待機中の connect() Promise を新ピアへ引き継ぐ
            inheritedResolvers = existing.openResolvers.splice(0);
            inheritedRejecters = existing.openRejecters.splice(0);
            this.destroyPeer(fromId, existing, false);
        }

        const iceServers = await this.resolveIceServers();
        if (this.closed) {
            for (const reject of inheritedRejecters) {
                reject(new Error('WebRTCChannel is closed'));
            }
            return;
        }

        let state = this.createPeer(fromId, false, iceServers);
        state.openResolvers.push(...inheritedResolvers);
        state.openRejecters.push(...inheritedRejecters);

        const attachHandlers = (target: PeerState) => {
            target.connection.ondatachannel = (event) => {
                this.attachDataChannel(fromId, target, event.channel);
            };
        };
        attachHandlers(state);

        for (let attempt = 1; ; attempt += 1) {
            try {
                await state.connection.setRemoteDescription(description);
                state.remoteDescriptionSet = true;
                await this.flushCandidates(fromId, state);

                const answer = await state.connection.createAnswer();
                await state.connection.setLocalDescription(answer);
                await this.sendSignal(fromId, 'answer', state.connection.localDescription ?? answer);
                return;
            } catch (error) {
                if (attempt >= DTLS_IDENTITY_MAX_ATTEMPTS || this.closed || !isDtlsIdentityNotReady(error)) {
                    this.destroyPeer(fromId, state, false);
                    throw error;
                }
                // identity の無い接続は再利用しない。同じ offer で新しい接続を作る（#97）
                this.logger.warn(
                    `Answering connection to ${fromId} has no DTLS identity; rebuilding (attempt ${attempt + 1} of ${DTLS_IDENTITY_MAX_ATTEMPTS})`,
                );
                const resolvers = state.openResolvers.splice(0);
                const rejecters = state.openRejecters.splice(0);
                const history = state.remoteCandidates;
                this.destroyPeer(fromId, state, false);

                await new Promise<void>((resolve) => setTimeout(resolve, DTLS_IDENTITY_REBUILD_DELAY_MS));
                if (this.closed) throw new Error('WebRTCChannel is closed');

                // 作り直す間に届いた候補（orphan）の前に、これまでの候補を並べる
                const queued = this.orphanCandidates.get(fromId) ?? [];
                this.orphanCandidates.set(fromId, [...history, ...queued]);

                state = this.createPeer(fromId, false, iceServers);
                state.openResolvers.push(...resolvers);
                state.openRejecters.push(...rejecters);
                attachHandlers(state);
            }
        }
    }

    private async handleAnswer(
        fromId: NodeId,
        description: RTCSessionDescriptionInit,
    ): Promise<void> {
        const state = this.peers.get(fromId);
        if (!state) {
            this.logger.warn(`Received answer from unknown peer ${fromId}`);
            return;
        }
        if (!state.awaitingAnswer) {
            // 重複または不要な answer は無視する
            return;
        }

        state.awaitingAnswer = false;
        await state.connection.setRemoteDescription(description);
        state.remoteDescriptionSet = true;
        state.restartingIce = false;
        await this.flushCandidates(fromId, state);
    }

    private async handleCandidate(
        fromId: NodeId,
        candidate: RTCIceCandidateInit,
    ): Promise<void> {
        const state = this.peers.get(fromId);

        if (!state || !state.remoteDescriptionSet) {
            const queue = this.orphanCandidates.get(fromId) ?? [];
            queue.push(candidate);
            this.orphanCandidates.set(fromId, queue);
            return;
        }

        if (!state.opened) state.remoteCandidates.push(candidate);
        try {
            await state.connection.addIceCandidate(candidate);
        } catch (error) {
            this.logger.warn(`Failed to add ICE candidate from ${fromId}:`, error);
        }
    }

    private async flushCandidates(fromId: NodeId, state: PeerState): Promise<void> {
        const orphans = this.orphanCandidates.get(fromId) ?? [];
        this.orphanCandidates.delete(fromId);

        for (const candidate of orphans) {
            if (!state.opened) state.remoteCandidates.push(candidate);
            try {
                await state.connection.addIceCandidate(candidate);
            } catch (error) {
                this.logger.warn(`Failed to add queued ICE candidate from ${fromId}:`, error);
            }
        }
    }

    private async handleMessage(peerId: NodeId, data: unknown): Promise<void> {
        if (this.closed) return;

        if (data instanceof ArrayBuffer) {
            this.emit('data', peerId, new Uint8Array(data));
            return;
        }
        if (data instanceof Uint8Array) {
            this.emit('data', peerId, data);
            return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            const buffer = await data.arrayBuffer();
            this.emit('data', peerId, new Uint8Array(buffer));
            return;
        }
        if (typeof data === 'string') {
            this.emit('data', peerId, new TextEncoder().encode(data));
            return;
        }

        this.logger.warn(`Unsupported message type from ${peerId}`);
    }
}
