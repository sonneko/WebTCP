/**
 * ドメイン所有権の検証（specification.md §13.4）。
 *
 * 既定実装 `createDomainOwnershipVerifier()` は **fail-closed** である:
 * 構造・指紋・署名・有効期間・（要求時は）台帳アンカーのうち 1 つでも検証できなければ
 * 失敗を返す。例外は投げず、常に `DomainVerifyResult` を返す。
 */

import {
    decodeBase64Url,
    decodePublicKey,
    deriveNodeId,
} from '../routing/keys.js';
import type { Logger } from '../util/Logger.js';
import {
    MAX_DOMAIN_RECORD_LIFETIME_MS,
    canonicalDomainRecordBodyBytes,
    commitDomainRecord,
    parseDomainRecordBody,
    type DomainOwnershipRecord,
} from './record.js';
import {
    checkpointRollsBack,
    domainCheckpointHash,
    parseDomainAnchor,
    verifyDomainCheckpoint,
    verifyDomainCheckpointChain,
    type DomainAnchor,
    type DomainAnchorChainRef,
    type SignedDomainCheckpoint,
} from './checkpoint.js';
import { defaultDomainHash, verifyDomainEd25519, type DomainHashFn } from './crypto.js';
import { verifyDomainMerkleProof } from './merkle.js';
import { isDomainGlobalName, normalizeDomainName } from './names.js';
import { DomainProofCode } from './errors.js';

/** 検証結果コードは `./errors.js` が単一の定義源（specification.md §13.4.1）。 */
export type { DomainProofCode } from './errors.js';

/** 検証結果。 */
export interface DomainVerifyResult {
    ok: boolean;
    code: DomainProofCode;
    message?: string;
    /** 台帳アンカー（Merkle + チェックポイント署名）まで検証できたか。 */
    anchorVerified?: boolean;
    /** 実チェーン検証の結果。`null` は検証手段が無かったこと（未確認）。 */
    chainVerified?: boolean | null;
    /** 検証に供した commitment（hex SHA-256）。 */
    commitment?: string;
}

/** チェックポイント連鎖の検証に使うデータ源（任意実装）。 */
export interface DomainCheckpointSource {
    checkpointsBetween?(params: {
        logId: string;
        afterTreeSize: number;
        toTreeSize: number;
    }): Promise<SignedDomainCheckpoint[]>;
}

export interface DomainVerifyContext {
    /** 現在時刻（既定は `Date.now()`）。 */
    nowMs?: number;
    /** 解決中の名前。指定時はレコードの `domain` と一致しなければならない。 */
    expectedDomain?: string;
    /** 既に受理した最大の `serial`。これ未満のレコードは `stale-serial`。 */
    knownSerial?: number;
    /** 時刻ずれの猶予（既定は検証器設定）。 */
    clockSkewMs?: number;
    /** 検証済みチェックポイントを記憶しておく器（ロールバック検出）。 */
    pinnedCheckpoint?: SignedDomainCheckpoint;
    /** チェックポイント連鎖の追跡に使うデータ源。 */
    checkpointChain?: DomainCheckpointSource;
}

/** 所有権検証器のインターフェース（specification.md §13.4.1）。 */
export interface IDomainOwnershipVerifier {
    readonly name?: string;
    verify(
        record: DomainOwnershipRecord,
        context?: DomainVerifyContext,
    ): Promise<DomainVerifyResult>;
}

/** 実チェーン検証への差し替え点（specification.md §13.4.2、参照実装は #42）。 */
export interface IChainAnchorVerifier {
    readonly name?: string;
    verify(input: {
        commitment: string;
        checkpointHash: string;
        chain: DomainAnchorChainRef;
    }): Promise<{ verified: boolean; finality?: number; detail?: string }>;
}

