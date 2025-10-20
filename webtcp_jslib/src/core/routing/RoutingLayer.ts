import { EventEmitter } from 'events';
import { NodeId, VirtualPort, TTL } from '../types/protocol';
import { WebTCPPacket } from '../types/packet';
import { IChannel } from '../link/IChannel';
import { RoutingTable } from './RoutingTable';
import { RoutingTableManager } from './RoutingTableManager';
import { PacketVerifier } from './PacketVerifier';

// 仮のPacketSerializerの型定義。実際には専用のクラスが必要。
interface PacketSerializer {
    serialize(packet: WebTCPPacket): Uint8Array;
    deserialize(data: Uint8Array): WebTCPPacket;
}

// TransportLayerへパケットを渡すためのインターフェース
interface TransportLayer {
    handleIncomingPacket(packet: WebTCPPacket): void;
}

/**
 * WebTCPプロトコルのルーティング層 (L2.5/L3)。
 * パケットの転送、署名検証、TTL管理、RPFチェック、トランスポート層への振り分けを担う。
 */
export class RoutingLayer extends EventEmitter {
    // 依存オブジェクト
    private localNodeId: NodeId;
    private channel: IChannel;
    private routingTable: RoutingTable;
    private verifier: PacketVerifier;
    private serializer: PacketSerializer;
    
    // 上位層への参照
    private transportLayer: TransportLayer | null = null;
    
    // 自身が管理するRTM
    public manager: RoutingTableManager; 

    /**
     * @param localNodeId このノードのID。
     * @param channel P2Pリンク層のインターフェース。
     * @param routingTable ルーティング情報テーブル。
     * @param verifier パケット署名検証/付与オブジェクト。
     * @param serializer パケットのバイナリ変換オブジェクト。
     */
    constructor(
        localNodeId: NodeId,
        channel: IChannel,
        routingTable: RoutingTable,
        verifier: PacketVerifier,
        serializer: PacketSerializer
    ) {
        super();
        this.localNodeId = localNodeId;
        this.channel = channel;
        this.routingTable = routingTable;
        this.verifier = verifier;
        this.serializer = serializer;
        
        // RTMをインスタンス化し、ルーティング情報の交換を管理させる
        this.manager = new RoutingTableManager(routingTable, channel, localNodeId);

        // IChannelからのデータ受信イベントを購読
        this.channel.on('data', this.handleIncomingData.bind(this));
        
        // RTMを起動
        this.manager.start();
    }

    /**
     * TransportLayerへの参照を設定する。
     * @param transportLayer TransportLayerのインスタンス。
     */
    public setTransportLayer(transportLayer: TransportLayer): void {
        this.transportLayer = transportLayer;
    }

    // =================================================================
    // 1. 受信パケット処理 (IChannel -> RoutingLayer)
    // =================================================================

    /**
     * IChannel (隣接ノード) から受信した生データ (Uint8Array) を処理する。
     * @param senderId 隣接ノードID。
     * @param data 受信したバイナリデータ。
     */
    private async handleIncomingData(senderId: NodeId, data: Uint8Array): Promise<void> {
        let packet: WebTCPPacket;
        try {
            packet = this.serializer.deserialize(data);
        } catch (e) {
            console.error('[RL] Failed to deserialize packet. Dropping.', e);
            return;
        }

        // --- Step 1: 署名検証 (Verification) ---
        if (!(await this.verifier.verifyPacket(packet))) {
            console.warn('[RL] Invalid signature or public key. Dropping packet.');
            return;
        }

        // --- Step 2: RPFチェック (Reverse Path Forwarding) ---
        // 受信したパケットが、送信元への最短経路から来たかを確認
        if (!this.checkReversePath(packet.senderId, senderId)) {
            console.warn(`[RL] RPF check failed: Packet from ${packet.senderId} did not arrive via shortest path from ${senderId}. Dropping.`);
            // ルーティング情報パケットはRPFチェックをスキップする必要があるが、
            // ここでは簡易的に全パケットに適用する。
            return;
        }

        // --- Step 3: TTLチェックとデクリメント ---
        if (packet.ttl <= 1) {
            if (packet.destinationId !== this.localNodeId) {
                console.warn(`[RL] TTL expired for packet to ${packet.destinationId}. Dropping.`);
                return;
            }
        }
        packet.ttl -= 1; // TTLを減らす

        // --- Step 4: 宛先判定 ---
        if (packet.destinationId === this.localNodeId) {
            // 自身宛てのパケットは上位層へ
            this.forwardToTransportLayer(packet);
        } else {
            // 他のノード宛てのパケットは転送
            this.forwardPacket(packet);
        }
    }

