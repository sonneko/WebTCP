/**
 * 台帳アンカーとチェックポイント（specification.md §14.3）。
 *
 * 台帳（registry / transparency log）は受領したレコードの commitment を追記専用の
 * Merkle 木へ積上げ、`{ logId, treeSize, root, prevHash, timestamp }` をログ鍵で署名した
 * チェックポイントを発行する。受信側は
 *
 * 1. 包含証明（Merkle path）がルートに到達すること、
 * 2. チェックポイント署名が**設定済みのログ鍵**で検証できること、
 * 3. `treeSize` が記憶済みから後退していないこと、
 * 4. 必要なら `prevHash` 連鎖を追跡できること、
 *
 * を確認する。これにより「台帳が過去を書換えた」ことを PIN 以降で検出できる。
 */

import { rejectUnknownKeys } from './internal.js';
import {
    bytesToHex,
    decodeBase64Url,
    decodePublicKey,
    encodeBase64Url,
} from '../routing/keys.js';
import type { Ed25519KeyManager } from '../routing/keys.js';
import type { Logger } from '../util/Logger.js';
import { defaultDomainHash, verifyDomainEd25519, type DomainHashFn } from './crypto.js';
import { DomainRecordError } from './errors.js';

/** チェックポイントの本文（署名対象）。 */
export interface DomainCheckpoint {
    /** ログの識別子。既定はログ鍵の NodeId（公開鍵指紋）。 */
    logId: string;
    /** 葉数（1 以上）。 */
    treeSize: number;
    /** Base64url の Merkle ルート（32 バイト）。 */
    root: string;
    /** 直前チェックポイントの canonical バイト列の SHA-256（hex）。genesis は 32 バイトの 0。 */
    prevHash: string;
    /** 発行時刻（epoch ms）。 */
    timestamp: number;
}

/** 署名済みチェックポイント。 */
export interface SignedDomainCheckpoint extends DomainCheckpoint {
    /** `canonicalDomainCheckpointBytes` に対する Ed25519 署名（Base64url、64 バイト）。 */
    signature: string;
}

/** 実チェーンへの追加コミットメント（検証は `IChainAnchorVerifier` が担う、§14.4.2）。 */
export interface DomainAnchorChainRef {
    network: string;
    txId?: string;
    blockHeight?: number;
    commitment?: string;
}

/** 台帳アンカー（§14.3）。 */
export interface DomainAnchor {
    /** 0 起始の葉番号。 */
    leafIndex: number;
    /** 包含証明（兄弟ノードの Base64url SHA-256、葉から根へ）。 */
    proof: string[];
    /** ログ鍵によって署名されたチェックポイント。 */
    checkpoint: SignedDomainCheckpoint;
    /** 任意: 実チェーンへの追加コミットメント。 */
    chain?: DomainAnchorChainRef;
}

/** genesis の `prevHash`（32 バイトの 0）。 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** 未来時刻チェックの既定許容幅（ログと検証側の時計ずれ、§12.3）。 */
export const DEFAULT_CHECKPOINT_CLOCK_SKEW_MS = 300_000;

/** チェックポイント本文の上限（暴走防止）。 */
export const MAX_DOMAIN_TREE_SIZE = 65_536;

const encoder = new TextEncoder();

/** チェックポイントの canonical バイト列（固定キー順・空白なし JSON）。 */
export function canonicalDomainCheckpointBytes(checkpoint: DomainCheckpoint): Uint8Array {
    return encoder.encode(
        `{"logId":${JSON.stringify(checkpoint.logId)}` +
            `,"treeSize":${checkpoint.treeSize}` +
            `,"root":${JSON.stringify(checkpoint.root)}` +
            `,"prevHash":${JSON.stringify(checkpoint.prevHash)}` +
            `,"timestamp":${checkpoint.timestamp}}`,
    );
}

/** チェックポイントのハッシュ（次チェックポイントの `prevHash`、hex SHA-256）。 */
export async function domainCheckpointHash(
    checkpoint: DomainCheckpoint,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<string> {
    return bytesToHex(await hashFn(canonicalDomainCheckpointBytes(checkpoint)));
}

function assertIntegerRange(
    value: unknown,
    name: string,
    min: number,
    max: number,
): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new DomainRecordError(`${name} must be an integer in ${min}..${max}`, name);
    }
    return value;
}

