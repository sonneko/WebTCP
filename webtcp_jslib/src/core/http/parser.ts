/**
 * HTTP/1.1 の逐次パーサ（specification.md §15.2 / §15.2.1）。
 *
 * `HTTPMessageParser` は与えられたバイト列を**消費しながら**状態を進める。
 * ストリームの分割位置に依存しないため、1 バイトずつ渡しても、ヘッダ途中で
 * 分割しても同じ結果になる。上限はパースの入口で強制する。
 *
 * 対応するフレーミング:
 * - `Content-Length`
 * - `Transfer-Encoding: chunked`（トレーラは読み捨て）
 * - どちらも無い（本文なし）
 */

import { HTTPParseError } from './errors.js';
import { HTTPHeaders, normalizeHeaderName, normalizeHeaderValue } from './message.js';

/** パーサの上限（§15.2.1）。 */
export interface HTTPParserLimits {
    /** リクエストライン / ステータスラインの最大バイト数。既定 8 KiB。 */
    maxLineBytes?: number;
    /** ヘッダ 1 行の最大バイト数。既定 8 KiB。 */
    maxFieldLineBytes?: number;
    /** ヘッダの最大行数。既定 100。 */
    maxHeaderCount?: number;
    /** ヘッダ合計の最大バイト数。既定 32 KiB。 */
    maxHeaderBytes?: number;
    /** `chunk-size` 行の最大バイト数。既定 1 KiB。 */
    maxChunkLineBytes?: number;
    /** CRLF のみを受理する。既定 `true`（`false` で裸の `LF` も受理）。 */
    strictLineEndings?: boolean;
}

export interface ResolvedHTTPParserLimits {
    maxLineBytes: number;
    maxFieldLineBytes: number;
    maxHeaderCount: number;
    maxHeaderBytes: number;
    maxChunkLineBytes: number;
    strictLineEndings: boolean;
}

/** パーサの受け取る本文フレーミング。 */
export type HTTPBodyFraming =
    | { kind: 'none' }
    | { kind: 'length'; length: number }
    | { kind: 'chunked' };

/** パース済みのヘッダ部。 */
export interface HTTPHeadResult {
    /** リクエストなら `{ method, target }`、応答なら `{ status, statusText }`。 */
    startLine: {
        method?: string;
        target?: string;
        status?: number;
        statusText?: string;
    };
    headers: HTTPHeaders;
    framing: HTTPBodyFraming;
    /** ヘッダ終端までに消費したバイト数（デバッグ用）。 */
    headBytes: number;
}

const CR = 0x0d;
const LF = 0x0a;

export function resolveParserLimits(limits: HTTPParserLimits = {}): ResolvedHTTPParserLimits {
    return {
        maxLineBytes: positive(limits.maxLineBytes ?? 8 * 1024, 'maxLineBytes'),
        maxFieldLineBytes: positive(limits.maxFieldLineBytes ?? 8 * 1024, 'maxFieldLineBytes'),
        maxHeaderCount: positive(limits.maxHeaderCount ?? 100, 'maxHeaderCount'),
        maxHeaderBytes: positive(limits.maxHeaderBytes ?? 32 * 1024, 'maxHeaderBytes'),
        maxChunkLineBytes: positive(limits.maxChunkLineBytes ?? 1024, 'maxChunkLineBytes'),
        strictLineEndings: limits.strictLineEndings !== false,
    };
}

/**
 * ヘッダ部（開始行 + フィールド群）を 1 度だけパースする。
 *
 * `readLine` で行を取り出し、上限を超える前に例外を投げる。本文は扱わない。
 */
export class HTTPHeadParser {
    private readonly limits: ResolvedHTTPParserLimits;
    private readonly buffer: number[] = [];
    private startLine: string | null = null;
    private readonly headers = new HTTPHeaders();
    private headerCount = 0;
    private headerBytes = 0;
    private done = false;

    constructor(
        private readonly isResponse: boolean,
        limits: HTTPParserLimits = {},
    ) {
        this.limits = resolveParserLimits(limits);
    }

    public get finished(): boolean {
        return this.done;
    }