export interface DomainOwnershipVerifierOptions {
    /** アンカー（台帳証明）を必須化する（既定 `false`）。 */
    requireAnchor?: boolean;
    /** `anchor.chain` の実チェーン検証を必須化する（既定 `false`）。 */
    requireChainAnchor?: boolean;
    /** 信任するログ鍵（`logId` -> 公開鍵）。未設定のログは fail-closed。 */
    logKeys?: Record<string, string | Uint8Array>;
    /** ログ鍵の遅延解決（`KeyDirectory` 等）。 */
    resolveLogKey?: (
        logId: string,
    ) => Promise<Uint8Array | string | null> | Uint8Array | string | null;
    /** チェックポイントの最大経過（ms）。既定は無制限。 */
    checkpointMaxAgeMs?: number;
    /** レコードの最大寿命（既定 1 年）。 */
    maxLifetimeMs?: number;
    /** 時刻ずれの猶予（既定 300 000 ms）。 */
    clockSkewMs?: number;
    /** 実チェーン検証器（未設定なら `chainVerified: null`）。 */
    chainAnchorVerifier?: IChainAnchorVerifier;
    /** Ed25519 検証の差し替え（既定は Web Crypto）。 */
    verifySignature?: (
        publicKey: Uint8Array,
        data: Uint8Array,
        signature: Uint8Array,
    ) => Promise<boolean>;
    /** ハッシュ関数（テスト用）。 */
    hashFn?: DomainHashFn;
    logger?: Logger;
}

const DEFAULT_CLOCK_SKEW_MS = 300_000;

function fail(
    logger: Logger | undefined,
    code: DomainProofCode,
    message: string,
    extra: Partial<DomainVerifyResult> = {},
): DomainVerifyResult {
    logger?.debug(`domain proof failed (${code}): ${message}`);
    return { ok: false, code, message, ...extra };
}

/**
 * 既定の所有権検証器を作る（specification.md §13.4.1 の 1〜8 をこの順序で実施する）。
 */
