/**
 * レベル付きロガー（#26, specification.md §12.1）。
 *
 * コアおよびアダプタは `console.*` を直接呼ばず、このインターフェース経由でログ出力する。
 * 既定レベルは `warn` 以上。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export interface LogSink {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export interface ConsoleLoggerOptions {
    /** 出力する最低ログレベル。既定 `'warn'`。 */
    level?: LogLevel;
    /** メッセージ先頭に付ける接頭辞（任意）。 */
    prefix?: string;
    /** 出力先シンク（テスト用に差し替え可能）。既定は `globalThis.console`。 */
    sink?: LogSink;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};

/** 何も出力しないロガー（テストや完全消音向け）。 */
export const noopLogger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

/**
 * コンソールへ出力する標準ロガー実装。
 * 既定レベルは `'warn'`（`warn` と `error` のみ出力）。
 */
export class ConsoleLogger implements Logger {
    private level: LogLevel;
    private readonly prefix: string;
    private readonly sink: LogSink;

    constructor(options: ConsoleLoggerOptions = {}) {
        this.level = options.level ?? 'warn';
        this.prefix = options.prefix ?? '';
        this.sink = options.sink ?? globalThis.console;
    }

    public getLevel(): LogLevel {
        return this.level;
    }

    public setLevel(level: LogLevel): void {
        this.level = level;
    }

    public debug(message: string, ...args: unknown[]): void {
        if (!this.shouldLog('debug')) return;
        this.sink.debug(this.format(message), ...args);
    }

    public info(message: string, ...args: unknown[]): void {
        if (!this.shouldLog('info')) return;
        this.sink.info(this.format(message), ...args);
    }

    public warn(message: string, ...args: unknown[]): void {
        if (!this.shouldLog('warn')) return;
        this.sink.warn(this.format(message), ...args);
    }

    public error(message: string, ...args: unknown[]): void {
        if (!this.shouldLog('error')) return;
        this.sink.error(this.format(message), ...args);
    }

    private shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
    }

    private format(message: string): string {
        return this.prefix ? `${this.prefix} ${message}` : message;
    }
}

/** 既定ロガーを生成するヘルパー。 */
export function createLogger(options: ConsoleLoggerOptions = {}): ConsoleLogger {
    return new ConsoleLogger(options);
}

/**
 * 既存ロガーに `[scope]` プレフィックスを付与した子ロガーを返す。
 */
export function createScopedLogger(logger: Logger, scope: string): Logger {
    const tag = `[${scope}]`;
    return {
        debug: (message, ...args) => logger.debug(`${tag} ${message}`, ...args),
        info: (message, ...args) => logger.info(`${tag} ${message}`, ...args),
        warn: (message, ...args) => logger.warn(`${tag} ${message}`, ...args),
        error: (message, ...args) => logger.error(`${tag} ${message}`, ...args),
    };
}

/** ライブラリ全体の既定ロガー（`warn` 以上）。 */
export const defaultLogger: Logger = new ConsoleLogger({ level: 'warn' });

/** オプションからロガーを解決する内部ヘルパー。 */
export function resolveLogger(logger?: Logger, logLevel?: LogLevel): Logger {
    if (logger) return logger;
    if (logLevel !== undefined) return new ConsoleLogger({ level: logLevel });
    return defaultLogger;
}
