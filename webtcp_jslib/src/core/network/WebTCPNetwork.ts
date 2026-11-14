import { NodeId, VirtualPort } from '../types/protocol.js';
import { IPacketSerializer } from '../types/serializer.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { LogLevel, Logger, createScopedLogger, resolveLogger } from '../util/Logger.js';
import { generateNodeId } from '../util/id.js';
import { IChannel } from '../link/IChannel.js';
import { IEntranceSearcher } from '../link/IEntranceSearcher.js';
import { ISignalingAdapter } from '../link/ISignalingAdapter.js';
import { LinkManager } from '../link/LinkManager.js';
import { IPacketVerifier } from '../routing/PacketVerifier.js';
import { RoutingLayer } from '../routing/RoutingLayer.js';
import { RoutingTable } from '../routing/RoutingTable.js';
import { RoutingTableManagerOptions } from '../routing/RoutingTableManager.js';
import { TransportLayer, TransportLayerOptions } from '../transport/TransportLayer.js';
import { VirtualStream } from '../transport/VirtualStream.js';

export interface WebTCPNetworkOptions {
    /** データチャネルの実装（必須）。 */
    channel: IChannel;
    /** シグナリングアダプタ（任意。`channel` が内部で利用する）。 */
    signaling?: ISignalingAdapter;
    /** ノードID。省略時はシグナリングアダプタのID、それも無ければランダム生成。 */
    nodeId?: NodeId;
    /** パケットのシリアライザ（任意）。 */
    serializer?: IPacketSerializer;
    /** 署名検証器（任意。既定は NullPacketVerifier）。 */
    verifier?: IPacketVerifier;
    routingTableManager?: RoutingTableManagerOptions;
    transport?: TransportLayerOptions;
    /** 送信パケットの初期TTL。既定 64。 */
    defaultTtl?: number;
    /** 注入するロガー（任意。指定時は `logLevel` より優先）。 */
    logger?: Logger;
    /** 既定コンソールロガーのログレベル（任意。既定 `'warn'`）。 */
    logLevel?: LogLevel;
}

export interface BootstrapOptions {
    /** 確立したい隣接接続数。既定 1。 */
    targetConnections?: number;
    /** 探索〜接続の最大試行回数（初回含む）。既定 3。 */
    maxRetries?: number;
    /** 初回リトライまでのバックオフ時間（ms）。既定 500。 */
    initialBackoffMs?: number;
    /** バックオフ上限（ms）。既定 10000。 */
    maxBackoffMs?: number;
    /** バックオフ倍率。既定 2。 */
    backoffFactor?: number;
    /** 中断用シグナル（任意）。 */
    signal?: AbortSignal;
    /** 待機関数（テスト用に差し替え可能）。 */
    sleep?: (ms: number) => Promise<void>;
}

export interface BootstrapFailure {
    nodeId: NodeId;
    error: Error;
}

export interface BootstrapResult {
    /** 接続に成功したノードID一覧。 */
    connected: NodeId[];
    /** 接続に失敗した候補とエラー一覧。 */
    failed: BootstrapFailure[];
    /** 実行した試行ラウンド数。 */
    attempts: number;
}

/**
 * WebTCPプロトコルスタック全体をカプセル化する最上位クラス。
 *
 * 層の組み立てと、アプリケーション向けのAPI（listen / connect / bootstrap）を提供する。
 * ブラウザで使う場合は `createBrowserNetwork()`（`src/browser.ts`）を利用するとよい。
 */
export class WebTCPNetwork extends EventEmitter {
    public readonly localNodeId: NodeId;
    public readonly linkManager: LinkManager;
    public readonly routingLayer: RoutingLayer;
    public readonly transportLayer: TransportLayer;
    public readonly logger: Logger;

    private readonly scopedLogger: Logger;
    private started = false;
    private closed = false;

    constructor(options: WebTCPNetworkOptions) {
        const baseLogger = resolveLogger(options.logger, options.logLevel);
        super(baseLogger);
        if (!options.channel) {
            throw new Error('WebTCPNetwork requires an IChannel implementation');
        }

        this.logger = baseLogger;
        this.scopedLogger = createScopedLogger(baseLogger, 'NET');
        this.localNodeId =
            options.nodeId ?? options.signaling?.getLocalNodeId() ?? generateNodeId();

        const routingTable = new RoutingTable(this.localNodeId);

        this.linkManager = new LinkManager(
            this.localNodeId,
            options.channel,
            options.serializer,
            baseLogger,
        );

        this.routingLayer = new RoutingLayer(this.localNodeId, this.linkManager, routingTable, {
            ...(options.verifier ? { verifier: options.verifier } : {}),
            ...(options.defaultTtl !== undefined ? { defaultTtl: options.defaultTtl } : {}),
            ...(options.routingTableManager
                ? { routingTableManager: options.routingTableManager }
                : {}),
            logger: baseLogger,
        });

        this.transportLayer = new TransportLayer(this.localNodeId, this.routingLayer, {
            ...options.transport,
            ...(options.defaultTtl !== undefined ? { defaultTtl: options.defaultTtl } : {}),
            logger: options.transport?.logger ?? baseLogger,
        });
    }

    /**
     * すべての層を開始する（冪等）。
     */
    public async start(): Promise<void> {
        if (this.started) return;
        if (this.closed) throw new Error('WebTCPNetwork is closed');
        this.started = true;

        await this.linkManager.start();
        this.routingLayer.start();
        this.transportLayer.start();

        this.scopedLogger.info(`WebTCPNetwork started (nodeId=${this.localNodeId})`);
        this.emit('ready');
    }

