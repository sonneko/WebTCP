import type { WebTCPNetwork } from '../network/WebTCPNetwork.js';
import { isValidNodeId } from '../routing/keys.js';
import { NodeId, VirtualPort } from '../types/protocol.js';
import type { VirtualStream } from '../transport/VirtualStream.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { normalizeWebTCPName } from './url.js';
import { isDomainGlobalName } from '../domain/names.js';
import { DomainOwnershipError, DomainResolutionUnavailableError } from '../domain/errors.js';
import {
    domainRecordToJSON,
    parseDomainOwnershipRecord,
    type DomainOwnershipRecord,
} from '../domain/record.js';
import {
    createDomainOwnershipVerifier,
    type DomainVerifyResult,
    type IDomainOwnershipVerifier,
} from '../domain/verifier.js';
import type { DomainAuthority, DomainResolution } from '../domain/authority.js';

export const DEFAULT_NAME_SERVER_PORT = 5300;
export const DEFAULT_NAME_TTL_MS = 60_000;
export const MAX_NAME_TTL_MS = 86_400_000;
export const MAX_NAME_MESSAGE_BYTES = 16 * 1024;

export type NameRecordType = 'A' | 'CNAME';

export interface NameRecord {
    type: NameRecordType;
    name: string;
    /** NodeId for A, canonical name for CNAME. */
    target: string;
    ttlMs: number;
}

export interface NameResolution {
    name: string;
    nodeId: NodeId;
    /** Remaining TTL of the answer chain in milliseconds. */
    ttlMs: number;
    /** `'domain'` = 所有権レコードを検証済みの `domain.global` 解決（specification.md §13.5）。 */
    source: 'local' | 'cache' | 'remote' | 'domain';
    /** Names traversed, including the queried name and final A name. */
    chain: string[];
    /** 検証に使用した所有権レコード（ゾーン内名前のときのみ）。 */
    record?: DomainOwnershipRecord;
    /** 所有権検証の結果（`source === 'domain'` / ローカル信託時のみ）。 */
    proof?: DomainVerifyResult;
}

export interface NameServerOptions {
    port?: VirtualPort;
    defaultTtlMs?: number;
    queryTimeoutMs?: number;
    resolveTimeoutMs?: number;
    maxCnameDepth?: number;
    maxCacheEntries?: number;
    maxQueriedNodes?: number;
    queryConcurrency?: number;
    /** Explicit resolver NodeIds queried before neighbors and routing-table destinations. */
    resolvers?: NodeId[];
    /**
     * `domain.global` の権威（specification.md §13.5）。
     * 未指定の場合、ゾーン内名前の**解決**は `DomainResolutionUnavailableError` で失敗し、
     * ローカル検証（署名・指紋・有効期間）でのみ `registerDomain()` が使える。
     */
    domains?: DomainAuthority | null;
    logger?: Logger;
}

export interface ResolveOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface RegisterDomainOptions {
    /** 応答に添える A レコードの TTL。既定はレコード残存期間（上限 86 400 000 ms）。 */
    ttlMs?: number;
}

export class NameNotFoundError extends Error {
    constructor(public readonly queryName: string) {
        super(`WebTCP name not found: ${queryName}`);
        this.name = 'NameNotFoundError';
    }
}

export class NameResolutionTimeoutError extends Error {
    constructor(public readonly queryName: string) {
        super(`WebTCP name resolution timed out: ${queryName}`);
        this.name = 'NameResolutionTimeoutError';
    }
}

export class NameLoopError extends Error {
    constructor(public readonly queryName: string) {
        super(`WebTCP name loop or CNAME depth exceeded: ${queryName}`);
        this.name = 'NameLoopError';
    }
}

interface CacheEntry { record: NameRecord; expiresAt: number }
interface QueryMessage { protocol: 1; type: 'query'; id: string; name: string; wantOwnership?: true }
interface AnswerMessage {
    protocol: 1;
    type: 'answer';
    id: string;
    name: string;
    record: NameRecord;
    ownership?: unknown[];
}
interface ErrorMessage { protocol: 1; type: 'error'; id: string; name: string; code: 'NXDOMAIN' | 'INVALID' }

