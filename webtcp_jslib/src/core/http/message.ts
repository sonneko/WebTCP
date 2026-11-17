/**
 * HTTP/1.1 のメッセージ型（specification.md §16.2）。
 *
 * ヘッダは名前を小文字化して保持し、重複は到着順の配列として保持する。
 * `HTTPHeaders.get()` は RFC 9110 のカンマ連結規則に従う。
 */

import { HTTPError, HTTPHeaderInjectionError } from './errors.js';

/** 大文字小文字を区別しないヘッダ集合（重複保持）。 */
export class HTTPHeaders {
    private readonly entries = new Map<string, string[]>();

    constructor(init?: Record<string, string | string[]> | HTTPHeaders | Iterable<[string, string]>) {
        if (!init) return;
        if (init instanceof HTTPHeaders) {
            for (const [name, values] of init.entries) {
                this.entries.set(name, [...values]);
            }
            return;
        }
        if (isIterable(init)) {
            for (const [name, value] of init) this.append(name, value);
            return;
        }
        for (const [name, value] of Object.entries(init)) {
            if (Array.isArray(value)) for (const item of value) this.append(name, item);
            else this.append(name, value);
        }
    }

    /** 値を追加する（同名ヘッダを上書きしない）。名前と値は書き込み時に検証する。 */
    public append(name: string, value: string): this {
        const key = normalizeHeaderName(name);
        const checked = normalizeHeaderValue(value);
        const list = this.entries.get(key);
        if (list) list.push(checked);
        else this.entries.set(key, [checked]);
        return this;
    }

    /** 値を設定する（既存値を置き換える）。名前と値は書き込み時に検証する。 */
    public set(name: string, value: string): this {
        const key = normalizeHeaderName(name);
        this.entries.set(key, [normalizeHeaderValue(value)]);
        return this;
    }

    /** カンマ連結した値、または `undefined`。 */
    public get(name: string): string | undefined {
        const list = this.entries.get(normalizeHeaderName(name));
        if (!list || list.length === 0) return undefined;
        return list.join(', ');
    }

    /** カンマ連結した値を分割せずに、設定順の配列として返す。 */
    public getAll(name: string): string[] {
        return [...(this.entries.get(normalizeHeaderName(name)) ?? [])];
    }

    /** ヘッダが存在するか。 */
    public has(name: string): boolean {
        return this.entries.has(normalizeHeaderName(name));
    }

    /** ヘッダを削除する。 */
    public delete(name: string): boolean {
        return this.entries.delete(normalizeHeaderName(name));
    }

    /** `[name, value]` の配列（重複は展開せず 1 行 1 値を保つ）。 */
    public rawEntries(): Array<[string, string]> {
        const out: Array<[string, string]> = [];
        for (const [name, values] of this.entries) {
            for (const value of values) out.push([name, value]);
        }
        return out;
    }

    /** 小文字化・ソート済みのヘッダ名。 */
    public names(): string[] {
        return [...this.entries.keys()];
    }

    /** ヘッダ数（重複行を含む）。 */
    public get size(): number {
        let total = 0;
        for (const values of this.entries.values()) total += values.length;
        return total;
    }

    public toJSON(): Record<string, string | string[]> {
        const out: Record<string, string | string[]> = {};
        for (const [name, values] of this.entries) {
            out[name] = values.length === 1 ? values[0]! : [...values];
        }
        return out;
    }
}

/** リクエストのボディ読み取りインターフェース（§16.3 / §16.4）。 */
export interface HTTPBodyReader extends AsyncIterable<Uint8Array> {
    /** 本文が既に無い（`Content-Length: 0` または本文なし）かどうか。 */
    readonly empty: boolean;
    /** 宣言された本文長（不明なら `null`）。 */
    get contentLength(): number | null;
    /** 任意バイト数を読む。EOF なら `null`。 */
    read(maxBytes?: number): Promise<Uint8Array | null>;
    /** 本文をすべて読み、UTF-8 文字列として返す（1 度だけ）。 */
    text(): Promise<string>;
    /** 本文をすべて読み、JSON として返す（1 度だけ）。 */
    json<T = unknown>(): Promise<T>;
    /** 本文をすべて読み、バイト列として返す（1 度だけ）。 */
    arrayBuffer(): Promise<Uint8Array>;
}