    /**
     * バイト列を供給する。ヘッダ終端に達したら結果を返す。
     *
     * 終端後は**追加バイトを無視する**（`HTTPMessageReader` が残余をまとめて
     * 渡しても壊れないようにするため）。EOF 前の終端判定は `finished` で行う。
     */
    public push(chunk: Uint8Array): HTTPHeadResult | null {
        if (this.done) return null;
        for (let i = 0; i < chunk.byteLength; i += 1) {
            const byte = chunk[i]!;
            this.buffer.push(byte);
            if (byte === LF) {
                const result = this.consumeLine();
                if (result) {
                    this.done = true;
                    return result;
                }
            }
            // 行末が来ていない巨大な行を保持し続けない（早期に上限で落とす）
            const limit = this.startLine === null ? this.limits.maxLineBytes : this.limits.maxFieldLineBytes;
            if (this.buffer.length > limit + 1) {
                throw new HTTPParseError(
                    this.startLine === null
                        ? `start line exceeds ${limit} bytes`
                        : `header line exceeds ${limit} bytes`,
                    { status: this.startLine === null ? 414 : 431 },
                );
            }
        }
        return null;
    }

    private consumeLine(): HTTPHeadResult | null {
        const bytes = this.buffer.splice(0, this.buffer.length);
        const line = decodeLine(bytes, this.limits.strictLineEndings);
        if (this.startLine === null) {
            if (line.length === 0) return null; // 先頭の空行は無視する（RFC 9112 §2.2）
            this.startLine = line;
            return null;
        }
        if (line.length === 0) {
            // ヘッダ終端
            if (this.isResponse) {
                const parsed = parseStatusLine(this.startLine);
                return {
                    startLine: parsed,
                    headers: this.headers,
                    framing: { kind: 'none' },
                    headBytes: 0,
                };
            }
            const parsed = parseRequestLine(this.startLine);
            return {
                startLine: parsed,
                headers: this.headers,
                framing: determineRequestFraming(this.headers),
                headBytes: 0,
            };
        }
        if (line.startsWith(' ') || line.startsWith('\t')) {
            throw new HTTPParseError('obsolete line folding is not supported', { status: 400 });
        }
        this.headerCount += 1;
        if (this.headerCount > this.limits.maxHeaderCount) {
            throw new HTTPParseError(`too many header fields (max ${this.limits.maxHeaderCount})`, {
                status: 431,
            });
        }
        this.headerBytes += bytes.length;
        if (this.headerBytes > this.limits.maxHeaderBytes) {
            throw new HTTPParseError(`header section exceeds ${this.limits.maxHeaderBytes} bytes`, {
                status: 431,
            });
        }
        const colon = line.indexOf(':');
        if (colon <= 0) throw new HTTPParseError('malformed header field', { status: 400 });
        let name: string;
        try {
            name = normalizeHeaderName(line.slice(0, colon));
        } catch {
            throw new HTTPParseError('malformed header field name', { status: 400 });
        }
        let value: string;
        try {
            value = normalizeHeaderValue(line.slice(colon + 1));
        } catch {
            throw new HTTPParseError('header value contains CR, LF or NUL', { status: 400 });
        }
        this.headers.append(name, value);
        if (this.headerCount > this.limits.maxHeaderCount) {
            throw new HTTPParseError('too many header fields', { status: 431 });
        }
        return null;
    }
}

/** 開始行 + ヘッダ部を一度にパースする（`Buffer` 全体が揃っている場合の補助）。 */
export function parseHTTPHead(
    bytes: Uint8Array,
    options: { response: boolean; limits?: HTTPParserLimits },
): { head: HTTPHeadResult; rest: Uint8Array } {
    const parser = new HTTPHeadParser(options.response, options.limits);
    const head = parser.push(bytes);
    if (!head) throw new HTTPParseError('incomplete HTTP message head', { status: 400 });
    // 末尾の CRLF を探して残りを切り出す
    const end = findHeadEnd(bytes);
    return { head, rest: end < 0 ? new Uint8Array(0) : bytes.subarray(end) };
}

