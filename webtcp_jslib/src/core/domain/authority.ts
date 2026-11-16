/**
 * `domain.global` 名前解決のオーケストレーション（specification.md §13.5）。
 *
 * 責務は 4 つだけ:
 *
 * 1. 完全名を `.domain.global` として**正規化**し、収集元（`local` -> `sources` -> `peers`）
 *    へ並列に問い合わせる（全体デッドライン付き）。
 * 2. 候補レコードを {@link IDomainOwnershipVerifier} で検証する。
 * 3. 検証に成功した候補だけから §13.4.3 の衝突解決で勝者を決める。
 * 4. 勝者の `body.nodeId` を返し、`IPublicKeyResolver` への bridge を提供する。
 *
 * ローカル `NameServer` へのフォールバックも、エラーを `webtcp://` 解決失敗へ写像するのも
 * {@link NameServer} 側の仕事である（§12.2 / §13.5）。
 */

import type { NodeId } from '../routing/keys.js';
import { decodePublicKey, deriveNodeId, isValidNodeId } from '../routing/keys.js';

const isNodeId = isValidNodeId;
import type { IPublicKeyResolver } from '../routing/PacketVerifier.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import type { VirtualPort } from '../types/protocol.js';
import { isDomainGlobalName, isValidDomainName, normalizeDomainName, prepareDomainName } from './names.js';
import { commitDomainRecord, parseDomainOwnershipRecord, type DomainOwnershipRecord } from './record.js';
import type { SignedDomainCheckpoint } from './checkpoint.js';
import type { DomainCheckpointSource } from './verifier.js';
import {
    createDomainOwnershipVerifier,
    createDomainProofCache,
    type DomainVerifyContext,
    type DomainVerifyResult,
    type IDomainOwnershipVerifier,
} from './verifier.js';
import {
    DomainOwnershipError,
    DomainProofCode,
    DomainResolutionUnavailableError,
    conflictVerdict,
    domainProofCodeToReason,
} from './errors.js';

/** 収集元が受け取る問い合わせ文脈。 */
export interface DomainSourceContext {
    signal?: AbortSignal;
    /** 絶対デッドライン（`Date.now()` 基準の epoch ms）。 */
    deadline?: number;
}

/**
 * ドメイン解決が使うレコード源（specification.md §13.5 / §13.6）。
 *
 * 1 件でも複数件でも返せる。複数件は「同一ドメインに対する競合候補」として §13.4.3 に
 * かける。無関係な名前を混在させてはならない (MUST NOT)。
 */
export interface IDomainRecordSource {
    readonly name?: string;
    lookupByDomain(
        domain: string,
        context?: DomainSourceContext,
    ): Promise<readonly DomainOwnershipRecord[] | DomainOwnershipRecord | null>;
    /** 逆引き（可視化・診断用。未実装でもよい）。 */
    lookupByNodeId?(nodeId: NodeId): Promise<readonly DomainOwnershipRecord[]>;
}

/** 解決結果（成功時）。 */
export interface DomainResolutionSuccess {
    ok: true;
    domain: string;
    /** 解決に成功したレコードが束縛する NodeId。 */
    nodeId: NodeId;
    record: DomainOwnershipRecord;
    proof: DomainVerifyResult;
    /** 検証済みチェックポイント（`pinCheckpoints` 時に記憶される）。 */
    pinnedCheckpoint?: SignedDomainCheckpoint;
    /** `record.body.port`（ヒント。`webtcp://` の必須ポートは置き換えない）。 */
    port?: VirtualPort;
    /** 何件目の候補が勝ったか（0 起始）。 */
    candidates: number;
    /** 結果の出た収集元名。 */
    via: string;
}

/** 解決結果（失敗時）。 */
export interface DomainResolutionFailure {
    ok: false;
    domain: string;
    code: DomainProofCode;
    message: string;
    /** 検証に失敗した候補（先頭 1 件）。 */
    record?: DomainOwnershipRecord;
    proof?: DomainVerifyResult;
}

export type DomainResolution = DomainResolutionSuccess | DomainResolutionFailure;

