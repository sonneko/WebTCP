import { WebTCPPacket } from '../types/packet.js';
import { NodeId } from '../types/protocol.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import type { LinkManager } from '../link/LinkManager.js';
import { IPacketVerifier, NullPacketVerifier } from './PacketVerifier.js';
import { RoutingTable } from './RoutingTable.js';
import {
    RoutingInfoPacket,
    RoutingTableManager,
    RoutingTableManagerOptions,
} from './RoutingTableManager.js';

/**
 * トランスポート層へパケットを渡すための抽象。
 * 循環依存を避けるため、具象クラスではなくインターフェースに依存する。
 */
export interface TransportSink {
    handleIncomingPacket(packet: WebTCPPacket): void;
}

/** トランスポート層がルーティング層へ要求するAPI。 */
export interface IRoutingLayer {
    sendPacket(packet: WebTCPPacket): Promise<void>;
    setTransportLayer(sink: TransportSink): void;
}

export interface RoutingLayerOptions {
    verifier?: IPacketVerifier;
    routingTableManager?: RoutingTableManagerOptions;
    /** 送信パケットの初期TTL。既定 64。 */
    defaultTtl?: number;
    /** ロガー（任意）。 */
    logger?: Logger;
}

/**
 * WebTCPプロトコルのルーティング層（L3）。
 *
 * - パケットの宛先判定と転送
 * - 署名検証（M1–M2は NullPacketVerifier）
 * - TTL 管理
 * - RPF（Reverse Path Forwarding）チェック
 * - RT_UPDATE のルーティングテーブルへの反映
 */
export class RoutingLayer extends EventEmitter implements IRoutingLayer {
    public readonly manager: RoutingTableManager;

    private readonly localNodeId: NodeId;
    private readonly linkManager: LinkManager;
    private readonly routingTable: RoutingTable;
    private readonly verifier: IPacketVerifier;
    private readonly defaultTtl: number;
    private readonly logger: Logger;

    private transportLayer: TransportSink | null = null;

    constructor(
        localNodeId: NodeId,
        linkManager: LinkManager,
        routingTable: RoutingTable,
        options: RoutingLayerOptions = {},
    ) {
        const baseLogger = options.logger ?? defaultLogger;
        super(baseLogger);
        this.localNodeId = localNodeId;
        this.linkManager = linkManager;
        this.routingTable = routingTable;
        this.verifier = options.verifier ?? new NullPacketVerifier();
        this.defaultTtl = options.defaultTtl ?? 64;
        this.logger = createScopedLogger(baseLogger, 'RL');

        this.manager = new RoutingTableManager(
            localNodeId,
            routingTable,
            {
                getNeighbors: () => this.linkManager.getActiveNeighbors(),
                sendRoutingUpdate: (neighborId, info) => this.sendRoutingUpdate(neighborId, info),
            },
            {
                ...options.routingTableManager,
                logger: options.routingTableManager?.logger ?? baseLogger,
            },
        );

        // LinkManager からのイベントを購読する
        this.linkManager.on('packet', (packet: WebTCPPacket, fromId: NodeId) => {
            void this.handleIncomingPacket(packet, fromId);
        });
        this.linkManager.on('neighbor-connected', (peerId: NodeId) => {
            this.manager.handleNeighborUp(peerId);
        });
        this.linkManager.on('neighbor-disconnected', (peerId: NodeId) => {
            this.manager.handleNeighborDown(peerId);
        });
    }

    /** 定期メンテナンスを開始する。 */
    public start(): void {
        this.manager.start();
    }

    /** 定期メンテナンスを停止する。 */
    public stop(): void {
        this.manager.stop();
    }

    /** 上位層（トランスポート層）を設定する。 */
    public setTransportLayer(transportLayer: TransportSink): void {
        this.transportLayer = transportLayer;
    }

    /** ルーティングテーブルへの参照（読み取り用）。 */
    public getRoutingTable(): RoutingTable {
        return this.routingTable;
    }

    // =================================================================
    // 送信 (TransportLayer -> RoutingLayer)
    // =================================================================

    /**
     * 上位層から受け取ったパケットに署名し、宛先へ送り出す。
     */
    public async sendPacket(packet: WebTCPPacket): Promise<void> {
        const signedPacket = await this.verifier.signPacket(packet);

        if (signedPacket.destinationId === this.localNodeId) {
            this.forwardToTransportLayer(signedPacket);
            return;
        }

        this.forwardPacket(signedPacket, false);
    }

