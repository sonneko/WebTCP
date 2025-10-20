import { NodeId } from '../types/protocol';
import { IChannel } from '../link/IChannel';
import { RoutingTable, ForwardingEntry } from './RoutingTable';

// WebTCP上でルーティング情報を交換するためのパケット構造
interface RoutingInfoPacket {
    // パケットを送信したノードID
    senderId: NodeId;
    // 送信元ノードが知っているルーティングエントリのリスト
    entries: {
        destinationId: NodeId;
        cost: number;
    }[];
}

/**
 * ルーティングテーブルの動的な管理、更新、エイジング、トポロジー情報交換を担うクラス。
 */
export class RoutingTableManager {
    private table: RoutingTable;
    private channel: IChannel; // IChannel (隣接ノード管理) に依存
    private maintenanceInterval: NodeJS.Timeout | null = null;

    // 設定値
    private readonly MAINTENANCE_PERIOD_MS = 30000; // 30秒ごとにメンテナンス実行
    private readonly AGE_THRESHOLD_MS = 60000;      // 60秒以上更新がないエントリを削除

    /**
     * @param table 管理対象のRoutingTableインスタンス。
     * @param channel P2Pリンク層のインターフェース。
     * @param localNodeId ローカルノードのID。
     */
    constructor(table: RoutingTable, channel: IChannel, localNodeId: NodeId) {
        this.table = table;
        this.channel = channel;

        // 隣接ノードの接続/切断イベントを購読
        this.channel.on('connection-status', this.handleConnectionStatusChange.bind(this));
    }

    /**
     * ルーティングマネージャーの実行を開始し、定期的なメンテナンスをセットアップする。
     */
    public start(): void {
        if (this.maintenanceInterval) {
            clearInterval(this.maintenanceInterval);
        }
        this.maintenanceInterval = setInterval(() => {
            this.runMaintenance();
        }, this.MAINTENANCE_PERIOD_MS);

        console.log('[RTM] Routing Table Manager started.');
    }

    /**
     * ルーティングマネージャーを停止する。
     */
    public stop(): void {
        if (this.maintenanceInterval) {
            clearInterval(this.maintenanceInterval);
            this.maintenanceInterval = null;
        }
        console.log('[RTM] Routing Table Manager stopped.');
    }

    // ===============================================
    // 1. 隣接ノード管理 (IChannel連携)
    // ===============================================

    /**
     * 隣接ノードの接続状態が変更された際に呼び出される。
     */
    private handleConnectionStatusChange(peerId: NodeId, isConnected: boolean): void {
        if (isConnected) {
            // 新しい隣接ノードが接続された場合、コスト1としてテーブルを更新
            // このノードを介して自分自身に到達できる（ネクストホップが自分自身）
            this.table.updateEntry(peerId, { cost: 1, nextHopId: peerId });
            console.log(`[RTM] New neighbor connected: ${peerId}. Cost 1 set.`);
            
            // 全エントリを新しい隣接ノードに送信し、情報交換を開始
            this.sendRoutingUpdate(peerId);

        } else {
            // 隣接ノードが切断された場合、そのノードを介した全経路を無効化（削除）
            this.invalidateRoutesThroughPeer(peerId);
            console.log(`[RTM] Neighbor disconnected: ${peerId}. Routes invalidated.`);
        }
    }

