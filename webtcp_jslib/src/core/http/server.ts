/**
 * `HTTPServer`（specification.md §16.3 / design.md §3.26）。
 *
 * 仮想ポートで `VirtualStream` を待ち受け、接続ごとに逐次リクエストループを回す。
 * - `keep-alive`（既定）と `Connection: close`（FIN 後も応答を書ける）
 * - ハンドラ未応答は `500`、パース失敗は `4xx`
 * - 同時接続上限・アイドルタイムアウト・`server.close()` での一括中断
 */

import type { VirtualPort } from '../types/protocol.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { HTTPBodyStream, type HTTPBodySource } from './body.js';
import { HTTPError } from './errors.js';
import {
    HTTPHeaders,
    type HTTPHandler,
    type HTTPResponseWriter,
    type HTTPRequest as HTTPRequestMessage,
    KNOWN_HTTP_METHODS,
    splitTarget,
    statusTextFor,
} from './message.js';
import type { HTTPParserLimits } from './parser.js';
import { HTTPMessageReader, type HTTPStreamLike } from './reader.js';
import { connectionHasToken, encodeChunk, encodeChunkedEnd, serializeHTTPResponse } from './writer.js';

/** `HTTPServer` が要求するネットワーク機能（`WebTCPNetwork` のサブセット）。 */
export interface HTTPServerNetwork {
    readonly localNodeId: string;
    listen(port: VirtualPort, handler: (stream: HTTPStreamLike) => void): void;
    transportLayer: { unlisten(port: VirtualPort): boolean };
}

export interface HTTPServerOptions {
    /** 同時接続数の上限。既定 64。 */
    maxConnections?: number;
    /** アイドル接続のタイムアウト（ms）。既定 30 000。`0` で無効。 */
    idleTimeoutMs?: number;
    /** パーサの上限（§16.2.1）。 */
    limits?: HTTPParserLimits;
    /** 最大リクエスト本文（バイト）。既定 `0`（無制限、ストリーミング）。 */
    maxRequestBodyBytes?: number;
    /** `Expect: 100-continue` を自動応答するか。既定 `false`（§16.2.2）。 */
    send100Continue?: boolean;
    /** サーバー名（`Server` ヘッダ）。既定 `webtcp`。`''` で付与しない。 */
    serverName?: string;
    /** ロガー。 */
    logger?: Logger;
}

/** 接続 1 本の状態。 */
interface Connection {
    readonly reader: HTTPMessageReader;
    readonly stream: HTTPStreamLike;
    readonly remoteNodeId: string;
    closed: boolean;
    idleTimer: ReturnType<typeof setTimeout> | null;
    /** 読み取り中のリクエスト本文（接続終了時に打ち切る）。 */
    currentBody: HTTPBodyStream | null;
    /** ストリームを実際に閉じたか（`end()` / `destroy()` の二重呼び出し防止）。 */
    streamShutdown: boolean;
}

/**
 * 仮想ポート上の HTTP/1.1 サーバー。
 *
 * `network.serveHTTP(port, handler)` が本クラスを組み立てる。
 */
export class HTTPServer {
    public readonly port: VirtualPort;
    private readonly network: HTTPServerNetwork;
    private readonly handler: HTTPHandler;
    private readonly options: Required<Omit<HTTPServerOptions, 'logger' | 'limits'>> & {
        limits: HTTPParserLimits;
    };
    private readonly logger: Logger;
    private readonly connections = new Set<Connection>();
    private listening = false;
    private closed = false;

