import { NodeId, VirtualPort, WebTCPPacket } from '../types/index.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { allocateEphemeralPort } from '../util/id.js';
import { createAbortError, throwIfAborted } from '../util/abort.js';
import type { IRoutingLayer } from '../routing/RoutingLayer.js';
import { ManagedStream, SessionManager, SessionManagerOptions } from './SessionManager.js';
import { TransportContext, VirtualStream, VirtualStreamOptions } from './VirtualStream.js';
import { SynReplayGuard, SynReplayGuardOptions } from './SynReplayGuard.js';

/** `TransportLayer.connect()` のオプション（#44）。 */
export interface TransportConnectOptions {
    /** 中断用シグナル。 */
    signal?: AbortSignal;
}

/** アプリケーションがポートで待ち受ける際に登録するハンドラ。 */
export type PortHandler = (stream: VirtualStream) => void;

export interface TransportLayerOptions {
    sessionManager?: SessionManagerOptions;
    stream?: VirtualStreamOptions;
    /** 接続確立のタイムアウト（ms）。既定 10000。 */
    connectTimeoutMs?: number;
    /** 制御パケットの初期TTL。既定 64。 */
    defaultTtl?: number;
    /** ロガー（任意）。 */
    logger?: Logger;
    /** `SYN` のリプレイ検知（#48、仕様 §11.6.1）。既定は有効（旧 `SYN` を受理）。 */
    synReplay?: SynReplayGuardOptions;
}

/**
 * WebTCP のトランスポート層（L4）。
 *
 * - 仮想ポートによる多重化
 * - 仮想ストリームの生成・破棄（SessionManager）
 * - SYN の受付と RST の返送
 */
export class TransportLayer extends EventEmitter implements TransportContext {
    public readonly localNodeId: NodeId;
    public readonly sessionManager: SessionManager;

    private readonly routingLayer: IRoutingLayer;
    private readonly portHandlers = new Map<VirtualPort, PortHandler>();
    private readonly streamOptions: VirtualStreamOptions;
    private readonly connectTimeoutMs: number;
    private readonly defaultTtl: number;
    private readonly baseLogger: Logger;
    private readonly synGuard: SynReplayGuard;
    private readonly logger: Logger;

    private started = false;
    private closed = false;

    constructor(
        localNodeId: NodeId,
        routingLayer: IRoutingLayer,
        options: TransportLayerOptions = {},
    ) {
        const baseLogger = options.logger ?? defaultLogger;
        super(baseLogger);
        this.localNodeId = localNodeId;
        this.routingLayer = routingLayer;
        this.baseLogger = baseLogger;
        this.logger = createScopedLogger(baseLogger, 'TL');
        this.sessionManager = new SessionManager({
            ...options.sessionManager,
            logger: options.sessionManager?.logger ?? baseLogger,
        });
        this.streamOptions = {
            ...options.stream,
            logger: options.stream?.logger ?? baseLogger,
        };
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
        this.defaultTtl = options.defaultTtl ?? 64;
        this.synGuard = new SynReplayGuard({ logger: baseLogger, ...options.synReplay });

        this.routingLayer.setTransportLayer(this);
    }

    /** セッションのタイムアウト監視を開始する（冪等）。 */
    public start(): void {
        if (this.started) return;
        this.started = true;
        this.sessionManager.start();
    }

