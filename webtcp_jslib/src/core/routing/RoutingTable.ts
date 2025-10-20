import { NodeId } from '../types/protocol'; // NodeIdの型をインポート

/**
 * ルーティングテーブルのエントリ構造。
 * 特定の宛先ノードへの転送情報を保持する。
 */
export interface ForwardingEntry {
    /** 宛先ノードまでの推定コスト (例: ホップ数)。RPFチェックの基準。 */
    cost: number;
    /** パケットを次に転送すべき隣接ノードのID (Next Hop)。 */
    nextHopId: NodeId;
    /** エントリが最後に更新されたタイムスタンプ (Unix time)。 */
    lastSeen: number;
}

/**
 * WebTCPネットワークにおけるルーティングテーブル。
 * NodeIdをキーとしてForwardingEntryを管理し、パケット転送のための経路情報を提供する。
 * * NOTE: テーブルの更新ロジック（コスト計算、エイジング）は RoutingTableManager が担当する。
 * このクラスはデータの保存と検索のみに責任を持つ。
 */
export class RoutingTable {
    // 宛先NodeId (Destination) をキーとし、ForwardingEntryを値とするマップ
    private table: Map<NodeId, ForwardingEntry>;
    private localNodeId: NodeId;

    /**
     * @param localNodeId このテーブルを所有するノードのID。
     */
    constructor(localNodeId: NodeId) {
        this.localNodeId = localNodeId;
        this.table = new Map<NodeId, ForwardingEntry>();

        // 自身のノードIDへのエントリは、コスト0、ネクストホップは自身として初期設定する
        this.updateEntry(localNodeId, { cost: 0, nextHopId: localNodeId });
    }

    /**
     * テーブルに新しいエントリを追加または既存のエントリを更新する。
     * @param destinationId 宛先ノードID。
     * @param entry 更新/新規作成する転送情報。
     */
    public updateEntry(destinationId: NodeId, entry: Omit<ForwardingEntry, 'lastSeen'>): void {
        const fullEntry: ForwardingEntry = {
            ...entry,
            lastSeen: Date.now(), // 更新された日時を記録
        };
        this.table.set(destinationId, fullEntry);
    }

    /**
     * 指定された宛先ノードへの転送エントリを取得する。
     * @param destinationId 宛先ノードID。
     * @returns 転送エントリ、または見つからない場合はnull。
     */
    public getEntry(destinationId: NodeId): ForwardingEntry | null {
        return this.table.get(destinationId) || null;
    }

    /**
     * 指定されたノードIDのエントリをテーブルから削除する。
     * @param destinationId 削除するノードID。
     */
    public deleteEntry(destinationId: NodeId): boolean {
        // 自身のノードIDは削除できないように保護
        if (destinationId === this.localNodeId) {
            return false;
        }
        return this.table.delete(destinationId);
    }

    /**
     * テーブル全体のコピーを取得する（Managerが更新ロジックに使用するため）。
     * @returns 現在のテーブルのMap形式のコピー。
     */
    public getAllEntries(): ReadonlyMap<NodeId, ForwardingEntry> {
        // 外部からの直接的な変更を防ぐため、コピーを返す
        return new Map(this.table);
    }
}
