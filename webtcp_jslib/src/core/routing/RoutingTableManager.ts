import { NodeId } from '../types/protocol.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { RoutingTable } from './RoutingTable.js';

/**
 * ルーティング情報パケット（RT_UPDATE）のペイロード（specification.md §7.4）。
 */
export interface RoutingInfoPacket {
    /** パケットを送信したノードID。 */
    senderId: NodeId;
    /** 送信元ノードが知っているルーティングエントリ。 */
    entries: {
        destinationId: NodeId;
        cost: number;
    }[];
    /** 到達不能になった宛先（経路の撤回）。 */
    withdrawals?: NodeId[];
}

/**
 * ルーティング情報の送信に必要な機能を RoutingLayer から注入するためのフック。
 * これにより RoutingTableManager はリンク層に直接依存しない。
 */
export interface RoutingUpdateTransport {
    /** 現在の隣接ノード一覧。 */
    getNeighbors(): NodeId[];
    /** 指定隣接ノードへルーティング情報を送る。 */
    sendRoutingUpdate(neighborId: NodeId, info: RoutingInfoPacket): Promise<boolean>;
}

export interface RoutingTableManagerOptions {
    /** メンテナンス周期（ms）。既定 30000。 */
    maintenancePeriodMs?: number;
    /** エントリの寿命（ms）。既定 60000。 */
    ageThresholdMs?: number;
    /** ロガー（任意）。 */
    logger?: Logger;
}

/**
 * ルーティングテーブルの動的管理を担う。
 *
 * - 隣接の接続/切断に応じたエントリの追加・無効化
 * - 距離ベクトル方式による経路更新
 * - 定期的なエイジングとブロードキャスト
 */
export class RoutingTableManager {
    private readonly localNodeId: NodeId;
    private readonly table: RoutingTable;
    private readonly transport: RoutingUpdateTransport;
    private readonly maintenancePeriodMs: number;
    private readonly ageThresholdMs: number;
    private readonly logger: Logger;

