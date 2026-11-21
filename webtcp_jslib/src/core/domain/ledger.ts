/**
 * 開発用・参照実装のドメイン台帳（specification.md §14.3 / §14.7）。
 *
 * 追記専用の Merkle 木と署名済みチェックポイントを管理する**インメモリ台帳**である。
 * 本番の透明性ログ（実チェーンアンカーを含む）は #42 のスコープであり、
 * ここでは検証パスを通すための最小実装（HTTP レジストリのモックも兼ねる）に留める。
 */

import { positiveInt } from '../util/internal.js';
import {
    Ed25519KeyManager,
    NodeId,
    bytesToHex,
    decodeBase64Url,
    decodePublicKey,
    deriveNodeId,
    encodePublicKey,
} from '../routing/keys.js';
import type { Logger } from '../util/Logger.js';
import {
    GENESIS_PREV_HASH,
    canonicalDomainCheckpointBytes,
    signDomainCheckpoint,
    type DomainAnchor,
    type SignedDomainCheckpoint,
} from './checkpoint.js';
import { defaultDomainHash, verifyDomainEd25519, type DomainHashFn } from './crypto.js';
import type { DomainSourceContext, IDomainRecordSource } from './authority.js';
import {
    DomainConflictError,
    DomainLedgerAppendError,
    conflictVerdict,
} from './errors.js';
import { buildDomainMerkleProof, buildDomainMerkleRoot } from './merkle.js';
import {
    canonicalDomainRecordBodyBytes,
    commitDomainRecord,
    domainCommitmentBytes,
    parseDomainOwnershipRecord,
    type DomainOwnershipRecord,
} from './record.js';

/** 台帳への追加結果。 */
export interface DomainLedgerAppendResult {
    /** アンカーを添付済みのレコード（そのまま配布できる）。 */
    record: DomainOwnershipRecord;
    commitment: string;
    anchor: DomainAnchor;
}

/** 台帳の公開状態スナップショット。 */
export interface DomainLedgerSnapshot {
    logId: string;
    treeSize: number;
    /** Base64url の Merkle ルート（葉が無ければ空文字）。 */
    root: string;
    /** 直近の署名済みチェックポイント（葉が無ければ `null`）。 */
    checkpoint: SignedDomainCheckpoint | null;
    /** ドメイン -> 現行レコード。 */
    current: Record<string, DomainOwnershipRecord>;
}

export interface DomainLedgerOptions {
    /** 台帳の署名鍵。チェックポイントはこの鍵で署名される。 */
    keyManager: Ed25519KeyManager;
    /** ログ識別子（既定は鍵の NodeId）。 */
    logId?: string;
    /** 追加前に所有者署名を検証する（既定 `true`）。 */
    requireOwnerSignature?: boolean;
    hashFn?: DomainHashFn;
    /** 葉数の上限（既定 65 536。超過時の追加は拒否する = §14.7 の増幅防止）。 */
    maxEntries?: number;
    logger?: Logger;
}

interface LedgerEntry {
    commitment: string;
    /** 葉の原料（commitment の 32 バイト）。 */
    leafBytes: Uint8Array;
    record: DomainOwnershipRecord;
}

/** 台帳の葉数の既定上限（specification.md §14.7）。 */
export const MAX_DOMAIN_LEDGER_LEAVES = 65_536;


