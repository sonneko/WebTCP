import { NodeId, VirtualPort } from '../types/protocol.js';
import { IPacketSerializer } from '../types/serializer.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { LogLevel, Logger, createScopedLogger, resolveLogger } from '../util/Logger.js';
import { generateNodeId } from '../util/id.js';
import { IChannel } from '../link/IChannel.js';
import { IEntranceSearcher } from '../link/IEntranceSearcher.js';
import { ISignalingAdapter } from '../link/ISignalingAdapter.js';
import { LinkManager } from '../link/LinkManager.js';
import { Ed25519PacketVerifier, IPacketVerifier, NullPacketVerifier } from '../routing/PacketVerifier.js';
import { KeyDirectory } from '../routing/KeyDirectory.js';
import { Ed25519KeyManager, NodeIdCollisionError, isValidNodeId } from '../routing/keys.js';
import type { NameServer } from '../naming/NameServer.js';
import { formatWebTCPUrl, parseWebTCPUrl, WebTCPUrl } from '../naming/url.js';
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
    /** ノードID。省略時は鍵管理の NodeId、シグナリングアダプタのID、ランダム生成の順に解決する。 */
    nodeId?: NodeId;
    /**
     * Ed25519 鍵管理（#28）。
     *
     * 指定すると、`verifier` 未指定の場合に `Ed25519PacketVerifier` を自動で組み立て、
     * NodeId を公開鍵の指紋として扱う（プロトコル v2・署名必須）。
     */
    keyManager?: Ed25519KeyManager;
    /**
     * ピアの公開鍵ディレクトリ（任意）。
     * 指定すると RT_UPDATE で学習した公開鍵を検証器と共有する。
     * 省略時は `keyManager` から新しい `KeyDirectory` を生成して `network.keyDirectory` に公開する。
     */
    keyDirectory?: KeyDirectory;
    /**
     * 署名の必須化。既定は自動判定。
     * - `keyManager` または `Ed25519PacketVerifier` を指定した場合は `true`
     * - それ以外（`NullPacketVerifier`）は `false`（v1 パケットも受理）
     */
    requireSignatures?: boolean;
    /** パケットのシリアライザ（任意）。 */
    serializer?: IPacketSerializer;
    /**
     * 署名検証器（任意）。
     * 省略時は `keyManager` があれば `Ed25519PacketVerifier`、無ければ `NullPacketVerifier`。
     */
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

export interface ConnectURLOptions {
    /** 名前指定の解決に使う NameServer。NodeId 指定では不要。 */
    nameServer?: NameServer;
    localPort?: VirtualPort;
    signal?: AbortSignal;
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
    /** Ed25519 鍵管理（未指定なら null）。 */
    public readonly keyManager: Ed25519KeyManager | null;
    /** 公開鍵ディレクトリ（鍵管理・検証器を使わない場合は null）。 */
    public readonly keyDirectory: KeyDirectory | null;
    /** 署名検証器（実際に使われているもの）。 */
    public readonly verifier: IPacketVerifier;

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
        this.keyManager = options.keyManager ?? null;
        this.localNodeId = this.resolveLocalNodeId(options);
        this.keyDirectory = this.resolveKeyDirectory(options);
        if (options.keyManager && this.keyDirectory) {
            const existing = this.keyDirectory.get(this.localNodeId);
            if (existing && !bytesEqual(existing, options.keyManager.publicKey)) {
                throw new NodeIdCollisionError(this.localNodeId, existing, options.keyManager.publicKey);
            }
        }
        this.verifier = this.resolveVerifier(options);

        const routingTable = new RoutingTable(this.localNodeId);

        this.linkManager = new LinkManager(
            this.localNodeId,
            options.channel,
            options.serializer,
            baseLogger,
        );