    /**
     * ルーティングテーブルに従って次のホップへ転送する。
     * 中継転送（`isTransit = true`）では TTL を 1 減算し、0 以下になった場合は破棄する（#30）。
     */
    private forwardPacket(packet: WebTCPPacket, isTransit: boolean): void {
        if (isTransit) {
            if (packet.ttl <= 1) {
                this.logger.warn(
                    `TTL expired while forwarding to ${packet.destinationId}. Dropping.`,
                );
                return;
            }
            packet = { ...packet, ttl: packet.ttl - 1 };
        } else if (packet.ttl <= 0) {
            this.logger.warn(`TTL expired before sending to ${packet.destinationId}. Dropping.`);
            return;
        }

        let nextHopId: NodeId | null = null;

        const entry = this.routingTable.getEntry(packet.destinationId);
        if (entry && entry.cost > 0) {
            nextHopId = entry.nextHopId;
        } else if (this.linkManager.isNeighbor(packet.destinationId)) {
            // 経路情報が未学習でも、直接の隣接なら届けられる
            nextHopId = packet.destinationId;
        }

        if (!nextHopId) {
            this.logger.warn(`No route to ${packet.destinationId}. Dropping packet.`);
            return;
        }
        if (nextHopId === this.localNodeId) {
            this.logger.error('Routing loop detected: next hop is self.');
            return;
        }

        this.logger.debug(
            `${isTransit ? 'Forwarded' : 'Sent'} ${packet.flags} packet to ${packet.destinationId} via ${nextHopId} (ttl=${packet.ttl})`,
        );

        void this.linkManager.sendPacketToNeighbor(nextHopId, packet).then((sent) => {
            if (!sent) {
                this.logger.warn(
                    `Failed to forward packet to ${packet.destinationId} via ${nextHopId}.`,
                );
            }
        });
    }

    // =================================================================
    // 受信 (LinkManager -> RoutingLayer)
    // =================================================================

    private async handleIncomingPacket(packet: WebTCPPacket, fromId: NodeId): Promise<void> {
        // --- 1. 署名検証 ---
        let verified: boolean;
        try {
            verified = await this.verifier.verifyPacket(packet);
        } catch (error) {
            this.logger.warn('Signature verification threw. Dropping packet.', error);
            return;
        }
        if (!verified) {
            this.logger.warn('Invalid signature. Dropping packet.');
            return;
        }

        // --- 2. ルーティング情報は RPF / TTL の対象外 ---
        if (packet.flags === 'RT_UPDATE') {
            this.manager.handleRoutingInfoPayload(packet.senderId, packet.payload);
            return;
        }

        // --- 3. RPF チェック ---
        if (!this.checkReversePath(packet.senderId, fromId)) {
            this.logger.warn(
                `RPF check failed: packet from ${packet.senderId} arrived via ${fromId}. Dropping.`,
            );
            return;
        }

        // --- 4. 宛先判定と転送 ---
        if (packet.destinationId === this.localNodeId) {
            this.forwardToTransportLayer(packet);
        } else {
            this.forwardPacket(packet, true);
        }
    }

    /**
     * 送信元への最短経路のネクストホップが、実際に受信した隣接と一致するか確認する。
     * 経路が未学習の場合は、直接の隣接からの受信のみ許可する（M1–M2の縮退動作）。
     */
    private checkReversePath(sourceId: NodeId, receivedFromId: NodeId): boolean {
        const entry = this.routingTable.getEntry(sourceId);

        if (entry) {
            return entry.nextHopId === receivedFromId;
        }
        return this.linkManager.isNeighbor(receivedFromId);
    }

    // =================================================================
    // 上位層への引き渡し / ルーティング情報の送信
    // =================================================================

    private forwardToTransportLayer(packet: WebTCPPacket): void {
        if (this.transportLayer) {
            this.transportLayer.handleIncomingPacket(packet);
        } else {
            this.logger.warn('Transport layer is not attached. Dropping packet.');
        }
    }

    /**
     * ルーティング情報を RT_UPDATE パケットとして隣接ノードへ送る。
     */
    public async sendRoutingUpdate(neighborId: NodeId, info: RoutingInfoPacket): Promise<boolean> {
        const payload = new TextEncoder().encode(JSON.stringify(info));
        const packet: WebTCPPacket = {
            senderId: this.localNodeId,
            destinationId: neighborId,
            ttl: this.defaultTtl,
            signature: new Uint8Array(0),
            sourcePort: 0,
            destinationPort: 0,
            flags: 'RT_UPDATE',
            seqNum: 0,
            ackNum: 0,
            payload,
        };
        return this.linkManager.sendPacketToNeighbor(neighborId, packet);
    }
}