export function createDomainOwnershipVerifier(
    options: DomainOwnershipVerifierOptions = {},
): IDomainOwnershipVerifier {
    const hashFn = options.hashFn ?? defaultDomainHash;
    const maxLifetimeMs = options.maxLifetimeMs ?? MAX_DOMAIN_RECORD_LIFETIME_MS;
    const defaultClockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

    const verifyBodySignature = async (
        record: DomainOwnershipRecord,
    ): Promise<DomainVerifyResult | null> => {
        const publicKey = decodePublicKey(record.body.ownerPublicKey);
        if (!publicKey) {
            return fail(options.logger, 'invalid-record', 'ownerPublicKey is not Base64url of 32 bytes');
        }
        if ((await deriveNodeId(publicKey)) !== record.body.nodeId) {
            return fail(
                options.logger,
                'fingerprint-mismatch',
                'nodeId does not match the fingerprint of ownerPublicKey',
            );
        }
        const signature = decodeBase64Url(record.signature);
        if (!signature || signature.byteLength !== 64) {
            return fail(options.logger, 'invalid-record', 'signature is not a 64-byte Ed25519 signature');
        }
        const bodyBytes = canonicalDomainRecordBodyBytes(record.body);
        const verify = options.verifySignature ?? verifyDomainEd25519;
        const ok = await verify(publicKey, bodyBytes, signature);
        if (!ok) {
            return fail(options.logger, 'bad-signature', 'owner signature does not verify', {
                commitment: await commitDomainRecord(record.body, hashFn),
            });
        }
        return null;
    };

    const verifyAnchor = async (
        record: DomainOwnershipRecord,
        commitmentHex: string,
        context: DomainVerifyContext,
        clockSkewMs: number,
    ): Promise<{ result: DomainVerifyResult | null; verified: boolean }> => {
        const anchor: DomainAnchor | undefined = record.anchor;
        if (!anchor) {
            if (options.requireAnchor) {
                return {
                    result: fail(
                        options.logger,
                        'anchor-missing',
                        'this verifier requires a ledger anchor (requireAnchor: true)',
                    ),
                    verified: false,
                };
            }
            return { result: null, verified: false };
        }
        let parsed: DomainAnchor;
        try {
            parsed = parseDomainAnchor(anchor);
        } catch (error) {
            return {
                result: fail(
                    options.logger,
                    'invalid-record',
                    error instanceof Error ? error.message : 'invalid anchor',
                ),
                verified: false,
            };
        }
        const checkpointResult = await verifyDomainCheckpoint(parsed.checkpoint, {
            ...(options.logKeys ? { logKeys: options.logKeys } : {}),
            ...(options.resolveLogKey ? { resolveLogKey: options.resolveLogKey } : {}),
            ...(options.checkpointMaxAgeMs !== undefined
                ? { maxAgeMs: options.checkpointMaxAgeMs }
                : {}),
            ...(context.nowMs !== undefined ? { nowMs: context.nowMs } : {}),
            clockSkewMs,
        });
        if (!checkpointResult.ok) {
            return {
                result: fail(
                    options.logger,
                    checkpointResult.code === 'anchor-untrusted-log'
                        ? 'anchor-untrusted-log'
                        : 'anchor-bad-checkpoint',
                    checkpointResult.message ?? 'checkpoint verification failed',
                ),
                verified: false,
            };
        }
        if (context.pinnedCheckpoint) {
            if (
                context.pinnedCheckpoint.logId === parsed.checkpoint.logId &&
                checkpointRollsBack(context.pinnedCheckpoint, parsed.checkpoint)
            ) {
                return {
                    result: fail(
                        options.logger,
                        'anchor-rollback',
                        `checkpoint treeSize ${parsed.checkpoint.treeSize} is older than the pinned ${context.pinnedCheckpoint.treeSize}`,
                    ),
                    verified: false,
                };
            }
            if (
                context.pinnedCheckpoint.logId === parsed.checkpoint.logId &&
                parsed.checkpoint.treeSize > context.pinnedCheckpoint.treeSize &&
                context.checkpointChain?.checkpointsBetween
            ) {
                const between = await context.checkpointChain.checkpointsBetween({
                    logId: parsed.checkpoint.logId,
                    afterTreeSize: context.pinnedCheckpoint.treeSize,
                    toTreeSize: parsed.checkpoint.treeSize,
                });
                const chain = await verifyDomainCheckpointChain({
                    pinned: context.pinnedCheckpoint,
                    target: parsed.checkpoint,
                    between,
                    hashFn,
                });
                if (!chain.ok && chain.code !== 'unavailable') {
                    return {
                        result: fail(
                            options.logger,
                            chain.code === 'anchor-rollback' ? 'anchor-rollback' : 'anchor-bad-checkpoint',
                            chain.message ?? 'checkpoint chain verification failed',
                        ),
                        verified: false,
                    };
                }
            }
        }
        // 葉の原料は commitment バイト列（canonical バイト列の SHA-256 を raw にしたもの）
        const proofOk = await verifyDomainMerkleProof(
            {
                commitment: commitmentHex,
                leafIndex: parsed.leafIndex,
                treeSize: parsed.checkpoint.treeSize,
                root: parsed.checkpoint.root,
                proof: parsed.proof,
            },
            hashFn,
        );
        if (!proofOk) {
            return {
                result: fail(
                    options.logger,
                    'anchor-bad-proof',
                    'Merkle inclusion proof does not reach the checkpoint root',
                ),
                verified: false,
            };
        }
        return { result: null, verified: true };
    };

    return {
        name: 'domain-ownership-verifier',
        async verify(record, context = {}) {
            // 1. 構造（未知キー拒否を含む）
            let body;
            try {
                body = parseDomainRecordBody(record?.body);
            } catch (error) {
                return fail(
                    options.logger,
                    'invalid-record',
                    error instanceof Error ? error.message : 'invalid record body',
                );
            }
            if (typeof record?.signature !== 'string') {
                return fail(options.logger, 'invalid-record', 'record.signature must be a string');
            }
            // 2. ゾーンと一致性
            if (!isDomainGlobalName(body.domain)) {
                return fail(options.logger, 'zone-mismatch', `${body.domain} is not in the domain.global zone`);
            }
            if (context.expectedDomain !== undefined) {
                let expected = '';
                try {
                    expected = normalizeDomainName(context.expectedDomain);
                } catch (error) {
                    return fail(
                        options.logger,
                        'zone-mismatch',
                        error instanceof Error ? error.message : 'invalid expected domain',
                    );
                }
                if (expected !== body.domain) {
                    return fail(
                        options.logger,
                        'zone-mismatch',
                        `record is for ${body.domain}, not ${expected}`,
                    );
                }
            }
            // 3〜4. 指紋と署名
            const signatureFailure = await verifyBodySignature({ ...record, body });
            if (signatureFailure) return signatureFailure;
            // 5. 有効期間
            const now = context.nowMs ?? Date.now();
            const clockSkewMs = context.clockSkewMs ?? defaultClockSkewMs;
            if (body.expiresAt - body.issuedAt > maxLifetimeMs) {
                return fail(
                    options.logger,
                    'invalid-record',
                    `record lifetime ${body.expiresAt - body.issuedAt}ms exceeds ${maxLifetimeMs}ms`,
                );
            }
            if (now + clockSkewMs < body.issuedAt) {
                return fail(
                    options.logger,
                    'not-yet-valid',
                    `record is not valid yet (issuedAt ${body.issuedAt}, now ${now})`,
                );
            }
            if (now - clockSkewMs > body.expiresAt) {
                return fail(
                    options.logger,
                    'expired',
                    `record for ${body.domain} expired at ${body.expiresAt}`,
                );
            }
            // 6. リプレイ / 失効
            if (context.knownSerial !== undefined && body.serial < context.knownSerial) {
                return fail(
                    options.logger,
                    'stale-serial',
                    `serial ${body.serial} is older than the known ${context.knownSerial}`,
                );
            }
            const commitment = await commitDomainRecord(body, hashFn);
            if (body.revoked) {
                return {
                    ok: false,
                    code: 'revoked',
                    message: `the owner revoked this record (serial ${body.serial})`,
                    commitment,
                };
            }
            // 7. 台帳アンカー
            const anchorOutcome = await verifyAnchor({ ...record, body }, commitment, context, clockSkewMs);
            if (anchorOutcome.result) return anchorOutcome.result;
            // 8. 実チェーン検証（任意）
            let chainVerified: boolean | null = null;
            if (record.anchor?.chain) {
                const checkpointHash = await domainCheckpointHash(
                    record.anchor.checkpoint,
                    hashFn,
                );
                if (!options.chainAnchorVerifier) {
                    chainVerified = null;
                    if (options.requireChainAnchor) {
                        return fail(
                            options.logger,
                            'chain-unverified',
                            'anchor.chain is present but no IChainAnchorVerifier is configured',
                            { chainVerified },
                        );
                    }
                } else {
                    try {
                        const chainResult = await options.chainAnchorVerifier.verify({
                            commitment,
                            checkpointHash,
                            chain: record.anchor.chain,
                        });
                        chainVerified = chainResult.verified === true;
                        if (!chainVerified) {
                            return fail(
                                options.logger,
                                'chain-unverified',
                                chainResult.detail ?? 'on-chain verification failed',
                                { chainVerified },
                            );
                        }
                    } catch (error) {
                        return fail(
                            options.logger,
                            'chain-unverified',
                            error instanceof Error ? error.message : 'chain verification threw',
                            { chainVerified: false },
                        );
                    }
                }
            }
            return {
                ok: true,
                code: 'ok',
                anchorVerified: anchorOutcome.verified,
                chainVerified,
                commitment,
            };
        },
    };
}

