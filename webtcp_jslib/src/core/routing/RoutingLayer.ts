import { WebTCPPacket } from '../types/packet.js';
import { WEBTCP_PROTOCOL_VERSION, WEBTCP_PROTOCOL_VERSION_V1, NodeId } from '../types/protocol.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import type { LinkManager } from '../link/LinkManager.js';
import { IPacketVerifier, NullPacketVerifier } from './PacketVerifier.js';
import { KeyDirectory } from './KeyDirectory.js';
import { encodePublicKey } from './keys.js';
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
    /**
     * 署名検証器。
     * 省略時は `requiredSignatures` に応じて決まる。
     * - `false`（既定・後方互換）: `NullPacketVerifier`（v1 相当）
     * - `true`: 例外（Ed25519 検証器の明示的な指定が必要）
     */
    verifier?: IPacketVerifier;
    /**
     * 署名の必須化（プロトコル v2、#28）。
     *
     * `true` の場合、署名のない v1 パケットや検証に失敗したパケットを破棄する。
     * 既定は `false`（v1 パケットも受理）で、v2 パケットは常に検証される。
     */
    requiredSignatures?: boolean;
    /**
     * ピアの公開鍵ディレクトリ（任意）。
     * 指定すると RT_UPDATE で学習した公開鍵を `Ed25519PacketVerifier` へ共有する。
     */
    keyDirectory?: KeyDirectory;
    /** 自身の公開鍵（Base64url）。RT_UPDATE に同梱して全隣接へ配布する（§11.4.2）。 */
    localPublicKey?: Uint8Array;
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
 * - 署名付与（送信）・署名検証（受信）（#28, specification.md §11）
 * - TTL 管理
 * - RPF（Reverse Path Forwarding）チェック
 * - RT_UPDATE のルーティングテーブルへの反映と公開鍵の配布
 */
export class RoutingLayer extends EventEmitter implements IRoutingLayer {
    public readonly manager: RoutingTableManager;

    private readonly localNodeId: NodeId;
    private readonly linkManager: LinkManager;
    private readonly routingTable: RoutingTable;
    private readonly verifier: IPacketVerifier;
    private readonly keyDirectory: KeyDirectory | null;
    private readonly requiredSignatures: boolean;
    private readonly localPublicKey: Uint8Array | null;
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
        this.keyDirectory = options.keyDirectory ?? null;
        this.requiredSignatures = options.requiredSignatures ?? false;
        this.localPublicKey = options.localPublicKey ?? null;
        this.defaultTtl = options.defaultTtl ?? 64;
        this.logger = createScopedLogger(baseLogger, 'RL');

        this.manager = new RoutingTableManager(
            localNodeId,
            routingTable,
            {
                getNeighbors: () => this.linkManager.getActiveNeighbors(),
                sendRoutingUpdate: (neighborId, info) => this.sendRoutingUpdate(neighborId, info),
                getPublicKeyBase64Url: (nodeId) => this.keyDirectory?.exportPublicKey(nodeId) ?? null,
            },
            {
                ...options.routingTableManager,
                logger: options.routingTableManager?.logger ?? baseLogger,
            },
        );

        // LinkManager からのイベントを購読する
        this.linkManager.on(
            'packet',
            (packet: WebTCPPacket, fromId: NodeId, rawBytes?: Uint8Array) => {
                void this.handleIncomingPacket(packet, fromId, rawBytes);
            },
        );
        // RT_UPDATE で配布された公開鍵をディレクトリへ登録する（§11.4.2）
        this.manager.onPublicKey = (senderId, publicKeyBase64Url) => {
            void this.learnPublicKey(senderId, publicKeyBase64Url);
        };
        this.manager.onAdvertisedPublicKey = (nodeId, publicKeyBase64Url) => {
            void this.learnPublicKey(nodeId, publicKeyBase64Url);
        };
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

    /** 公開鍵ディレクトリ（読み取り用）。 */
    public getKeyDirectory(): KeyDirectory | null {
        return this.keyDirectory;
    }

    /** RT_UPDATE で受信した公開鍵を学習する。 */
    private async learnPublicKey(nodeId: NodeId, publicKeyBase64Url: string): Promise<void> {
        if (!this.keyDirectory) return;
        try {
            const alreadyKnown = this.keyDirectory.get(nodeId) !== undefined;
            const accepted = await this.keyDirectory.addPublicKey(nodeId, publicKeyBase64Url);
            if (accepted && !alreadyKnown) {
                this.logger.debug(`Learned Ed25519 public key for ${nodeId} from RT_UPDATE`);
                // 新しく学習した鍵を隣接へ伝播してマルチホップ先の検証を可能にする。
                this.manager.announce();
            }
        } catch (error) {
            this.logger.warn(`Failed to register public key for ${nodeId}:`, error);
        }
    }

