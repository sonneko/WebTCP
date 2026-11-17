/**
 * `HTTPClient`（specification.md §15.4 / design.md §3.26）。
 *
 * `webtcp://` URL（または NodeId + 仮想ポート）へ HTTP/1.1 リクエストを送る。
 * - `fetch` 風の API（`fetch(url, init)` / `request({ nodeId, port, ... })`）
 * - `webtcp://` の `path` + `search` を request-target へ写像（§15.6）
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
    connect(remoteId: string, remotePort: VirtualPort, localPort?: VirtualPort): Promise<HTTPStreamLike>;
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
    stream: HTTPStreamLike;
    reader: HTTPMessageReader;
    lastUsed: number;
    busy: boolean;
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
    private readonly limits: HTTPParserLimits;
    private readonly nameServer: NameServer | null;
    private readonly pool = new Map<string, PooledConnection>();
    private closed = false;

    constructor(network: HTTPClientNetwork, options: HTTPClientOptions = {}) {
        this.network = network;
        this.nameServer = options.nameServer ?? null;
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
        this.keepAlive = options.keepAlive !== false;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
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
        for (const entry of this.pool.values()) {
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
            const pooled = this.pool.get(key);
            if (pooled && !pooled.busy && this.isUsable(pooled)) {
                pooled.busy = true;
                return { stream: pooled.stream, reader: pooled.reader, pooled };
            }
            if (pooled && !pooled.busy) {
                // アイドル期限切れ、または相手が FIN を送ってきた（サーバーの idle timeout 等）
                pooled.reader.dispose();
                try {
                    (pooled.stream as SendCapableStream).destroy?.();
                } catch {
                    /* 無視 */
                }
                this.pool.delete(key);
            }
            if (pooled && !pooled.busy) {
                pooled.reader.dispose();
                try {
                    (pooled.stream as SendCapableStream).destroy?.();
                } catch {
                    /* 無視 */
                }
                this.pool.delete(key);
            }
        }

        if (signal?.aborted) throw new HTTPAbortError();
        const stream =
            'nodeId' in input && typeof input.nodeId === 'string'
                ? await this.network.connect(input.nodeId, input.port)
                : await this.network.connectURL(formatWebTCPUrl((input as HTTPClientUrlRequest).url), {
                      ...(this.nameServer ? { nameServer: this.nameServer } : {}),
                      ...(signal ? { signal } : {}),
                  });
        const reader = new HTTPMessageReader(stream, { limits: this.limits, label: 'client' });
        if (!keepAlive) return { stream, reader, pooled: null };
        const entry: PooledConnection = { stream, reader, lastUsed: Date.now(), busy: true };
        this.pool.set(key, entry);
        return { stream, reader, pooled: entry };
    }

    /** プール済み接続がまだ使えるか（状態とアイドル時間の両方を見る）。 */
    private isUsable(pooled: PooledConnection): boolean {
        if (Date.now() - pooled.lastUsed > this.idleTimeoutMs) return false;
        const state = (pooled.stream as { state?: string }).state;
        // `CLOSE_WAIT` は相手の FIN 受信済み、`CLOSED` は終了済み。どちらも再利用できない。
        if (state === undefined) return true;
        return state === 'ESTABLISHED';
    }

    private release(
        key: string,
        acquired: { stream: HTTPStreamLike; reader: HTTPMessageReader; pooled: PooledConnection | null },
        keep: boolean,
    ): void {
        if (!keep) {
            if (acquired.pooled && this.pool.get(key) === acquired.pooled) this.pool.delete(key);
            acquired.reader.dispose();
            try {
                (acquired.stream as SendCapableStream).end?.();
            } catch {
                /* 無視 */
            }
            return;
        }
        const pooled = acquired.pooled ?? this.pool.get(key);
        if (pooled && pooled.stream === acquired.stream) {
            pooled.busy = false;
            pooled.lastUsed = Date.now();
        } else {
            // プールに載っていない接続（keepAlive=false で作った）は閉じる
            acquired.reader.dispose();
            try {
                (acquired.stream as SendCapableStream).end?.();
            } catch {
                /* 無視 */
            }
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