/** ヘッダ終端（空行の直後）のインデックス。無ければ -1。 */
export function findHeadEnd(bytes: Uint8Array): number {
    for (let i = 0; i + 3 < bytes.byteLength; i += 1) {
        if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) {
            return i + 4;
        }
    }
    // 裸の LF で空行を構成する場合も探す（strictLineEndings=false 用）
    for (let i = 0; i + 1 < bytes.byteLength; i += 1) {
        if (bytes[i] === LF && bytes[i + 1] === LF) return i + 2;
    }
    return -1;
}

/** `Transfer-Encoding` / `Content-Length` からリクエストの本文フレーミングを決める（§15.2）。 */
export function determineRequestFraming(headers: HTTPHeaders): HTTPBodyFraming {
    return determineFraming(headers, true);
}

/** 応答の本文フレーミングを決める。`HEAD` / `204` / `304` は呼び出し側で `none` を強制する。 */
export function determineResponseFraming(headers: HTTPHeaders): HTTPBodyFraming {
    return determineFraming(headers, false);
}

function determineFraming(headers: HTTPHeaders, isRequest: boolean): HTTPBodyFraming {
    const transferEncoding = headers.getAll('transfer-encoding').map((value) => value.toLowerCase());
    const contentLength = headers.getAll('content-length');

    if (transferEncoding.length > 0 && contentLength.length > 0) {
        throw new HTTPParseError(
            'a message must not carry both Transfer-Encoding and Content-Length',
            { status: 400 },
        );
    }

    if (transferEncoding.length > 0) {
        const codings = transferEncoding
            .flatMap((value) => value.split(','))
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (codings.length !== 1 || codings[0] !== 'chunked') {
            throw new HTTPParseError(
                `unsupported Transfer-Encoding: ${headers.get('transfer-encoding')}`,
                { status: 400 },
            );
        }
        if (isRequest && codings.length > 1) {
            throw new HTTPParseError('chunked must be the final transfer coding', { status: 400 });
        }
        return { kind: 'chunked' };
    }

    if (contentLength.length > 0) {
        const values = [...new Set(contentLength.map((value) => value.trim()))];
        if (values.length !== 1) {
            throw new HTTPParseError('conflicting Content-Length values', { status: 400 });
        }
        const raw = values[0]!;
        if (!/^[0-9]+$/.test(raw)) {
            throw new HTTPParseError(`invalid Content-Length: ${raw}`, { status: 400 });
        }
        const length = Number(raw);
        if (!Number.isSafeInteger(length)) {
            throw new HTTPParseError(`Content-Length is too large: ${raw}`, { status: 400 });
        }
        return length === 0 ? { kind: 'none' } : { kind: 'length', length };
    }

    return { kind: 'none' };
}

/** `Content-Length` の生値を読む（ヘッダを書き換えずに長さだけ得る）。 */
export function declaredContentLength(headers: HTTPHeaders): number | null {
    const framing = determineFraming(headers, false);
    return framing.kind === 'length' ? framing.length : null;
}

/** リクエストラインをパースする。 */
export function parseRequestLine(line: string): { method: string; target: string } {
    const parts = line.split(' ');
    if (parts.length !== 3) throw new HTTPParseError('malformed request line', { status: 400 });
    const [method, target, version] = parts as [string, string, string];
    if (!/^[A-Z]+$/.test(method)) throw new HTTPParseError('invalid method token', { status: 400 });
    if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') {
        throw new HTTPParseError(`unsupported HTTP version: ${version}`, { status: 505 });
    }
    if (target.length === 0) throw new HTTPParseError('empty request target', { status: 400 });
    if (!target.startsWith('/') && target !== '*') {
        throw new HTTPParseError('request target must be an origin-form path', { status: 400 });
    }
    return { method, target };
}

/** ステータスラインをパースする。 */
export function parseStatusLine(line: string): { status: number; statusText: string } {
    const match = /^(HTTP\/1\.[01]) ([0-9]{3})(?: (.*))?$/.exec(line);
    if (!match) throw new HTTPParseError('malformed status line', { status: 400 });
    const status = Number(match[2]);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new HTTPParseError(`invalid status code: ${match[2]}`, { status: 400 });
    }
    return { status, statusText: match[3] ?? '' };
}

