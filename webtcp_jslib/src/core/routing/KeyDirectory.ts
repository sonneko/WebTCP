import { NodeId } from '../types/protocol.js';
import { IPublicKeyResolver } from './PacketVerifier.js';
import {
    ED25519_PUBLIC_KEY_BYTES,
    decodePublicKey,
    encodePublicKey,
    nodeIdMatchesPublicKey,
    NodeIdCollisionError,
    isValidNodeId,
} from './keys.js';
import type { Logger } from '../util/Logger.js';

/**
 * ノード ID → Ed25519 公開鍵 のディレクトリ（#28, specification.md §10.4）。
 *
 * 公開鍵の配布チャネルは 2 つある。
 * 1. **シグナリング時の交換**: `SendPublicKeyPayload` を `SignalMessage` で送受信する
 *    （`SignalingAdapterHub` / `WebRTCChannel` が自動で行う）
 * 2. **ルーティング更新への同梱**: `RT_UPDATE` の `publicKey` フィールド
 *    （マルチホップの中継ノードへ伝播させるため）
 *
 * どちらの経路でも登録時に **指紋の一致（`nodeId == deriveNodeId(publicKey)`）を検証** するため、
 * 悪意あるノードが他人の NodeId の公開鍵を出し抜くことはできない。
 *
 * 未知のノードの鍵が登録されたときは `'key-added'` イベントを発火する。
 * `Ed25519PacketVerifier` はこれを待って検証を再試行する。
 */
export class KeyDirectory implements IPublicKeyResolver {
    private readonly keys = new Map<NodeId, Uint8Array>();
    private readonly waiters = new Map<NodeId, Set<(key: Uint8Array) => void>>();
    private readonly pending = new Map<string, Promise<Uint8Array | null>>();
    private readonly logger: Logger | null;
    private readonly verifyFingerprint: (
        nodeId: NodeId,
        key: Uint8Array,
    ) => Promise<boolean>;

    /**
     * @param options.verifyFingerprint 指紋照合関数（既定は Web Crypto による SHA-256）
     * @param options.logger ロガー（任意）
     */
    constructor(
        options: {
            logger?: Logger;
            verifyFingerprint?: (nodeId: NodeId, key: Uint8Array) => Promise<boolean>;
        } = {},
    ) {
        this.logger = options.logger ?? null;
        this.verifyFingerprint =
            options.verifyFingerprint ??
            ((nodeId, key) => nodeIdMatchesPublicKey(nodeId, key));
    }

    /** 登録済みの公開鍵を返す（同期）。未登録なら `undefined`。 */
    public get(nodeId: NodeId): Uint8Array | undefined {
        return this.keys.get(nodeId);
    }

    /** 登録済みノード数。 */
    public get size(): number {
        return this.keys.size;
    }

    /** `IPublicKeyResolver` 実装。 */
    public async getPublicKey(nodeId: NodeId): Promise<Uint8Array | null> {
        return this.keys.get(nodeId) ?? null;
    }

    /**
     * 公開鍵を登録する。指紋が `nodeId` と一致しない場合は登録せず `false` を返す。
     *
     * 同じノードの鍵が既に登録済みで、内容が同一なら `true`（冪等）。
     * 内容が異なる場合は既存の信頼済み鍵を保持して `false` を返す。
     */
    public async addPublicKey(nodeId: NodeId, publicKey: Uint8Array | string): Promise<boolean> {
        const key =
            typeof publicKey === 'string' ? decodePublicKey(publicKey) : publicKey;
        if (!key || key.byteLength !== ED25519_PUBLIC_KEY_BYTES) return false;
        if (!(await this.verifyFingerprint(nodeId, key))) {
            this.logger?.warn(`Rejected public key for ${nodeId}: fingerprint mismatch`);
            return false;
        }

        const existing = this.keys.get(nodeId);
        if (existing) {
            if (bytesEqual(existing, key)) return true;
            this.logger?.warn(`Ignored conflicting public key for ${nodeId}`);
            return false;
        }

        this.keys.set(nodeId, key);
        this.notify(nodeId, key);
        return true;
    }

    /**
     * 非同期検証を挟まずに登録する（指紋検証済みの鍵を渡す場合のみ）。
     * 既存鍵と異なる場合は NodeIdCollisionError（M4 / #36）。
     */
    public setPublicKey(nodeId: NodeId, publicKey: Uint8Array): void {
        if (!isValidNodeId(nodeId) || publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
            throw new Error('setPublicKey requires a valid NodeId and a 32-byte public key');
        }
        const existing = this.keys.get(nodeId);
        if (existing) {
            if (bytesEqual(existing, publicKey)) return;
            throw new NodeIdCollisionError(nodeId, existing, publicKey);
        }
        this.keys.set(nodeId, publicKey);
        this.notify(nodeId, publicKey);
    }

    /** 登録を削除する（鍵のローテーション・テスト用）。 */
    public delete(nodeId: NodeId): boolean {
        return this.keys.delete(nodeId);
    }

    /** 全登録を消去する。 */
    public clear(): void {
        this.keys.clear();
    }

    /** 登録済みのノード ID 一覧。 */
    public nodeIds(): NodeId[] {
        return [...this.keys.keys()];
    }

    /**
     * 公開鍵の到着を待つ。既に登録済みなら即座に返す。
     * `timeoutMs`（既定 5000）経過で `null`。
     */
    public waitForPublicKey(
        nodeId: NodeId,
        timeoutMs = 5000,
    ): Promise<Uint8Array | null> {
        const existing = this.keys.get(nodeId);
        if (existing) return Promise.resolve(existing);
        if (timeoutMs <= 0) return Promise.resolve(null);

        const pendingKey = `${nodeId}:${timeoutMs}`;
        const inFlight = this.pending.get(pendingKey);
        if (inFlight) return inFlight;

        const promise = new Promise<Uint8Array | null>((resolve) => {
            const cleanup = (): void => {
                clearTimeout(timer);
                this.waiters.get(nodeId)?.delete(onKey);
                if (this.waiters.get(nodeId)?.size === 0) this.waiters.delete(nodeId);
                this.pending.delete(pendingKey);
            };
            const onKey = (key: Uint8Array): void => {
                cleanup();
                resolve(key);
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeoutMs);

            const set = this.waiters.get(nodeId) ?? new Set();
            set.add(onKey);
            this.waiters.set(nodeId, set);
        });

        this.pending.set(pendingKey, promise);
        return promise;
    }

    /**
     * `RT_UPDATE` ペイロードなどの JSON オブジェクトから公開鍵を取り込み、
     * 指紋照合に成功したら登録する。
     */
    public async ingestFromRoutingInfo(
        nodeId: NodeId,
        publicKey: unknown,
    ): Promise<boolean> {
        const key = decodePublicKey(publicKey);
        if (!key) return false;
        return this.addPublicKey(nodeId, key);
    }

    /** 登録済みの公開鍵を Base64url で返す（デバッグ用）。 */
    public exportPublicKey(nodeId: NodeId): string | null {
        const key = this.keys.get(nodeId);
        return key ? encodePublicKey(key) : null;
    }

    private notify(nodeId: NodeId, key: Uint8Array): void {
        const set = this.waiters.get(nodeId);
        if (!set) return;
        for (const waiter of [...set]) {
            try {
                waiter(key);
            } catch {
                // 待機側の例外は無視する
            }
        }
        this.waiters.delete(nodeId);
    }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
