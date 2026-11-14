import { NodeId, VirtualPort } from '../types/protocol.js';
import { IPacketSerializer } from '../types/serializer.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { generateNodeId } from '../util/id.js';
import { IChannel } from '../link/IChannel.js';
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
}

/**
 * WebTCPプロトコルスタック全体をカプセル化する最上位クラス。
 *
 * 層の組み立てと、アプリケーション向けのAPI（listen / connect）を提供する。
 * ブラウザで使う場合は `createBrowserNetwork()`（`src/browser.ts`）を利用するとよい。
 */
export class WebTCPNetwork extends EventEmitter {
    public readonly localNodeId: NodeId;
    public readonly linkManager: LinkManager;
    public readonly routingLayer: RoutingLayer;
    public readonly transportLayer: TransportLayer;

    private started = false;
    private closed = false;

    constructor(options: WebTCPNetworkOptions) {
        super();
        if (!options.channel) {
            throw new Error('WebTCPNetwork requires an IChannel implementation');
        }

        this.localNodeId =
            options.nodeId ?? options.signaling?.getLocalNodeId() ?? generateNodeId();

        const routingTable = new RoutingTable(this.localNodeId);

        this.linkManager = new LinkManager(
            this.localNodeId,
            options.channel,
            options.serializer,
        );

        this.routingLayer = new RoutingLayer(this.localNodeId, this.linkManager, routingTable, {
            ...(options.verifier ? { verifier: options.verifier } : {}),
            ...(options.defaultTtl !== undefined ? { defaultTtl: options.defaultTtl } : {}),
            ...(options.routingTableManager
                ? { routingTableManager: options.routingTableManager }
                : {}),
        });

        this.transportLayer = new TransportLayer(this.localNodeId, this.routingLayer, {
            ...options.transport,
            ...(options.defaultTtl !== undefined ? { defaultTtl: options.defaultTtl } : {}),
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

        this.emit('ready');
    }

    /**
     * 仮想ポートで接続を待ち受ける。
     * @throws 同じポートがすでに待ち受けられている、または未起動の場合
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
}
