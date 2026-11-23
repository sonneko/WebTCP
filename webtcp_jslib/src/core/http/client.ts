/**
 * `HTTPClient`（specification.md §16.4 / design.md §3.26）。
 *
 * `webtcp://` URL（または NodeId + 仮想ポート）へ HTTP/1.1 リクエストを送る。
 * - `fetch` 風の API（`fetch(url, init)` / `request({ nodeId, port, ... })`）
 * - `webtcp://` の `path` + `search` を request-target へ写像（§16.6）
 * - `(nodeId, port)` 単位の `keep-alive` プール（逐次・非パイプライン）
 * - ストリーミング本文（`AsyncIterable`）と、読み切る補助 API（`text` / `json` / `arrayBuffer`）
 */

import type { NameServer } from '../naming/NameServer.js';
import { WebTCPUrl, formatWebTCPUrl, parseWebTCPUrl } from '../naming/url.js';
import type { VirtualPort } from '../types/protocol.js';
import type { Logger } from '../util/Logger.js';
import { HTTPBodyStream, type HTTPBodySource } from './body.js';
import {
    HTTPAbortError,
    HTTPConnectionClosedError,
    HTTPError,
    HTTPTimeoutError,
} from './errors.js';
import { HTTPHeaders, type HTTPResponse, statusTextFor } from './message.js';
import { determineResponseFraming, type HTTPParserLimits } from './parser.js';
import { HTTPMessageReader, type HTTPStreamLike } from './reader.js';
import { connectionHasToken, encodeChunk, encodeChunkedEnd, serializeHTTPRequest } from './writer.js';

/** `HTTPClient` が要求するネットワーク機能（`WebTCPNetwork` のサブセット）。 */
export interface HTTPClientNetwork {
    readonly localNodeId: string;
    connect(
        remoteId: string,
        remotePort: VirtualPort,
        localPort?: VirtualPort,
        options?: { signal?: AbortSignal },
    ): Promise<HTTPStreamLike>;
    connectURL(
        url: string | WebTCPUrl,
        options?: { nameServer?: NameServer; signal?: AbortSignal },
    ): Promise<HTTPStreamLike>;
}

/** リクエスト本文。 */
export type HTTPClientBody = string | Uint8Array | AsyncIterable<Uint8Array>;

/** `fetch` / `request` の共通オプション。 */
export interface HTTPClientRequestOptions {
    method?: string;
    headers?: HTTPHeaders | Record<string, string | string[]>;
    body?: HTTPClientBody;
    /** 応答ヘッダ到着までのタイムアウト（ms）。既定は `HTTPClient.timeoutMs`。 */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** このリクエストだけ `keep-alive` を無効にする。 */
    keepAlive?: boolean;
}

/** `request()` の引数（NodeId 直指定）。 */
export interface HTTPClientDirectRequest extends HTTPClientRequestOptions {
    nodeId: string;
    port: VirtualPort;
    /** リクエストターゲット（`/path?query`）。 */
    path: string;
    /** ローカルポート（任意）。 */
    localPort?: VirtualPort;
}

/** `request()` の引数（URL 指定。名前解決は `nameServer` で行う）。 */
export interface HTTPClientUrlRequest extends HTTPClientRequestOptions {
    url: WebTCPUrl;
    localPort?: VirtualPort;
}

export interface HTTPClientOptions {
    /** 名前解決に使う NameServer（URL 指定で名前を使う場合に必須）。 */
    nameServer?: NameServer;
    /** 応答ヘッダ到着までのタイムアウト（ms）。既定 30 000。 */
    timeoutMs?: number;
    /** `text()` / `json()` / `arrayBuffer()` の上限（バイト）。既定 8 MiB。`0` で無制限。 */
    maxResponseBytes?: number;
    /** `keep-alive` を使うか。既定 `true`。 */
    keepAlive?: boolean;
    /** `keep-alive` 接続のアイドルタイムアウト（ms）。既定 30 000。 */
    idleTimeoutMs?: number;
    /**
     * 接続プールの上限（接続数）。既定 32。超えたらアイドル接続のうち最も古く使われたものを閉じる。
     * 使用中の接続は追い出さない（仕様 §16.5 の 9）。
     */
    maxPooledConnections?: number;
    /** パーサの上限。 */
    limits?: HTTPParserLimits;
    /** ロガー。 */
    logger?: Logger;
}

