import { WebTCPPacket } from '../types/packet.js';
import { NodeId } from '../types/protocol.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';

/**
 * `SYN` のリプレイ検知（specification.md §11.6.1、#48）。
 *
 * 新しい受動セッションを開く `SYN` のペイロードに、送信時刻と一様乱数の Nonce を載せる。
 * ペイロードは署名対象に含まれるため、リンク層の外で捕獲した `SYN` を後から注入しても、
 * 時刻の窓の外か、受理済みの Nonce として拒否される。
 *
 * 拡張の形式（28 バイト、ビッグエンディアン）:
 *   0  4  magic      `WSN1`
 *   4  8  timestamp  送信時刻（Unix エポックからのミリ秒、uint64）
 *  12 16  nonce      `SYN` ごとの乱数
 */

/** 拡張の magic（ASCII `WSN1`）。 */
export const SYN_EXTENSION_MAGIC = Uint8Array.of(0x57, 0x53, 0x4e, 0x31);
/** 拡張の長さ（バイト）。 */
export const SYN_EXTENSION_BYTES = 28;
const NONCE_BYTES = 16;
const TIMESTAMP_OFFSET = 4;
const NONCE_OFFSET = 12;

/** 既定の許容時計ずれ（ms）。`SessionManager` の既定 session timeout と揃える。 */
export const DEFAULT_SYN_REPLAY_WINDOW_MS = 300_000;
/** 既定の受理済み記録の上限。 */
export const DEFAULT_SYN_REPLAY_MAX_ENTRIES = 4096;

export interface SynReplayGuardOptions {
    /** 許容する時計のずれ（ms）。既定 300 000。 */
    windowMs?: number;
    /** 受理済み `(senderId, nonce)` の上限。既定 4096。満杯は fail-closed で拒否する。 */
    maxEntries?: number;
    /**
     * 拡張を持たない旧実装の `SYN`（空のペイロード）を受理するか。既定 true（相互運用のため）。
     * false にすると、拡張を持つ `SYN` だけを受理する。
     */
    allowLegacySyn?: boolean;
    /** 現在時刻の供給元（テスト用）。既定 `Date.now`。 */
    now?: () => number;
    logger?: Logger;
}

export type SynReplayDecision =
    | { accepted: true; legacy: boolean }
    | { accepted: false; reason: 'legacy-disabled' | 'malformed' | 'stale' | 'replayed' | 'full' };

/** 新しい `SYN` 用の拡張ペイロードを作る（時刻と Nonce は呼び出しごとに新しくする）。 */
export function createSynExtension(now: number = Date.now()): Uint8Array {
    const bytes = new Uint8Array(SYN_EXTENSION_BYTES);
    bytes.set(SYN_EXTENSION_MAGIC, 0);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(TIMESTAMP_OFFSET, BigInt(Math.floor(now)), false);
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    bytes.set(nonce, NONCE_OFFSET);
    return bytes;
}

export class SynReplayGuard {
    private readonly windowMs: number;
    private readonly maxEntries: number;
    private readonly allowLegacySyn: boolean;
    private readonly now: () => number;
    private readonly logger: Logger;

    /** `senderId:nonceHex` → 期限（ms）。期限は `timestamp + windowMs`。 */
    private readonly seen = new Map<string, number>();

    constructor(options: SynReplayGuardOptions = {}) {
        this.windowMs = options.windowMs ?? DEFAULT_SYN_REPLAY_WINDOW_MS;
        this.maxEntries = options.maxEntries ?? DEFAULT_SYN_REPLAY_MAX_ENTRIES;
        this.allowLegacySyn = options.allowLegacySyn ?? true;
        this.now = options.now ?? Date.now;
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'SYN');
    }

    /**
     * 既存セッションに一致しない `SYN` を検査する。受理した場合は Nonce を記録する。
     * 呼び出し側は `accepted: false` のとき、そのパケットを破棄しなければならない。
     */
    public check(packet: WebTCPPacket): SynReplayDecision {
        const payload = packet.payload;
        if (payload.byteLength === 0) {
            if (!this.allowLegacySyn) return this.reject('legacy-disabled', packet);
            return { accepted: true, legacy: true };
        }
        if (payload.byteLength !== SYN_EXTENSION_BYTES || !hasMagic(payload)) {
            return this.reject('malformed', packet);
        }

        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const timestamp = Number(view.getBigUint64(TIMESTAMP_OFFSET, false));
        const now = this.now();
        if (Math.abs(now - timestamp) > this.windowMs) {
            return this.reject('stale', packet);
        }

        this.prune(now);
        const key = `${packet.senderId}:${toHex(payload.subarray(NONCE_OFFSET))}`;
        if (this.seen.has(key)) {
            return this.reject('replayed', packet);
        }
        if (this.seen.size >= this.maxEntries) {
            return this.reject('full', packet);
        }
        this.seen.set(key, timestamp + this.windowMs);
        return { accepted: true, legacy: false };
    }

    /** 記録の数（テスト・監視用）。 */
    public get size(): number {
        return this.seen.size;
    }

    private prune(now: number): void {
        for (const [key, expiresAt] of this.seen) {
            if (expiresAt < now) this.seen.delete(key);
        }
    }

    private reject(
        reason: 'legacy-disabled' | 'malformed' | 'stale' | 'replayed' | 'full',
        packet: WebTCPPacket,
    ): SynReplayDecision {
        this.logger.warn(
            `Dropped SYN from ${packet.senderId as NodeId} (${reason}); possible replay or invalid SYN.`,
        );
        return { accepted: false, reason };
    }
}

function hasMagic(payload: Uint8Array): boolean {
    for (let i = 0; i < SYN_EXTENSION_MAGIC.length; i += 1) {
        if (payload[i] !== SYN_EXTENSION_MAGIC[i]) return false;
    }
    return true;
}

function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
    return out;
}