export interface ResolveDomainOptions {
    signal?: AbortSignal;
    /** 全体デッドライン（既定は `resolveTimeoutMs`）。 */
    timeoutMs?: number;
    /** 成否を問わずキャッシュを参照しない (既定 `false`)。 */
    skipCache?: boolean;
}

export interface DomainAuthorityOptions {
    /** 所有権検証器。`verifier: null` で検証を無効化できる（実験モード、既定は fail-closed 実装）。 */
    verifier?: IDomainOwnershipVerifier | null;
    /** `verifier` を渡さないときの検証器オプション（§13.4.1）。 */
    verifierOptions?: Parameters<typeof createDomainOwnershipVerifier>[0];
    /** 最優先の収集元（`NameServer.registerDomain()` のローカルストア等）。 */
    local?: IDomainRecordSource | null;
    /** HTTP レジストリ等の明示的な収集元。 */
    sources?: readonly (IDomainRecordSource | null | undefined)[];
    /** 既知ノードへの `wantOwnership` 問い合わせ（`NameServer` が供給する）。 */
    peers?: IDomainRecordSource | null;
    /** 成功結果のキャッシュ TTL（既定 60 000 ms）。 */
    cacheTtlMs?: number;
    /** 失敗結果のキャッシュ TTL（既定 5 000 ms。成功より長くしてはならない MUST）。 */
    negativeTtlMs?: number;
    /** キャッシュ最大件数（既定 256）。 */
    maxCacheEntries?: number;
    /** 解決全体のデッドライン（既定 5 000 ms）。 */
    resolveTimeoutMs?: number;
    /** 収集元 1 件あたりの問い合わせタイムアウト（既定 1 500 ms）。 */
    queryTimeoutMs?: number;
    /** 1 ドメインにつき検証に回す候補数の上限（既定 8）。 */
    maxRecordsPerDomain?: number;
    /** 受理したチェックポイントを記憶し、後退を拒否する（既定 `true`）。 */
    pinCheckpoints?: boolean;
    /** チェックポイント連結の追跡源（`HttpDomainRegistryClient` 等が実装する、§13.3）。 */
    checkpointChain?: DomainCheckpointSource | null;
    logger?: Logger;
}

type NameVerdict = { ok: true; domain: string } | { ok: false; code: DomainProofCode; message: string };

/**
 * 入力をゾーン名として分類する（specification.md §13.1）。
 * ゾーン外の正当な名前は `zone-mismatch`、形式自体が不正なら `invalid-record`。
 */
function classifyName(input: string): NameVerdict {
    let prepared: string;
    try {
        prepared = prepareDomainName(input);
    } catch (error) {
        return {
            ok: false,
            code: 'invalid-record',
            message: error instanceof Error ? error.message : 'invalid domain name',
        };
    }
    if (!isDomainGlobalName(prepared)) {
        return isValidDomainName(prepared)
            ? {
                  ok: false,
                  code: 'zone-mismatch',
                  message: `${prepared} does not belong to the domain.global zone (§13.1)`,
              }
            : { ok: false, code: 'invalid-record', message: `invalid domain name: ${prepared}` };
    }
    try {
        return { ok: true, domain: normalizeDomainName(prepared) };
    } catch (error) {
        return {
            ok: false,
            code: 'invalid-record',
            message: error instanceof Error ? error.message : 'invalid domain name',
        };
    }
}

interface AuthorityCacheEntry {
    resolution: DomainResolution;
    expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;

/**
 * 検証済み結果を記憶し、ロールバック検出（§13.4.1 の 6）に使う `serial` /
 * チェックポイント台帳を保持するドメイン権威者。
 */
export class DomainAuthority {
    private readonly verifier: IDomainOwnershipVerifier | null;
    private readonly local: IDomainRecordSource | null;
    private readonly sources: IDomainRecordSource[];
    private readonly peers: IDomainRecordSource | null;
    private readonly cacheTtlMs: number;
    private readonly negativeTtlMs: number;
    private readonly maxCacheEntries: number;
    private readonly resolveTimeoutMs: number;
    private readonly queryTimeoutMs: number;
    private readonly maxRecordsPerDomain: number;
    private readonly pinCheckpoints: boolean;
    private readonly checkpointChain: DomainCheckpointSource | null;
    private readonly logger: Logger;
    private readonly state = createDomainProofCache();
    private readonly cache = new Map<string, AuthorityCacheEntry>();
    private readonly stored = new Map<string, DomainOwnershipRecord>();
    /** `remember()` / `register()` で信託されたレコード（最優先の収集元）。 */
    private readonly ownStore: IDomainRecordSource;
    private closed = false;