    private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        localNodeId: NodeId,
        table: RoutingTable,
        transport: RoutingUpdateTransport,
        options: RoutingTableManagerOptions = {},
    ) {
        this.localNodeId = localNodeId;
        this.table = table;
        this.transport = transport;
        this.maintenancePeriodMs = options.maintenancePeriodMs ?? 30_000;
        this.ageThresholdMs = options.ageThresholdMs ?? 60_000;
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'RTM');
    }

    /** 定期メンテナンスを開始する（冪等）。 */
    public start(): void {
        if (this.maintenanceTimer !== null) return;
        this.maintenanceTimer = setInterval(() => {
            this.runMaintenance();
        }, this.maintenancePeriodMs);
    }

    /** 定期メンテナンスを停止する。 */
    public stop(): void {
        if (this.maintenanceTimer !== null) {
            clearInterval(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
    }

    // ===============================================
    // 隣接ノードの増減
    // ===============================================

    /** 隣接ノードが接続した。コスト1の経路を登録して情報交換を始める。 */
    public handleNeighborUp(peerId: NodeId): void {
        this.table.updateEntry(peerId, { cost: 1, nextHopId: peerId });
        const neighbors = this.transport.getNeighbors();
        if (!neighbors.includes(peerId)) {
            void this.sendRoutingUpdate(peerId).catch((error) => {
                this.logger.warn(`Failed to send initial routing update to ${peerId}:`, error);
            });
        }
        this.broadcastRoutingUpdate();
    }

    /** 隣接ノードが切断した。そのノード経由の経路をすべて削除する。 */
    public handleNeighborDown(peerId: NodeId): void {
        this.invalidateRoutesThroughPeer(peerId);
    }

    private invalidateRoutesThroughPeer(peerId: NodeId): void {
        const entriesToDelete: NodeId[] = [];
        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (destinationId !== this.localNodeId && entry.nextHopId === peerId) {
                entriesToDelete.push(destinationId);
            }
        });
        entriesToDelete.forEach((id) => this.table.deleteEntry(id));

        if (entriesToDelete.length > 0) {
            this.logger.debug(`Invalidated ${entriesToDelete.length} routes via ${peerId}`);
            this.broadcastRoutingUpdate(entriesToDelete);
        }
    }

    // ===============================================
    // 受信
    // ===============================================

    /**
     * RT_UPDATE のペイロード（UTF-8 JSON）を処理する。
     * 不正なペイロードは警告して無視する。
     */
    public handleRoutingInfoPayload(senderId: NodeId, payload: Uint8Array): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(payload));
        } catch (error) {
            this.logger.warn(`Dropping RT_UPDATE from ${senderId}: invalid JSON`, error);
            return;
        }

        const info = this.validateRoutingInfo(parsed);
        if (!info) {
            this.logger.warn(`Dropping RT_UPDATE from ${senderId}: invalid structure`);
            return;
        }

        this.updateTableFromPeer(senderId, info.entries, info.withdrawals ?? []);
    }

    /**
     * 受信したエントリに基づいてルーティングテーブルを更新する（距離ベクトル）。
     */
    private updateTableFromPeer(
        peerId: NodeId,
        peerEntries: RoutingInfoPacket['entries'],
        withdrawals: NodeId[] = [],
    ): void {
        let tableChanged = false;

        // 直接隣接ノード自身のコスト1経路の生存時刻を更新する（#30）
        const peerEntry = this.table.getEntry(peerId);
        if (!peerEntry || peerEntry.cost > 1) {
            this.table.updateEntry(peerId, { cost: 1, nextHopId: peerId });
            tableChanged = true;
        } else if (peerEntry.nextHopId === peerId) {
            this.table.updateEntry(peerId, { cost: 1, nextHopId: peerId });
        }

        // 経路の撤回: 送信元をネクストホップとしていた経路のみ削除する
        for (const destinationId of withdrawals) {
            if (destinationId === this.localNodeId) continue;
            const current = this.table.getEntry(destinationId);
            if (current && current.nextHopId === peerId) {
                this.table.deleteEntry(destinationId);
                tableChanged = true;
            }
        }

        for (const { destinationId, cost: peerCost } of peerEntries) {
            if (destinationId === this.localNodeId || destinationId === peerId) continue;

            const newCost = peerCost + 1;
            const currentEntry = this.table.getEntry(destinationId);

            if (!currentEntry || newCost < currentEntry.cost) {
                this.table.updateEntry(destinationId, { cost: newCost, nextHopId: peerId });
                tableChanged = true;
            } else if (currentEntry.nextHopId === peerId) {
                // 同一ネクストホップからの更新: コスト変化がなくても lastSeen を更新する（#30）
                this.table.updateEntry(destinationId, { cost: newCost, nextHopId: peerId });
                if (newCost !== currentEntry.cost) {
                    tableChanged = true;
                }
            }
        }

        if (tableChanged) {
            this.broadcastRoutingUpdate();
        }
    }

    // ===============================================
    // 送信
    // ===============================================

    /** 現在のテーブルから送信用の情報を組み立てる（自身のエントリは含めない）。 */
    public createRoutingInfoPacket(withdrawals: NodeId[] = []): RoutingInfoPacket {
        const entries: RoutingInfoPacket['entries'] = [];
        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (destinationId === this.localNodeId) return;
            entries.push({ destinationId, cost: entry.cost });
        });
        return { senderId: this.localNodeId, entries, withdrawals };
    }

    private async sendRoutingUpdate(neighborId: NodeId): Promise<boolean> {
        return this.transport.sendRoutingUpdate(neighborId, this.createRoutingInfoPacket());
    }

    /** 全隣接ノードへ現在のテーブルを送る。 */
    private broadcastRoutingUpdate(withdrawals: NodeId[] = []): void {
        const info = this.createRoutingInfoPacket(withdrawals);
        for (const neighborId of this.transport.getNeighbors()) {
            void this.transport.sendRoutingUpdate(neighborId, info).catch((error) => {
                this.logger.warn(`Failed to send routing update to ${neighborId}:`, error);
            });
        }
    }

    // ===============================================
    // メンテナンス
    // ===============================================

    private runMaintenance(): void {
        this.performAging();
        this.broadcastRoutingUpdate();
    }

    private performAging(): void {
        const now = Date.now();
        const staleEntries: NodeId[] = [];

        this.table.getAllEntries().forEach((entry, destinationId) => {
            if (
                destinationId !== this.localNodeId &&
                entry.cost > 0 &&
                now - entry.lastSeen > this.ageThresholdMs
            ) {
                staleEntries.push(destinationId);
            }
        });

        staleEntries.forEach((id) => this.table.deleteEntry(id));
        if (staleEntries.length > 0) {
            this.logger.debug(`Aged out ${staleEntries.length} stale route(s)`);
            this.broadcastRoutingUpdate(staleEntries);
        }
    }

    private validateRoutingInfo(value: unknown): RoutingInfoPacket | null {
        if (typeof value !== 'object' || value === null) return null;
        const candidate = value as Partial<RoutingInfoPacket>;
        if (typeof candidate.senderId !== 'string' || !Array.isArray(candidate.entries)) {
            return null;
        }

        const entries: RoutingInfoPacket['entries'] = [];
        for (const entry of candidate.entries) {
            if (typeof entry !== 'object' || entry === null) return null;
            const { destinationId, cost } = entry as { destinationId?: unknown; cost?: unknown };
            if (typeof destinationId !== 'string' || typeof cost !== 'number') return null;
            if (!Number.isFinite(cost) || cost < 0) return null;
            entries.push({ destinationId, cost });
        }

        const withdrawals: NodeId[] = [];
        if (candidate.withdrawals !== undefined) {
            if (!Array.isArray(candidate.withdrawals)) return null;
            for (const destinationId of candidate.withdrawals) {
                if (typeof destinationId !== 'string') return null;
                withdrawals.push(destinationId);
            }
        }

        return { senderId: candidate.senderId, entries, withdrawals };
    }
}
