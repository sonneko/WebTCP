/**
 * 変更の後に保存を自動で行うスケジューラ（#51 / M9 / specification.md §9.8、design.md §3.42）。
 *
 * - **デバウンス**: 最後の変更から `debounceMs` 後に 1 回だけ保存する。短時間の連続した変更は 1 回にまとめる。
 * - **上限待ち**: 変更が途切れなくても、最初の未保存の変更から `maxWaitMs` を超えて保存を遅らせない。
 *   これが、強制終了された場合に失われうる変更の上限になる。
 * - **直列化**: 保存は同時に 1 件だけ動く。保存中の変更は、保存の完了後に次の保存で扱う。
 * - **失敗**: 保存が失敗したら変更を未保存のままにし、`debounceMs` 後に再試行する。
 * - **同期の開始**: `flush()` / `stop()` は、保存を同期的に開始する。`WebTCPNetwork.close()` の前に
 *   状態を取り込めるように、トランスポートを閉じる前に呼べる。
 */

/**
 * 既定値（design.md §3.42）。`debounceMs` は実測の保存コスト（IndexedDB、名前 1000 件でも p95 1 ms 程度）から、
 * 保存の占有率を 1% 未満に保つ下限 100 ms より大きく取る。`maxWaitMs` は強制終了された場合に失われうる変更の上限。
 */
export const AUTO_PERSIST_DEBOUNCE_MS = 500;
export const AUTO_PERSIST_MAX_WAIT_MS = 5000;

export interface AutoPersistSchedulerOptions {
    /** 保存を開始する。戻り値の Promise の完了で成否を判断する。呼び出しは同期的に行われる。 */
    save: () => Promise<unknown>;
    /** 最後の変更から保存までの待ち時間（ms）。 */
    debounceMs: number;
    /** 最初の未保存の変更から保存までの上限（ms）。`debounceMs` 以上であること。 */
    maxWaitMs: number;
    /** 保存の失敗を通知する（再試行はスケジューラが行う）。 */
    onError?: (error: unknown) => void;
}

export interface AutoPersistScheduler {
    /** 状態が変わったことを知らせる。 */
    notify(): void;
    /** 未保存の変更があれば今すぐ保存し、進行中の保存の完了を待つ。 */
    flush(): Promise<void>;
    /** `flush()` の後、以後の変更を無視する。 */
    stop(): Promise<void>;
    /** 未保存の変更があるか。 */
    readonly pending: boolean;
    /** 成功した保存の回数。 */
    readonly saves: number;
    /** 失敗した保存の回数。 */
    readonly failures: number;
}

export function createAutoPersistScheduler(options: AutoPersistSchedulerOptions): AutoPersistScheduler {
    if (!(options.debounceMs >= 0) || !(options.maxWaitMs >= options.debounceMs)) {
        throw new Error('auto-persist requires 0 <= debounceMs <= maxWaitMs');
    }
    let dirty = false;
    let firstDirtyAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    let stopped = false;
    let saves = 0;
    let failures = 0;

    const clearTimer = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const schedule = (): void => {
        if (stopped) return;
        clearTimer();
        const remainingWait = firstDirtyAt + options.maxWaitMs - Date.now();
        const delay = Math.max(0, Math.min(options.debounceMs, remainingWait));
        timer = setTimeout(() => {
            timer = null;
            run();
        }, delay);
    };

    /** 未保存なら保存を同期的に開始する。進行中の保存があれば、完了後の再試行に任せる。 */
    const run = (): void => {
        if (!dirty || inFlight !== null) return;
        dirty = false;
        firstDirtyAt = 0;
        let started: Promise<unknown>;
        try {
            started = Promise.resolve(options.save());
        } catch (error) {
            started = Promise.reject(error);
        }
        inFlight = started
            .then(
                () => {
                    saves += 1;
                },
                (error: unknown) => {
                    failures += 1;
                    if (!dirty) {
                        dirty = true;
                        firstDirtyAt = Date.now();
                    }
                    options.onError?.(error);
                },
            )
            .finally(() => {
                inFlight = null;
                if (dirty && !stopped) schedule();
            });
    };

    const flushOnce = async (): Promise<void> => {
        clearTimer();
        run();
        while (inFlight !== null) await inFlight;
    };

    return {
        notify(): void {
            if (stopped) return;
            if (!dirty) {
                dirty = true;
                firstDirtyAt = Date.now();
            }
            schedule();
        },
        async flush(): Promise<void> {
            // 失敗した保存は再試行を 1 回だけ行う（それ以上は次の変更または次の flush に任せる）。
            await flushOnce();
            if (dirty) await flushOnce();
        },
        async stop(): Promise<void> {
            const pending = flushOnce();
            stopped = true;
            clearTimer();
            await pending;
        },
        get pending(): boolean {
            return dirty;
        },
        get saves(): number {
            return saves;
        },
        get failures(): number {
            return failures;
        },
    };
}