/** `network.fetchURL()` のオプション。 */
export interface FetchURLOptions extends HTTPClientRequestOptions {
    nameServer?: NameServer;
    maxResponseBytes?: number;
    localPort?: VirtualPort;
}

interface PooledConnection {
    key: string;
    stream: HTTPStreamLike;
    reader: HTTPMessageReader;
    lastUsed: number;
    busy: boolean;
    /** アイドル期限のタイマー（アイドル中だけ張る）。 */
    idleTimer: ReturnType<typeof setTimeout> | null;
    /** アイドル中に相手の `end` / `close` を検知するリスナー（使用に入るとき外す）。 */
    onPeerClose: (() => void) | null;
}

/** 接続プールの診断情報（`getPoolStats()`）。 */
export interface HTTPPoolStats {
    /** プールしている接続数（使用中を含む）。 */
    total: number;
    /** 使用中（リクエストの途中）の接続数。 */
    busy: number;
    /** アイドルの接続数。 */
    idle: number;
    /** 上限（`maxPooledConnections`）。 */
    max: number;
    /** LRU 追い出しの累計。 */
    evictedLru: number;
    /** アイドル期限切れによる回収の累計。 */
    expiredIdle: number;
    /** 相手からの切断（FIN / close）でプールから外した累計。 */
    closedByPeer: number;
}

type SendCapableStream = HTTPStreamLike & {
    send(data: Uint8Array): Promise<void>;
    end?(): void;
    destroy?(): void;
    on(event: string, fn: () => void): void;
    off(event: string, fn: () => void): void;
};

/**
 * `fetch` 風の HTTP/1.1 クライアント。
 *
 * 1 度に 1 リクエストだけを 1 接続で送る（パイプラインしない）。同時に `fetch()` が
 * 呼ばれた場合は新しい接続を作って並行に実行する。
 */
export class HTTPClient {
    private readonly network: HTTPClientNetwork;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly keepAlive: boolean;
    private readonly idleTimeoutMs: number;
    private readonly maxPooledConnections: number;
    private readonly limits: HTTPParserLimits;
    private readonly nameServer: NameServer | null;
    /** 挿入順を LRU 順（先頭が最も古い）として使う。 */
    private readonly pool = new Set<PooledConnection>();
    private readonly poolCounters = { evictedLru: 0, expiredIdle: 0, closedByPeer: 0 };
    private closed = false;

    constructor(network: HTTPClientNetwork, options: HTTPClientOptions = {}) {
        this.network = network;
        this.nameServer = options.nameServer ?? null;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
        this.keepAlive = options.keepAlive !== false;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
        const max = options.maxPooledConnections ?? 32;
        if (!Number.isInteger(max) || max <= 0) throw new Error('maxPooledConnections must be a positive integer');
        this.maxPooledConnections = max;
        this.limits = options.limits ?? {};
        void (options.logger as Logger | undefined);
    }

    /** `webtcp://` URL へ 1 リクエストを送る。 */
    public async fetch(url: string | WebTCPUrl, init: HTTPClientRequestOptions = {}): Promise<HTTPResponse> {
        this.assertOpen();
        const parsed = typeof url === 'string' ? parseWebTCPUrl(url) : parseWebTCPUrl(formatWebTCPUrl(url));
        if (parsed.nodeId) {
            return this.request({
                ...init,
                nodeId: parsed.nodeId,
                port: parsed.port,
                path: `${parsed.path}${parsed.search}`,
            });
        }
        return this.request({ ...init, url: parsed });
    }

