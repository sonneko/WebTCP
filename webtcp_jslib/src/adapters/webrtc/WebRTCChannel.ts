import { IChannel } from '../../core/link/IChannel.js';
import { ISignalingAdapter } from '../../core/link/ISignalingAdapter.js';
import { NodeId } from '../../core/types/protocol.js';
import { EventEmitter } from '../../core/util/EventEmitter.js';

export interface WebRTCChannelOptions {
    /** STUN/TURN サーバー。既定は空（同一ホスト・同一LAN向け）。 */
    iceServers?: RTCIceServer[];
    /** データチャネルのラベル。既定 `webtcp`。 */
    dataChannelLabel?: string;
    /** 接続確立のタイムアウト（ms）。既定 15000。 */
    connectTimeoutMs?: number;
    /** 1メッセージの最大バイト数。既定 65536。 */
    maxMessageBytes?: number;
}

interface PeerState {
    connection: RTCPeerConnection;
    dataChannel: RTCDataChannel | null;
    remoteDescriptionSet: boolean;
    opened: boolean;
    openTimer: ReturnType<typeof setTimeout> | null;
    resolveOpen: (() => void) | null;
    rejectOpen: ((error: Error) => void) | null;
}

/**
 * WebRTC DataChannel を用いた `IChannel` の共通実装。
 *
 * Offer/Answer/ICE の交換、データチャネルの開設・監視をすべてここで行い、
 * サブクラスは `createPeerConnection()` だけを提供する。
 */
export abstract class WebRTCChannel extends EventEmitter implements IChannel {
    public readonly connectedPeers = new Map<NodeId, boolean>();

    protected readonly signaling: ISignalingAdapter;
    protected readonly options: WebRTCChannelOptions;

    private readonly peers = new Map<NodeId, PeerState>();
    private readonly orphanCandidates = new Map<NodeId, RTCIceCandidateInit[]>();

    private started = false;
    private closed = false;

    constructor(signaling: ISignalingAdapter, options: WebRTCChannelOptions = {}) {
        super();
        this.signaling = signaling;
        this.options = options;
    }

    /** プラットフォーム固有の RTCPeerConnection を生成する。 */
    protected abstract createPeerConnection(): RTCPeerConnection;

    public get localNodeId(): NodeId {
        return this.signaling.getLocalNodeId();
    }

    public async start(): Promise<void> {
        if (this.started) return;
        if (this.closed) throw new Error('WebRTCChannel is closed');
        this.started = true;

        await this.signaling.listen((fromId, message) => {
            void this.handleSignal(fromId, message).catch((error) => {
                console.error(`[WRTC] Failed to handle ${message.type} from ${fromId}:`, error);
            });
        });
    }

