import { EventEmitter } from 'events';
import { NodeId, VirtualPort } from '../types/protocol';
import { WebTCPPacket } from '../types/packet';
import { SessionManager, VirtualStream } from './SessionManager'; // VirtualStreamとSessionManagerの型定義をインポート
// 実際のVirtualStreamの実装ファイル
import { VirtualStream as VirtualStreamImpl } from './VirtualStream'; 

// ルーティング層への参照インターフェース
interface RoutingLayer {
    // パケットをネットワークに送信するAPI
    sendPacket(packet: WebTCPPacket): Promise<void>;
    // TransportLayerにパケットを渡すためのハンドラ登録API (実際にはRoutingLayerで実装される)
    registerPacketHandler(handler: (packet: WebTCPPacket) => void): void;
}

// アプリケーション層がポートでリッスンする際に登録するハンドラ
type PortHandler = (stream: VirtualStream) => void;

/**
 * WebTCPプロトコルスタックのトランスポート層 (L4) を実装するクラス。
 * ポート多重化、接続開始、セッション管理（SessionManager）、パケットのセッションへの振り分けを行う。
 */
export class TransportLayer extends EventEmitter {
    public readonly localNodeId: NodeId;
    private routingLayer: RoutingLayer;
    private sessionManager: SessionManager;

    // キー: VirtualPort, 値: PortHandler (リッスン中のアプリケーション)
    private portHandlers: Map<VirtualPort, PortHandler>;

    constructor(localNodeId: NodeId, routingLayer: RoutingLayer) {
        super();
        this.localNodeId = localNodeId;
        this.routingLayer = routingLayer;
        // SessionManagerのインスタンス化
        this.sessionManager = new SessionManager(); 
        this.portHandlers = new Map();

        // RoutingLayerにパケット受信ハンドラを登録
        this.routingLayer.registerPacketHandler(this.handleIncomingPacket.bind(this));
    }

    /**
     * トランスポート層の処理を開始する。
     */
    public start(): void {
        this.sessionManager.start();
        console.log(`[TL] TransportLayer started on Node ID: ${this.localNodeId}`);
    }

    /**
     * TransportLayer経由でRoutingLayerにパケットを送信する。
     * VirtualStreamが再送時に使用する。
     */
    public async sendPacket(packet: WebTCPPacket): Promise<void> {
        // TransportLayerで必要なヘッダー設定（Seq/AckNumはVirtualStreamが設定済み）
        // その後、RoutingLayerに転送を依頼
        await this.routingLayer.sendPacket(packet);
    }

    // ===============================================
    // アプリケーション層向けAPI
    // ===============================================

    /**
     * リモートノードとの新しい接続を確立する (アクティブオープン)。
     * @param remoteNodeId 接続先ノードID。
     * @param remotePort 接続先ポート。
     * @param localPort 使用するローカルポート (自動割り当ても可能だが、ここでは固定)。
     * @returns 確立されたVirtualStream。
     */
    public async connect(remoteNodeId: NodeId, remotePort: VirtualPort, localPort: VirtualPort): Promise<VirtualStream> {
        // 既存のセッションがないかチェック
        const existingStream = this.sessionManager.getStream(remoteNodeId, localPort, remotePort);
        if (existingStream) {
            return existingStream; // 既に接続中または接続試行中
        }

        // 新しいVirtualStreamインスタンスを作成 (isInitiator: true)
        const stream = new VirtualStreamImpl(this, remoteNodeId, localPort, remotePort, true) as unknown as VirtualStream;
        
        // SessionManagerに登録
        this.sessionManager.registerStream(stream);

        // 接続を開始 (SYNパケット送信)
        await stream.initiateConnection(); 

        // 接続完了イベントを待機して返す（非同期処理の簡略化のため、ここではPromiseを返す）
        return new Promise((resolve, reject) => {
            stream.once('connect', () => resolve(stream));
            stream.once('error', (err) => reject(err));
            // TODO: タイムアウト処理などを実装
        });
    }

    /**
     * 指定されたポートで接続リクエスト（SYN）を待ち受ける (パッシブオープン)。
     * @param port 待ち受けるポート番号。
     * @param handler 接続が確立したときに実行されるコールバック関数。
     */
    public listen(port: VirtualPort, handler: PortHandler): void {
        if (this.portHandlers.has(port)) {
            console.error(`[TL] Port ${port} is already listening.`);
            return;
        }
        this.portHandlers.set(port, handler);
        console.log(`[TL] Listening for connections on Port ${port}`);
    }
    