    /** 全ストリームを閉じ、監視を停止する。 */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.sessionManager.closeAll();
        this.sessionManager.stop();
        this.portHandlers.clear();
    }

    // ===============================================
    // アプリケーション向けAPI
    // ===============================================

    /**
     * 能動オープン。リモートノードとの仮想接続を確立する。
     *
     * @param remoteNodeId 接続先ノードID
     * @param remotePort 接続先ポート
     * @param localPort ローカルポート（省略時は衝突しないエフェメラルポートを自動割り当て）
     * @param options `signal` で中断できる（#44）。中断時は `AbortError` で reject し、
     *   既に送った SYN は `RST` で取り消す（`destroy()`）。タイマーとリスナーは解除する。
     * @throws タイムアウト、RST、送信失敗、または中断（`AbortError`）
     */
    public async connect(
        remoteNodeId: NodeId,
        remotePort: VirtualPort,
        localPort?: VirtualPort,
        options: TransportConnectOptions = {},
    ): Promise<VirtualStream> {
        if (this.closed) throw new Error('TransportLayer is closed');
        this.assertPort(remotePort);
        const signal = options.signal;
        throwIfAborted(signal, `Connection to ${remoteNodeId}:${remotePort} aborted`);

        const local =
            localPort !== undefined
                ? localPort
                : this.allocateUnusedEphemeralPort(remoteNodeId, remotePort);
        this.assertPort(local);

        const existing = this.sessionManager.getStream(remoteNodeId, local, remotePort);
        if (existing instanceof VirtualStream) {
            return existing;
        }
        if (existing) {
            throw new Error('A non-VirtualStream session already exists for this tuple');
        }

        const stream = new VirtualStream(this, remoteNodeId, local, remotePort, true, {
            defaultTtl: this.defaultTtl,
            ...this.streamOptions,
            logger: this.streamOptions.logger ?? this.baseLogger,
        });
        this.sessionManager.registerStream(stream);

        const connected = new Promise<VirtualStream>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                stream.close();
                reject(
                    new Error(
                        `Connection to ${remoteNodeId}:${remotePort} timed out after ${this.connectTimeoutMs}ms`,
                    ),
                );
            }, this.connectTimeoutMs);

            const onConnect = (): void => {
                cleanup();
                resolve(stream);
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            const onClose = (): void => {
                cleanup();
                reject(new Error('Stream closed before the connection was established'));
            };
            const onAbort = (): void => {
                cleanup();
                this.logger.debug(`Connection to ${remoteNodeId}:${remotePort} aborted`);
                // RST で相手側の半開きセッションも取り消す（#54）。
                stream.destroy();
                reject(createAbortError(`Connection to ${remoteNodeId}:${remotePort} aborted`));
            };

            const cleanup = (): void => {
                clearTimeout(timer);
                stream.off('connect', onConnect);
                stream.off('error', onError);
                stream.off('close', onClose);
                signal?.removeEventListener('abort', onAbort);
            };

            stream.once('connect', onConnect);
            stream.once('error', onError);
            stream.once('close', onClose);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        // 送信失敗時など `connected` を待たずに抜ける経路があるため、未処理の拒否にしない
        connected.catch(() => undefined);

        try {
            await stream.initiateConnection();
        } catch (error) {
            if (signal?.aborted) {
                // 中断は `connected` 側で処理済み（ストリームは破棄されている）
                throw createAbortError(`Connection to ${remoteNodeId}:${remotePort} aborted`);
            }
            stream.close();
            throw error;
        }

        return connected;
    }

    /**
     * パッシブオープン。指定ポートへの接続を待ち受ける。
     * ハンドラはハンドシェイクが完了して `ESTABLISHED` になったタイミングで呼ばれる（#31）。
     * @throws 同じポートがすでに登録されている場合
     */
    public listen(port: VirtualPort, handler: PortHandler): void {
        if (this.closed) throw new Error('TransportLayer is closed');
        this.assertPort(port);
        if (this.portHandlers.has(port)) {
            throw new Error(`Port ${port} is already listening`);
        }
        this.portHandlers.set(port, handler);
        this.emit('listening-changed', port);
    }

    /** 指定ポートの待ち受けを解除する。 */
    public unlisten(port: VirtualPort): boolean {
        const removed = this.portHandlers.delete(port);
        if (removed) this.emit('listening-changed', port);
        return removed;
    }

    /** 待ち受け中のポート一覧。 */
    public getListeningPorts(): VirtualPort[] {
        return [...this.portHandlers.keys()];
    }

    // ===============================================
    // ルーティング層とのやりとり
    // ===============================================

    /** ルーティング層へパケットを送る（VirtualStream から呼ばれる）。 */
    public async sendPacket(packet: WebTCPPacket): Promise<void> {
        await this.routingLayer.sendPacket(packet);
    }

    /** ストリームの登録を解除する（VirtualStream から呼ばれる）。 */
    public deregisterStream(stream: ManagedStream): void {
        this.sessionManager.deregisterStream(stream);
    }

    /**
     * ルーティング層から自身宛てのパケットを受け取る。
     */
    public handleIncomingPacket(packet: WebTCPPacket): void {
        if (this.closed) return;

        if (packet.destinationId !== this.localNodeId) {
            this.logger.warn('Received packet not destined for this node. Dropping.');
            return;
        }

        const localPort = packet.destinationPort;
        const remotePort = packet.sourcePort;

        const stream = this.sessionManager.getStream(packet.senderId, localPort, remotePort);

        if (stream instanceof VirtualStream) {
            stream.handleIncomingPacket(packet);
            return;
        }

        if (packet.flags === 'SYN') {
            // 既存セッションに一致しない SYN は、再生でないことを確かめてから新しい受動セッションを作る（#48）
            if (!this.synGuard.check(packet).accepted) return;
            this.handleSynRequest(packet, localPort, remotePort);
            return;
        }

        // RST への RST は返さない。両端が同時に destroy() すると、互いの RST を無いセッションへの
        // 応答として返し続けて終わらなくなるため（#54）。
        if (packet.flags === 'RST') {
            this.logger.debug(`RST for unknown session ${packet.senderId}:${remotePort} -> ${localPort}; ignored.`);
            return;
        }
        this.logger.warn(
            `No session for ${packet.senderId}:${remotePort} -> ${localPort} (flags=${packet.flags}). Sending RST.`,
        );
        void this.sendRst(packet.senderId, remotePort, localPort);
    }

    // ===============================================
    // 内部処理
    // ===============================================

    private handleSynRequest(
        packet: WebTCPPacket,
        localPort: VirtualPort,
        remotePort: VirtualPort,
    ): void {
        const handler = this.portHandlers.get(localPort);
        if (!handler) {
            this.logger.warn(`Port ${localPort} is not listening. Sending RST.`);
            void this.sendRst(packet.senderId, remotePort, localPort);
            return;
        }

        const stream = new VirtualStream(this, packet.senderId, localPort, remotePort, false, {
            defaultTtl: this.defaultTtl,
            ...this.streamOptions,
            logger: this.streamOptions.logger ?? this.baseLogger,
        });
        this.sessionManager.registerStream(stream);

        // ハンドシェイクが完了して ESTABLISHED に到達したタイミングでハンドラを呼ぶ（#31, design.md §5.2）
        stream.once('connect', () => {
            if (!this.closed) {
                handler(stream);
            }
        });

        // SYN を処理させ、SYN_ACK を返させる
        stream.handleIncomingPacket(packet);
    }

    private allocateUnusedEphemeralPort(
        remoteNodeId: NodeId,
        remotePort: VirtualPort,
    ): VirtualPort {
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const candidate = allocateEphemeralPort();
            if (!this.sessionManager.hasStream(remoteNodeId, candidate, remotePort)) {
                return candidate;
            }
        }
        throw new Error('Failed to allocate an unused ephemeral port');
    }

    /**
     * RST を返送する。
     * @param destinationId 相手ノード
     * @param destinationPort 相手ポート（元の sourcePort）
     * @param sourcePort 自分ポート（元の destinationPort）
     */
    private async sendRst(
        destinationId: NodeId,
        destinationPort: VirtualPort,
        sourcePort: VirtualPort,
    ): Promise<void> {
        const rst: WebTCPPacket = {
            senderId: this.localNodeId,
            destinationId,
            sourcePort,
            destinationPort,
            ttl: this.defaultTtl,
            flags: 'RST',
            seqNum: 0,
            ackNum: 0,
            payload: new Uint8Array(0),
            signature: new Uint8Array(0),
        };

        try {
            await this.routingLayer.sendPacket(rst);
        } catch (error) {
            this.logger.warn('Failed to send RST:', error);
        }
    }

    private assertPort(port: VirtualPort): void {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid virtual port: ${port}`);
        }
    }
}