    constructor(options: DomainAuthorityOptions = {}) {
        this.verifier =
            options.verifier === null
                ? null
                : (options.verifier ?? createDomainOwnershipVerifier(options.verifierOptions ?? {}));
        this.local = options.local ?? null;
        this.sources = (options.sources ?? []).filter((source): source is IDomainRecordSource => Boolean(source));
        this.peers = options.peers ?? null;
        this.cacheTtlMs = positive(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 'cacheTtlMs');
        this.negativeTtlMs = positive(options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS, 'negativeTtlMs');
        if (this.negativeTtlMs > this.cacheTtlMs) {
            throw new Error('negativeTtlMs must not exceed cacheTtlMs (specification.md §13.5)');
        }
        this.maxCacheEntries = positiveInt(options.maxCacheEntries ?? 256, 'maxCacheEntries');
        this.resolveTimeoutMs = positive(options.resolveTimeoutMs ?? 5_000, 'resolveTimeoutMs');
        this.queryTimeoutMs = positive(options.queryTimeoutMs ?? 1_500, 'queryTimeoutMs');
        this.maxRecordsPerDomain = positiveInt(options.maxRecordsPerDomain ?? 8, 'maxRecordsPerDomain');
        this.pinCheckpoints = options.pinCheckpoints !== false;
        this.checkpointChain = options.checkpointChain ?? null;
        this.ownStore = {
            name: 'local-store',
            lookupByDomain: async (domain: string) => {
                const found = this.stored.get(domain);
                return found ? [found] : null;
            },
            lookupByNodeId: async (nodeId: NodeId) => {
                return [...this.stored.values()].filter((record) => record.body.nodeId === nodeId);
            },
        };
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'DOMAIN');
    }

    /** 記憶済みの `serial` / チェックポイント（診断用）。 */
    get proofState(): ReturnType<typeof createDomainProofCache> {
        return this.state;
    }

    /** 収集元が 1 つでもあるか（無ければゾーン名は常に失敗する）。 */
    get enabled(): boolean {
        return this.local !== null || this.sources.length > 0 || this.peers !== null;
    }

    /** ローカルストア（`remember()` で入れたレコード）。 */
    get storedSize(): number {
        return this.stored.size;
    }

    /**
     * 完全名を収集元から解決し、所有権を検証する。
     *
     * @throws DomainResolutionUnavailableError 収集元が無い / 問い合わせ先が全滅（候補 0 件）
     * @throws DomainOwnershipError 候補はあるが検証に失敗
     */
    async resolve(input: string, options: ResolveDomainOptions = {}): Promise<DomainResolution> {
        const resolution = await this.settle(input, options);
        if (!resolution.ok) {
            if (resolution.code === 'resolution-unavailable') {
                throw new DomainResolutionUnavailableError(resolution.domain, resolution.message);
            }
            throw new DomainOwnershipError(resolution.domain, resolution.code, resolution.message);
        }
        return resolution;
    }