    constructor(
        network: HTTPServerNetwork,
        port: VirtualPort,
        handler: HTTPHandler,
        options: HTTPServerOptions = {},
    ) {
        if (typeof handler !== 'function') {
            throw new TypeError('HTTPServer requires an HTTPHandler');
        }
        this.network = network;
        this.port = port;
        this.handler = handler;
        this.options = {
            maxConnections: options.maxConnections ?? 64,
            idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
            maxRequestBodyBytes: options.maxRequestBodyBytes ?? 0,
            send100Continue: options.send100Continue === true,
            serverName: options.serverName ?? 'webtcp',
            limits: options.limits ?? {},
        };
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'HTTP-SERVER');
    }

    /** 待ち受けを開始する（冪等）。 */
    public listen(): void {
        if (this.listening) return;
        if (this.closed) throw new Error('HTTPServer is closed');
        this.listening = true;
        this.network.listen(this.port, (stream) => {
            this.handleConnection(stream).catch((error) => {
                this.logger.warn(`connection handler failed on port ${this.port}:`, error);
            });
        });
    }

    /** 現在の接続数。 */
    public get connectionCount(): number {
        return this.connections.size;
    }

    /** 待ち受けを解除し、全接続を閉じる。 */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.listening = false;
        try {
            this.network.transportLayer.unlisten(this.port);
        } catch {
            /* すでに解除済み */
        }
        for (const connection of [...this.connections]) {
            this.closeConnection(connection, false);
        }
        this.connections.clear();
    }

    // ============================================================
    // 接続処理
    // ============================================================

    private async handleConnection(stream: HTTPStreamLike): Promise<void> {
        if (this.closed) {
            stream.destroy?.();
            return;
        }
        if (this.connections.size >= this.options.maxConnections) {
            this.logger.warn(
                `refusing an HTTP connection on port ${this.port}: maxConnections (${this.options.maxConnections}) reached`,
            );
            await this.writeStandalone(stream, 503, 'too many connections');
            return;
        }

        const remoteNodeId = (stream as { remoteNodeId?: string }).remoteNodeId ?? 'unknown';
        const reader = new HTTPMessageReader(stream, { limits: this.options.limits, label: 'server' });
        const connection: Connection = {
            reader,
            stream,
            remoteNodeId,
            closed: false,
            idleTimer: null,
            currentBody: null,
            streamShutdown: false,
        };
        this.connections.add(connection);
        this.touchIdle(connection);

        try {
            let keepAlive = true;
            while (keepAlive && !connection.closed && !this.closed) {
                const head = await reader.readHead(false);
                if (!head) break;
                this.touchIdle(connection);

                const start = head.startLine;
                const method = start.method ?? 'GET';
                const target = start.target ?? '/';
                const { path, query } = splitTarget(target);
                const headers = head.headers;

                // Host は必須（§16.2）
                if (!headers.has('host')) {
                    await this.respondError(connection, 400, 'missing Host header');
                    break;
                }
                if (!KNOWN_HTTP_METHODS.has(method)) {
                    await this.respondError(connection, 501, `unsupported method: ${method}`);
                    break;
                }
                if (method === 'CONNECT') {
                    await this.respondError(connection, 405, 'CONNECT is not supported by the WebTCP HTTP tunnel');
                    break;
                }
                const expect = headers.get('expect');
                if (expect && expect.toLowerCase() !== '100-continue') {
                    await this.respondError(connection, 417, 'unsupported Expect header');
                    break;
                }

                const bodyFraming = head.framing;
                const bodyMax = this.options.maxRequestBodyBytes;
                if (bodyMax > 0 && bodyFraming.kind === 'length' && bodyFraming.length > bodyMax) {
                    await this.respondError(connection, 413, `request body exceeds ${bodyMax} bytes`);
                    break;
                }

                // 本文の供給器（reader のバッファ + 以降のデータ）
                let bodySubscription: { dispose: () => void } | null = null;
                const events = stream as unknown as {
                    on: (event: string, fn: () => void) => void;
                    off: (event: string, fn: () => void) => void;
                };
                const source: HTTPBodySource = {
                    onData: (listener) => {
                        bodySubscription = reader.streamBody(listener);
                    },
                    onEnd: (listener) => {
                        events.on('end', listener);
                    },
                    onClose: (listener) => {
                        events.on('close', listener);
                    },
                    off: (event, listener) => {
                        if (event === 'data') {
                            bodySubscription?.dispose();
                            bodySubscription = null;
                            return;
                        }
                        events.off(event, listener as () => void);
                    },
                    pause: () => {
                        reader.pause();
                    },
                    resume: () => {
                        reader.resume();
                    },
                };

                if (expect && this.options.send100Continue) {
                    const sender = stream as unknown as { send(data: Uint8Array): Promise<void> };
                    await sender.send(new TextEncoder().encode('HTTP/1.1 100 Continue\r\n\r\n'));
                }

                const body = new HTTPBodyStream(source, {
                    framing: bodyFraming,
                    maxBytes: bodyMax > 0 ? bodyMax : 0,
                });
                connection.currentBody = body;

                const request: HTTPRequestMessage = {
                    method,
                    target,
                    path,
                    query,
                    headers,
                    httpVersion: 'HTTP/1.1',
                    remoteNodeId,
                    body,
                };

                let keepAliveRequested = !connectionHasToken(headers, 'close');
                const response = new ServerResponseWriter(
                    connection,
                    method === 'HEAD',
                    this.options.serverName,
                    !keepAliveRequested,
                );
                try {
                    await this.handler(request, response);
                } catch (error) {
                    this.logger.warn(`handler failed for ${method} ${target}:`, error);
                    if (!response.headersSent) {
                        response.statusCode = 500;
                        await response.end('internal server error');
                    } else if (!response.finished) {
                        // 応答開始済みならフレーミングが壊れている。接続を切る（§16.3）
                        connection.closed = true;
                    }
                }
                if (!response.finished && !connection.closed) {
                    if (!response.headersSent) {
                        response.statusCode = 500;
                        await response.end();
                    } else {
                        connection.closed = true;
                    }
                }

                // 本文を読み切っていなければ読み捨てる（keep-alive のフレーミング維持、§16.3）
                await drainBody(body);
                connection.currentBody = null;

                if (connection.closed) break;
                if (response.connectionClose) keepAliveRequested = false;
                if (!keepAliveRequested) break;
                keepAlive = true;
                this.touchIdle(connection);
            }
        } catch (error) {
            if (error instanceof HTTPError) {
                this.logger.warn(`HTTP ${error.status} on port ${this.port}: ${error.message}`);
                await this.respondError(connection, error.status || 400, error.message);
            } else {
                this.logger.warn(`HTTP connection error on port ${this.port}:`, error);
            }
        } finally {
            this.closeConnection(connection, false);
        }
    }

    /**
     * 1 接続を閉じる（冪等）。
     *
     * **常に `end()`（FIN）で閉じる。** `VirtualStream.destroy()` は RST も FIN も送らないため、
     * 使うと相手側のストリームが `ESTABLISHED` のまま残る（Half-Close の非対称）。
     * `force` のときだけ、ローカル資源を即座に解放するために `destroy()` する。
     */
    private closeConnection(connection: Connection, force = false): void {
        if (connection.streamShutdown && !this.connections.has(connection)) return;
        connection.closed = true;
        if (connection.idleTimer) {
            clearTimeout(connection.idleTimer);
            connection.idleTimer = null;
        }
        connection.currentBody?.abort();
        connection.currentBody = null;
        connection.reader.dispose();
        if (!connection.streamShutdown) {
            connection.streamShutdown = true;
            try {
                if (force) (connection.stream as unknown as { destroy?: () => void }).destroy?.();
                else (connection.stream as unknown as { end?: () => void }).end?.();
            } catch {
                /* 無視 */
            }
        }
        this.connections.delete(connection);
    }

    private touchIdle(connection: Connection): void {
        if (this.options.idleTimeoutMs <= 0) return;
        if (connection.idleTimer) clearTimeout(connection.idleTimer);
        connection.idleTimer = setTimeout(() => {
            this.logger.debug(`closing idle HTTP connection on port ${this.port}`);
            this.closeConnection(connection, false);
        }, this.options.idleTimeoutMs);
        (connection.idleTimer as { unref?: () => void }).unref?.();
    }

    /** パース前のエラーを 1 メッセージとして返す。 */
    private async respondError(connection: Connection, status: number, message: string): Promise<void> {
        if (connection.closed) return;
        try {
            const bytes = serializeHTTPResponse({
                status,
                headers: { 'content-type': 'text/plain; charset=utf-8', connection: 'close' },
                body: new TextEncoder().encode(message),
                connection: 'close',
            });
            const sender = connection.stream as unknown as { send?: (data: Uint8Array) => Promise<void> };
            if (!sender.send) return;
            await sender.send(bytes);
        } catch (error) {
            this.logger.debug('failed to send an HTTP error response:', error);
        }
    }

    private async writeStandalone(stream: HTTPStreamLike, status: number, message: string): Promise<void> {
        const sender = stream as unknown as { send?: (data: Uint8Array) => Promise<void> };
        if (!sender.send) {
            stream.destroy?.();
            return;
        }
        try {
            await sender.send(
                serializeHTTPResponse({
                    status,
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                    body: new TextEncoder().encode(message),
                    connection: 'close',
                }),
            );
        } catch (error) {
            this.logger.debug('failed to send the standalone response:', error);
        } finally {
            stream.destroy?.();
        }
    }
}

