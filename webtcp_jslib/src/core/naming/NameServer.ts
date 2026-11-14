import type { WebTCPNetwork } from '../network/WebTCPNetwork.js';
import { isValidNodeId } from '../routing/keys.js';
import { NodeId, VirtualPort } from '../types/protocol.js';
import type { VirtualStream } from '../transport/VirtualStream.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { normalizeWebTCPName } from './url.js';

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
    source: 'local' | 'cache' | 'remote';
    /** Names traversed, including the queried name and final A name. */
    chain: string[];
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
    logger?: Logger;
}

export interface ResolveOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
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
interface QueryMessage { protocol: 1; type: 'query'; id: string; name: string }
interface AnswerMessage { protocol: 1; type: 'answer'; id: string; name: string; record: NameRecord }
interface ErrorMessage { protocol: 1; type: 'error'; id: string; name: string; code: 'NXDOMAIN' | 'INVALID' }

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Application-layer NameServer (specification.md §12). Local registrations are
 * authoritative; remote answers are iterative, TTL-cached hints, not global
 * ownership proofs. Uses signed VirtualStreams on a configurable virtual port.
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
    private readonly local = new Map<string, NameRecord>();
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
    }

    public get cacheSize(): number { return this.cache.size; }
    public get localSize(): number { return this.local.size; }

    public registerA(name: string, nodeId: NodeId, ttlMs = this.defaultTtlMs): void {
        const normalized = normalizeWebTCPName(name);
        if (!isValidNodeId(nodeId)) throw new Error(`invalid A record NodeId: ${nodeId}`);
        this.assertOpen();
        this.local.set(normalized, { type: 'A', name: normalized, target: nodeId, ttlMs: validTtl(ttlMs) });
        this.cache.delete(normalized);
    }

    public registerCNAME(name: string, target: string, ttlMs = this.defaultTtlMs): void {
        const normalized = normalizeWebTCPName(name);
        const canonical = normalizeWebTCPName(target);
        if (normalized === canonical) throw new NameLoopError(normalized);
        this.assertOpen();
        this.local.set(normalized, { type: 'CNAME', name: normalized, target: canonical, ttlMs: validTtl(ttlMs) });
        this.cache.delete(normalized);
    }

    public unregister(name: string): boolean {
        const normalized = normalizeWebTCPName(name);
        this.cache.delete(normalized);
        return this.local.delete(normalized);
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
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = (): void => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) controller.abort();
        const deadline = Date.now() + timeoutMs;
        const visited = new Set<string>();
        const chain: string[] = [];
        let current = original;
        let ttlMs = MAX_NAME_TTL_MS;
        let source: NameResolution['source'] = 'local';
        try {
            for (let depth = 0; depth <= this.maxCnameDepth; depth += 1) {
                if (controller.signal.aborted) {
                    if (options.signal?.aborted) throw new Error('WebTCP name resolution aborted');
                    throw new NameResolutionTimeoutError(original);
                }
                if (visited.has(current)) throw new NameLoopError(current);
                visited.add(current);
                chain.push(current);
                const found = this.lookup(current);
                let record: NameRecord;
                if (found) {
                    record = found.record;
                    ttlMs = Math.min(ttlMs, found.ttlMs);
                    if (found.source === 'cache' && source === 'local') source = 'cache';
                } else {
                    const remote = await this.queryKnownNodes(current, controller.signal, deadline);
                    if (!remote) throw new NameNotFoundError(current);
                    record = remote;
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
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            this.controllers.delete(controller);
        }
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

    private async queryKnownNodes(name: string, signal: AbortSignal, deadline: number): Promise<NameRecord | null> {
        const candidates = this.knownNodes();
        let next = 0;
        let answer: NameRecord | null = null;
        const worker = async (): Promise<void> => {
            while (!signal.aborted && answer === null && next < candidates.length) {
                const nodeId = candidates[next++]!;
                try {
                    const record = await this.queryNode(nodeId, name, signal, deadline);
                    if (record && answer === null) answer = record;
                } catch (error) {
                    if (signal.aborted) return;
                    this.logger.debug(`Name query to ${nodeId} failed:`, error);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.queryConcurrency, candidates.length) }, () => worker()));
        if (signal.aborted) return null;
        return answer;
    }

    private async queryNode(nodeId: NodeId, name: string, signal: AbortSignal, deadline: number): Promise<NameRecord | null> {
        const remaining = Math.min(this.queryTimeoutMs, deadline - Date.now());
        if (remaining <= 0 || signal.aborted) throw new Error('query deadline exceeded');
        const controller = new AbortController();
        let stream: VirtualStream | null = null;
        const onAbort = (): void => { controller.abort(); stream?.destroy(); };
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { controller.abort(); stream?.destroy(); }, remaining);
        const id = randomId();
        try {
            stream = await this.network.connect(nodeId, this.port);
            if (controller.signal.aborted) { stream.destroy(); throw new Error('query aborted'); }
            this.active.add(stream);
            const request: QueryMessage = { protocol: 1, type: 'query', id, name };
            const responsePromise = readMessage(stream, MAX_NAME_MESSAGE_BYTES);
            await stream.send(JSON.stringify(request));
            stream.end();
            const response = await responsePromise;
            return parseResponse(response, id, name);
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            if (stream) { this.active.delete(stream); stream.destroy(); }
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
            const response: AnswerMessage | ErrorMessage = record
                ? { protocol: 1, type: 'answer', id: request.id, name: request.name, record }
                : { protocol: 1, type: 'error', id: request.id, name: request.name, code: 'NXDOMAIN' };
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

function parseQuery(raw: Uint8Array): QueryMessage {
    const value = JSON.parse(decoder.decode(raw)) as Partial<QueryMessage>;
    if (value.protocol !== 1 || value.type !== 'query' || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64 || typeof value.name !== 'string') {
        throw new Error('invalid name query');
    }
    return { protocol: 1, type: 'query', id: value.id, name: normalizeWebTCPName(value.name) };
}

function parseResponse(raw: Uint8Array, id: string, name: string): NameRecord | null {
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
    if (record.type === 'A') {
        if (!isValidNodeId(record.target)) throw new Error('invalid A target');
        return { type: 'A', name, target: record.target, ttlMs: record.ttlMs };
    }
    if (record.type === 'CNAME') {
        return { type: 'CNAME', name, target: normalizeWebTCPName(record.target), ttlMs: record.ttlMs };
    }
    throw new Error('unknown record type');
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
