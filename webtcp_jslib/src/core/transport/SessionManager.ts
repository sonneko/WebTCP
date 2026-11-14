import { NodeId, VirtualPort } from '../types/protocol.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';

/**
 * SessionManager が管理するストリームの最小インターフェース。
 * 循環依存を避けるため、VirtualStream の具象型には依存しない。
 */
export interface ManagedStream {
    readonly sessionId: string;
    readonly remoteNodeId: NodeId;
    readonly localPort: VirtualPort;
    readonly remotePort: VirtualPort;
    lastActivity: number;
    close(): void;
    /** パケットを送らずに即座に破棄する（ネットワーク停止時に使う）。 */
    destroy?(): void;
}

/** ストリームの一意キーを生成する（specification.md §5.3）。 */
export function streamKey(
    remoteNodeId: NodeId,
    localPort: VirtualPort,
    remotePort: VirtualPort,
): string {
    return `${remoteNodeId}:${localPort}:${remotePort}`;
}

export interface SessionManagerOptions {
    /** 無通信でタイムアウトするまでの時間（ms）。既定 300000。 */
    sessionTimeoutMs?: number;
    /** クリーンアップの実行間隔（ms）。既定 60000。 */
    cleanupPeriodMs?: number;
    /** ロガー（任意）。 */
    logger?: Logger;
}

/**
 * 仮想セッション（VirtualStream）の登録・検索・回収を担う。
 */
export class SessionManager {
    private readonly activeStreams = new Map<string, ManagedStream>();
    private readonly sessionTimeoutMs: number;
    private readonly cleanupPeriodMs: number;
    private readonly logger: Logger;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: SessionManagerOptions = {}) {
        this.sessionTimeoutMs = options.sessionTimeoutMs ?? 300_000;
        this.cleanupPeriodMs = options.cleanupPeriodMs ?? 60_000;
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'SM');
    }

    /** 定期クリーンアップを開始する（冪等）。 */
    public start(): void {
        if (this.cleanupTimer !== null) return;
        this.cleanupTimer = setInterval(() => this.runCleanup(), this.cleanupPeriodMs);
    }

    /** 定期クリーンアップを停止する。 */
    public stop(): void {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /** ストリームを登録する。 */
    public registerStream(stream: ManagedStream): void {
        const key = streamKey(stream.remoteNodeId, stream.localPort, stream.remotePort);
        if (this.activeStreams.has(key)) {
            this.logger.warn(`Stream already exists for ${key}. Overwriting.`);
        }
        this.activeStreams.set(key, stream);
    }

    /** 三つ組でストリームを取得する。アクティビティ時刻を更新する。 */
    public getStream(
        remoteNodeId: NodeId,
        localPort: VirtualPort,
        remotePort: VirtualPort,
    ): ManagedStream | undefined {
        const stream = this.activeStreams.get(streamKey(remoteNodeId, localPort, remotePort));
        if (stream) {
            stream.lastActivity = Date.now();
        }
        return stream;
    }

    /** 指定三つ組のストリームが存在するか確認する（アクティビティ時刻は更新しない）。 */
    public hasStream(
        remoteNodeId: NodeId,
        localPort: VirtualPort,
        remotePort: VirtualPort,
    ): boolean {
        return this.activeStreams.has(streamKey(remoteNodeId, localPort, remotePort));
    }

    /** ストリームを登録解除する（close は呼ばない）。 */
    public deregisterStream(stream: ManagedStream): boolean {
        const key = streamKey(stream.remoteNodeId, stream.localPort, stream.remotePort);
        const registered = this.activeStreams.get(key);
        if (registered !== stream) return false;
        return this.activeStreams.delete(key);
    }

    /** 現在のストリーム数。 */
    public size(): number {
        return this.activeStreams.size;
    }

    /** すべてのストリームを閉じて破棄する。 */
    public closeAll(): void {
        for (const stream of [...this.activeStreams.values()]) {
            this.activeStreams.delete(
                streamKey(stream.remoteNodeId, stream.localPort, stream.remotePort),
            );
            if (stream.destroy) {
                stream.destroy();
            } else {
                stream.close();
            }
        }
    }

    private runCleanup(): void {
        const now = Date.now();
        for (const [key, stream] of [...this.activeStreams.entries()]) {
            if (now - stream.lastActivity > this.sessionTimeoutMs) {
                this.logger.warn(`Stream ${key} timed out due to inactivity.`);
                this.activeStreams.delete(key);
                if (stream.destroy) {
                    stream.destroy();
                } else {
                    stream.close();
                }
            }
        }
    }
}