/** チェックポイント本文（署名除く）の構造検証。 */
export function normalizeDomainCheckpoint(value: unknown): DomainCheckpoint {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainRecordError('checkpoint must be an object', 'checkpoint');
    }
    const raw = value as Record<string, unknown>;
    rejectUnknownKeys(
        raw,
        ['logId', 'treeSize', 'root', 'prevHash', 'timestamp', 'signature'],
        'checkpoint',
    );
    if (typeof raw.logId !== 'string' || raw.logId.length === 0 || raw.logId.length > 128) {
        throw new DomainRecordError('checkpoint.logId must be a non-empty string (<=128 chars)', 'logId');
    }
    const treeSize = assertIntegerRange(raw.treeSize, 'checkpoint.treeSize', 1, MAX_DOMAIN_TREE_SIZE);
    if (typeof raw.root !== 'string' || !decodeBase64Url(raw.root)) {
        throw new DomainRecordError('checkpoint.root must be Base64url bytes', 'root');
    }
    if (typeof raw.prevHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.prevHash)) {
        throw new DomainRecordError('checkpoint.prevHash must be 32 bytes of lowercase hex', 'prevHash');
    }
    const timestamp = assertIntegerRange(raw.timestamp, 'checkpoint.timestamp', 0, Number.MAX_SAFE_INTEGER);
    return {
        logId: raw.logId,
        treeSize,
        root: raw.root,
        prevHash: raw.prevHash,
        timestamp,
    };
}

/** 署名済みチェックポイントの構造検証（未知キー拒否）。 */
export function parseDomainCheckpoint(value: unknown): SignedDomainCheckpoint {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainRecordError('checkpoint must be an object', 'checkpoint');
    }
    const body = normalizeDomainCheckpoint(value);
    const signature = (value as Record<string, unknown>).signature;
    if (typeof signature !== 'string') {
        throw new DomainRecordError('checkpoint.signature must be a Base64url string', 'signature');
    }
    const decoded = decodeBase64Url(signature);
    if (!decoded || decoded.byteLength !== 64) {
        throw new DomainRecordError(
            'checkpoint.signature must decode to a 64-byte Ed25519 signature',
            'signature',
        );
    }
    return { ...body, signature };
}

/** 台帳アンカーの構造検証（未知キー拒否）。 */
export function parseDomainAnchor(value: unknown): DomainAnchor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainRecordError('anchor must be an object', 'anchor');
    }
    const raw = value as Record<string, unknown>;
    rejectUnknownKeys(raw, ['leafIndex', 'proof', 'checkpoint', 'chain'], 'anchor');
    const leafIndex = assertIntegerRange(raw.leafIndex, 'anchor.leafIndex', 0, MAX_DOMAIN_TREE_SIZE - 1);
    if (!Array.isArray(raw.proof) || raw.proof.length > 32) {
        throw new DomainRecordError('anchor.proof must be an array of at most 32 entries', 'proof');
    }
    const proof: string[] = [];
    for (const entry of raw.proof) {
        if (typeof entry !== 'string' || !decodeBase64Url(entry)) {
            throw new DomainRecordError('anchor.proof entries must be Base64url bytes', 'proof');
        }
        proof.push(entry);
    }
    const anchor: DomainAnchor = {
        leafIndex,
        proof,
        checkpoint: parseDomainCheckpoint(raw.checkpoint),
    };
    if (raw.chain !== undefined) {
        if (typeof raw.chain !== 'object' || raw.chain === null) {
            throw new DomainRecordError('anchor.chain must be an object', 'chain');
        }
        const chain = raw.chain as Record<string, unknown>;
        rejectUnknownKeys(chain, ['network', 'txId', 'blockHeight', 'commitment'], 'anchor.chain');
        if (
            typeof chain.network !== 'string' ||
            chain.network.length === 0 ||
            chain.network.length > 64
        ) {
            throw new DomainRecordError(
                'anchor.chain.network must be a non-empty string (<=64 chars)',
                'network',
            );
        }
        const ref: DomainAnchorChainRef = { network: chain.network };
        for (const key of ['txId', 'commitment'] as const) {
            const entry = chain[key];
            if (entry !== undefined) {
                if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) {
                    throw new DomainRecordError(
                        `anchor.chain.${key} must be a string (<=256 chars)`,
                        key,
                    );
                }
                ref[key] = entry;
            }
        }
        if (chain.blockHeight !== undefined) {
            ref.blockHeight = assertIntegerRange(
                chain.blockHeight,
                'anchor.chain.blockHeight',
                0,
                Number.MAX_SAFE_INTEGER,
            );
        }
        anchor.chain = ref;
    }
    return anchor;
}