/** chunked 本文のデコーダ（`chunk-size` 行 → データ → CRLF の繰り返し）。 */
export class HTTPChunkedDecoder {
    private state: 'size' | 'data' | 'data-crlf' | 'trailer' | 'done' = 'size';
    private remaining = 0;
    private readonly line: number[] = [];
    private readonly output: Uint8Array[] = [];

    constructor(private readonly limits: HTTPParserLimits = {}) {}

    public get finished(): boolean {
        return this.state === 'done';
    }

    /** 入力チャンクを消費し、得られた本文片を返す。 */
    public push(chunk: Uint8Array): Uint8Array[] {
        const maxLine = resolveParserLimits(this.limits).maxChunkLineBytes;
        for (let i = 0; i < chunk.byteLength; i += 1) {
            const byte = chunk[i]!;
            switch (this.state) {
                case 'size': {
                    if (byte === LF) {
                        const text = decodeLine([...this.line, byte], false);
                        this.line.length = 0;
                        const sizeText = text.split(';')[0]!.trim();
                        if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
                            throw new HTTPParseError('invalid chunk size', { status: 400 });
                        }
                        const size = Number.parseInt(sizeText, 16);
                        if (!Number.isSafeInteger(size)) {
                            throw new HTTPParseError('chunk size is too large', { status: 400 });
                        }
                        if (size === 0) this.state = 'trailer';
                        else {
                            this.remaining = size;
                            this.state = 'data';
                        }
                    } else {
                        this.line.push(byte);
                        if (this.line.length > maxLine) {
                            throw new HTTPParseError(
                                `chunk size line exceeds ${maxLine} bytes`,
                                { status: 400 },
                            );
                        }
                    }
                    break;
                }
                case 'data': {
                    const take = Math.min(this.remaining, chunk.byteLength - i);
                    this.output.push(new Uint8Array(chunk.subarray(i, i + take)));
                    this.remaining -= take;
                    i += take - 1;
                    if (this.remaining === 0) this.state = 'data-crlf';
                    break;
                }
                case 'data-crlf': {
                    if (byte === CR) continue;
                    if (byte === LF) this.state = 'size';
                    else throw new HTTPParseError('chunk data must end with CRLF', { status: 400 });
                    break;
                }
                case 'trailer': {
                    if (byte === LF) {
                        const text = decodeLine([...this.line, byte], false);
                        this.line.length = 0;
                        if (text.length === 0) this.state = 'done';
                        // トレーラは読み捨てる
                    } else {
                        this.line.push(byte);
                        if (this.line.length > maxLine) {
                            throw new HTTPParseError('trailer line is too long', { status: 400 });
                        }
                    }
                    break;
                }
                case 'done':
                    if (byte !== 0) {
                        throw new HTTPParseError('data after the final chunk', { status: 400 });
                    }
                    break;
            }
        }
        const out = [...this.output];
        this.output.length = 0;
        return out;
    }
}

function decodeLine(bytes: number[], strict: boolean): string {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === LF) end -= 1;
    if (end > 0 && bytes[end - 1] === CR) end -= 1;
    else if (strict && bytes.length > 0 && bytes[bytes.length - 1] === LF) {
        throw new HTTPParseError('line must end with CRLF', { status: 400 });
    }
    return decodeLatin1(bytes.slice(0, end));
}

/**
 * ヘッダ・開始行はバイト列（ISO-8859-1）として解釈する。
 * `TextDecoder('latin1')` は仕様名が `iso-8859-1` であり、`0x00–0xFF` を
 * そのまま 1 文字へ写せる（UTF-8 の多バイト解釈はしない）。
 */
const LATIN1 = new TextDecoder('latin1');

export function decodeLatin1(bytes: Uint8Array | number[]): string {
    const array = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    return LATIN1.decode(array);
}

function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive finite number (got ${value})`);
    }
    return Math.floor(value);
}