    // =================================================================
    // 送信 (TransportLayer -> RoutingLayer)
    // =================================================================

    /**
     * 上位層から受け取ったパケットに署名し、宛先へ送り出す。
     *
     * 署名は RoutingLayer で 1 度だけ付与する。中継転送時は TTL を変更するが、
     * TTL は署名対象外（0 に正規化）なので再署名は不要である（§11.3）。
     */
    public async sendPacket(packet: WebTCPPacket): Promise<void> {
        const signedPacket = await this.signPacket(packet);

        if (signedPacket.destinationId === this.localNodeId) {
            this.forwardToTransportLayer(signedPacket);
            return;
        }

        this.forwardPacket(signedPacket, false);
    }

    private async signPacket(packet: WebTCPPacket): Promise<WebTCPPacket> {
        // 転送時に付与済みの署名は保持する（要件: 中継ノードは再署名しない）
        if (packet.signature.byteLength > 0) {
            return packet;
        }
        try {
            return await this.verifier.signPacket(packet);
        } catch (error) {
            this.logger.warn(`Failed to sign ${packet.flags} packet; sending unsigned.`, error);
            return { ...packet, version: WEBTCP_PROTOCOL_VERSION_V1 };
        }
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

    private async handleIncomingPacket(
        packet: WebTCPPacket,
        fromId: NodeId,
        rawBytes?: Uint8Array,
    ): Promise<void> {
        // --- 1. 署名検証（§11.2） ---
        const verification = await this.verifyIncoming(packet, rawBytes);
        if (!verification.ok) {
            this.logger.warn(
                `Dropping ${packet.flags} from ${packet.senderId}: ${verification.reason}`,
            );
            return;
        }

        // --- 2. ルーティング情報は直接隣接・sender 一致・正 TTL のみ（M4 / #37） ---
        if (packet.flags === 'RT_UPDATE') {
            if (
                !this.linkManager.isNeighbor(fromId) ||
                packet.senderId !== fromId ||
                packet.destinationId !== this.localNodeId ||
                packet.ttl <= 0 ||
                packet.sourcePort !== 0 ||
                packet.destinationPort !== 0
            ) {
                this.logger.warn(`Dropping RT_UPDATE from ${packet.senderId} via ${fromId}: invalid control packet`);
                return;
            }
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
     * 受信パケットの署名を検証し、結果と理由を返す。
     *
     * - v1（署名なし）パケットは `requiredSignatures = false` のときのみ受理する。
     * - v2 パケットは必ず検証する。
     */
    private async verifyIncoming(
        packet: WebTCPPacket,
        rawBytes?: Uint8Array,
    ): Promise<{ ok: boolean; reason: string }> {
        const isV1 = (packet.version ?? WEBTCP_PROTOCOL_VERSION) === WEBTCP_PROTOCOL_VERSION_V1;

        if (isV1 && packet.signature.byteLength === 0) {
            return this.requiredSignatures
                ? { ok: false, reason: 'signature required (protocol v2)' }
                : { ok: true, reason: 'unsigned v1 packet accepted' };
        }

        try {
            const verified =
                rawBytes && this.verifier.verifyBytes
                    ? await this.verifier.verifyBytes(packet, rawBytes)
                    : await this.verifier.verifyPacket(packet);
            return verified
                ? { ok: true, reason: 'signature ok' }
                : { ok: false, reason: 'invalid signature' };
        } catch (error) {
            return {
                ok: false,
                reason: `signature verification threw: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
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
     *
     * 自身の公開鍵をペイロードへ同梱し、受信側が署名検証できるようにする（§11.4.2）。
     */
    public async sendRoutingUpdate(neighborId: NodeId, info: RoutingInfoPacket): Promise<boolean> {
        const payloadInfo: RoutingInfoPacket = this.localPublicKey
            ? { ...info, publicKey: encodePublicKey(this.localPublicKey) }
            : info;
        const payload = new TextEncoder().encode(JSON.stringify(payloadInfo));

        let packet: WebTCPPacket = {
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

        // RT_UPDATE も署名する（受信側は同梱公開鍵で件数を検証できる）
        packet = await this.signPacket(packet);
        return this.linkManager.sendPacketToNeighbor(neighborId, packet);
    }
}