    public async connect(peerId: NodeId): Promise<void> {
        if (this.closed) throw new Error('WebRTCChannel is closed');
        if (!this.started) throw new Error('WebRTCChannel.start() must be called before connect()');
        if (peerId === this.localNodeId) throw new Error('Cannot connect to self');
        if (this.connectedPeers.get(peerId) === true) return;

        const state = this.createPeer(peerId);
        const opened = new Promise<void>((resolve, reject) => {
            state.resolveOpen = resolve;
            state.rejectOpen = reject;
        });

        try {
            const dataChannel = state.connection.createDataChannel(
                this.options.dataChannelLabel ?? 'webtcp',
                { ordered: true },
            );
            this.attachDataChannel(peerId, state, dataChannel);

            const offer = await state.connection.createOffer();
            await state.connection.setLocalDescription(offer);
            await this.sendSignal(
                peerId,
                'offer',
                state.connection.localDescription ?? offer,
            );
        } catch (error) {
            this.destroyPeer(peerId, state, false);
            throw error instanceof Error ? error : new Error(String(error));
        }

        await opened;
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
    // ピアの生成と破棄
    // ===============================================

    private createPeer(peerId: NodeId): PeerState {
        const connection = this.createPeerConnection();
        const state: PeerState = {
            connection,
            dataChannel: null,
            remoteDescriptionSet: false,
            opened: false,
            openTimer: null,
            resolveOpen: null,
            rejectOpen: null,
        };
        this.peers.set(peerId, state);
        this.connectedPeers.set(peerId, false);

        const timeoutMs = this.options.connectTimeoutMs ?? 15_000;
        state.openTimer = setTimeout(() => {
            state.rejectOpen?.(
                new Error(`WebRTC connection to ${peerId} timed out after ${timeoutMs}ms`),
            );
            state.rejectOpen = null;
            state.resolveOpen = null;
            this.destroyPeer(peerId, state, true);
        }, timeoutMs);

        connection.onicecandidate = (event) => {
            if (!event.candidate) return;
            void this.sendSignal(peerId, 'candidate', event.candidate.toJSON()).catch((error) => {
                console.warn(`[WRTC] Failed to send ICE candidate to ${peerId}:`, error);
            });
        };

        connection.onconnectionstatechange = () => {
            const connectionState = connection.connectionState;
            if (connectionState === 'failed' || connectionState === 'closed') {
                this.destroyPeer(peerId, state, true);
            }
        };

        return state;
    }

    private attachDataChannel(
        peerId: NodeId,
        state: PeerState,
        dataChannel: RTCDataChannel,
    ): void {
        state.dataChannel = dataChannel;
        dataChannel.binaryType = 'arraybuffer';

        dataChannel.onopen = () => {
            state.opened = true;
            if (state.openTimer !== null) {
                clearTimeout(state.openTimer);
                state.openTimer = null;
            }
            this.connectedPeers.set(peerId, true);
            state.rejectOpen = null;
            state.resolveOpen?.();
            state.resolveOpen = null;
            this.emit('connection-status', peerId, true);
        };

        dataChannel.onclose = () => {
            this.destroyPeer(peerId, state, true);
        };

        dataChannel.onerror = (event) => {
            console.error(`[WRTC] DataChannel error with ${peerId}:`, event);
        };

        dataChannel.onmessage = (event: MessageEvent) => {
            void this.handleMessage(peerId, event.data).catch((error) => {
                console.warn(`[WRTC] Failed to read message from ${peerId}:`, error);
            });
        };
    }

    private destroyPeer(peerId: NodeId, state: PeerState, notify: boolean): void {
        if (this.peers.get(peerId) === state) {
            this.peers.delete(peerId);
        }

        if (state.openTimer !== null) {
            clearTimeout(state.openTimer);
            state.openTimer = null;
        }
        state.rejectOpen?.(new Error(`WebRTC connection to ${peerId} was closed`));
        state.resolveOpen = null;
        state.rejectOpen = null;

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
                console.warn(`[WRTC] Unknown signaling message type: ${message.type}`);
        }
    }

    private async handleOffer(
        fromId: NodeId,
        description: RTCSessionDescriptionInit,
    ): Promise<void> {
        const existing = this.peers.get(fromId);
        if (existing) {
            if (existing.opened) {
                console.warn(`[WRTC] Ignoring duplicate offer from connected peer ${fromId}`);
                return;
            }
            // 接続試行中の再オファーは既存のものを破棄して作り直す
            this.destroyPeer(fromId, existing, false);
        }

        const state = this.createPeer(fromId);
        state.connection.ondatachannel = (event) => {
            this.attachDataChannel(fromId, state, event.channel);
        };

        try {
            await state.connection.setRemoteDescription(description);
            state.remoteDescriptionSet = true;
            await this.flushCandidates(fromId, state);

            const answer = await state.connection.createAnswer();
            await state.connection.setLocalDescription(answer);
            await this.sendSignal(
                fromId,
                'answer',
                state.connection.localDescription ?? answer,
            );
        } catch (error) {
            this.destroyPeer(fromId, state, false);
            throw error;
        }
    }

    private async handleAnswer(
        fromId: NodeId,
        description: RTCSessionDescriptionInit,
    ): Promise<void> {
        const state = this.peers.get(fromId);
        if (!state) {
            console.warn(`[WRTC] Received answer from unknown peer ${fromId}`);
            return;
        }
        if (state.remoteDescriptionSet) {
            // 再送された answer は無視する
            return;
        }

        await state.connection.setRemoteDescription(description);
        state.remoteDescriptionSet = true;
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

        try {
            await state.connection.addIceCandidate(candidate);
        } catch (error) {
            console.warn(`[WRTC] Failed to add ICE candidate from ${fromId}:`, error);
        }
    }

    private async flushCandidates(fromId: NodeId, state: PeerState): Promise<void> {
        const orphans = this.orphanCandidates.get(fromId) ?? [];
        this.orphanCandidates.delete(fromId);

        for (const candidate of orphans) {
            try {
                await state.connection.addIceCandidate(candidate);
            } catch (error) {
                console.warn(`[WRTC] Failed to add queued ICE candidate from ${fromId}:`, error);
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

        console.warn(`[WRTC] Unsupported message type from ${peerId}`);
    }
}
