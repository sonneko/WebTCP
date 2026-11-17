/**
 * ストリーム上の本文読み取り（specification.md §15.2 / §15.4）。
 *
 * `HTTPBodyStream` はプル型の `read()` を持ち、`AsyncIterable` でも消費できる。
 * `Content-Length` / `chunked` / 本文なしの 3 経路を同じインターフェースに均す。
 *
 * バッファは `highWaterMark`（既定 64 KiB）で抑え、超えたら `VirtualStream.pause()`
 * で受信を止める。これにより大きな応答でも一定メモリで扱える（design.md §3.24）。
 */

import { HTTPBodyConsumedError, HTTPConnectionClosedError, HTTPResponseTooLargeError } from './errors.js';
import type { HTTPBodyReader } from './message.js';
import { HTTPChunkedDecoder } from './parser.js';
import type { HTTPBodyFraming } from './parser.js';

/** 本文の供給元（`VirtualStream` の薄い抽象。テストで差し替えられる）。 */
export interface HTTPBodySource {
    /** データが届くたびに呼ばれる（`HTTPBodyStream` が購読する）。 */
    onData(listener: (chunk: Uint8Array) => void): void;
    onEnd(listener: () => void): void;
    onClose(listener: () => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    /** 受信の一時停止・再開（省略可）。 */
    pause?(): void;
    resume?(): void;
}

export interface HTTPBodyStreamOptions {
    /** 本文のフレーミング。 */
    framing: HTTPBodyFraming;
    /** 内部バッファの上限（バイト）。既定 64 KiB。 */
    highWaterMark?: number;
    /** `text()` / `json()` / `arrayBuffer()` の上限。`0` で無制限。既定 8 MiB。 */
    maxBytes?: number;
    /** デバッグ用のラベル。 */
    label?: string;
}

const UTF8 = new TextDecoder('utf-8');

/**
 * 本文の読み取り器。
 *
 * 1 つのストリーム状態を共有するため、`text()` などを 1 度呼ぶと以降の `read()` は
 * 空になる（`HTTPBodyConsumedError`）。
 */
export class HTTPBodyStream implements HTTPBodyReader {
    private readonly framing: HTTPBodyFraming;
    private readonly decoder: HTTPChunkedDecoder | null;
    private readonly highWaterMark: number;
    private readonly maxBytes: number;
    private readonly chunks: Uint8Array[] = [];
    private queuedBytes = 0;
    private remaining: number;
    private done = false;
    private failure: Error | null = null;
    private waiter: (() => void) | null = null;
    private consumedByHelper = false;
    private totalRead = 0;
    private readonly doneListeners: Array<(ok: boolean) => void> = [];

    private readonly onData = (chunk: Uint8Array): void => {
        if (this.done) return;
        try {
            if (this.decoder) {
                for (const part of this.decoder.push(chunk)) this.enqueue(part);
                if (this.decoder.finished) this.finish();
            } else if (this.framing.kind === 'length') {
                const take = Math.min(this.remaining - this.queuedBytes - this.totalRead, chunk.byteLength);
                if (take > 0) {
                    const part = chunk.subarray(0, take);
                    this.enqueue(part);
                    const consumed = this.totalRead + this.queuedBytes;
                    if (consumed >= this.remaining) this.finish();
                }
            } else {
                this.enqueue(chunk);
            }
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
        this.wake();
    };

    private readonly onEnd = (): void => {
        if (!this.done) {
            if (this.framing.kind === 'chunked' && this.decoder && !this.decoder.finished) {
                this.fail(new HTTPConnectionClosedError('connection closed inside a chunked body'));
            } else if (this.framing.kind === 'length' && this.totalRead + this.queuedBytes < this.remaining) {
                this.fail(
                    new HTTPConnectionClosedError(
                        `connection closed before the declared Content-Length (${this.totalRead + this.queuedBytes}/${this.remaining})`,
                    ),
                );
            } else {
                this.finish();
            }
        }
        this.wake();
    };

    private readonly onClose = (): void => {
        if (this.done) return;
        if (this.framing.kind === 'none' || this.framing.kind === 'length' || this.framing.kind === 'chunked') {
            if (this.framing.kind === 'length' && this.totalRead + this.queuedBytes < this.remaining) {
                this.fail(new HTTPConnectionClosedError('stream closed before the body completed'));
            } else if (this.framing.kind === 'chunked' && this.decoder && !this.decoder.finished) {
                this.fail(new HTTPConnectionClosedError('stream closed inside a chunked body'));
            } else {
                this.finish();
            }
        }
        this.wake();
    };

    constructor(
        private readonly source: HTTPBodySource,
        options: HTTPBodyStreamOptions,
    ) {
        this.framing = options.framing;
        this.decoder = options.framing.kind === 'chunked' ? new HTTPChunkedDecoder() : null;
        this.highWaterMark = Math.max(1024, options.highWaterMark ?? 64 * 1024);
        this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
        this.remaining = options.framing.kind === 'length' ? options.framing.length : Number.POSITIVE_INFINITY;

        source.onData(this.onData);
        source.onEnd(this.onEnd);
        source.onClose(this.onClose);

        if (options.framing.kind === 'none') {
            this.finish();
        }
    }

    /** 本文の読み取りが完了（EOF / 失敗）したときに一度だけ呼ばれる。 */
    public onceDone(listener: (ok: boolean) => void): void {
        if (this.done || this.failure) {
            queueMicrotask(() => listener(!this.failure));
            return;
        }
        this.doneListeners.push(listener);
    }

    /** 本文の読み取りが完了しているか。 */
    public get isDone(): boolean {
        return this.done || this.failure !== null;
    }

    public get empty(): boolean {
        return this.framing.kind === 'none' || this.totalRead + this.queuedBytes >= this.remaining;
    }

    public get contentLength(): number | null {
        return this.framing.kind === 'length' ? this.framing.length : null;
    }

    /** 本文を破棄して購読を解除する。 */
    public dispose(): void {
        this.done = true;
        this.source.off('data', this.onData as never);
        this.source.off('end', this.onEnd as never);
        this.source.off('close', this.onClose as never);
        this.chunks.length = 0;
        this.queuedBytes = 0;
        this.wake();
    }

    /**
     * 読み取りを打ち切る（接続の強制終了時）。保留中の `read()` は reject される。
     * `dispose()` との違いは「失敗として通知する」こと。
     */
    public abort(error: Error = new HTTPConnectionClosedError('the connection was closed')): void {
        this.dispose();
        this.fail(error);
    }

    /** 任意バイト数を読む。EOF なら `null`。 */
    public async read(maxBytes?: number): Promise<Uint8Array | null> {
        this.assertNotConsumed();
        return this.readInternal(maxBytes);
    }

    private async readInternal(maxBytes?: number): Promise<Uint8Array | null> {
        if (maxBytes !== undefined) {
            if (!Number.isInteger(maxBytes) || maxBytes < 0) {
                throw new RangeError(`maxBytes must be a non-negative integer (got ${maxBytes})`);
            }
            if (maxBytes === 0) return new Uint8Array(0);
        }
        const first = await this.pull();
        if (first === null) return null;
        const limit = maxBytes === undefined ? Number.POSITIVE_INFINITY : maxBytes;
        if (first.byteLength >= limit) {
            if (first.byteLength === limit) return first;
            const head = first.subarray(0, limit);
            const tail = first.subarray(limit);
            this.chunks.unshift(tail);
            this.queuedBytes += tail.byteLength;
            return head;
        }
        const parts = [first];
        let size = first.byteLength;
        while (size < limit && this.chunks.length > 0) {
            const next = this.chunks.shift()!;
            this.queuedBytes -= next.byteLength;
            if (size + next.byteLength <= limit) {
                parts.push(next);
                size += next.byteLength;
            } else {
                const take = limit - size;
                parts.push(next.subarray(0, take));
                const rest = next.subarray(take);
                this.chunks.unshift(rest);
                this.queuedBytes += rest.byteLength;
                size = limit;
            }
        }
        return concat(parts);
    }

    /** `for await` で本文を読み進める。 */
    public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        for (;;) {
            const chunk = await this.read();
            if (chunk === null) return;
            yield chunk;
        }
    }

