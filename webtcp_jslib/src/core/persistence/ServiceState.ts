/**
 * サービス役の状態の永続化（#51 / specification.md §9）。
 *
 * ブラウザのタブが停止・リロードされても、サービス役（待ち受けポート、
 * ローカル登録の A / CNAME、`domain.global` の所有権レコード）を失わないように、
 * 復元に必要な最小限の状態だけを JSON として保存する。
 *
 * - 秘密鍵は含めない（鍵は `BrowserKeyManager` が別途 IndexedDB に保存する）。
 * - 接続（WebRTC・仮想ストリーム）は保存しない。復元後に再接続する（§9.4）。
 */
import type { NodeId, VirtualPort } from '../types/protocol.js';
import { isValidNodeId } from '../routing/keys.js';

export const SERVICE_STATE_VERSION = 1;

/**
 * 保存する隣接先の上限（M9 項目 30）。復元後に再接続する対象のみを保存し、状態を肥大化させない。
 */
export const MAX_SAVED_NEIGHBORS = 16;

export interface PersistedNameRecord {
    type: 'A' | 'CNAME';
    name: string;
    /** A の場合は NodeId、CNAME の場合は正規化済みの名前。 */
    target: string;
    ttlMs: number;
}

export interface PersistedServiceState {
    /** 状態フォーマットのバージョン。 */
    version: typeof SERVICE_STATE_VERSION;
    /** 保存時刻（Unix ms）。 */
    savedAt: number;
    /** 保存時点で待ち受けていた仮想ポート。 */
    listenPorts: VirtualPort[];
    /** `domain.global` 外のローカル登録（A / CNAME）。 */
    names: PersistedNameRecord[];
    /** `domain.global` の所有権レコード（`domainRecordToJSON` の結果）。 */
    domainRecords: Record<string, unknown>[];
    /** 保存元ノードの NodeId（復元時の取り違え検出用、任意）。 */
    nodeId?: NodeId;
    /**
     * 保存時点の隣接先の NodeId（任意。M9 項目 30）。復元後の `reconnectNeighbors()` で再接続する。
     * 鍵・アドレス・時刻は含めない。省略された古い状態は空として扱う。
     */
    neighbors?: NodeId[];
}

/** 状態の保存先。IndexedDB 実装は `adapters/persistence` にある。 */
export interface ServiceStateStorage {
    load(): Promise<PersistedServiceState | null>;
    save(state: PersistedServiceState): Promise<void>;
    clear(): Promise<void>;
}

/** テスト・非ブラウザ環境向けのメモリ実装。 */
export class MemoryServiceStateStorage implements ServiceStateStorage {
    private state: PersistedServiceState | null = null;

    public async load(): Promise<PersistedServiceState | null> {
        return this.state ? structuredClone(this.state) : null;
    }

    public async save(state: PersistedServiceState): Promise<void> {
        this.state = structuredClone(state);
    }

    public async clear(): Promise<void> {
        this.state = null;
    }
}

/** 読み込んだ値が保存フォーマットとして妥当かを検査する（不正なら `null`）。 */
export function parsePersistedServiceState(value: unknown): PersistedServiceState | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<PersistedServiceState>;
    if (v.version !== SERVICE_STATE_VERSION) return null;
    if (!Array.isArray(v.listenPorts) || !Array.isArray(v.names) || !Array.isArray(v.domainRecords)) {
        return null;
    }
    if (!v.listenPorts.every((p) => Number.isInteger(p) && p >= 0 && p <= 65535)) return null;
    if (v.neighbors !== undefined) {
        if (!Array.isArray(v.neighbors) || !v.neighbors.every((id) => isValidNodeId(id))) return null;
        if (v.neighbors.length > MAX_SAVED_NEIGHBORS) return null;
    }
    for (const n of v.names) {
        if (!n || (n.type !== 'A' && n.type !== 'CNAME')) return null;
        if (typeof n.name !== 'string' || typeof n.target !== 'string') return null;
        if (typeof n.ttlMs !== 'number' || !(n.ttlMs > 0)) return null;
    }
    return {
        version: SERVICE_STATE_VERSION,
        savedAt: typeof v.savedAt === 'number' ? v.savedAt : 0,
        listenPorts: v.listenPorts,
        names: v.names,
        domainRecords: v.domainRecords as Record<string, unknown>[],
        ...(typeof v.nodeId === 'string' ? { nodeId: v.nodeId } : {}),
        ...(v.neighbors !== undefined ? { neighbors: [...new Set(v.neighbors)] } : {}),
    };
}
