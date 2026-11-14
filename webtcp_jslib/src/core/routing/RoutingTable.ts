import { NodeId } from '../types/protocol.js';

/**
 * ルーティングテーブルのエントリ構造。
 * 特定の宛先ノードへの転送情報を保持する。
 */
export interface ForwardingEntry {
    /** 宛先ノードまでの推定コスト（ホップ数）。RPFチェックの基準。 */
    cost: number;
    /** 次に転送すべき隣接ノードのID。 */
    nextHopId: NodeId;
    /** エントリが最後に更新されたタイムスタンプ（Unix time, ms）。 */
    lastSeen: number;
}

/**
 * WebTCPネットワークにおけるルーティングテーブル。
 *
 * データの保存と検索のみを責務とし、更新ロジック（コスト計算・エイジング）は
 * `RoutingTableManager` が担う。
 */
export class RoutingTable {
    private readonly table = new Map<NodeId, ForwardingEntry>();
    private readonly localNodeId: NodeId;

    /**
     * @param localNodeId このテーブルを所有するノードのID
     */
    constructor(localNodeId: NodeId) {
        this.localNodeId = localNodeId;
        // 自身へのエントリはコスト0、ネクストホップは自身
        this.updateEntry(localNodeId, { cost: 0, nextHopId: localNodeId });
    }

    public getLocalNodeId(): NodeId {
        return this.localNodeId;
    }

    /**
     * エントリを追加または更新する。
     */
    public updateEntry(destinationId: NodeId, entry: Omit<ForwardingEntry, 'lastSeen'>): void {
        this.table.set(destinationId, { ...entry, lastSeen: Date.now() });
    }

    /** 宛先のエントリを取得する。存在しなければ null。 */
    public getEntry(destinationId: NodeId): ForwardingEntry | null {
        return this.table.get(destinationId) ?? null;
    }

    /** エントリを削除する。自身のエントリは削除できない。 */
    public deleteEntry(destinationId: NodeId): boolean {
        if (destinationId === this.localNodeId) return false;
        return this.table.delete(destinationId);
    }

    /** テーブル全体のコピーを返す。 */
    public getAllEntries(): ReadonlyMap<NodeId, ForwardingEntry> {
        return new Map(this.table);
    }

    /** 登録エントリ数（自身を含む）。 */
    public size(): number {
        return this.table.size;
    }
}
