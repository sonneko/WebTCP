import { NodeId, VirtualPort, WebTCPPacket } from '../types/index.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { allocateEphemeralPort } from '../util/id.js';
import type { IRoutingLayer } from '../routing/RoutingLayer.js';
import { ManagedStream, SessionManager, SessionManagerOptions } from './SessionManager.js';
import { TransportContext, VirtualStream, VirtualStreamOptions } from './VirtualStream.js';

/** アプリケーションがポートで待ち受ける際に登録するハンドラ。 */
export type PortHandler = (stream: VirtualStream) => void;

export interface TransportLayerOptions {
    sessionManager?: SessionManagerOptions;
    stream?: VirtualStreamOptions;
    /** 接続確立のタイムアウト（ms）。既定 10000。 */
    connectTimeoutMs?: number;
    /** 制御パケットの初期TTL。既定 64。 */
    defaultTtl?: number;
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

    private started = false;
    private closed = false;

    constructor(
        localNodeId: NodeId,
        routingLayer: IRoutingLayer,
        options: TransportLayerOptions = {},
    ) {
        super();
        this.localNodeId = localNodeId;
        this.routingLayer = routingLayer;
        this.sessionManager = new SessionManager(options.sessionManager);
        this.streamOptions = options.stream ?? {};
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
        this.defaultTtl = options.defaultTtl ?? 64;

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
     * @param localPort ローカルポート（省略時は自動割り当て）
     * @throws タイムアウト、RST、または送信失敗時
     */
    public async connect(
        remoteNodeId: NodeId,
        remotePort: VirtualPort,
        localPort?: VirtualPort,
    ): Promise<VirtualStream> {
        if (this.closed) throw new Error('TransportLayer is closed');
        this.assertPort(remotePort);
        const local = localPort ?? allocateEphemeralPort();
        this.assertPort(local);

        const existing = this.sessionManager.getStream(remoteNodeId, local, remotePort);
        if (existing instanceof VirtualStream) {
            return existing;
        }
        if (existing) {
            throw new Error('A non-VirtualStream session already exists for this tuple');
        }

        const stream = new VirtualStream(
            this,
            remoteNodeId,
            local,
            remotePort,
            true,
            this.streamOptions,
        );
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

            const cleanup = (): void => {
                clearTimeout(timer);
                stream.off('connect', onConnect);
                stream.off('error', onError);
                stream.off('close', onClose);
            };

            stream.once('connect', onConnect);
            stream.once('error', onError);
            stream.once('close', onClose);
        });

        try {
            await stream.initiateConnection();
        } catch (error) {
            stream.close();
            throw error;
        }

        return connected;
    }

    /**
     * パッシブオープン。指定ポートへの SYN を待ち受ける。
     * @throws 同じポートがすでに登録されている場合
     */
    public listen(port: VirtualPort, handler: PortHandler): void {
        if (this.closed) throw new Error('TransportLayer is closed');
        this.assertPort(port);
        if (this.portHandlers.has(port)) {
            throw new Error(`Port ${port} is already listening`);
        }
        this.portHandlers.set(port, handler);
    }

    /** 指定ポートの待ち受けを解除する。 */
    public unlisten(port: VirtualPort): boolean {
        return this.portHandlers.delete(port);
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
            console.warn('[TL] Received packet not destined for this node. Dropping.');
            return;
        }

        const localPort = packet.destinationPort;
        const remotePort = packet.sourcePort;

        const stream = this.sessionManager.getStream(
            packet.senderId,
            localPort,
            remotePort,
        );

        if (stream instanceof VirtualStream) {
            stream.handleIncomingPacket(packet);
            return;
        }

        if (packet.flags === 'SYN') {
            this.handleSynRequest(packet, localPort, remotePort);
            return;
        }

        console.warn(
            `[TL] No session for ${packet.senderId}:${remotePort} -> ${localPort} (flags=${packet.flags}). Sending RST.`,
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
            console.warn(`[TL] Port ${localPort} is not listening. Sending RST.`);
            void this.sendRst(packet.senderId, remotePort, localPort);
            return;
        }

        const stream = new VirtualStream(
            this,
            packet.senderId,
            localPort,
            remotePort,
            false,
            this.streamOptions,
        );
        this.sessionManager.registerStream(stream);

        // SYN を処理させ、SYN_ACK を返させる
        stream.handleIncomingPacket(packet);

        handler(stream);
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
            console.warn('[TL] Failed to send RST:', error);
        }
    }

    private assertPort(port: VirtualPort): void {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid virtual port: ${port}`);
        }
    }
}