    public async text(): Promise<string> {
        const bytes = await this.collectAll();
        return UTF8.decode(bytes);
    }

    public async json<T = unknown>(): Promise<T> {
        const text = await this.text();
        if (text.length === 0) throw new Error('cannot parse an empty body as JSON');
        return JSON.parse(text) as T;
    }

    public async arrayBuffer(): Promise<Uint8Array> {
        return this.collectAll();
    }

    private async collectAll(): Promise<Uint8Array> {
        this.assertNotConsumed();
        this.consumedByHelper = true;
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const chunk = await this.readInternal();
            if (chunk === null) break;
            total += chunk.byteLength;
            if (this.maxBytes > 0 && total > this.maxBytes) {
                this.dispose();
                throw new HTTPResponseTooLargeError(
                    `body exceeds maxBytes (${this.maxBytes}); read it with the AsyncIterable API`,
                );
            }
            parts.push(chunk);
        }
        return concat(parts);
    }

    private async pull(): Promise<Uint8Array | null> {
        for (;;) {
            if (this.failure) throw this.failure;
            if (this.chunks.length > 0) {
                const chunk = this.chunks.shift()!;
                this.queuedBytes -= chunk.byteLength;
                this.totalRead += chunk.byteLength;
                if (this.source.resume && this.queuedBytes <= this.highWaterMark / 2) this.source.resume();
                return chunk;
            }
            if (this.done) {
                if (this.failure) throw this.failure;
                return null;
            }
            await new Promise<void>((resolve) => {
                this.waiter = resolve;
            });
        }
    }

    private enqueue(chunk: Uint8Array): void {
        if (chunk.byteLength === 0) return;
        this.chunks.push(chunk);
        this.queuedBytes += chunk.byteLength;
        if (this.source.pause && this.queuedBytes >= this.highWaterMark) this.source.pause();
        if (this.maxBytes > 0 && this.totalRead + this.queuedBytes > this.maxBytes && this.consumedByHelper) {
            this.fail(
                new HTTPResponseTooLargeError(
                    `body exceeds maxBytes (${this.maxBytes}); read it with the AsyncIterable API`,
                ),
            );
        }
    }

    private finish(): void {
        this.done = true;
        this.source.off('data', this.onData as never);
        this.source.off('end', this.onEnd as never);
        this.source.off('close', this.onClose as never);
        this.wake();
    }

    private fail(error: Error): void {
        this.failure = error;
        this.done = true;
        this.wake();
    }

    private wake(): void {
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.();
        if ((this.done || this.failure) && this.doneListeners.length > 0) {
            const listeners = this.doneListeners.splice(0, this.doneListeners.length);
            const ok = this.failure === null;
            for (const listener of listeners) {
                try {
                    listener(ok);
                } catch {
                    /* 無視 */
                }
            }
        }
    }

    private assertNotConsumed(): void {
        if (this.consumedByHelper) throw new HTTPBodyConsumedError();
    }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0]!;
    let total = 0;
    for (const part of parts) total += part.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}