/** ログ鍵でチェックポイントを署名する（台帳側）。 */
export async function signDomainCheckpoint(
    checkpoint: DomainCheckpoint,
    keyManager: Ed25519KeyManager,
): Promise<SignedDomainCheckpoint> {
    const body = normalizeDomainCheckpoint(checkpoint);
    const signature = await keyManager.sign(canonicalDomainCheckpointBytes(body));
    if (signature.byteLength !== 64) {
        throw new DomainRecordError('keyManager.sign() must return a 64-byte Ed25519 signature', 'signature');
    }
    return { ...body, signature: encodeBase64Url(signature) };
}

export interface VerifyDomainCheckpointOptions {
    /** 信任するログ鍵（`logId` -> 公開鍵 Base64url or bytes）。設定済みの鍵のみ受け付ける。 */
    logKeys?: Record<string, string | Uint8Array>;
    /** 遅延解決（`KeyDirectory` を使う場合など）。`logKeys` で見つからなければ呼ばれる。 */
    resolveLogKey?: (
        logId: string,
    ) => Promise<Uint8Array | string | null> | Uint8Array | string | null;
    /** チェックポイントの最大経過（ms）。既定は無制限。 */
    maxAgeMs?: number;
    /** 未来時刻の許容幅（ms、既定 300 000）。これを超える `timestamp` は拒否する。 */
    clockSkewMs?: number;
    /** 現在時刻（テスト用）。 */
    nowMs?: number;
    logger?: Logger;
}

/** チェックポイント署名の検証結果。 */
export interface DomainCheckpointVerifyResult {
    ok: boolean;
    code: 'ok' | 'anchor-untrusted-log' | 'anchor-bad-checkpoint';
    message?: string;
}

/**
 * 署名済みチェックポイントを検証する（specification.md §14.3 / §14.4.1 の 7）。
 *
 * ログ鍵が設定されていない場合は `anchor-untrusted-log`（fail-closed）。
 */
export async function verifyDomainCheckpoint(
    checkpoint: SignedDomainCheckpoint,
    options: VerifyDomainCheckpointOptions = {},
): Promise<DomainCheckpointVerifyResult> {
    let parsed: SignedDomainCheckpoint;
    try {
        parsed = parseDomainCheckpoint(checkpoint);
    } catch (error) {
        return {
            ok: false,
            code: 'anchor-bad-checkpoint',
            message: error instanceof Error ? error.message : 'invalid checkpoint',
        };
    }
    let publicKey: Uint8Array | null = null;
    const configured = options.logKeys?.[parsed.logId];
    if (typeof configured === 'string') publicKey = decodePublicKey(configured);
    else if (configured instanceof Uint8Array) publicKey = configured;
    if (!publicKey && options.resolveLogKey) {
        const resolved = await options.resolveLogKey(parsed.logId);
        if (typeof resolved === 'string') publicKey = decodePublicKey(resolved);
        else if (resolved instanceof Uint8Array) publicKey = resolved;
    }
    if (!publicKey) {
        return {
            ok: false,
            code: 'anchor-untrusted-log',
            message: `no trusted log key is configured for log "${parsed.logId}"`,
        };
    }
    const now = options.nowMs ?? Date.now();
    const clockSkewMs = options.clockSkewMs ?? DEFAULT_CHECKPOINT_CLOCK_SKEW_MS;
    if (parsed.timestamp > now + clockSkewMs) {
        return {
            ok: false,
            code: 'anchor-bad-checkpoint',
            message: `checkpoint timestamp ${parsed.timestamp} is in the future (now ${now})`,
        };
    }
    if (options.maxAgeMs !== undefined && now - parsed.timestamp > options.maxAgeMs) {
        return {
            ok: false,
            code: 'anchor-bad-checkpoint',
            message: 'checkpoint is older than maxAgeMs',
        };
    }
    const signature = decodeBase64Url(parsed.signature) as Uint8Array;
    const ok = await verifyDomainEd25519(publicKey, canonicalDomainCheckpointBytes(parsed), signature);
    return ok
        ? { ok: true, code: 'ok' }
        : { ok: false, code: 'anchor-bad-checkpoint', message: 'checkpoint signature does not verify' };
}