    /** リクエストを送る。`nodeId` か `url` のどちらかを指定する。 */
    public async request(input: HTTPClientDirectRequest | HTTPClientUrlRequest): Promise<HTTPResponse> {
        this.assertOpen();
        const isDirect = 'nodeId' in input && typeof input.nodeId === 'string';
        const parsedUrl = isDirect ? null : (input as HTTPClientUrlRequest).url;
        const port = isDirect ? (input as HTTPClientDirectRequest).port : parsedUrl!.port;
        const target = isDirect
            ? normalizeTarget((input as HTTPClientDirectRequest).path)
            : `${parsedUrl!.path}${parsedUrl!.search}`;
        const method = (input.method ?? 'GET').toUpperCase();
        const keepAlive = input.keepAlive ?? this.keepAlive;
        const timeoutMs = input.timeoutMs ?? this.timeoutMs;
        const signal = input.signal;
        if (signal?.aborted) throw new HTTPAbortError();

        const key = isDirect
            ? `node:${(input as HTTPClientDirectRequest).nodeId}:${port}`
            : `url:${formatWebTCPUrl(parsedUrl!)}`;
        const host = isDirect
            ? `${(input as HTTPClientDirectRequest).nodeId}:${port}`
            : `${parsedUrl!.host}:${parsedUrl!.port}`;

        const acquired = await this.acquire(input, key, keepAlive, signal);
        const stream = acquired.stream as SendCapableStream;

        const headers =
            input.headers instanceof HTTPHeaders
                ? new HTTPHeaders(input.headers)
                : new HTTPHeaders(input.headers ?? {});
        if (!headers.has('host')) headers.set('host', host);

        // 本文のエンコード方針を決める
        const chunkedBody = isAsyncIterable(input.body);
        let payload: Uint8Array = new Uint8Array(0);
        if (typeof input.body === 'string') {
            if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
            payload = new TextEncoder().encode(input.body);
        } else if (input.body instanceof Uint8Array) {
            payload = input.body;
        }

        const headBytes = serializeHTTPRequest({
            method,
            target,
            headers,
            body: payload,
            ...(chunkedBody ? { contentLength: null, chunkedTerminator: false } : {}),
            connection: keepAlive ? 'keep-alive' : 'close',
            omitHost: true,
        });

        let settled = false;
        const release = (keep: boolean): void => {
            if (settled) return;
            settled = true;
            this.release(key, acquired, keep && keepAlive);
        };

        try {
            await withTimeout(stream.send(headBytes), timeoutMs, () => stream.destroy?.(), signal);
            if (chunkedBody) {
                const iterator = (input.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
                for (;;) {
                    const next = await iterator.next();
                    if (next.done) break;
                    const frame = encodeChunk(next.value);
                    if (frame.byteLength > 0) {
                        await withTimeout(stream.send(frame), timeoutMs, () => stream.destroy?.(), signal);
                    }
                }
                await withTimeout(stream.send(encodeChunkedEnd()), timeoutMs, () => stream.destroy?.(), signal);
            }

            const head = await withTimeout(
                acquired.reader.readHead(true),
                timeoutMs,
                () => stream.destroy?.(),
                signal,
            );
            if (!head) {
                throw new HTTPConnectionClosedError('connection closed before the response head arrived');
            }

            const status = head.startLine.status ?? 0;
            const statusText = head.startLine.statusText ?? statusTextFor(status);
            const responseHeaders = head.headers;
            const bodyless =
                method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
            const framing = bodyless ? ({ kind: 'none' } as const) : determineResponseFraming(responseHeaders);
            const closeAfter = connectionHasToken(responseHeaders, 'close');

            let bodySubscription: { dispose: () => void } | null = null;
            const source: HTTPBodySource = {
                onData: (listener) => {
                    bodySubscription = acquired.reader.streamBody(listener);
                },
                onEnd: (listener) => {
                    stream.on('end', listener);
                },
                onClose: (listener) => {
                    stream.on('close', listener);
                },
                off: (event, listener) => {
                    if (event === 'data') {
                        bodySubscription?.dispose();
                        bodySubscription = null;
                        return;
                    }
                    stream.off(event, listener as () => void);
                },
                pause: () => {
                    acquired.reader.pause();
                },
                resume: () => {
                    acquired.reader.resume();
                },
            };
            const body = new HTTPBodyStream(source, {
                framing,
                maxBytes: this.maxResponseBytes,
            });
            if (framing.kind === 'none') {
                // 本文が無い応答は即座に接続を返せる
                release(!closeAfter);
            } else {
                body.onceDone((ok) => release(ok && !closeAfter));
            }

            return {
                status,
                statusText,
                headers: responseHeaders,
                body,
                ok: status >= 200 && status < 300,
                text: () => body.text(),
                json: <T = unknown>() => body.json<T>(),
                arrayBuffer: () => body.arrayBuffer(),
            };
        } catch (error) {
            release(false);
            if (error instanceof HTTPError) throw error;
            if (signal?.aborted) throw new HTTPAbortError();
            throw error;
        }
    }

    /** 接続プールを閉じる。 */
    public close(): void {
        this.closed = true;
        for (const entry of [...this.pool]) {
            this.detachIdle(entry);
            entry.reader.dispose();
            try {
                (entry.stream as SendCapableStream).destroy?.();
            } catch {
                /* 無視 */
            }
        }
        this.pool.clear();
    }

    /** プールしている接続数（診断用）。 */
    public get pooledConnectionCount(): number {
        return this.pool.size;
    }

    /** プールの内訳と累計（診断用）。 */
    public getPoolStats(): HTTPPoolStats {
        let busy = 0;
        for (const entry of this.pool) if (entry.busy) busy += 1;
        return {
            total: this.pool.size,
            busy,
            idle: this.pool.size - busy,
            max: this.maxPooledConnections,
            evictedLru: this.poolCounters.evictedLru,
            expiredIdle: this.poolCounters.expiredIdle,
            closedByPeer: this.poolCounters.closedByPeer,
        };
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('HTTPClient is closed');
    }

    private async acquire(
        input: HTTPClientDirectRequest | HTTPClientUrlRequest,
        key: string,
        keepAlive: boolean,
        signal?: AbortSignal,
    ): Promise<{ stream: HTTPStreamLike; reader: HTTPMessageReader; pooled: PooledConnection | null }> {
        if (keepAlive) {
            // 同キーのアイドル接続を、新しいものから順に探す。使えないものはその場で外す。
            for (const entry of [...this.pool].reverse()) {
                if (entry.key !== key || entry.busy) continue;
                const reason = this.unusableReason(entry);
                if (reason !== null) {
                    this.drop(entry, reason);
                    continue;
                }
                this.detachIdle(entry);
                entry.busy = true;
                this.touch(entry);
                return { stream: entry.stream, reader: entry.reader, pooled: entry };
            }
        }

        if (signal?.aborted) throw new HTTPAbortError();
        const stream =
            'nodeId' in input && typeof input.nodeId === 'string'
                ? await this.network.connect(input.nodeId, input.port, undefined, signal ? { signal } : {})
                : await this.network.connectURL(formatWebTCPUrl((input as HTTPClientUrlRequest).url), {
                      ...(this.nameServer ? { nameServer: this.nameServer } : {}),
                      ...(signal ? { signal } : {}),
                  });
        const reader = new HTTPMessageReader(stream, { limits: this.limits, label: 'client' });
        if (!keepAlive) return { stream, reader, pooled: null };
        if (this.closed) {
            // 接続中に close() された場合は、プールに載せずに閉じる
            reader.dispose();
            try {
                (stream as SendCapableStream).destroy?.();
            } catch {
                /* 無視 */
            }
            throw new Error('HTTPClient is closed');
        }
        const entry: PooledConnection = {
            key,
            stream,
            reader,
            lastUsed: Date.now(),
            busy: true,
            idleTimer: null,
            onPeerClose: null,
        };
        this.pool.add(entry);
        this.enforceCap();
        return { stream, reader, pooled: entry };
    }

    /** アイドル接続が今も使えるか。使えない理由（期限切れ・相手による切断）を返す。使えるなら `null`。 */
    private unusableReason(entry: PooledConnection): 'expiredIdle' | 'closedByPeer' | null {
        if (Date.now() - entry.lastUsed > this.idleTimeoutMs) return 'expiredIdle';
        const state = (entry.stream as { state?: string }).state;
        // `CLOSE_WAIT` は相手の FIN 受信済み、`CLOSED` は終了済み。どちらも再利用できない。
        if (state !== undefined && state !== 'ESTABLISHED') return 'closedByPeer';
        return null;
    }

    private release(
        key: string,
        acquired: { stream: HTTPStreamLike; reader: HTTPMessageReader; pooled: PooledConnection | null },
        keep: boolean,
    ): void {
        const entry = acquired.pooled;
        if (!keep || !entry) {
            if (entry) this.drop(entry, 'closed', false);
            else this.endUnpooled(acquired);
            return;
        }
        if (!this.pool.has(entry) || this.closed) {
            this.drop(entry, 'closed', false);
            return;
        }
        // 同キーのアイドルが既にあれば、余分な接続は戻さない（仕様 §16.5 の 10）
        for (const other of this.pool) {
            if (other !== entry && other.key === key && !other.busy) {
                this.drop(entry, 'closed', false);
                return;
            }
        }
        entry.busy = false;
        this.touch(entry);
        this.armIdle(entry);
        this.enforceCap();
    }

    /** 上限を超えたら、アイドルだけを最も古く使われたもの（LRU）から閉じる（仕様 §16.5 の 9）。 */
    private enforceCap(): void {
        while (this.pool.size > this.maxPooledConnections) {
            let victim: PooledConnection | null = null;
            for (const entry of this.pool) {
                if (!entry.busy) {
                    victim = entry;
                    break;
                }
            }
            // 使用中しか無い間は一時的に上限を超えてよい
            if (victim === null) return;
            this.drop(victim, 'lru');
        }
    }

    /** LRU 順で末尾（最近使用）へ移す。 */
    private touch(entry: PooledConnection): void {
        this.pool.delete(entry);
        entry.lastUsed = Date.now();
        this.pool.add(entry);
    }

    /** アイドルになった接続に期限タイマーと相手切断の監視を付ける。 */
    private armIdle(entry: PooledConnection): void {
        this.detachIdle(entry);
        const timer = setTimeout(() => {
            if (!entry.busy && this.pool.has(entry)) this.drop(entry, 'expiredIdle');
        }, this.idleTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
        entry.idleTimer = timer;
        const onPeerClose = (): void => {
            if (!entry.busy && this.pool.has(entry)) this.drop(entry, 'closedByPeer');
        };
        entry.onPeerClose = onPeerClose;
        entry.stream.on('end', onPeerClose);
        entry.stream.on('close', onPeerClose);
    }

    /** アイドル用のタイマーと監視を外す（使用に入るとき、または破棄するとき）。 */
    private detachIdle(entry: PooledConnection): void {
        if (entry.idleTimer !== null) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        if (entry.onPeerClose !== null) {
            entry.stream.off('end', entry.onPeerClose);
            entry.stream.off('close', entry.onPeerClose);
            entry.onPeerClose = null;
        }
    }

    /**
     * プールから外して閉じる。理由ごとに累計を増やす（`counted` が false なら増やさない）。
     */
    private drop(
        entry: PooledConnection,
        reason: 'lru' | 'expiredIdle' | 'closedByPeer' | 'closed',
        counted = true,
    ): void {
        this.detachIdle(entry);
        this.pool.delete(entry);
        if (counted) {
            if (reason === 'lru') this.poolCounters.evictedLru += 1;
            else if (reason === 'expiredIdle') this.poolCounters.expiredIdle += 1;
            else if (reason === 'closedByPeer') this.poolCounters.closedByPeer += 1;
        }
        entry.reader.dispose();
        try {
            // 相手がもう閉じている接続には RST、それ以外は FIN で終える
            if (reason === 'closedByPeer') (entry.stream as SendCapableStream).destroy?.();
            else (entry.stream as SendCapableStream).end?.();
        } catch {
            /* 無視 */
        }
    }

    /** プールに載せなかった接続（`keepAlive: false`）を閉じる。 */
    private endUnpooled(acquired: { stream: HTTPStreamLike; reader: HTTPMessageReader }): void {
        acquired.reader.dispose();
        try {
            (acquired.stream as SendCapableStream).end?.();
        } catch {
            /* 無視 */
        }
    }

}

function normalizeTarget(path: string): string {
    if (path.length === 0) return '/';
    return path.startsWith('/') ? path : `/${path}`;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
    );
}

/** タイムアウト付きで Promise を待つ（`signal` でも中断できる）。 */
function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
    signal?: AbortSignal,
): Promise<T> {
    if (timeoutMs <= 0 && !signal) return promise;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer =
            timeoutMs > 0
                ? setTimeout(() => {
                      if (settled) return;
                      settled = true;
                      onTimeout();
                      reject(new HTTPTimeoutError(`HTTP response did not arrive within ${timeoutMs}ms`));
                  }, timeoutMs)
                : null;
        (timer as { unref?: () => void } | null)?.unref?.();

        const cleanup = (): void => {
            if (timer !== null) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            onTimeout();
            reject(new HTTPAbortError());
        };
        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            },
            (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            },
        );
    });
}