    /** 例外を投げない解決（{@link resolve} の結果値版）。 */
    async settle(input: string, options: ResolveDomainOptions = {}): Promise<DomainResolution> {
        if (this.closed) throw new Error('DomainAuthority is closed');
        const verdict = classifyName(input);
        if (!verdict.ok) {
            return { ok: false, domain: String(input), code: verdict.code, message: verdict.message };
        }
        const domain = verdict.domain;
        if (!this.enabled) {
            return {
                ok: false,
                domain,
                code: 'resolution-unavailable',
                message: 'no domain record source is configured',
            };
        }
        if (!options.skipCache) {
            const cached = this.cache.get(domain);
            if (cached && cached.expiresAt > Date.now()) return cached.resolution;
            if (cached) this.cache.delete(domain);
        }

        const timeoutMs = positive(options.timeoutMs ?? this.resolveTimeoutMs, 'timeoutMs');
        const controller = new AbortController();
        const onOuterAbort = (): void => controller.abort();
        options.signal?.addEventListener('abort', onOuterAbort, { once: true });
        if (options.signal?.aborted) controller.abort();
        const deadline = Date.now() + timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const collected = await this.collect(domain, {
                signal: controller.signal,
                deadline,
            });
            if (collected.length === 0) {
                const failure: DomainResolution = {
                    ok: false,
                    domain,
                    code: 'resolution-unavailable',
                    message:
                        controller.signal.aborted && !options.signal?.aborted
                            ? `domain resolution timed out for ${domain}`
                            : `no ownership record found for ${domain}`,
                };
                this.putCache(failure);
                return failure;
            }
            const resolution = await this.verifyCandidates(domain, collected);
            this.putCache(resolution);
            return resolution;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onOuterAbort);
        }
    }

    /**
     * レコードをローカルに信託する（§13.5）。**検証は必ず通す** — 検証に失敗した
     * レコードは保存しない。
     */
    async remember(
        input: DomainOwnershipRecord | unknown,
        options: { domain?: string } = {},
    ): Promise<DomainVerifyResult> {
        const record = await parseDomainOwnershipRecord(input);
        if (options.domain !== undefined) {
            const expected = normalizeDomainName(options.domain);
            if (expected !== record.body.domain) {
                return {
                    ok: false,
                    code: 'zone-mismatch',
                    message: `record is for ${record.body.domain}, not ${expected}`,
                };
            }
        }
        const proof = await this.verifyRecord(record.body.domain, record);
        if (proof.ok) this.stored.set(record.body.domain, record);
        else this.stored.delete(record.body.domain);
        return proof;
    }

    /**
     * 収集元を参照せず、呼び出し側が持てる候補だけを権威で検証して解決する（§13.5）。
     *
     * `NameServer` が既知ノードの `wantOwnership` 応答から集めた候補をここに流す。
     * 成否はキャッシュされる（§13.5 の TTL 規則に従い、失敗は短い TTL）。
     */
    async settleCandidates(
        input: string,
        records: readonly DomainOwnershipRecord[],
        options: { skipCache?: boolean } = {},
    ): Promise<DomainResolution> {
        const verdict = classifyName(input);
        if (!verdict.ok) {
            return { ok: false, domain: String(input), code: verdict.code, message: verdict.message };
        }
        const domain = verdict.domain;
        if (!options.skipCache) {
            const cached = this.cache.get(domain);
            if (cached && cached.expiresAt > Date.now()) return cached.resolution;
        }
        const candidates = records
            .slice(0, this.maxRecordsPerDomain)
            .map((record) => ({ record, via: 'candidate' }));
        const resolution = await this.verifyCandidates(domain, candidates);
        this.putCache(resolution);
        return resolution;
    }

    /**
     * レコードをローカルストアへ信託する（§13.5 の `register`）。検証に成功した場合のみ保存し、
     * 解決結果と同じ形の値を返す。
     */
    async register(
        input: DomainOwnershipRecord | unknown,
        options: { domain?: string } = {},
    ): Promise<DomainResolution> {
        const record = await parseDomainOwnershipRecord(input);
        const proof = await this.remember(record, options);
        const domain = record.body.domain;
        if (!proof.ok) {
            return {
                ok: false,
                domain,
                code: proof.code,
                message: proof.message ?? domainProofCodeToReason(proof.code),
                record,
                proof,
            };
        }
        return {
            ok: true,
            domain,
            nodeId: record.body.nodeId,
            record,
            proof,
            candidates: 1,
            via: 'local',
        };
    }

    /** ローカル信託とキャッシュを捨てる。 */
    forget(name: string): boolean {
        let removed = false;
        try {
            const domain = normalizeDomainName(name);
            if (this.stored.delete(domain)) removed = true;
            void this.ownStore;
            if (this.cache.delete(domain)) removed = true;
        } catch {
            return false;
        }
        return removed;
    }

    /** 待機中の問い合わせを取り消し、以後の解決を拒否する。 */
    close(): void {
        this.closed = true;
        this.cache.clear();
    }

    /**
     * `IPublicKeyResolver`（§10.4.3）と同じ契約で公開鍵を返す bridge。
     *
     * 収集元から引いたレコードのうち**検証に成功したもの**が该当 NodeId を束縛していれば、
     * その `ownerPublicKey` を返す。レコードが無い・検証に失敗した場合は `inner` へ委譲する
     * （§13.5 の bridge。検証失敗の束縛を鍵配布に流用してはならない MUST NOT）。
     */
    createPublicKeyResolver(inner?: IPublicKeyResolver | null): IPublicKeyResolver {
        const authority = this;
        const resolver: IPublicKeyResolver = {
            async getPublicKey(nodeId: string): Promise<Uint8Array | null> {
                const verified = await authority.findVerifiedRecordFor(nodeId);
                if (verified) {
                    const publicKey = decodePublicKey(verified.body.ownerPublicKey);
                    if (publicKey && (await deriveNodeId(publicKey)) === nodeId) return publicKey;
                    authority.logger.warn(
                        `domain record for ${nodeId} carries a public key that does not match its fingerprint`,
                    );
                    return null;
                }
                return inner ? inner.getPublicKey(nodeId) : null;
            },
        };
        if (inner?.waitForPublicKey) {
            resolver.waitForPublicKey = (id: string, timeoutMs?: number): Promise<Uint8Array | null> =>
                (inner.waitForPublicKey as (nodeId: string, ms?: number) => Promise<Uint8Array | null>)(
                    id,
                    timeoutMs,
                );
        }
        return resolver;
    }

    /** 该当 NodeId を束縛する検証済みレコードを 1 件探す（鍵配布用の制限付き解決）。 */
    async findVerifiedRecordFor(
        nodeId: NodeId,
        context: DomainSourceContext = {},
    ): Promise<DomainOwnershipRecord | null> {
        if (!this.enabled || !isNodeId(nodeId)) return null;
        const usable: IDomainRecordSource[] = [this.ownStore];
        if (this.local) usable.push(this.local);
        usable.push(...this.sources);
        if (this.peers) usable.push(this.peers);
        for (const source of usable) {
            if (!source.lookupByNodeId) continue;
            let records: readonly DomainOwnershipRecord[];
            try {
                records = await withTimeout(
                    Promise.resolve(source.lookupByNodeId(nodeId)),
                    this.remaining(context),
                    source.name ?? 'source',
                );
            } catch (error) {
                this.logger.debug(`domain source lookup for ${nodeId} failed: ${String(error)}`);
                continue;
            }
            for (const record of records.slice(0, this.maxRecordsPerDomain)) {
                if (record.body.nodeId !== nodeId) continue;
                const proof = await this.verifyRecord(record.body.domain, record);
                if (proof.ok) return record;
                this.logger.warn(
                    `refusing to distribute a public key from ${record.body.domain}: ${
                        proof.message ?? proof.code
                    }`,
                );
                return null;
            }
        }
        return null;
    }

    /** すべての収集元へ並列に問い合わせ、候補を集める（1 件の停滞が全体を止めてはならない MUST NOT）。 */
    private async collect(
        domain: string,
        context: DomainSourceContext,
    ): Promise<{ record: DomainOwnershipRecord; via: string }[]> {
        const usable: IDomainRecordSource[] = [this.ownStore];
        if (this.local) usable.push(this.local);
        usable.push(...this.sources);
        if (this.peers) usable.push(this.peers);
        const out: { record: DomainOwnershipRecord; via: string }[] = [];
        await Promise.all(
            usable.map(async (source) => {
                const label = source.name ?? 'source';
                try {
                    const found = await withTimeout(
                        Promise.resolve(source.lookupByDomain(domain, context)),
                        this.remaining(context),
                        label,
                    );
                    if (!found) return;
                    const list = Array.isArray(found) ? found : [found as DomainOwnershipRecord];
                    for (const candidate of list.slice(0, this.maxRecordsPerDomain)) {
                        out.push({ record: candidate, via: label });
                    }
                } catch (error) {
                    this.logger.debug(`domain source "${label}" failed for ${domain}: ${String(error)}`);
                }
            }),
        );
        return out;
    }

    private remaining(context: DomainSourceContext): number {
        const budget = context.deadline ? context.deadline - Date.now() : this.queryTimeoutMs;
        return Math.max(1, Math.min(this.queryTimeoutMs, budget));
    }

    /** 候補を検証し、勝者を決める（specification.md §13.4 / §13.4.3）。 */
    private async verifyCandidates(
        domain: string,
        candidates: readonly { record: DomainOwnershipRecord; via: string }[],
    ): Promise<DomainResolution> {
        const accepted: {
            record: DomainOwnershipRecord;
            proof: DomainVerifyResult;
            via: string;
            commitment: string;
        }[] = [];
        let lastFailure: DomainResolution | null = null;
        for (const candidate of candidates) {
            const proof = await this.verifyRecord(domain, candidate.record, {
                via: candidate.via,
            });
            if (proof.ok) {
                accepted.push({
                    record: candidate.record,
                    proof,
                    via: candidate.via,
                    commitment: proof.commitment ?? (await commitDomainRecord(candidate.record.body)),
                });
                continue;
            }
            lastFailure = {
                ok: false,
                domain,
                code: proof.code,
                message: proof.message ?? domainProofCodeToReason(proof.code),
                record: candidate.record,
                proof,
            };
        }
        if (accepted.length === 0) {
            return (
                lastFailure ?? {
                    ok: false,
                    domain,
                    code: 'resolution-unavailable',
                    message: `no ownership record found for ${domain}`,
                }
            );
        }
        // 勝者選択: max(serial) -> 最小 leafIndex -> conflict
        let winner = accepted[0] as (typeof accepted)[number];
        for (const rival of accepted.slice(1)) {
            const verdict = conflictVerdict(
                {
                    serial: winner.record.body.serial,
                    commitment: winner.commitment,
                    anchorLeafIndex: winner.record.anchor?.leafIndex,
                },
                {
                    serial: rival.record.body.serial,
                    commitment: rival.commitment,
                    anchorLeafIndex: rival.record.anchor?.leafIndex,
                },
            );
            if (verdict === 'conflict') {
                return {
                    ok: false,
                    domain,
                    code: 'conflict',
                    message:
                        `unresolved ownership conflict for ${domain}: ` +
                        `serial ${winner.record.body.serial} (${winner.via}) vs ${rival.record.body.serial} (${rival.via})`,
                    record: rival.record,
                    proof: rival.proof,
                };
            }
            if (verdict === 'candidate') winner = rival;
        }
        const success: DomainResolutionSuccess = {
            ok: true,
            domain,
            nodeId: winner.record.body.nodeId,
            record: winner.record,
            proof: winner.proof,
            candidates: accepted.length,
            via: winner.via,
        };
        if (winner.record.body.port !== undefined) success.port = winner.record.body.port;
        if (winner.record.anchor) success.pinnedCheckpoint = winner.record.anchor.checkpoint;
        if (this.pinCheckpoints) this.state.observe(winner.record);
        this.logger.debug(
            `domain ${domain} resolved to ${winner.record.body.nodeId} ` +
                `(serial ${winner.record.body.serial}, via ${winner.via}, anchor=${
                    winner.proof.anchorVerified ? 'verified' : 'none'
                })`,
        );
        return success;
    }

    /**
     * 検証器を 1 回通す（§13.4）。収集元名はログにだけ使う（成否には影響しない）。
     * 呼び出し側が既に候補を持っている場合（`NameServer` の応答など）に使う。
     */
    async verifyRecord(
        domain: string,
        record: DomainOwnershipRecord,
        extra: { via?: string } = {},
    ): Promise<DomainVerifyResult> {
        if (!this.verifier) {
            this.logger.warn(
                'domain ownership verifier is disabled; accepting an unverified record (experimental mode)',
            );
            return { ok: true, code: 'ok' };
        }
        const context: DomainVerifyContext = {
            expectedDomain: domain,
            knownSerial: this.state.knownSerial(domain),
        };
        if (record.anchor && this.pinCheckpoints) {
            context.pinnedCheckpoint = this.state.pinnedCheckpoint(record.anchor.checkpoint.logId);
            if (context.pinnedCheckpoint && this.checkpointChain) {
                context.checkpointChain = this.checkpointChain;
            }
        }
        const proof = await this.verifier.verify(record, context);
        if (extra.via) this.logger.debug(`domain proof via ${extra.via}: ${proof.code}`);
        return proof;
    }

    private putCache(resolution: DomainResolution): void {
        const now = Date.now();
        for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
        while (this.cache.size >= this.maxCacheEntries) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
        const ttl = resolution.ok ? this.cacheTtlMs : this.negativeTtlMs;
        if (ttl <= 0) return;
        this.cache.set(resolution.domain, { resolution, expiresAt: now + ttl });
    }
}