    // ===============================================
    // パケット処理 (Port Multiplexing)
    // ===============================================

    /**
     * RoutingLayerから受信したパケットを処理し、適切なストリームに振り分ける。
     */
    private handleIncomingPacket(packet: WebTCPPacket): void {
        const { senderId, destinationPort, sourcePort } = packet;
        
        // 1. 宛先が自分自身か確認（RoutingLayerで確認済みのはずだが、二重チェック）
        if (packet.destinationId !== this.localNodeId) {
            console.warn('[TL] Received packet not destined for this node. Dropping.');
            return;
        }
        
        const localPort = destinationPort;
        const remotePort = sourcePort;
        
        // 2. 既存のVirtualStreamを検索
        let stream = this.sessionManager.getStream(senderId, localPort, remotePort);
        
        const type = this.getPacketType(packet);

        if (stream) {
            // 3. 既存のセッションにパケットを渡す
            stream.handleIncomingPacket(packet);
        } else {
            // 4. セッションが存在しない場合、SYNパケットかどうかチェック
            if (type === 'SYN') {
                this.handleSynRequest(packet, localPort, remotePort, senderId);
            } else {
                // 5. SYN以外のパケットがセッションなしで到着した場合はRSTを返す
                this.sendRst(senderId, remotePort, localPort);
                console.warn(`[TL] Dropping non-SYN packet for non-existent session. From ${senderId}:${remotePort} to ${localPort}`);
            }
        }
    }

    /**
     * SYNパケットを受信した場合の処理 (パッシブオープン)
     */
    private handleSynRequest(packet: WebTCPPacket, localPort: VirtualPort, remotePort: VirtualPort, remoteNodeId: NodeId): void {
        const handler = this.portHandlers.get(localPort);

        if (handler) {
            // 接続リクエストを受け入れる
            console.log(`[TL] SYN received on Port ${localPort}. Creating new VirtualStream.`);
            
            // 新しいVirtualStreamインスタンスを作成 (isInitiator: false)
            // stateはコンストラクタ内で 'SYN_RCVD' に設定される
            const stream = new VirtualStreamImpl(this, remoteNodeId, localPort, remotePort, false) as unknown as VirtualStream;
            this.sessionManager.registerStream(stream);

            // VirtualStreamにSYNパケットを渡し、SYN-ACK応答を促す
            stream.handleIncomingPacket(packet);

            // アプリケーション層のハンドラに新しいストリームを渡す
            handler(stream);
        } else {
            // 誰もリッスンしていないポートへのSYNはRSTを返す
            this.sendRst(remoteNodeId, remotePort, localPort);
            console.warn(`[TL] Port ${localPort} not listening. Sent RST.`);
        }
    }

    /**
     * RST (Reset) パケットを作成し、リモートノードに送信する。
     */
    private sendRst(destinationId: NodeId, destinationPort: VirtualPort, sourcePort: VirtualPort): void {
        // RSTパケットを作成（seqNum/ackNumは省略またはゼロ）
        const rstPacket: WebTCPPacket = {
            senderId: this.localNodeId,
            destinationId: destinationId,
            sourcePort: sourcePort,
            destinationPort: destinationPort,
            ttl: 64, 
            flags: 'RST' as any,
            seqNum: 0,
            ackNum: 0,
            payload: Buffer.from('RST'),
            signature: '' 
        };
        this.routingLayer.sendPacket(rstPacket);
    }
    
    /**
     * VirtualStreamからコピーしたパケットタイプ判定ロジック。
     * 実際には、パケットヘッダーのフラグフィールドから判定すべき。
     */
    private getPacketType(packet: WebTCPPacket): 'SYN' | 'ACK' | 'SYN_ACK' | 'DATA' | 'FIN' | 'RST' | 'OTHER' {
        // 簡易フラグ判定 (VirtualStreamと同様のロジックを使用)
        if (packet.flags === 'SYN') return 'SYN';
        if (packet.flags === 'ACK') return 'ACK';
        if (packet.flags === 'SYN_ACK') return 'SYN_ACK';
        if (packet.flags === 'FIN') return 'FIN';
        if (packet.flags === 'RST') return 'RST';
        if (packet.payload.length > 0 && packet.flags !== 'SYN' && packet.flags !== 'FIN') return 'DATA';
        return 'OTHER';
    }
}