/** チェックポイント本文のハッシュ（次チェックポイントの `prevHash`）。 */
export async function domainCheckpointHex(
    checkpoint: SignedDomainCheckpoint,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<string> {
    return bytesToHex(await hashFn(canonicalDomainCheckpointBytes(checkpoint)));
}

/** レコードの所有者署名 + 鍵指紋のみを検証する（台帳側の一次審査）。 */
export async function verifyDomainRecordSelfSignature(
    record: DomainOwnershipRecord,
): Promise<boolean> {
    const publicKey = decodePublicKey(record.body.ownerPublicKey);
    if (!publicKey) return false;
    if ((await deriveNodeId(publicKey)) !== record.body.nodeId) return false;
    const signature = decodeBase64Url(record.signature);
    if (!signature || signature.byteLength !== 64) return false;
    return verifyDomainEd25519(
        publicKey,
        canonicalDomainRecordBodyBytes(record.body),
        signature,
    );
}

/**
 * インメモリ台帳。`append()` は衝突解決（§14.4.3）を通ったレコードのみを葉として
 * 追加し、新しいチェックポイントを発行する。
 */
export class DomainLedger implements IDomainRecordSource {
    readonly name = 'memory';
    private readonly keyManager: Ed25519KeyManager;
    private readonly logIdValue: string;
    private readonly requireOwnerSignature: boolean;
    private readonly hashFn: DomainHashFn;
    private readonly logger?: Logger;
    private readonly entries: LedgerEntry[] = [];
    private readonly currentByDomain = new Map<string, DomainOwnershipRecord>();
    private readonly checkpoints: SignedDomainCheckpoint[] = [];
    private rootCache: Promise<string> | null = null;
    private readonly maxEntries: number;

    constructor(options: DomainLedgerOptions) {
        if (!options?.keyManager) {
            throw new DomainLedgerAppendError('DomainLedger requires a keyManager to sign checkpoints');
        }
        this.keyManager = options.keyManager;
        this.logIdValue = options.logId ?? options.keyManager.nodeId;
        this.requireOwnerSignature = options.requireOwnerSignature !== false;
        this.hashFn = options.hashFn ?? defaultDomainHash;
        this.maxEntries = positiveInt(options.maxEntries ?? MAX_DOMAIN_LEDGER_LEAVES, 'maxEntries');
        if (options.logger) this.logger = options.logger;
    }

    /** 台帳のログ識別子（チェックポイントの `logId`）。 */
    get logId(): string {
        return this.logIdValue;
    }

    /** ログ鍵の公開鍵（Base64url）。`GET /domain/log` の TOFU ピン留めに使う (§14.6)。 */
    get publicKeyEncoded(): string {
        return encodePublicKey(this.keyManager.publicKey);
    }

    /** 葉数。 */
    get size(): number {
        return this.entries.length;
    }

    /** 直近の署名済みチェックポイント（葉が 1 つも無ければ `null`）。 */
    get head(): SignedDomainCheckpoint | null {
        if (this.entries.length === 0) return null;
        return (this.checkpoints[this.checkpoints.length - 1] ?? null) as SignedDomainCheckpoint | null;
    }

    /** 現行ルート（Base64url）。葉が無ければ `null`。 */
    async root(): Promise<string | null> {
        if (this.entries.length === 0) return null;
        if (!this.rootCache) {
            const leaves = this.entries.map((entry) => entry.leafBytes);
            this.rootCache = buildDomainMerkleRoot(leaves, this.hashFn);
        }
        return this.rootCache;
    }

    /**
     * レコードを追加する。
     *
     * @throws DomainRecordError 構造・指紋・署名検証に失敗
     * @throws DomainConflictError 現行レコードより古い / 同一 serial で内容が異なる
     */
    async append(input: DomainOwnershipRecord | unknown): Promise<DomainLedgerAppendResult> {
        const record = await parseDomainOwnershipRecord(input);
        const domain = record.body.domain;
        const commitment = await commitDomainRecord(record.body, this.hashFn);

        if (this.requireOwnerSignature) {
            if (!(await verifyDomainRecordSelfSignature(record))) {
                throw new DomainLedgerAppendError(
                    `owner signature does not verify for ${domain}`,
                    domain,
                );
            }
        }

        const existing = this.currentByDomain.get(domain);
        if (existing) {
            const verdict = conflictVerdict(
                {
                    serial: existing.body.serial,
                    commitment: await commitDomainRecord(existing.body, this.hashFn),
                    anchorLeafIndex: existing.anchor?.leafIndex,
                },
                {
                    serial: record.body.serial,
                    commitment,
                    anchorLeafIndex: record.anchor?.leafIndex,
                },
            );
            if (verdict === 'identical') {
                // 冪等: 新しい葉は追加せず、既存レコード（とそのアンカー）をそのまま返す。
                const leafIndex = this.entries.findIndex((entry) => entry.commitment === commitment);
                const anchor = existing.anchor ?? (leafIndex >= 0 ? await this.buildAnchor(leafIndex) : null);
                if (!anchor) {
                    throw new DomainLedgerAppendError(`missing ledger anchor for ${domain}`, domain);
                }
                const anchored: DomainOwnershipRecord = { ...existing, anchor };
                this.currentByDomain.set(domain, anchored);
                return { record: anchored, commitment, anchor };
            }
            if (verdict !== 'candidate') {
                throw new DomainConflictError(
                    `record for ${domain} was not accepted (verdict "${verdict}", current serial ${
                        existing.body.serial
                    }, candidate serial ${record.body.serial})`,
                    domain,
                    existing,
                    record,
                );
            }
        }

        if (this.entries.length >= this.maxEntries) {
            throw new DomainLedgerAppendError(
                `domain ledger is full (maxEntries=${this.maxEntries})`,
                domain,
            );
        }
        const leafIndex = this.entries.length;
        this.entries.push({ commitment, leafBytes: domainCommitmentBytes(commitment), record });
        this.rootCache = null;

        const checkpoint = await this.issueCheckpoint();
        const anchor: DomainAnchor = {
            leafIndex,
            proof: await buildDomainMerkleProof(
                this.entries.map((entry) => entry.leafBytes),
                leafIndex,
                this.hashFn,
            ),
            checkpoint,
        };
        const anchored: DomainOwnershipRecord = { ...record, anchor };
        this.currentByDomain.set(domain, anchored);
        const lastEntry = this.entries[leafIndex];
        if (lastEntry) lastEntry.record = anchored;
        this.logger?.debug(
            `domain ledger appended ${domain} serial=${record.body.serial} leaf=${leafIndex}`,
        );
        return { record: anchored, commitment, anchor };
    }

    /**
     * 葉から根への包含証明を、現行木の直近チェックポイントと組み合わせる（追加はしない）。
     *
     * チェックポイントを**再発行しない**のが要点である。読み出しのたびに新しい
     * チェックポイントを作ると `prevHash` 連鎖が自己参照で壊れる（§14.3）。
     */
    async buildAnchor(leafIndex: number): Promise<DomainAnchor> {
        const treeSize = this.entries.length;
        if (treeSize === 0 || leafIndex < 0 || leafIndex >= treeSize) {
            throw new DomainLedgerAppendError(`no ledger leaf at index ${leafIndex}`);
        }
        const proof = await buildDomainMerkleProof(
            this.entries.map((entry) => entry.leafBytes),
            leafIndex,
            this.hashFn,
        );
        const checkpoint = this.head ?? (await this.issueCheckpoint());
        return { leafIndex, proof, checkpoint };
    }

    /** 現行の木で新しい署名済みチェックポイントを発行して履歴へ積む。 */
    private async issueCheckpoint(): Promise<SignedDomainCheckpoint> {
        const previous = this.checkpoints[this.checkpoints.length - 1];
        const checkpoint = await signDomainCheckpoint(
            {
                logId: this.logIdValue,
                treeSize: this.entries.length,
                root: (await this.root()) ?? '',
                prevHash: previous
                    ? await domainCheckpointHex(previous, this.hashFn)
                    : GENESIS_PREV_HASH,
                timestamp: Date.now(),
            },
            this.keyManager,
        );
        this.checkpoints.push(checkpoint);
        return checkpoint;
    }

    /** 直近の署名済みチェックポイント。 */
    async checkpoint(): Promise<SignedDomainCheckpoint | null> {
        await this.root();
        return this.head;
    }

    /** `afterTreeSize` を超え `toTreeSize` 未満（対象チェックポイントを含まない）の範囲。 */
    async checkpointsBetween(params: {
        afterTreeSize: number;
        toTreeSize: number;
    }): Promise<SignedDomainCheckpoint[]> {
        return this.checkpoints
            .filter(
                (entry) =>
                    entry.treeSize > params.afterTreeSize && entry.treeSize < params.toTreeSize,
            )
            .sort((a, b) => a.treeSize - b.treeSize);
    }

    /** 特定ドメインの現行レコード。 */
    async lookupByDomain(
        domain: string,
        _context: DomainSourceContext = {},
    ): Promise<DomainOwnershipRecord | null> {
        void _context;
        return this.currentByDomain.get(domain) ?? null;
    }

    /** 特定ノードに束縛された現行レコード（1 ノードに複数ドメインがあり得る）。 */
    async lookupByNodeId(nodeId: NodeId): Promise<DomainOwnershipRecord[]> {
        const out: DomainOwnershipRecord[] = [];
        for (const record of this.currentByDomain.values()) {
            if (record.body.nodeId === nodeId) out.push(record);
        }
        return out.sort((a, b) => (a.body.domain < b.body.domain ? -1 : 1));
    }

    /** 現行レコードの全件（テスト・可視化用）。 */
    async listCurrent(): Promise<DomainOwnershipRecord[]> {
        return [...this.currentByDomain.values()].sort((a, b) =>
            a.body.domain < b.body.domain ? -1 : 1,
        );
    }

    /** 台帳状態のスナップショット（`GET /domain/checkpoint` の応答形に合わせる）。 */
    async snapshot(): Promise<DomainLedgerSnapshot> {
        const current: Record<string, DomainOwnershipRecord> = {};
        for (const [domain, record] of this.currentByDomain) current[domain] = record;
        return {
            logId: this.logIdValue,
            treeSize: this.entries.length,
            root: (await this.root()) ?? '',
            checkpoint: this.head,
            current,
        };
    }

    /** 台帳を空にする（テスト用）。 */
    clear(): void {
        this.entries.length = 0;
        this.currentByDomain.clear();
        this.checkpoints.length = 0;
        this.rootCache = null;
    }
}

/** インメモリ台帳のファクトリ（`new DomainLedger(...)` の糖衣）。 */
export function createDomainLedger(options: DomainLedgerOptions): DomainLedger {
    return new DomainLedger(options);
}
