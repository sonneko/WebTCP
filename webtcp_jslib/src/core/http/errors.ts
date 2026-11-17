/**
 * HTTP トンネル層のエラー（specification.md §15.8）。
 *
 * すべて `HTTPError` を継承し、`status` は「サーバーが返すべき 4xx/5xx」、
 * `code` は機械判定用の短い識別子である。パース段階のエラーは `HTTPParseError`。
 */

/** HTTP 層の基底エラー。`status` はサーバーが返すステータスコード（クライアント側では 0）。 */
export class HTTPError extends Error {
    public readonly status: number;
    public readonly code: string;

    constructor(message: string, options: { status?: number; code?: string } = {}) {
        super(message);
        this.name = 'HTTPError';
        this.status = options.status ?? 0;
        this.code = options.code ?? 'http-error';
    }
}

/** メッセージの文法違反（サーバーは `status` の 4xx を返す）。 */
export class HTTPParseError extends HTTPError {
    constructor(message: string, options: { status?: number } = {}) {
        super(message, { status: options.status ?? 400, code: 'parse-error' });
        this.name = 'HTTPParseError';
    }
}

/** ヘッダ名・値への CR/LF/NUL 混入など、書き込み側の安全性違反。 */
export class HTTPHeaderInjectionError extends HTTPError {
    constructor(message: string) {
        super(message, { status: 500, code: 'header-injection' });
        this.name = 'HTTPHeaderInjectionError';
    }
}

/** クライアントが応答ヘッダまでに時間切れになった。 */
export class HTTPTimeoutError extends HTTPError {
    constructor(message = 'HTTP request timed out') {
        super(message, { status: 504, code: 'timeout' });
        this.name = 'HTTPTimeoutError';
    }
}

/** 応答本文が `maxResponseBytes` を超えた。 */
export class HTTPResponseTooLargeError extends HTTPError {
    constructor(message: string) {
        super(message, { status: 0, code: 'response-too-large' });
        this.name = 'HTTPResponseTooLargeError';
    }
}

/** 応答の受信中に接続が閉じた、または宣言された長さに足りない。 */
export class HTTPConnectionClosedError extends HTTPError {
    constructor(message = 'HTTP connection closed before the response completed') {
        super(message, { status: 0, code: 'connection-closed' });
        this.name = 'HTTPConnectionClosedError';
    }
}

/** 本文を 2 度読もうとした。 */
export class HTTPBodyConsumedError extends HTTPError {
    constructor(message = 'HTTP body has already been consumed') {
        super(message, { status: 0, code: 'body-consumed' });
        this.name = 'HTTPBodyConsumedError';
    }
}

/** 呼び出し側の `AbortSignal` により中断された。`name` は `'AbortError'`（DOM 互換）。 */
export class HTTPAbortError extends HTTPError {
    constructor(message = 'HTTP request aborted') {
        super(message, { status: 0, code: 'aborted' });
        this.name = 'AbortError';
    }
}