/** 受信したリクエスト（§16.3）。 */
export interface HTTPRequest {
    readonly method: string;
    /** リクエストターゲット（`/path?query`）。 */
    readonly target: string;
    /** ターゲットのパス部分。 */
    readonly path: string;
    /** `?` を含むクエリ部分（無ければ空文字）。 */
    readonly query: string;
    readonly headers: HTTPHeaders;
    /** `HTTP/1.1` 固定。 */
    readonly httpVersion: string;
    /** 接続元の NodeId（サーバーのみ）。 */
    readonly remoteNodeId?: string;
    readonly body: HTTPBodyReader;
}

/** 応答本文の読み取りインターフェース（クライアント側、§16.4）。 */
export type HTTPResponseBody = HTTPBodyReader;

/** 受信した応答（§16.4）。 */
export interface HTTPResponse {
    readonly status: number;
    readonly statusText: string;
    readonly headers: HTTPHeaders;
    readonly body: HTTPResponseBody;
    /** `200–299` かどうか。 */
    readonly ok: boolean;
    /** 本文を文字列として返す（1 度だけ）。 */
    text(): Promise<string>;
    /** 本文を JSON として返す（1 度だけ）。 */
    json<T = unknown>(): Promise<T>;
    /** 本文をバイト列として返す（1 度だけ）。 */
    arrayBuffer(): Promise<Uint8Array>;
}

/** サーバーハンドラ（§16.3）。 */
export type HTTPHandler = (
    request: HTTPRequest,
    response: HTTPResponseWriter,
) => void | Promise<void>;

/** 応答書き込みインターフェース（§16.3）。 */
export interface HTTPResponseWriter {
    statusCode: number;
    /** ヘッダが既に送信されたか。 */
    readonly headersSent: boolean;
    /** 応答が完了したか。 */
    readonly finished: boolean;
    setHeader(name: string, value: string | string[]): void;
    appendHeader(name: string, value: string): void;
    getHeader(name: string): string | undefined;
    /** 本文を書く。初回呼び出しでヘッダを送信する。 */
    write(chunk: Uint8Array | string): Promise<void>;
    /** 応答を終了する。`body` があれば先に書く。 */
    end(body?: Uint8Array | string): Promise<void>;
}

const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_VALUE = /[\r\n\0]/;

/** ヘッダ名を検証して小文字化する。 */
export function normalizeHeaderName(name: string): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new HTTPError('header name must not be empty', { status: 400, code: 'invalid-header-name' });
    }
    if (!HEADER_NAME_TOKEN.test(name)) {
        throw new HTTPError(`invalid header name: ${JSON.stringify(name)}`, {
            status: 400,
            code: 'invalid-header-name',
        });
    }
    return name.toLowerCase();
}

/**
 * ヘッダ値に CR / LF / NUL が含まれていないことを検証する（§16.7 のインジェクション防止）。
 * 前後の OWS（空白・水平タブ）は落とす。
 */
export function normalizeHeaderValue(value: string): string {
    if (typeof value !== 'string') {
        throw new HTTPError('header value must be a string', { status: 400, code: 'invalid-header-value' });
    }
    if (INVALID_VALUE.test(value)) {
        throw new HTTPHeaderInjectionError('header value must not contain CR, LF or NUL');
    }
    return value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 配列を含む `[name, value]` の並びか（`Object.entries` との区別）。 */
function isIterable(value: unknown): value is Iterable<[string, string]> {
    if (typeof value !== 'object' || value === null) return false;
    if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') return false;
    if (!Array.isArray(value)) return true;
    return value.every((entry) => Array.isArray(entry) && entry.length === 2);
}

/** 代表的なステータスコードの理由句。 */
export const HTTP_STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
    100: 'Continue',
    101: 'Switching Protocols',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    206: 'Partial Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    417: 'Expectation Failed',
    422: 'Unprocessable Content',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
});

/** ステータスコードの理由句（未知なら空文字）。 */
export function statusTextFor(status: number): string {
    return HTTP_STATUS_TEXT[status] ?? '';
}

/** ターゲットをパスとクエリ（`?` を含む）に分ける。 */
export function splitTarget(target: string): { path: string; query: string } {
    const index = target.indexOf('?');
    if (index < 0) return { path: target, query: '' };
    return { path: target.slice(0, index), query: target.slice(index) };
}

/** メソッドが仕様（§16.3）で扱う既知のトークンか。 */
export const KNOWN_HTTP_METHODS: ReadonlySet<string> = new Set([
    'GET',
    'HEAD',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
    'TRACE',
    'CONNECT',
]);
