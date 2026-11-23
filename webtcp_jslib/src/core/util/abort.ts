/**
 * `AbortSignal` の共通ヘルパー（#44）。
 *
 * 中断は DOM 互換の `name === 'AbortError'` を持つ `Error` で表す。
 * `connect()` 系 API は中断時にこのエラーで reject し、リスナー・タイマー・部分的に開いたリソースを残さない。
 */

/** 中断を表す `AbortError` を作る（`name === 'AbortError'`）。 */
export function createAbortError(message = 'The operation was aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/** 値が中断由来のエラー（`name === 'AbortError'`）かどうか。 */
export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** `signal` が既に中断されていれば `AbortError` を投げる。 */
export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
    if (signal?.aborted) throw createAbortError(message);
}

/**
 * `promise` を `signal` と競争させる。中断されたら即座に `AbortError` で reject する。
 * 元の `promise` が後から失敗しても未処理の拒否にはならない（結果は捨てる）。
 * `signal` が無ければ `promise` をそのまま返す。
 */
export function raceAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    message?: string,
): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(createAbortError(message));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            reject(createAbortError(message));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