/** 応答本文を最後まで読んで捨てる（失敗は無視）。 */
async function drainBody(body: HTTPBodyStream): Promise<void> {
    try {
        for (;;) {
            const chunk = await body.read();
            if (chunk === null) return;
        }
    } catch {
        /* 途中で切れた場合は接続が閉じる */
    }
}

/**
 * サーバー側の応答ライタ（§16.3）。
 *
 * 初回 `write()` でヘッダを送る。`Content-Length` を指定せずに `write()` した場合は
 * `Transfer-Encoding: chunked` を使う。
 */
class ServerResponseWriter implements HTTPResponseWriter {
    public statusCode = 200;
    public headersSent = false;
    public finished = false;
    public connectionClose: boolean;

    private readonly headers = new HTTPHeaders();
    private chunked = false;
    private readonly headOnly: boolean;
    private readonly serverName: string;
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly connection: Connection,
        headOnly: boolean,
        serverName: string,
        closeAfterResponse: boolean,
    ) {
        this.headOnly = headOnly;
        this.serverName = serverName;
        this.connectionClose = connection.closed || closeAfterResponse;
    }

    public setHeader(name: string, value: string | string[]): void {
        if (this.headersSent) throw new HTTPError('headers already sent', { status: 500, code: 'headers-sent' });
        if (Array.isArray(value)) {
            this.headers.delete(name);
            for (const item of value) this.headers.append(name, item);
        } else {
            this.headers.set(name, value);
        }
    }

    public appendHeader(name: string, value: string): void {
        if (this.headersSent) throw new HTTPError('headers already sent', { status: 500, code: 'headers-sent' });
        this.headers.append(name, value);
    }

    public getHeader(name: string): string | undefined {
        return this.headers.get(name);
    }

    public async write(chunk: Uint8Array | string): Promise<void> {
        if (this.finished) throw new HTTPError('response already finished', { status: 500, code: 'finished' });
        if (this.headOnly) return;
        const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
        if (bytes.byteLength === 0) return;
        if (!this.headersSent) await this.sendHead(null);
        if (this.chunked) {
            await this.sendBytes(encodeChunk(bytes));
        } else {
            await this.sendBytes(bytes);
        }
    }

    public async end(body?: Uint8Array | string): Promise<void> {
        if (this.finished) return;
        const bytes =
            body === undefined
                ? new Uint8Array(0)
                : typeof body === 'string'
                  ? new TextEncoder().encode(body)
                  : body;

        if (!this.headersSent) {
            await this.sendHead(bytes.byteLength);
        }
        if (!this.headOnly) {
            if (this.chunked) {
                if (bytes.byteLength > 0) await this.sendBytes(encodeChunk(bytes));
                await this.sendBytes(encodeChunkedEnd());
            } else if (bytes.byteLength > 0) {
                await this.sendBytes(bytes);
            }
        }
        this.finished = true;
        if (this.connectionClose) {
            const sender = this.connection.stream as unknown as { end?: () => void };
            sender.end?.();
        }
    }

    private async sendHead(contentLength: number | null): Promise<void> {
        this.headersSent = true;
        if (this.serverName && !this.headers.has('server')) this.headers.set('server', this.serverName);
        if (connectionHasToken(this.headers, 'close')) this.connectionClose = true;

        let framing: 'none' | 'length' | 'chunked';
        const declared = this.headers.get('content-length');
        if (contentLength === null && declared !== undefined && /^[0-9]+$/.test(declared)) {
            // アプリケーションが `setHeader('content-length', n)` で長さを宣言している。
            // ここで `Transfer-Encoding: chunked` を足すと両立となりスマグリング判定になる（§16.7）。
            if (this.headers.has('transfer-encoding')) {
                this.headers.delete('transfer-encoding');
            }
            framing = Number(declared) === 0 ? 'none' : 'length';
        } else if (contentLength !== null) {
            if (contentLength > 0 || !this.canOmitLength()) {
                this.headers.set('content-length', String(contentLength));
                framing = 'length';
            } else {
                framing = 'none';
            }
        } else if (this.canOmitLength()) {
            // 本文を書かない可能性がある（204/304/HEAD）。長さは付けない。
            framing = 'none';
        } else {
            this.headers.set('transfer-encoding', 'chunked');
            framing = 'chunked';
        }
        this.chunked = framing === 'chunked';
        if (this.connectionClose) this.headers.set('connection', 'close');

        let head = `HTTP/1.1 ${this.statusCode} ${statusTextFor(this.statusCode)}\r\n`;
        for (const [name, value] of this.headers.rawEntries()) {
            head += `${name}: ${value}\r\n`;
        }
        head += '\r\n';
        await this.sendBytes(new TextEncoder().encode(head));
    }

    private canOmitLength(): boolean {
        return this.headOnly || this.statusCode === 204 || this.statusCode === 304 || this.statusCode < 200;
    }

    private sendBytes(bytes: Uint8Array): Promise<void> {
        const sender = this.connection.stream as unknown as { send?: (data: Uint8Array) => Promise<void> };
        if (!sender.send) {
            this.connection.closed = true;
            return Promise.reject(new HTTPError('the underlying stream cannot send data', { status: 500 }));
        }
        this.queue = this.queue.then(async () => {
            if (this.connection.closed) return;
            try {
                await sender.send!(bytes);
            } catch (error) {
                this.connection.closed = true;
                throw error;
            }
        });
        return this.queue;
    }
}

