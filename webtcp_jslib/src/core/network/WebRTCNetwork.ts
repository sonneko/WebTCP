import { EventEmitter } from 'events';
import { NodeId, VirtualPort, Milliseconds } from './core/types/protocol';
import { WebTCPPacket } from './core/types/packet';

// リンク層
import { LinkManager } from './core/link/LinkManager'; // 仮定
import { ISignalingAdapter } from './core/link/ISignalingAdapter';

// ルーティング層
import { RoutingLayer } from './core/routing/RoutingLayer';
import { RoutingTableManager } from './core/routing/RoutingTableManager'; // 仮定
import { RoutingTable } from './core/routing/RoutingTable'; // 仮定
import { PacketVerifier } from './core/routing/PacketVerifier'; // 仮定

// トランスポート層
import { TransportLayer } from './core/transport/TransportLayer';
import { VirtualStream } from './core/transport/VirtualStream'; // アプリケーション層向け

// 鍵管理 (仮定)
interface KeyManager {
    getPublicKey(id: NodeId): string;
    getLocalPrivateKey(): string;
    getLocalNodeId(): NodeId;
}

/**
 * WebTCPプロトコルスタック全体をカプセル化し、
 * ネットワークへのエントリーポイントを提供する最上位のクラス。
 */
export class WebTCPNetwork extends EventEmitter {
    public readonly localNodeId: NodeId;
    
    // 依存サービス
    private keyManager: KeyManager;
    
    // プロトコルレイヤー
    private linkManager: LinkManager;
    private routingLayer: RoutingLayer;
    private transportLayer: TransportLayer;

    // アプリケーション層向けの公開メソッド (TransportLayerのラッパー)
    public connect: (remoteId: NodeId, remotePort: VirtualPort, localPort: VirtualPort) => Promise<VirtualStream>;
    public listen: (port: VirtualPort, handler: (stream: VirtualStream) => void) => void;

    /**
     * @param adapter シグナリングに使用するアダプター
     * @param keyManager ノードIDと鍵ペアを提供するマネージャー
     */
    constructor(adapter: ISignalingAdapter, keyManager: KeyManager) {
        super();
        this.keyManager = keyManager;
        this.localNodeId = keyManager.getLocalNodeId();

        // 1. ルーティングテーブル/検証の準備 (仮の依存性注入)
        const routingTable = new RoutingTable();
        const routingTableManager = new RoutingTableManager(this.localNodeId, routingTable);
        const packetVerifier = new PacketVerifier(keyManager);

        // 2. リンク層の初期化
        this.linkManager = new LinkManager(this.localNodeId, adapter, keyManager);

        // 3. ルーティング層の初期化
        this.routingLayer = new RoutingLayer(
            this.localNodeId,
            this.linkManager,
            routingTable,
            routingTableManager,
            packetVerifier
        );

        // 4. トランスポート層の初期化
        this.transportLayer = new TransportLayer(this.localNodeId, this.routingLayer);

        // 5. アプリケーション層向けのAPIを公開
        this.connect = this.transportLayer.connect.bind(this.transportLayer);
        this.listen = this.transportLayer.listen.bind(this.transportLayer);

        console.log(`[WebTCP] Initialized Node: ${this.localNodeId}`);
    }

    /**
     * WebTCPネットワークの全レイヤーの処理を開始する。
     */
    public async start(): Promise<void> {
        console.log('[WebTCP] Starting all layers...');

        // リンク層（WebRTC接続の確立/監視）を開始
        await this.linkManager.start(); 
        
        // ルーティング層を開始 (経路情報交換の開始)
        await this.routingLayer.start();

        // トランスポート層を開始 (セッション管理タイマーの開始)
        this.transportLayer.start();

        this.emit('ready');
        console.log('[WebTCP] Network is READY.');
    }

    /**
     * 既知の隣接ノードを取得する。
     */
    public getNeighbors(): NodeId[] {
        // リンクマネージャーからアクティブな隣接ノードリストを取得
        return this.linkManager.getActiveNeighbors(); 
    }

    /**
     * ネットワーク内の任意のノードにデータを送信する (Raw API)。
     * 信頼性はTransportLayerが保証するため、ここでは提供しない。
     * 代わりに、connect/listenを通じてVirtualStreamを使用することを推奨する。
     */
    public async sendData(destinationId: NodeId, data: Buffer, destinationPort: VirtualPort, sourcePort: VirtualPort): Promise<void> {
        // これは主に内部で使用されるか、信頼性を必要としない通信用。
        // 通常のアプリケーションは this.connect/this.listen で得られる VirtualStream を使用すべきです。
        
        // 簡易的なパケットを作成し、ルーティング層に渡す
        const rawPacket: WebTCPPacket = {
            senderId: this.localNodeId,
            destinationId: destinationId,
            sourcePort: sourcePort,
            destinationPort: destinationPort,
            ttl: 64,
            flags: 'DATA' as any,
            seqNum: 0, 
            ackNum: 0,
            payload: data,
            signature: ''
        };
        await this.routingLayer.sendPacket(rawPacket);
    }
}
