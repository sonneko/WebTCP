import { NodeId } from '../types/protocol.js';
import { isValidNodeId } from './keys.js';
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
        /** 任意: 宛先の Ed25519 公開鍵（Base64url）。指紋照合して伝播する（M4 / #37）。 */
        publicKey?: string;
    }[];
    /** 到達不能になった宛先（経路の撤回）。 */
    withdrawals?: NodeId[];
    /**
     * 送信元の Ed25519 公開鍵（Base64url、任意）。
     * プロトコル v2 では RT_UPDATE に同梱して全隣接へ配布する（specification.md §11.4.2）。
     */
    publicKey?: string;
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
    /** 既知の公開鍵を Base64url で返す（entries への同梱用、任意）。 */
    getPublicKeyBase64Url?(nodeId: NodeId): string | null;
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
    /**
     * RT_UPDATE に同梱された公開鍵（Base64url）を受け取るフック（#28）。
     * `RoutingLayer` が公開鍵ディレクトリへ登録するために設定する。
     */
    public onPublicKey:
        | ((senderId: NodeId, publicKeyBase64Url: string) => void)
        | null = null;
    /** entries[].publicKey で広告された鍵を受け取るフック（M4 / #37）。 */
    public onAdvertisedPublicKey:
        | ((nodeId: NodeId, publicKeyBase64Url: string) => void)
        | null = null;

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
        // 新しい隣接へ自身のテーブル（公開鍵つき）を送り、
        // 既存の隣接にも新しい経路を通知する
        void this.sendRoutingUpdate(peerId).catch((error) => {
            this.logger.warn(`Failed to send initial routing update to ${peerId}:`, error);
        });
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
        if (!info || info.senderId !== senderId) {
            this.logger.warn(`Dropping RT_UPDATE from ${senderId}: invalid structure or sender mismatch`);
            return;
        }

        // 同梱された公開鍵を配布する（§11.4.2）。指紋照合は受け取り側で行う。
        if (info.publicKey) {
            this.onPublicKey?.(senderId, info.publicKey);
        }
        for (const entry of info.entries) {
            if (entry.publicKey) this.onAdvertisedPublicKey?.(entry.destinationId, entry.publicKey);
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
            const advertised = this.transport.getPublicKeyBase64Url?.(destinationId);
            entries.push(advertised ? { destinationId, cost: entry.cost, publicKey: advertised } : { destinationId, cost: entry.cost });
        });
        return { senderId: this.localNodeId, entries, withdrawals };
    }

    /** 仕様 §7.4 の上限（entries / withdrawals 各 256 件）に収まるよう分割する。 */
    public splitRoutingInfo(info: RoutingInfoPacket): RoutingInfoPacket[] {
        const chunks: RoutingInfoPacket[] = [];
        const withdrawals = info.withdrawals ?? [];
        for (let i = 0; i < withdrawals.length; i += 256) {
            chunks.push({ senderId: info.senderId, entries: [], withdrawals: withdrawals.slice(i, i + 256) });
        }
        for (let i = 0; i < info.entries.length; i += 256) {
            chunks.push({ senderId: info.senderId, entries: info.entries.slice(i, i + 256), withdrawals: [] });
        }
        if (chunks.length === 0) chunks.push({ senderId: info.senderId, entries: [], withdrawals: [] });
        return chunks;
    }

    private async sendRoutingUpdate(neighborId: NodeId): Promise<boolean> {
        let allSent = true;
        for (const chunk of this.splitRoutingInfo(this.createRoutingInfoPacket())) {
            const sent = await this.transport.sendRoutingUpdate(neighborId, chunk);
            allSent = allSent && sent;
        }
        return allSent;
    }

    /**
     * 現在のテーブル（公開鍵つき）を全隣接へ即座に送る。
     * テストや、公開鍵の即時配布のために公開している。
     */
    public announce(): void {
        this.broadcastRoutingUpdate();
    }

    /** 全隣接ノードへ現在のテーブルを送る。 */
    private broadcastRoutingUpdate(withdrawals: NodeId[] = []): void {
        const chunks = this.splitRoutingInfo(this.createRoutingInfoPacket(withdrawals));
        for (const neighborId of this.transport.getNeighbors()) {
            for (const info of chunks) {
                void this.transport.sendRoutingUpdate(neighborId, info).catch((error) => {
                    this.logger.warn(`Failed to send routing update to ${neighborId}:`, error);
                });
            }
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
        if (typeof candidate.senderId !== 'string' || !isValidNodeId(candidate.senderId) || !Array.isArray(candidate.entries)) {
            return null;
        }

        const entries: RoutingInfoPacket['entries'] = [];
        if (candidate.entries.length > 256) return null;
        for (const entry of candidate.entries) {
            if (typeof entry !== 'object' || entry === null) return null;
            const { destinationId, cost, publicKey } = entry as { destinationId?: unknown; cost?: unknown; publicKey?: unknown };
            if (typeof destinationId !== 'string' || !isValidNodeId(destinationId) || typeof cost !== 'number') return null;
            if (!Number.isInteger(cost) || cost < 0 || cost > 255) return null;
            if (publicKey !== undefined && typeof publicKey !== 'string') return null;
            entries.push(publicKey === undefined ? { destinationId, cost } : { destinationId, cost, publicKey });
        }

        let publicKey: string | undefined;
        if (candidate.publicKey !== undefined) {
            if (typeof candidate.publicKey !== 'string') return null;
            publicKey = candidate.publicKey;
        }

        const withdrawals: NodeId[] = [];
        if (candidate.withdrawals !== undefined) {
            if (!Array.isArray(candidate.withdrawals) || candidate.withdrawals.length > 256) return null;
            for (const destinationId of candidate.withdrawals) {
                if (typeof destinationId !== 'string' || !isValidNodeId(destinationId)) return null;
                withdrawals.push(destinationId);
            }
        }

        return publicKey === undefined
            ? { senderId: candidate.senderId, entries, withdrawals }
            : { senderId: candidate.senderId, entries, withdrawals, publicKey };
    }
}