/**
 * 受理済みレコードの `serial` とチェックポイントを記憶する器（§13.4.1 の 6・§13.5）。
 * ロールバック（古い `serial` / 後退した `treeSize`）の検出に使う。
 */
export interface DomainProofState {
    knownSerial(domain: string): number | undefined;
    pinnedCheckpoint(logId: string): SignedDomainCheckpoint | undefined;
    /** 検証に成功したレコードを記憶する。`false` は後退（拒否）を示す。 */
    observe(record: DomainOwnershipRecord): boolean;
    /** 衝突（同 serial 異内容）の検出用に commitment を覚える。 */
    knownCommitment(domain: string): string | undefined;
    rememberCommitment(domain: string, commitment: string): void;
    clear(): void;
    readonly size: number;
}

export function createDomainProofCache(options: { maxEntries?: number } = {}): DomainProofState {
    const maxEntries = options.maxEntries ?? 1024;
    const serials = new Map<string, number>();
    const commitments = new Map<string, string>();
    const pins = new Map<string, SignedDomainCheckpoint>();

    const trim = <V>(map: Map<string, V>): void => {
        while (map.size > maxEntries) {
            const oldest = map.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    };

    return {
        knownSerial(domain) {
            return serials.get(domain);
        },
        pinnedCheckpoint(logId) {
            return pins.get(logId);
        },
        observe(record) {
            const domain = record.body.domain;
            const known = serials.get(domain);
            if (known !== undefined && record.body.serial < known) return false;
            serials.set(domain, record.body.serial);
            trim(serials);
            if (record.anchor) {
                const checkpoint = record.anchor.checkpoint;
                const pinned = pins.get(checkpoint.logId);
                if (pinned && checkpointRollsBack(pinned, checkpoint)) return false;
                if (!pinned || checkpoint.treeSize > pinned.treeSize) {
                    pins.set(checkpoint.logId, checkpoint);
                    trim(pins);
                }
            }
            return true;
        },
        knownCommitment(domain) {
            return commitments.get(domain);
        },
        rememberCommitment(domain, commitment) {
            commitments.set(domain, commitment);
            trim(commitments);
        },
        clear() {
            serials.clear();
            commitments.clear();
            pins.clear();
        },
        get size() {
            return serials.size;
        },
    };
}
