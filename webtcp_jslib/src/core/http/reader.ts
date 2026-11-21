/**
 * `VirtualStream` からの HTTP メッセージ読み取り（specification.md §16.2）。
 *
 * `HTTPMessageReader` は受信バイトを内部バッファへ積み、ヘッダ部が揃った時点で
 * `HTTPHeadParser` を通し、以降は本文のフレーミングに応じて残りを返す。
 * ストリームの分割位置に依存しない（1 バイトずつでも動く）。
 */

import { concatBytes } from '../util/internal.js';
import { HTTPParseError } from './errors.js';
import {
    HTTPHeadParser,
    type HTTPHeadResult,
    type HTTPParserLimits,
    findHeadEnd,
    type ResolvedHTTPParserLimits,
    resolveParserLimits,
} from './parser.js';

/** 読み取り対象のストリーム（`VirtualStream` / テスト用フェイク）。 */
export interface HTTPStreamLike {
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
    pause?(): unknown;
    resume?(): unknown;
    destroy?(): void;
    readonly state?: string;
}

export interface HTTPMessageReaderOptions {
    /** パーサの上限。 */
    limits?: HTTPParserLimits;
    /** ヘッダ部の読み取りタイムアウト（ms）。`0` で無効。既定 `0`（呼び出し側が制御）。 */
    headTimeoutMs?: number;
    /** デバッグ用ラベル。 */
    label?: string;
}

/**
 * 1 本のストリームから HTTP メッセージを順に読む。
 *
 * `next()` はヘッダ部を読み終えた時点で `HTTPHeadResult` と「残りの本文バイト供給器」を返す。
 * 本文は `HTTPBodyStream` が消費する（`reader.ts` の外では扱わない）。
 */
export class HTTPMessageReader {
    private readonly limits: ResolvedHTTPParserLimits;
    private buffer: Uint8Array = new Uint8Array(0);
    private ended = false;
    private failure: Error | null = null;
    private waiters: Array<() => void> = [];
    private closed = false;
    /**
     * 本文の購読中は、受信バイトを `buffer` ではなく本文リスナーへ流す。
     * ここを分けないと、本文が「ヘッダ領域」にも溜まって次メッセージのパースを壊す。
     */
    private readonly bodyListeners = new Set<(chunk: Uint8Array) => void>();

    private readonly onData = (chunk: Uint8Array): void => {
        if (this.closed) return;
        if (this.bodyListeners.size > 0) {
            for (const listener of [...this.bodyListeners]) listener(chunk);
            return;
        }
        this.buffer = this.buffer.byteLength === 0 ? new Uint8Array(chunk) : concatBytes([this.buffer, chunk]);
        this.wake();
    };

    private readonly onEnd = (): void => {
        this.ended = true;
        this.wake();
    };

    private readonly onClose = (): void => {
        this.ended = true;
        this.wake();
    };

    constructor(
        private readonly stream: HTTPStreamLike,
        options: HTTPMessageReaderOptions = {},
    ) {
        this.limits = resolveParserLimits(options.limits);
        stream.on('data', this.onData);
        stream.on('end', this.onEnd);
        stream.on('close', this.onClose);
    }

    /** 待機を解除し、購読を外す。 */
    public dispose(): void {
        if (this.closed) return;
        this.closed = true;
        this.stream.off('data', this.onData);
        this.stream.off('end', this.onEnd);
        this.stream.off('close', this.onClose);
        this.buffer = new Uint8Array(0);
        this.wake();
    }

    /** ヘッダ部を読む。EOF で何も残っていなければ `null`（接続終了）。 */
    public async readHead(response: boolean): Promise<HTTPHeadResult | null> {
        const parser = new HTTPHeadParser(response, {
            maxLineBytes: this.limits.maxLineBytes,
            maxFieldLineBytes: this.limits.maxFieldLineBytes,
            maxHeaderCount: this.limits.maxHeaderCount,
            maxHeaderBytes: this.limits.maxHeaderBytes,
            strictLineEndings: this.limits.strictLineEndings,
        });
        let offset = 0;
        for (;;) {
            if (this.failure) throw this.failure;
            if (offset < this.buffer.byteLength) {
                // 先頭の空行は読み飛ばす（keep-alive の区切り）
                if (offset === 0 && this.buffer.byteLength > 0 && this.buffer[0] === 0x0a) {
                    this.buffer = this.buffer.subarray(1);
                    continue;
                }
                if (offset === 0 && this.buffer.byteLength > 1 && this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
                    this.buffer = this.buffer.subarray(2);
                    continue;
                }
                const result = parser.push(this.buffer.subarray(offset));
                if (result) {
                    const consumed = findHeadEnd(this.buffer);
                    if (consumed < 0) {
                        throw new HTTPParseError('failed to locate the end of the message head', {
                            status: 400,
                        });
                    }
                    this.buffer = this.buffer.subarray(consumed);
                    return result;
                }
                offset = this.buffer.byteLength;
                continue;
            }
            if (this.ended) {
                if (this.buffer.byteLength === 0) return null;
                throw new HTTPParseError('incomplete HTTP message head', { status: 400 });
            }
            if (this.stream.resume) this.stream.resume();
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
            offset = 0;
        }
    }

    /** 現在バッファにある残りバイトを取り出す（本文の読み取りに使う）。 */
    public takeBuffered(): Uint8Array {
        const buffered = this.buffer;
        this.buffer = new Uint8Array(0);
        return buffered;
    }

    /** 以降の受信データをコールバックで受け取る（本文ストリーミング用）。 */
    public streamBody(onChunk: (chunk: Uint8Array) => void): { dispose: () => void } {
        // 既にバッファに残っている分を先に渡す
        if (this.buffer.byteLength > 0) {
            const buffered = this.buffer;
            this.buffer = new Uint8Array(0);
            this.bodyListeners.add(onChunk);
            try {
                onChunk(buffered);
            } catch (error) {
                this.bodyListeners.delete(onChunk);
                throw error;
            }
        } else {
            this.bodyListeners.add(onChunk);
        }
        return {
            dispose: () => {
                this.bodyListeners.delete(onChunk);
            },
        };
    }

    /** 受信を一時停止する（本文のバックプレッシャー）。 */
    public pause(): void {
        this.stream.pause?.();
    }

    /** 受信を再開する。 */
    public resume(): void {
        this.stream.resume?.();
    }

    /** ストリームが終了しているか。 */
    public get isEnded(): boolean {
        return this.ended;
    }

    private wake(): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) waiter();
    }
}