    /**
     * 特定の隣接ノードがダウンした場合、そのノードをネクストホップとする全経路を削除する。
     */
    private invalidateRoutesThroughPeer(peerId: NodeId): void {
        const entriesToDelete: NodeId[] = [];
        
        // 自身のノードIDは削除しないため、 getAllEntries() を使用
        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (entry.nextHopId === peerId) {
                entriesToDelete.push(destinationId);
            }
        });

        entriesToDelete.forEach(id => this.table.deleteEntry(id));
        // テーブル変更後、隣接ノードに更新情報をブロードキャストすべき（ポイズンリバースなど、より高度なロジックが必要）
        this.broadcastRoutingUpdate(); 
    }

    // ===============================================
    // 2. パケット受信時の処理
    // ===============================================

    /**
     * RoutingLayerからルーティング情報パケットを受信した際に呼び出される。
     * 受信した情報に基づき、最短経路を更新する。
     * @param senderId 情報の送信元ノードID (隣接ノード)。
     * @param packet 受信したRoutingInfoPacket。
     */
    public handleRoutingInfo(senderId: NodeId, packet: RoutingInfoPacket): void {
        this.updateTableFromPeer(senderId, packet.entries);
    }

    /**
     * 受信したエントリに基づいてルーティングテーブルを更新する（ディスタンスベクタアルゴリズム）。
     * @param peerId 情報の送信元（隣接ノード）。
     * @param peerEntries 隣接ノードが知っているエントリ。
     */
    private updateTableFromPeer(peerId: NodeId, peerEntries: RoutingInfoPacket['entries']): void {
        let tableChanged = false;

        for (const { destinationId, cost: peerCost } of peerEntries) {
            // 隣接ノードを介したこの宛先への新しいコスト
            const newCost = peerCost + 1; // 隣接ノードへのコストは1ホップとする

            // 現在のテーブルエントリを取得
            const currentEntry = this.table.getEntry(destinationId);

            if (destinationId === this.table.getAllEntries().keys().next().value) {
                // 自身へのエントリは無視
                continue;
            }

            if (!currentEntry || newCost < currentEntry.cost) {
                // 1. エントリが存在しない、または 2. 新しい経路の方がコストが低い場合
                this.table.updateEntry(destinationId, {
                    cost: newCost,
                    nextHopId: peerId // 送信元をネクストホップとする
                });
                tableChanged = true;
                // console.log(`[RTM] Updated: ${destinationId} via ${peerId}, Cost ${newCost}`);

            } else if (currentEntry.nextHopId === peerId) {
                // 現在の経路と同じネクストホップから情報を受信した場合（コストが変動しなかった or 増加した場合）
                if (newCost !== currentEntry.cost) {
                    this.table.updateEntry(destinationId, {
                        cost: newCost,
                        nextHopId: peerId
                    });
                    tableChanged = true;
                    // console.log(`[RTM] Cost updated for ${destinationId} via ${peerId}, New Cost ${newCost}`);
                }
            }
        }
        
        // テーブルが更新された場合、隣接ノードにその変更を伝播させる
        if (tableChanged) {
            this.broadcastRoutingUpdate();
        }
    }

    // ===============================================
    // 3. メンテナンスとブロードキャスト
    // ===============================================

    /**
     * 定期的に実行されるメンテナンス処理。
     */
    private runMaintenance(): void {
        this.performAging();
        this.broadcastRoutingUpdate();
    }

    /**
     * エイジング処理を実行し、古くなったエントリを削除する。
     */
    private performAging(): void {
        const now = Date.now();
        const staleEntries: NodeId[] = [];

        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (entry.cost > 0 && (now - entry.lastSeen > this.AGE_THRESHOLD_MS)) {
                staleEntries.push(destinationId);
            }
        });

        staleEntries.forEach(id => {
            this.table.deleteEntry(id);
            console.log(`[RTM] Aged out stale entry for ${id}`);
        });

        // テーブルからエントリが削除された場合、その情報を伝播させる
        if (staleEntries.length > 0) {
            this.broadcastRoutingUpdate();
        }
    }

    /**
     * 全隣接ノードに対して現在のルーティングテーブル情報をブロードキャストする。
     */
    private broadcastRoutingUpdate(): void {
        const routingPacket = this.createRoutingInfoPacket();
        const data = new TextEncoder().encode(JSON.stringify(routingPacket));

        // 接続されているすべての隣接ノードに対してパケットを送信
        this.channel.connectedPeers.forEach((isConnected, peerId) => {
            if (isConnected) {
                // IChannelを通じて生データを送信。実際のパケットヘッダー付与はRoutingLayerが行う想定だが、
                // ここではIChannelから直接送れるシンプルなプロトコルとして扱う。
                this.channel.send(peerId, data).catch(err => {
                    console.error(`[RTM] Failed to send update to ${peerId}: ${err}`);
                });
            }
        });
    }

    /**
     * 現在のルーティングテーブルから送信用の RoutingInfoPacket を作成する。
     */
    private createRoutingInfoPacket(): RoutingInfoPacket {
        const entries: RoutingInfoPacket['entries'] = [];
        
        // 自身のノードIDのエントリは送信しない（ブロードキャストプロトコルでは通常行わない）
        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (destinationId !== this.table.getAllEntries().keys().next().value) {
                 entries.push({
                    destinationId: destinationId,
                    cost: entry.cost
                });
            }
        });

        return {
            senderId: this.table.getAllEntries().keys().next().value, // 仮に最初のキーをローカルIDとする
            entries: entries
        };
    }
}