    /**
     * 仮想ポートで接続を待ち受ける。
     * @throws 同じポートがすでに待ち受けられている、またはクローズ済みの場合
     */
    public listen(port: VirtualPort, handler: (stream: VirtualStream) => void): void {
        this.transportLayer.listen(port, handler);
    }

    /**
     * リモートノードへの仮想接続を確立する。
     * 必要なら先に P2P リンクを確立する。
     */
    public async connect(
        remoteId: NodeId,
        remotePort: VirtualPort,
        localPort?: VirtualPort,
    ): Promise<VirtualStream> {
        if (this.closed) throw new Error('WebTCPNetwork is closed');
        if (remoteId === this.localNodeId) {
            throw new Error('Cannot connect to self');
        }

        // 直接のリンクが無く、経路も未学習の場合のみリンク確立を試みる。
        // マルチホップの経路が既に分かっている場合は、中継ノードに任せる。
        const route = this.getRoutingTable().getEntry(remoteId);
        if (!route || route.cost === 0) {
            await this.connectToPeer(remoteId);
        }

        return this.transportLayer.connect(remoteId, remotePort, localPort);
    }

    /**
     * リンク層の接続のみを確立する。
     */
    public async connectToPeer(remoteId: NodeId): Promise<void> {
        if (this.closed) throw new Error('WebTCPNetwork is closed');
        if (remoteId === this.localNodeId) {
            throw new Error('Cannot connect to self');
        }
        await this.linkManager.connectToNeighbor(remoteId);
    }

    /**
     * エントランス探索結果から候補ノードへ順に接続を試みる（#27, specification.md §9.5）。
     *
     * 目標接続数（既定 1）に達するまで候補へ順次 `connectToPeer()` を試行し、
     * 候補が無い・全候補への接続に失敗した場合は指数バックオフでリトライする。
     */
    public async bootstrap(
        searcher: IEntranceSearcher,
        options: BootstrapOptions = {},
    ): Promise<BootstrapResult> {
        if (this.closed) throw new Error('WebTCPNetwork is closed');

        const targetConnections = Math.max(1, options.targetConnections ?? 1);
        const maxRetries = Math.max(1, options.maxRetries ?? 3);
        const initialBackoffMs = Math.max(0, options.initialBackoffMs ?? 500);
        const maxBackoffMs = Math.max(initialBackoffMs, options.maxBackoffMs ?? 10_000);
        const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
        const sleepFn = options.sleep ?? ((ms: number) => this.delayWithAbort(ms, options.signal));

        if (!this.started) {
            await this.start();
        }

        const connected: NodeId[] = [];
        const failed: BootstrapFailure[] = [];
        let attempts = 0;

        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            this.assertNotAbortedOrClosed(options.signal);
            attempts = attempt;

            let candidates: NodeId[] = [];
            try {
                candidates = await searcher.search();
            } catch (error) {
                this.scopedLogger.warn(
                    `Bootstrap search attempt ${attempt}/${maxRetries} failed:`,
                    error,
                );
            }

            const filtered = candidates.filter(
                (nodeId) =>
                    nodeId !== this.localNodeId &&
                    !this.linkManager.isNeighbor(nodeId) &&
                    !connected.includes(nodeId),
            );

            for (const candidate of filtered) {
                this.assertNotAbortedOrClosed(options.signal);
                if (connected.length >= targetConnections) break;

                try {
                    await this.connectToPeer(candidate);
                    connected.push(candidate);
                    this.scopedLogger.info(`Bootstrapped peer connection: ${candidate}`);
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    failed.push({ nodeId: candidate, error: err });
                    this.scopedLogger.warn(
                        `Bootstrap failed to connect to ${candidate} (attempt ${attempt}/${maxRetries}):`,
                        err.message,
                    );
                }
            }

            if (connected.length >= targetConnections) {
                return { connected, failed, attempts };
            }

            if (attempt < maxRetries) {
                const backoffMs = Math.min(
                    maxBackoffMs,
                    Math.round(initialBackoffMs * Math.pow(backoffFactor, attempt - 1)),
                );
                this.scopedLogger.debug(
                    `Bootstrap attempt ${attempt}/${maxRetries} yielded ${connected.length}/${targetConnections} peer(s); retrying in ${backoffMs}ms`,
                );
                await sleepFn(backoffMs);
            }
        }

        return { connected, failed, attempts };
    }

    /** 接続済みの隣接ノード一覧。 */
    public getNeighbors(): NodeId[] {
        return this.linkManager.getActiveNeighbors();
    }

    /** ルーティングテーブル（読み取り用）。 */
    public getRoutingTable(): RoutingTable {
        return this.routingLayer.getRoutingTable();
    }

    /** 全層を停止する。 */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.transportLayer.close();
        this.routingLayer.stop();
        this.linkManager.close();
        this.removeAllListeners();
    }

    private assertNotAbortedOrClosed(signal?: AbortSignal): void {
        if (this.closed) {
            throw new Error('WebTCPNetwork is closed');
        }
        if (signal?.aborted) {
            throw new Error('Bootstrap aborted');
        }
    }

    private delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
        if (ms <= 0) {
            this.assertNotAbortedOrClosed(signal);
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('WebTCPNetwork is closed'));
                return;
            }
            if (signal?.aborted) {
                reject(new Error('Bootstrap aborted'));
                return;
            }

            const onAbort = (): void => {
                clearTimeout(timer);
                reject(new Error('Bootstrap aborted'));
            };

            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                if (this.closed) {
                    reject(new Error('WebTCPNetwork is closed'));
                } else {
                    resolve();
                }
            }, ms);

            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}
