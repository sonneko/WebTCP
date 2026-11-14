import { Logger, defaultLogger } from './Logger.js';

/**
 * ブラウザ・Node.jsのどちらでも動作する最小の EventEmitter。
 *
 * Node.js の `events` モジュールはブラウザに存在せず、ポリフィルを強制すると
 * 「バンドラなしで dist を直接 import できる」という設計目標（design.md §3.2）を
 * 達成できないため、必要な API だけを自前で実装する。
 */
export type EventListener = (...args: any[]) => void;

interface ListenerEntry {
    listener: EventListener;
    once: boolean;
}

export class EventEmitter {
    private readonly listeners = new Map<string, ListenerEntry[]>();
    protected eventLogger: Logger;

    constructor(logger: Logger = defaultLogger) {
        this.eventLogger = logger;
    }

    /** リスナーを登録する。 */
    public on(event: string, listener: EventListener): this {
        return this.addListener(event, listener, false);
    }

    /** 一度だけ呼ばれるリスナーを登録する。 */
    public once(event: string, listener: EventListener): this {
        return this.addListener(event, listener, true);
    }

    /** リスナーを解除する。 */
    public off(event: string, listener: EventListener): this {
        const entries = this.listeners.get(event);
        if (!entries) return this;

        const remaining = entries.filter((entry) => entry.listener !== listener);
        if (remaining.length === 0) {
            this.listeners.delete(event);
        } else {
            this.listeners.set(event, remaining);
        }
        return this;
    }

    /** `off` の別名（Node.js の EventEmitter 互換）。 */
    public removeListener(event: string, listener: EventListener): this {
        return this.off(event, listener);
    }

    /** すべてのリスナーを解除する。イベント名を指定するとそのイベントのみ解除する。 */
    public removeAllListeners(event?: string): this {
        if (event === undefined) {
            this.listeners.clear();
        } else {
            this.listeners.delete(event);
        }
        return this;
    }

    /** 登録済みリスナー数を返す。 */
    public listenerCount(event: string): number {
        return this.listeners.get(event)?.length ?? 0;
    }

    /**
     * イベントを発火する。
     * リスナー内の例外は他のリスナーの実行を妨げないよう捕捉し、ロガーへ出力する。
     * @returns リスナーが1つ以上呼ばれた場合は true
     */
    public emit(event: string, ...args: any[]): boolean {
        const entries = this.listeners.get(event);
        if (!entries || entries.length === 0) return false;

        // once リスナーが自身を解除できるようコピーを走査する
        for (const entry of [...entries]) {
            if (entry.once) {
                this.off(event, entry.listener);
            }
            try {
                entry.listener(...args);
            } catch (error) {
                this.eventLogger.error(`[EventEmitter] listener for "${event}" threw:`, error);
            }
        }
        return true;
    }

    private addListener(event: string, listener: EventListener, once: boolean): this {
        const entries = this.listeners.get(event);
        if (entries) {
            entries.push({ listener, once });
        } else {
            this.listeners.set(event, [{ listener, once }]);
        }
        return this;
    }
}