    /**
     * RPFチェックロジック。送信元への最短経路のネクストホップが、実際にパケットを
     * 送ってきた隣接ノードと一致するかを確認する。
     * @param sourceId パケットのオリジナルの送信元ノードID。
     * @param receivedFromId パケットを受信した隣接ノードID。
     * @returns 最短経路から来た場合はtrue。
     */
    private checkReversePath(sourceId: NodeId, receivedFromId: NodeId): boolean {
        const entry = this.routingTable.getEntry(sourceId);
        
        // 1. エントリがない場合は最短経路が不明なため、一旦転送を許可しない (Drop)
        if (!entry) return false;

        // 2. 最短経路のネクストホップが、受信したノードと一致するか
        return entry.nextHopId === receivedFromId;
    }

    // =================================================================
    // 2. 送信パケット処理 (TransportLayer -> RoutingLayer)
    // =================================================================

    /**
     * TransportLayerからのパケットを受信し、ルーティングと署名を行い、ネットワークへ送り出す。
     * @param packet TransportLayerから渡された未署名のWebTCPPacket。
     */
    public async sendPacket(packet: WebTCPPacket): Promise<void> {
        // --- Step 1: 署名付与 (Signing) ---
        const signedPacket = await this.verifier.signPacket(packet);

        // --- Step 2: 転送 ---
        if (signedPacket.destinationId === this.localNodeId) {
            // 自身宛てのパケットは直接TransportLayerへ（通常は応答パケットなど）
            this.forwardToTransportLayer(signedPacket);
        } else {
            this.forwardPacket(signedPacket);
        }
    }


    /**
     * パケットをルーティングテーブルに基づき次のホップに転送する。
     * @param packet 署名済みでTTLが更新されたWebTCPPacket。
     */
    private forwardPacket(packet: WebTCPPacket): void {
        const entry = this.routingTable.getEntry(packet.destinationId);

        if (!entry || entry.cost === 0) {
            console.warn(`[RL] Route not found for destination ${packet.destinationId}. Dropping.`);
            // パケットの送信元に経路が見つからない旨を通知するロジックをここに追加すべき
            return;
        }

        const nextHopId = entry.nextHopId;
        
        if (nextHopId === this.localNodeId) {
            // 自身宛のパケットはforwardToTransportLayerで処理されるはず
            console.error('[RL] Routing loop detected or misconfigured.');
            return;
        }

        // --- Step 3: シリアライズと送信 ---
        const data = this.serializer.serialize(packet);
        
        // IChannelを通じて次のホップへデータを送信
        this.channel.send(nextHopId, data)
            .catch(err => console.error(`[RL] Failed to send packet to next hop ${nextHopId}: ${err}`));
        
        console.log(`[RL] Forwarded packet to ${packet.destinationId} via ${nextHopId}. TTL: ${packet.ttl}`);
    }

    // =================================================================
    // 3. 上位層への引き渡し
    // =================================================================
    
    /**
     * 自身宛てのパケットをTransportLayerへ渡す。
     */
    private forwardToTransportLayer(packet: WebTCPPacket): void {
        if (this.transportLayer) {
            this.transportLayer.handleIncomingPacket(packet);
        } else {
            console.warn('[RL] Transport Layer not initialized. Dropping packet.');
        }
    }
}