/** 1 ノードからの応答（所有権レコードは 0 件以上）。 */
interface NameAnswer {
    record: NameRecord;
    ownership: DomainOwnershipRecord[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Application-layer NameServer (specification.md §12). Local registrations are
 * authoritative; remote answers are iterative, TTL-cached hints, not global
 * ownership proofs. Uses signed VirtualStreams on a configurable virtual port.
 *
 * `domain.global` 内の名前は §13 に従い、常に所有権レコードの検証を伴う。
 */
export class NameServer {
    public readonly port: VirtualPort;
    private readonly network: WebTCPNetwork;
    private readonly defaultTtlMs: number;
    private readonly queryTimeoutMs: number;
    private readonly resolveTimeoutMs: number;
    private readonly maxCnameDepth: number;
    private readonly maxCacheEntries: number;
    private readonly maxQueriedNodes: number;
    private readonly queryConcurrency: number;
    private readonly resolvers: NodeId[];
    private readonly logger: Logger;
    private readonly domains: DomainAuthority | null;
    private readonly localVerifier: IDomainOwnershipVerifier;
    private readonly local = new Map<string, NameRecord>();
    private readonly ownership = new Map<string, DomainOwnershipRecord>();
    private readonly cache = new Map<string, CacheEntry>();
    private readonly active = new Set<VirtualStream>();
    private readonly controllers = new Set<AbortController>();
    private listening = false;
    private closed = false;

    constructor(network: WebTCPNetwork, options: NameServerOptions = {}) {
        this.network = network;
        this.port = options.port ?? DEFAULT_NAME_SERVER_PORT;
        assertPort(this.port);
        this.defaultTtlMs = validTtl(options.defaultTtlMs ?? DEFAULT_NAME_TTL_MS);
        this.queryTimeoutMs = positive(options.queryTimeoutMs ?? 2000, 'queryTimeoutMs');
        this.resolveTimeoutMs = positive(options.resolveTimeoutMs ?? 5000, 'resolveTimeoutMs');
        this.maxCnameDepth = positiveInt(options.maxCnameDepth ?? 8, 'maxCnameDepth');
        this.maxCacheEntries = positiveInt(options.maxCacheEntries ?? 1024, 'maxCacheEntries');
        this.maxQueriedNodes = positiveInt(options.maxQueriedNodes ?? 16, 'maxQueriedNodes');
        this.queryConcurrency = positiveInt(options.queryConcurrency ?? 4, 'queryConcurrency');
        this.resolvers = (options.resolvers ?? []).map((id) => {
            if (!isValidNodeId(id)) throw new Error(`invalid resolver NodeId: ${id}`);
            return id;
        });
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'NS');
        this.domains = options.domains ?? null;
        // 権威が未指定でも、ローカル登録（自分のレコード）の検証は行う (§13.4)。
        this.localVerifier = createDomainOwnershipVerifier({});
    }

    public get cacheSize(): number { return this.cache.size; }
    public get localSize(): number { return this.local.size; }
    /** 使用中の `domain.global` 権威（無ければ `null`）。 */
    public get domainAuthority(): DomainAuthority | null { return this.domains; }

    public registerA(name: string, nodeId: NodeId, ttlMs = this.defaultTtlMs): void {
        const normalized = normalizeWebTCPName(name);
        assertNotZoneName(normalized);
        if (!isValidNodeId(nodeId)) throw new Error(`invalid A record NodeId: ${nodeId}`);
        this.assertOpen();
        this.local.set(normalized, { type: 'A', name: normalized, target: nodeId, ttlMs: validTtl(ttlMs) });
        this.cache.delete(normalized);
    }

    public registerCNAME(name: string, target: string, ttlMs = this.defaultTtlMs): void {
        const normalized = normalizeWebTCPName(name);
        assertNotZoneName(normalized);
        const canonical = normalizeWebTCPName(target);
        if (normalized === canonical) throw new NameLoopError(normalized);
        this.assertOpen();
        this.local.set(normalized, { type: 'CNAME', name: normalized, target: canonical, ttlMs: validTtl(ttlMs) });
        this.cache.delete(normalized);
    }

    public unregister(name: string): boolean {
        const normalized = normalizeWebTCPName(name);
        this.cache.delete(normalized);
        const owned = this.ownership.delete(normalized);
        const removed = this.local.delete(normalized);
        return removed || owned;
    }

    /**
     * 所有権レコードからゾーン内名前の提供を始める（specification.md §12.2 / §13.5）。
     *
     * 検証 → ローカル A レコード登録 → 応答用レコードの保管の順で行い、
     * **検証に失敗したレコードは登録しない** (MUST)。
     */
    public async registerDomain(
        input: DomainOwnershipRecord | unknown,
        options: RegisterDomainOptions = {},
    ): Promise<DomainResolution> {
        this.assertOpen();
        const parsed = await parseDomainOwnershipRecord(input);
        const resolution = this.domains
            ? await this.domains.register(parsed)
            : await verifyWith(this.localVerifier, parsed);
        if (!resolution.ok) {
            this.logger.warn(`registerDomain rejected ${parsed.body.domain}: ${resolution.message}`);
            return resolution;
        }
        const remaining = resolution.record.body.expiresAt - Date.now();
        if (remaining <= 0) {
            return {
                ok: false,
                domain: resolution.domain,
                code: 'expired',
                message: `ownership record for ${resolution.domain} is already expired`,
                record: resolution.record,
            };
        }
        // 名前レコードの TTL は §12.1 の上限 (86 400 000 ms) とレコード残存期間の小さいほう。
        const ttlMs = validTtl(Math.min(options.ttlMs ?? remaining, remaining, MAX_NAME_TTL_MS));
        this.local.set(resolution.domain, {
            type: 'A',
            name: resolution.domain,
            target: resolution.record.body.nodeId,
            ttlMs,
        });
        this.ownership.set(resolution.domain, resolution.record);
        this.cache.delete(resolution.domain);
        this.logger.info(
            `registered ${resolution.domain} -> ${resolution.record.body.nodeId} (serial ${resolution.record.body.serial})`,
        );
        return resolution;
    }

    /** ゾーン内名前の提供を取り消す。 */
    public unregisterDomain(domain: string): boolean {
        const normalized = normalizeWebTCPName(domain);
        if (!isDomainGlobalName(normalized)) throw new Error(`${normalized} is not a domain.global name`);
        this.cache.delete(normalized);
        const owned = this.ownership.delete(normalized);
        const removed = this.local.delete(normalized);
        return owned || removed;
    }

    /** このサーバーが所有権レコード付きで提供している名前の一覧。 */
    public servedDomainRecords(): DomainOwnershipRecord[] {
        return [...this.ownership.values()].sort((a, b) => (a.body.domain < b.body.domain ? -1 : 1));
    }

    public clearCache(): void { this.cache.clear(); }

    /** Register the service handler on the network. Idempotent. */
    public listen(): void {
        this.assertOpen();
        if (this.listening) return;
        this.network.listen(this.port, (stream) => { void this.handleStream(stream); });
        this.listening = true;
    }

    /** Stop serving and abort outstanding queries; does not close the network. */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.listening) {
            this.network.transportLayer.unlisten(this.port);
            this.listening = false;
        }
        for (const controller of [...this.controllers]) controller.abort();
        for (const stream of [...this.active]) stream.destroy();
        this.active.clear();
    }

    public async resolve(input: string, options: ResolveOptions = {}): Promise<NameResolution> {
        this.assertOpen();
        const original = normalizeWebTCPName(input);
        const controller = new AbortController();
        this.controllers.add(controller);
        const timeoutMs = positive(options.timeoutMs ?? this.resolveTimeoutMs, 'timeoutMs');
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const onAbort = (): void => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) controller.abort();
        const deadline = Date.now() + timeoutMs;
        // デッドラインと中断は絶対である (MUST, §12.2 / #40): 問い合わせ先が
        // `connect()` で宙吊りになっても、この guard が reject して解決を打ち切る。
        let rejectGuard: ((error: Error) => void) | null = null;
        const guard = new Promise<never>((_, reject) => {
            rejectGuard = reject;
        });
        const abortGuard = (): void => {
            rejectGuard?.(
                timedOut
                    ? new NameResolutionTimeoutError(original)
                    : new Error('WebTCP name resolution aborted'),
            );
        };
        controller.signal.addEventListener('abort', abortGuard, { once: true });
        if (controller.signal.aborted) abortGuard();
        try {
            return await Promise.race([
                this.resolveChain(original, controller.signal, deadline),
                guard,
            ]);
        } finally {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', abortGuard);
            options.signal?.removeEventListener('abort', onAbort);
            this.controllers.delete(controller);
        }
    }

    private async resolveChain(
        original: string,
        signal: AbortSignal,
        deadline: number,
    ): Promise<NameResolution> {
        const visited = new Set<string>();
        const chain: string[] = [];
        let current = original;
        let ttlMs = MAX_NAME_TTL_MS;
        let source: NameResolution['source'] = 'local';
        for (let depth = 0; depth <= this.maxCnameDepth; depth += 1) {
            if (signal.aborted) {
                if (Date.now() >= deadline) throw new NameResolutionTimeoutError(original);
                throw new Error('WebTCP name resolution aborted');
            }
            if (visited.has(current)) throw new NameLoopError(current);
            visited.add(current);
            chain.push(current);
            const found = this.lookup(current);
            if (found && isDomainGlobalName(current)) {
                // ローカル登録でも所有権レコードの再検証（失効・焼却）を必須とする (§13.4)。
                const owned = this.ownership.get(current);
                if (!owned) {
                    throw new DomainResolutionUnavailableError(
                        current,
                        `${current} is registered locally without an ownership record`,
                    );
                }
                return this.finishDomain(original, current, owned, chain, Math.min(ttlMs, found.ttlMs), 'local');
            }
            let record: NameRecord;
            if (found) {
                record = found.record;
                ttlMs = Math.min(ttlMs, found.ttlMs);
                if (found.source === 'cache' && source === 'local') source = 'cache';
            } else if (isDomainGlobalName(current)) {
                return this.resolveDomainName(original, current, chain, signal, deadline, ttlMs);
            } else {
                const answers = await this.queryKnownNodes(current, signal, deadline, false);
                const answer = answers[0];
                if (!answer) throw new NameNotFoundError(current);
                record = answer.record;
                source = 'remote';
                ttlMs = Math.min(ttlMs, record.ttlMs);
                this.putCache(record);
            }
            if (record.type === 'A') {
                return { name: original, nodeId: record.target, ttlMs, source, chain };
            }
            current = normalizeWebTCPName(record.target);
        }
        throw new NameLoopError(original);
    }

    /**
     * `domain.global` 名の解決（specification.md §13.5）。
     *
     * (1) 権威自身の収集元（HTTP レジストリ等）、(2) 既知ノードの `wantOwnership` 応答、
     * の順で候補を集め、**検証を通った候補のみ**で勝者を決める。
     */
    private async resolveDomainName(
        original: string,
        domain: string,
        chain: string[],
        signal: AbortSignal,
        deadline: number,
        ttlMs: number,
    ): Promise<NameResolution> {
        if (!this.domains) {
            throw new DomainResolutionUnavailableError(
                domain,
                `resolving ${domain} requires a DomainAuthority (NameServerOptions.domains, §13.5)`,
            );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new NameResolutionTimeoutError(original);
        const authorityOutcome: DomainResolution = await this.domains.settle(domain, {
            signal,
            timeoutMs: remaining,
        });
        if (authorityOutcome.ok) {
            return this.toResolution(original, authorityOutcome, chain, ttlMs);
        }
        const answers = await this.queryKnownNodes(domain, signal, deadline, true);
        const candidates = collectOwnershipCandidates(answers);
        if (candidates.length === 0) {
            if (authorityOutcome.code !== 'resolution-unavailable') {
                throw new DomainOwnershipError(domain, authorityOutcome.code, authorityOutcome.message);
            }
            throw new NameNotFoundError(domain);
        }
        const resolution = await this.domains.settleCandidates(domain, candidates);
        if (!resolution.ok) {
            throw new DomainOwnershipError(domain, resolution.code, resolution.message);
        }
        return this.toResolution(original, resolution, chain, ttlMs);
    }

    /** ローカル登録済みのゾーン名を再検証して解決結果へ変換する（§13.4 の失効・焼却確認）。 */
    private async finishDomain(
        original: string,
        domain: string,
        record: DomainOwnershipRecord,
        chain: string[],
        ttlMs: number,
        source: 'local',
    ): Promise<NameResolution> {
        const proof = this.domains
            ? await this.domains.verifyRecord(domain, record)
            : await this.localVerifier.verify(record, { expectedDomain: domain });
        if (!proof.ok) {
            throw new DomainOwnershipError(domain, proof.code, proof.message);
        }
        return { name: original, nodeId: record.body.nodeId, ttlMs, source, chain, record, proof };
    }

    private toResolution(
        original: string,
        resolution: DomainResolution,
        chain: string[],
        ttlMs: number,
        source: NameResolution['source'] = 'domain',
    ): NameResolution {
        if (!resolution.ok) {
            throw new DomainOwnershipError(resolution.domain, resolution.code, resolution.message);
        }
        const recordTtl = resolution.record.body.expiresAt - Date.now();
        return {
            name: original,
            nodeId: resolution.nodeId,
            ttlMs: Math.max(1, Math.min(ttlMs, recordTtl)),
            source,
            chain,
            record: resolution.record,
            proof: resolution.proof,
        };
    }

    private lookup(name: string): { record: NameRecord; ttlMs: number; source: 'local' | 'cache' } | null {
        const local = this.local.get(name);
        if (local) return { record: local, ttlMs: local.ttlMs, source: 'local' };
        const cached = this.cache.get(name);
        if (!cached) return null;
        const remaining = cached.expiresAt - Date.now();
        if (remaining <= 0) { this.cache.delete(name); return null; }
        return { record: cached.record, ttlMs: remaining, source: 'cache' };
    }

    private putCache(record: NameRecord): void {
        if (record.ttlMs <= 0) return;
        const now = Date.now();
        for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
        while (this.cache.size >= this.maxCacheEntries) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
        this.cache.set(record.name, { record, expiresAt: now + record.ttlMs });
    }

    private knownNodes(): NodeId[] {
        const ids = [...this.resolvers, ...this.network.getNeighbors(), ...this.network.getRoutingTable().getAllEntries().keys()];
        return [...new Set(ids)].filter((id) => id !== this.network.localNodeId && isValidNodeId(id)).slice(0, this.maxQueriedNodes);
    }

    /**
     * 既知ノードへ問い合わせる。`wantOwnership` 時は**全応答を集める**（候補の競合解決に使うため）。
     * 単一ノードの停滞が全体を遅らせてはならない (MUST NOT, §12.2 / #40) ので、
     * 応答は `queryTimeoutMs` と `deadline` の早いほうで打ち切る。
     */
    private async queryKnownNodes(
        name: string,
        signal: AbortSignal,
        deadline: number,
        wantOwnership: boolean,
    ): Promise<NameAnswer[]> {
        const candidates = this.knownNodes();
        if (candidates.length === 0) return [];
        let next = 0;
        const answers: NameAnswer[] = [];
        const collectAll = wantOwnership;
        const worker = async (): Promise<void> => {
            while (!signal.aborted && Date.now() < deadline && (collectAll || answers.length === 0)) {
                const nodeId = candidates[next++];
                if (nodeId === undefined) return;
                try {
                    const answer = await this.queryNode(nodeId, name, signal, deadline, wantOwnership);
                    if (answer && (collectAll || answers.length === 0)) answers.push(answer);
                } catch (error) {
                    if (signal.aborted) return;
                    this.logger.debug(`Name query to ${nodeId} failed:`, error);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.queryConcurrency, candidates.length) }, () => worker()));
        return answers;
    }

    private async queryNode(
        nodeId: NodeId,
        name: string,
        signal: AbortSignal,
        deadline: number,
        wantOwnership: boolean,
    ): Promise<NameAnswer | null> {
        const remaining = Math.min(this.queryTimeoutMs, deadline - Date.now());
        if (remaining <= 0 || signal.aborted) throw new Error('query deadline exceeded');
        const controller = new AbortController();
        // `stream` は非同期の `connect()` 完了後に入るため、制御流れ解析に頼まないよう箱に入れる。
        const holder: { stream: VirtualStream | null } = { stream: null };
        let timedOut = false;
        const onAbort = (): void => {
            controller.abort();
            holder.stream?.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const id = randomId();
        // `connect()` 自体は中断を受け取れない (#44) ため、宙吊りもここで打ち切る。
        const attempt = (async (): Promise<NameAnswer | null> => {
            holder.stream = await this.network.connect(nodeId, this.port);
            const stream = holder.stream;
            if (controller.signal.aborted) { stream.destroy(); throw new Error('query aborted'); }
            this.active.add(stream);
            const request: QueryMessage = {
                protocol: 1,
                type: 'query',
                id,
                name,
                ...(wantOwnership ? { wantOwnership: true } : {}),
            };
            const responsePromise = readMessage(stream, MAX_NAME_MESSAGE_BYTES);
            await stream.send(JSON.stringify(request));
            stream.end();
            return parseResponse(await responsePromise, id, name);
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const outcome = await Promise.race([
                attempt,
                new Promise<'deadline'>((resolve) => {
                    timer = setTimeout(() => resolve('deadline'), remaining);
                }),
            ]);
            if (outcome === 'deadline') {
                timedOut = true;
                controller.abort();
                holder.stream?.destroy();
                // 後から届いたストリームは必ず閉じる（リーク防止）。
                void attempt.catch(() => undefined).then(() => {
                    const late = holder.stream;
                    if (late) { this.active.delete(late); late.destroy(); }
                });
                throw new Error('query timed out');
            }
            return outcome;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            const opened = holder.stream;
            if (opened && !timedOut) { this.active.delete(opened); opened.destroy(); }
        }
    }

    private async handleStream(stream: VirtualStream): Promise<void> {
        this.active.add(stream);
        try {
            const raw = await readMessage(stream, MAX_NAME_MESSAGE_BYTES);
            let request: QueryMessage;
            try {
                request = parseQuery(raw);
            } catch {
                await this.respond(stream, { protocol: 1, type: 'error', id: '', name: '', code: 'INVALID' });
                return;
            }
            const record = this.local.get(request.name);
            if (!record) {
                await this.respond(stream, { protocol: 1, type: 'error', id: request.id, name: request.name, code: 'NXDOMAIN' });
                return;
            }
            const isZoneName = isDomainGlobalName(request.name);
            const owned = isZoneName ? this.ownership.get(request.name) : undefined;
            if (isZoneName && !owned) {
                // 所有権レコード無しでゾーン内名前に応答してはならない (MUST NOT, §12.2)。
                await this.respond(stream, { protocol: 1, type: 'error', id: request.id, name: request.name, code: 'NXDOMAIN' });
                return;
            }
            const response: AnswerMessage = {
                protocol: 1,
                type: 'answer',
                id: request.id,
                name: request.name,
                record,
                ...(owned ? { ownership: [domainRecordToJSON(owned)] } : {}),
            };
            await this.respond(stream, response);
        } catch (error) {
            this.logger.debug('NameServer stream failed:', error);
            stream.destroy();
        } finally {
            this.active.delete(stream);
        }
    }

    private async respond(stream: VirtualStream, response: AnswerMessage | ErrorMessage): Promise<void> {
        const data = encoder.encode(JSON.stringify(response));
        if (data.byteLength > MAX_NAME_MESSAGE_BYTES) throw new Error('NameServer response too large');
        await stream.send(data);
        stream.end();
    }

    private assertOpen(): void { if (this.closed) throw new Error('NameServer is closed'); }
}

/** `domain.global` のラベルを持つ名前はローカル登録できない (MUST NOT, §12.1)。 */
function assertNotZoneName(name: string): void {
    if (isDomainGlobalName(name)) {
        throw new Error(
            `"${name}" belongs to the ${'domain.global'} zone and cannot be registered with registerA()/registerCNAME(); ` +
                'use registerDomain() with a signed ownership record (specification.md §12.1 / §13.5)',
        );
    }
}

async function verifyWith(
    verifier: IDomainOwnershipVerifier,
    record: DomainOwnershipRecord,
): Promise<DomainResolution> {
    const proof = await verifier.verify(record, { expectedDomain: record.body.domain });
    if (proof.ok) {
        return {
            ok: true,
            domain: record.body.domain,
            nodeId: record.body.nodeId,
            record,
            proof,
            candidates: 1,
            via: 'local',
        };
    }
    return {
        ok: false,
        domain: record.body.domain,
        code: proof.code,
        message: proof.message ?? 'domain ownership verification failed',
        record,
        proof,
    };
}

/** 応答から解決に使える候補だけを抜き出す（`A` 応答の target と一致するレコードのみ）。 */
function collectOwnershipCandidates(answers: readonly NameAnswer[]): DomainOwnershipRecord[] {
    const out: DomainOwnershipRecord[] = [];
    const seen = new Set<string>();
    for (const answer of answers) {
        if (answer.record.type !== 'A') continue;
        for (const record of answer.ownership) {
            if (record.body.domain !== answer.record.name) continue;
            if (record.body.nodeId !== answer.record.target) continue;
            const key = `${record.body.domain}/${record.body.serial}/${record.signature}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(record);
        }
    }
    return out;
}

function parseQuery(raw: Uint8Array): QueryMessage {
    const value = JSON.parse(decoder.decode(raw)) as Partial<QueryMessage>;
    if (value.protocol !== 1 || value.type !== 'query' || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64 || typeof value.name !== 'string') {
        throw new Error('invalid name query');
    }
    const name = normalizeWebTCPName(value.name);
    return {
        protocol: 1,
        type: 'query',
        id: value.id,
        name,
        ...(value.wantOwnership === true && isDomainGlobalName(name) ? { wantOwnership: true } : {}),
    };
}

async function parseResponse(raw: Uint8Array, id: string, name: string): Promise<NameAnswer | null> {
    const value = JSON.parse(decoder.decode(raw)) as Record<string, unknown>;
    if (value.protocol !== 1 || value.id !== id || value.name !== name) throw new Error('mismatched name response');
    if (value.type === 'error') {
        if (value.code === 'NXDOMAIN') return null;
        throw new Error('invalid name query response');
    }
    if (value.type !== 'answer' || typeof value.record !== 'object' || value.record === null) throw new Error('invalid name answer');
    const record = value.record as Record<string, unknown>;
    if (record.name !== name || typeof record.target !== 'string' || typeof record.ttlMs !== 'number' || !Number.isInteger(record.ttlMs) || record.ttlMs < 0 || record.ttlMs > MAX_NAME_TTL_MS) {
        throw new Error('invalid name record');
    }
    let parsed: NameRecord;
    if (record.type === 'A') {
        if (!isValidNodeId(record.target)) throw new Error('invalid A target');
        parsed = { type: 'A', name, target: record.target, ttlMs: record.ttlMs };
    } else if (record.type === 'CNAME') {
        parsed = { type: 'CNAME', name, target: normalizeWebTCPName(record.target), ttlMs: record.ttlMs };
    } else {
        throw new Error('unknown record type');
    }
    const ownership = await parseOwnershipAnswer(value.ownership, name, parsed, isDomainGlobalName(name));
    return { record: parsed, ownership };
}

/**
 * 応答の `ownership` 配列を厳格検証する（specification.md §12.2 / §13.2）。
 *
 * ゾーン内名前の応答に所有権レコードが無い場合、その応答は解決に**使用できない** (MUST NOT)。
 */
async function parseOwnershipAnswer(
    value: unknown,
    name: string,
    record: NameRecord,
    isZoneName: boolean,
): Promise<DomainOwnershipRecord[]> {
    if (value === undefined) {
        if (isZoneName) {
            throw new Error(`answer for ${name} carries no ownership record (required by §12.2)`);
        }
        return [];
    }
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('ownership answer must be a non-empty array');
    }
    const out: DomainOwnershipRecord[] = [];
    for (const entry of value) {
        const parsed = await parseDomainOwnershipRecord(entry);
        if (parsed.body.domain !== name) throw new Error('ownership record name mismatch');
        if (record.type === 'A' && parsed.body.nodeId !== record.target) {
            throw new Error('ownership record does not bind the answered NodeId');
        }
        out.push(parsed);
    }
    return out;
}

function readMessage(stream: VirtualStream, maxBytes: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const cleanup = (): void => {
            stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); stream.off('close', onClose);
        };
        const onData = (chunk: Uint8Array): void => {
            size += chunk.byteLength;
            if (size > maxBytes) { cleanup(); stream.destroy(); reject(new Error('NameServer message too large')); return; }
            chunks.push(new Uint8Array(chunk));
        };
        const onEnd = (): void => {
            cleanup();
            const out = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
            resolve(out);
        };
        const onError = (error: Error): void => { cleanup(); reject(error); };
        const onClose = (): void => { cleanup(); reject(new Error('NameServer stream closed before EOF')); };
        stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError); stream.on('close', onClose);
    });
}

function randomId(): string {
    const bytes = new Uint8Array(8);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function validTtl(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > MAX_NAME_TTL_MS) throw new Error(`ttlMs must be an integer in 0..${MAX_NAME_TTL_MS}`);
    return value;
}
function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
}
function positiveInt(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}
function assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid NameServer port: ${port}`);
}