/** {@link DomainAuthority} のファクトリ。 */
export function createDomainAuthority(options: DomainAuthorityOptions = {}): DomainAuthority {
    return new DomainAuthority(options);
}

/**
 * 配列／Map から作るインメモリ収集元（テスト・ローカル信託用、specification.md §14.4）。
 *
 * 追加時に構造検証だけを行う（署名検証は解決時に権威が実施する）。
 */
export function memoryDomainRecordSource(
    options: {
        records?: readonly (DomainOwnershipRecord | unknown)[];
        logger?: Logger;
    } = {},
): IDomainRecordSource & {
    put(record: DomainOwnershipRecord | unknown): Promise<void>;
    remove(domain: string): boolean;
    list(): DomainOwnershipRecord[];
} {
    const records = new Map<string, DomainOwnershipRecord>();
    const log = options.logger;
    const put = async (input: DomainOwnershipRecord | unknown): Promise<void> => {
        const parsed = await parseDomainOwnershipRecord(input);
        records.set(parsed.body.domain, parsed);
    };
    const ready = Promise.all(
        (options.records ?? []).map(async (record) => {
            try {
                await put(record);
            } catch (error) {
                log?.warn(`memoryDomainRecordSource: rejected a record (${String(error)})`);
            }
        }),
    );
    return {
        name: 'memory',
        async lookupByDomain(domain) {
            await ready;
            const found = records.get(domain);
            return found ? [found] : null;
        },
        async lookupByNodeId(nodeId) {
            await ready;
            return [...records.values()].filter((record) => record.body.nodeId === nodeId);
        },
        async put(record) {
            await ready;
            await put(record);
        },
        remove(domain) {
            return records.delete(domain);
        },
        list() {
            return [...records.values()].sort((a, b) => (a.body.domain < b.body.domain ? -1 : 1));
        },
    };
}

/** 複数の収集元を 1 つに束ねる（§13.5 の収集順を明示的に組み立てるためのヘルパ）。 */
export function chainDomainRecordSources(
    sources: readonly (IDomainRecordSource | null | undefined)[],
): IDomainRecordSource {
    const usable = sources.filter((source): source is IDomainRecordSource => Boolean(source));
    return {
        name: 'chain',
        async lookupByDomain(domain, context) {
            const out: DomainOwnershipRecord[] = [];
            for (const source of usable) {
                const found = await source.lookupByDomain(domain, context);
                if (!found) continue;
                if (Array.isArray(found)) out.push(...(found as readonly DomainOwnershipRecord[]));
                else out.push(found as DomainOwnershipRecord);
            }
            return out.length > 0 ? out : null;
        },
        async lookupByNodeId(nodeId) {
            const out: DomainOwnershipRecord[] = [];
            for (const source of usable) {
                if (!source.lookupByNodeId) continue;
                out.push(...(await source.lookupByNodeId(nodeId)));
            }
            return out;
        },
    };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new Error(`domain source "${label}" exceeded its deadline`));
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`domain source "${label}" query timed out`)),
            timeoutMs,
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
}

function positiveInt(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}
