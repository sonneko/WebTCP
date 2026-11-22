/**
 * HTTP メッセージの書き出し（specification.md §16.2 / §16.7）。
 *
 * ヘッダ名・値はここで検証する。CR/LF/NUL を含む値は `HTTPHeaderInjectionError` となり、
 * アプリケーションがユーザー入力をそのままヘッダへ流してもスマグリングが成立しない。
 */

import { concatBytes } from '../util/internal.js';
import { HTTPError } from './errors.js';
import { HTTPHeaders, normalizeHeaderName, normalizeHeaderValue, statusTextFor } from './message.js';

const CRLF = '\r\n';
const UTF8 = new TextEncoder();

export interface HTTPRequestWriteOptions {
    method: string;
    /** リクエストターゲット（`/path?query`）。 */
    target: string;
    headers?: HTTPHeaders | Record<string, string | string[]>;
    /** 本文。`contentLength` 未指定かつ本文があれば `Content-Length` を付ける。 */
    body?: Uint8Array;
    /**
     * 本文の長さ。`null` を渡すと `Transfer-Encoding: chunked` で送る。
     * 省略時は `body.byteLength`（本文なしなら付与しない）。
     */
    contentLength?: number | null;
    /** `Host` を自動付与しない（テスト用）。 */
    omitHost?: boolean;
    /**
     * `contentLength: null` のとき終端チャンク（`0\r\n\r\n`）まで書くか。
     * ストリーミング送信では `false` にして呼び出し側が終端を書く。既定 `true`。
     */
    chunkedTerminator?: boolean;
    /** `Connection: keep-alive` / `Connection: close` を付与する。 */
    connection?: 'keep-alive' | 'close';
}

export interface HTTPResponseWriteOptions {
    status: number;
    statusText?: string;
    headers?: HTTPHeaders | Record<string, string | string[]>;
    body?: Uint8Array;
    contentLength?: number | null;
    connection?: 'keep-alive' | 'close';
    /** `HEAD` への応答で本文を抑止する。 */
    omitBody?: boolean;
}

/** リクエストをバイト列にする。 */
export function serializeHTTPRequest(options: HTTPRequestWriteOptions): Uint8Array {
    const headers = toHeaders(options.headers);
    const host = headers.get('host');
    if (!options.omitHost && !host) {
        throw new HTTPError('HTTP/1.1 requests must carry a Host header (specification.md §16.2)', {
            status: 400,
            code: 'missing-host',
        });
    }
    if (options.connection) headers.set('connection', options.connection);
    const body = options.body ?? new Uint8Array(0);
    const framing = applyBodyHeaders(headers, options.contentLength, body.byteLength);

    let head = `${options.method} ${options.target} HTTP/1.1${CRLF}`;
    for (const [name, value] of headers.rawEntries()) {
        head += `${name}: ${value}${CRLF}`;
    }
    head += CRLF;

    if (framing === 'chunked') {
        const terminator = options.chunkedTerminator === false ? new Uint8Array(0) : encodeChunkedEnd();
        return concatBytes([UTF8.encode(head), encodeChunk(body), terminator]);
    }
    return concatBytes([UTF8.encode(head), body]);
}

/** 応答をバイト列にする。 */
export function serializeHTTPResponse(options: HTTPResponseWriteOptions): Uint8Array {
    const headers = toHeaders(options.headers);
    const body = options.omitBody ? new Uint8Array(0) : (options.body ?? new Uint8Array(0));
    if (options.connection) headers.set('connection', options.connection);
    const statusText = options.statusText ?? statusTextFor(options.status);
    // 本文を持てないステータスでは Content-Length / Transfer-Encoding を付けない（RFC 9112 §6.3）
    const bodyForbidden = options.status === 204 || options.status === 304 || options.status < 200;
    const framing = bodyForbidden
        ? 'none'
        : applyBodyHeaders(headers, options.contentLength, body.byteLength, options.omitBody === true);

    let head = `HTTP/1.1 ${options.status}${statusText ? ` ${statusText}` : ''}${CRLF}`;
    for (const [name, value] of headers.rawEntries()) {
        head += `${name}: ${value}${CRLF}`;
    }
    head += CRLF;

    if (bodyForbidden) return UTF8.encode(head);
    if (framing === 'chunked') {
        return concatBytes([UTF8.encode(head), encodeChunk(body), UTF8.encode('0\r\n\r\n')]);
    }
    return concatBytes([UTF8.encode(head), body]);
}

/** 1 つの chunked フレームを作る。 */
export function encodeChunk(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength === 0) return new Uint8Array(0);
    const size = UTF8.encode(`${chunk.byteLength.toString(16)}\r\n`);
    return concatBytes([size, chunk, UTF8.encode(CRLF)]);
}

/** chunked の終端（`0\r\n\r\n`）。 */
export function encodeChunkedEnd(): Uint8Array {
    return UTF8.encode('0\r\n\r\n');
}

/** ヘッダの `Connection` トークンに `close` が含まれるか（大文字小文字を区別しない）。 */
export function connectionHasToken(headers: HTTPHeaders, token: string): boolean {
    return headers
        .getAll('connection')
        .flatMap((value) => value.split(','))
        .map((value) => value.trim().toLowerCase())
        .includes(token.toLowerCase());
}

function applyBodyHeaders(
    headers: HTTPHeaders,
    contentLength: number | null | undefined,
    bodyBytes: number,
    omitContentLength = false,
): 'none' | 'length' | 'chunked' {
    if (contentLength === null) {
        headers.set('transfer-encoding', 'chunked');
        return 'chunked';
    }
    if (contentLength !== undefined) {
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
            throw new HTTPError(`invalid contentLength: ${contentLength}`, {
                status: 500,
                code: 'invalid-content-length',
            });
        }
        headers.set('content-length', String(contentLength));
        return 'length';
    }
    if (omitContentLength) return 'none';
    if (bodyBytes === 0) {
        // 本文が無い場合は Content-Length を付けない（0 を明示したい場合だけ contentLength: 0）
        return 'none';
    }
    headers.set('content-length', String(bodyBytes));
    return 'length';
}

function toHeaders(
    init: HTTPHeaders | Record<string, string | string[]> | undefined,
): HTTPHeaders {
    const headers = init instanceof HTTPHeaders ? init : new HTTPHeaders(init ?? {});
    // 値を再検証する（呼び出し側が直接 append した場合の防御）
    for (const [name, value] of headers.rawEntries()) {
        normalizeHeaderName(name);
        normalizeHeaderValue(value);
    }
    return headers;
}