        this.routingLayer = new RoutingLayer(this.localNodeId, this.linkManager, routingTable, {
            verifier: this.verifier,
            requiredSignatures: this.requiresSignatures(options),
            ...(this.keyDirectory ? { keyDirectory: this.keyDirectory } : {}),
            ...(this.keyManager ? { localPublicKey: this.keyManager.publicKey } : {}),
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
        try {
            await this.linkManager.start();
            this.routingLayer.start();
            this.transportLayer.start();
        } catch (error) {
            this.started = false;
            throw error;
        }

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
     * `webtcp://` URL へ接続する（M4 / #25）。名前は NameServer で解決する。
     * path/query/fragment はアプリケーション用であり、ここまでは送信しない。
     */
    public async connectURL(
        url: string | WebTCPUrl,
        options: ConnectURLOptions = {},
    ): Promise<VirtualStream> {
        if (this.closed) throw new Error('WebTCPNetwork is closed');
        const parsed = typeof url === 'string' ? parseWebTCPUrl(url) : parseWebTCPUrl(formatWebTCPUrl(url));
        if (options.signal?.aborted) throw new Error('WebTCP URL connection aborted');
        let nodeId = parsed.nodeId;
        if (!nodeId) {
            if (!options.nameServer) throw new Error(`NameServer is required to resolve ${parsed.host}`);
            const resolution = await options.nameServer.resolve(parsed.name!, {
                ...(options.signal ? { signal: options.signal } : {}),
            });
            nodeId = resolution.nodeId;
        }
        if (options.signal?.aborted) throw new Error('WebTCP URL connection aborted');
        return this.connect(nodeId, parsed.port, options.localPort);
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

    /**
     * NodeId を解決する。
     *
     * 優先順位: 明示指定 → 鍵管理の指紋 → シグナリングアダプタ → ランダム生成。
     * 鍵管理が指定されている場合、明示 NodeId は指紋と一致しなければならない（§10.1）。
     */
    private resolveLocalNodeId(options: WebTCPNetworkOptions): NodeId {
        const candidate =
            options.nodeId ??
            options.keyManager?.nodeId ??
            (options.verifier instanceof Ed25519PacketVerifier
                ? undefined
                : options.signaling?.getLocalNodeId()) ??
            generateNodeId();

        if (options.keyManager && candidate !== options.keyManager.nodeId) {
            throw new Error(
                `nodeId ${candidate} does not match the Ed25519 key fingerprint ${options.keyManager.nodeId}`,
            );
        }
        if (options.keyManager && !isValidNodeId(candidate)) {
            throw new Error(`invalid NodeId: ${candidate}`);
        }
        return candidate;
    }

    private resolveKeyDirectory(options: WebTCPNetworkOptions): KeyDirectory | null {
        if (options.keyDirectory) return options.keyDirectory;
        if (options.verifier instanceof Ed25519PacketVerifier) {
            return new KeyDirectory({ logger: options.logger });
        }
        if (options.keyManager) {
            return new KeyDirectory({ logger: options.logger });
        }
        return null;
    }

    private resolveVerifier(options: WebTCPNetworkOptions): IPacketVerifier {
        if (options.verifier) {
            // `Ed25519PacketVerifier` にディレクトリが無い場合は、ネットワークの
            // ディレクトリ（RT_UPDATE / シグナリングで学習）を共有する
            if (
                options.verifier instanceof Ed25519PacketVerifier &&
                !options.verifier.hasKeyDirectory &&
                this.keyDirectory &&
                options.keyManager
            ) {
                return new Ed25519PacketVerifier({
                    keyManager: options.keyManager,
                    keyDirectory: this.keyDirectory,
                    // 署名対象の導出は実際の送信と同一のシリアライザで行う (MUST, §10.3 / #41)
                    ...(options.serializer ? { serializer: options.serializer } : {}),
                });
            }
            return options.verifier;
        }
        if (options.keyManager) {
            return new Ed25519PacketVerifier({
                keyManager: options.keyManager,
                ...(this.keyDirectory ? { keyDirectory: this.keyDirectory } : {}),
                // §10.3 / #41: 送信に使うシリアライザで署名対象も導出する
                ...(options.serializer ? { serializer: options.serializer } : {}),
            });
        }
        return new NullPacketVerifier();
    }

    private requiresSignatures(options: WebTCPNetworkOptions): boolean {
        if (options.requireSignatures !== undefined) return options.requireSignatures;
        return Boolean(options.keyManager) || options.verifier instanceof Ed25519PacketVerifier;
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
    return true;
}