/** `treeSize` が記憶済みから後退していないか（ロールバック検出）。 */
export function checkpointRollsBack(
    pinned: Pick<DomainCheckpoint, 'treeSize'>,
    candidate: Pick<DomainCheckpoint, 'treeSize'>,
): boolean {
    return candidate.treeSize < pinned.treeSize;
}

export interface VerifyCheckpointChainParams {
    /** クライアントが PIN 済みのチェックポイント。 */
    pinned: SignedDomainCheckpoint;
    /** 検証したいチェックポイント。 */
    target: SignedDomainCheckpoint;
    /** `pinned` と `target` の間（両端を含まない）のチェックポイント。 */
    between?: readonly SignedDomainCheckpoint[];
    hashFn?: DomainHashFn;
}

export interface DomainCheckpointChainResult {
    ok: boolean;
    code: 'ok' | 'unavailable' | 'anchor-rollback' | 'anchor-bad-checkpoint';
    message?: string;
}

/**
 * `pinned` -> `target` の `prevHash` 連鎖を検証する（specification.md §14.3）。
 *
 * 区間を提供できない台帳に対しては `unavailable` を返す（呼び出し側が拒否可否を決める）。
 */
export async function verifyDomainCheckpointChain(
    params: VerifyCheckpointChainParams,
): Promise<DomainCheckpointChainResult> {
    const hashFn = params.hashFn ?? defaultDomainHash;
    const { pinned, target } = params;
    if (pinned.logId !== target.logId) {
        return { ok: false, code: 'anchor-bad-checkpoint', message: 'checkpoint logId mismatch' };
    }
    if (target.treeSize < pinned.treeSize) {
        return { ok: false, code: 'anchor-rollback', message: 'checkpoint treeSize went backwards' };
    }
    if (target.treeSize === pinned.treeSize) {
        if (target.root !== pinned.root || target.prevHash !== pinned.prevHash) {
            return {
                ok: false,
                code: 'anchor-rollback',
                message: 'checkpoint fork: the same treeSize carries a different root',
            };
        }
        return { ok: true, code: 'ok' };
    }
    const between = [...(params.between ?? [])].sort((a, b) => a.treeSize - b.treeSize);
    // 隣接チェックポイント（`target.treeSize === pinned.treeSize + 1`）は区間不要で検証できる。
    const adjacent = target.treeSize === pinned.treeSize + 1;
    if (between.length === 0 && !adjacent) {
        return {
            ok: false,
            code: 'unavailable',
            message: 'the ledger did not provide the checkpoint range to verify',
        };
    }
    const chain = [pinned, ...between, target];
    for (let i = 1; i < chain.length; i += 1) {
        const prev = chain[i - 1] as SignedDomainCheckpoint;
        const current = chain[i] as SignedDomainCheckpoint;
        if (current.treeSize <= prev.treeSize) {
            return {
                ok: false,
                code: 'anchor-rollback',
                message: `checkpoint ${current.treeSize} does not extend ${prev.treeSize}`,
            };
        }
        const expected = await domainCheckpointHash(prev, hashFn);
        if (current.prevHash !== expected) {
            return {
                ok: false,
                code: 'anchor-rollback',
                message: `checkpoint ${current.treeSize} prevHash does not match the previous checkpoint`,
            };
        }
    }
    return { ok: true, code: 'ok' };
}
