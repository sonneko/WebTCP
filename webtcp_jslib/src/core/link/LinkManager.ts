import { EventEmitter } from 'events';
import { NodeId } from '../types/protocol';
import { WebTCPPacket } from '../types/packet';
import { IChannel } from './IChannel';
import { ISignalingAdapter, SignalMessage } from './ISignalingAdapter';

// 鍵管理のインターフェース (WebTCPNetworkで仮定したものと整合させる)
interface KeyManager {
    getLocalNodeId(): NodeId;
    // 実際には、WebRTCの接続確立に署名鍵は不要だが、NodeIdとWebTCPのID管理のために参照
    getPublicKey(id: NodeId): string;
}

/**
 * WebTCPプロトコルスタックにおけるリンク層のメインコントローラー。
 * シグナリングアダプターとIChannelを統合し、ピアとの物理接続を確立・維持する。
 */
export class LinkManager extends EventEmitter {
    public readonly localNodeId: NodeId;

    private signalingAdapter: ISignalingAdapter;
    private keyManager: KeyManager;
    
    // キー: 隣接ノードID (remoteNodeId), 値: アクティブなWebRTC接続 (IChannel)
    private activeChannels: Map<NodeId, IChannel>;

    // 接続処理を追跡するための仮のMap (オファー送信済み、アンサー待ちなど)
    private pendingConnections: Map<NodeId, { channel: IChannel, timer: NodeJS.Timeout }>;

    /**
     * @param localNodeId このノードのID
     * @param adapter シグナリングに使用するアダプター
     * @param keyManager 鍵管理サービス
     */
    constructor(localNodeId: NodeId, adapter: ISignalingAdapter, keyManager: KeyManager) {
        super();
        this.localNodeId = localNodeId;
        this.signalingAdapter = adapter;
        this.keyManager = keyManager;
        this.activeChannels = new Map();
        this.pendingConnections = new Map();
    }

    /**
     * リンクマネージャーの処理を開始し、シグナリングの待ち受けを開始する。
     */
    public async start(): Promise<void> {
        console.log(`[LM] LinkManager started. Listening for signals...`);
        // シグナリングアダプターからの受信メッセージを処理するハンドラを登録
        await this.signalingAdapter.listen(this.handleIncomingSignal.bind(this));
    }

    /**
     * 既知のアクティブな隣接ノードのリストを返す。
     */
    public getActiveNeighbors(): NodeId[] {
        return Array.from(this.activeChannels.keys());
    }

    // ===============================================
    // データ送信 (RoutingLayer向けAPI)
    // ===============================================

    /**
     * 隣接ノードにパケットを直接送信する。
     * このメソッドはRoutingLayerから呼び出される。
     * @param neighborId 隣接ノードID
     * @param packet 送信するWebTCPPacket
     */
    public async sendPacketToNeighbor(neighborId: NodeId, packet: WebTCPPacket): Promise<boolean> {
        const channel = this.activeChannels.get(neighborId);
        if (channel && channel.isConnected()) {
            try {
                // IChannelのsendメソッドを使用してデータを送信
                const data = JSON.stringify(packet); // 実際はPacketSerializerでバイナリに変換
                channel.send(data);
                return true;
            } catch (error) {
                console.error(`[LM] Failed to send packet to ${neighborId}:`, error);
                this.disconnectChannel(neighborId);
                return false;
            }
        }
        console.warn(`[LM] Channel to ${neighborId} is not active or connected.`);
        return false;
    }

    // ===============================================
    // 接続確立 (WebRTC)
    // ===============================================

    /**
     * 特定のノードへのWebRTC接続を積極的に開始する (オファーを生成)。
     * このメソッドはRoutingTableManager/RoutingLayerから呼び出される。
     * @param remoteNodeId 接続先のノードID
     */
    public async initiateConnection(remoteNodeId: NodeId): Promise<void> {
        if (this.activeChannels.has(remoteNodeId) || this.pendingConnections.has(remoteNodeId)) {
            return; // 既に接続済みまたは接続試行中
        }

        // 1. 新しいIChannelを作成 (WebRTC PeerConnectionに相当)
        // 仮にIChannelImplという具体的な実装があると仮定
        const channel: IChannel = {
             // 接続開始のダミー実装
            init: (isInitiator: boolean) => {
                console.log(`[IChannel] Initializing as initiator for ${remoteNodeId}`);
                channel.on('data', this.handleChannelData.bind(this, remoteNodeId));
                channel.on('signal', (signal) => this.sendSignalToPeer(remoteNodeId, signal));
                channel.on('connected', () => this.handleChannelConnected(remoteNodeId));
                channel.on('closed', () => this.disconnectChannel(remoteNodeId));
                return Promise.resolve();
            },
            // 他のIChannelメソッドは省略
            send: (data: string) => { console.log(`[IChannel] Sending data to ${remoteNodeId}`); },
            isConnected: () => false,
            on: (event: string, handler: any) => {},
            close: () => {}
        } as unknown as IChannel; // ダミー実装の型アサーション

        await channel.init(true);

        // 2. 接続を追跡
        this.pendingConnections.set(remoteNodeId, { channel, timer: setTimeout(() => this.handleConnectionTimeout(remoteNodeId), 30000) });
    }

    // ===============================================
    // シグナリング受信処理
    // ===============================================

    /**
     * シグナリングアダプターから受信したメッセージを処理する。
     * @param senderId シグナルを送信したノードID
     * @param message 受信したシグナルメッセージ (Offer, Answer, ICE)
     */
    private async handleIncomingSignal(senderId: NodeId, message: SignalMessage): Promise<void> {
        let channel = this.activeChannels.get(senderId);

        if (!channel && (message.type === 'offer')) {
            // 接続要求 (オファー) の受信
            // 1. 新しいIChannelを作成 (isInitiator: false)
            const newChannel: IChannel = { /* ... IChannelのダミー実装 (上記参照) ... */ } as unknown as IChannel;
            await newChannel.init(false);
            newChannel.on('data', this.handleChannelData.bind(this, senderId));
            newChannel.on('signal', (signal) => this.sendSignalToPeer(senderId, signal));
            newChannel.on('connected', () => this.handleChannelConnected(senderId));
            newChannel.on('closed', () => this.disconnectChannel(senderId));

            this.pendingConnections.set(senderId, { channel: newChannel, timer: setTimeout(() => this.handleConnectionTimeout(senderId), 30000) });
            channel = newChannel;
            
            console.log(`[LM] Received OFFER from ${senderId}. Creating channel and processing...`);
        }

        if (channel) {
            // 2. 既存のチャネルにシグナルを設定
            // channel.handleSignal(message); // IChannelがSDPやICEを処理する
        } else {
            console.warn(`[LM] Received signal for unknown/inactive peer ${senderId}: ${message.type}. Dropping.`);
        }
    }

    /**
     * IChannelからのシグナルをシグナリングアダプター経由でピアに転送する。
     */
    private async sendSignalToPeer(recipientId: NodeId, signal: SignalMessage): Promise<void> {
        signal.fromId = this.localNodeId;
        await this.signalingAdapter.sendMessage(recipientId, signal);
    }

    // ===============================================
    // IChannelからのイベント処理
    // ===============================================

    /**
     * IChannelが接続確立状態になったときのハンドラ。
     */
    private handleChannelConnected(remoteNodeId: NodeId): void {
        const pending = this.pendingConnections.get(remoteNodeId);
        if (pending) {
            clearTimeout(pending.timer);
            this.activeChannels.set(remoteNodeId, pending.channel);
            this.pendingConnections.delete(remoteNodeId);
            
            // 接続完了イベントをRoutingLayerに通知
            this.emit('channel_connected', remoteNodeId);
            console.log(`[LM] Channel ESTABLISHED with ${remoteNodeId}.`);
        }
    }

    /**
     * IChannelがデータを受信したときのハンドラ。
     */
    private handleChannelData(remoteNodeId: NodeId, data: string | ArrayBuffer): void {
        try {
            // 受信データをWebTCPPacketに復元
            // 実際はPacketSerializerを使用
            const packet: WebTCPPacket = JSON.parse(data.toString());

            // RoutingLayerにパケットを渡す
            this.emit('packet_received', remoteNodeId, packet);
        } catch (error) {
            console.error(`[LM] Error processing data from ${remoteNodeId}:`, error);
        }
    }

    /**
     * IChannelが切断されたときのハンドラ。
     */
    private disconnectChannel(remoteNodeId: NodeId): void {
        if (this.activeChannels.has(remoteNodeId)) {
            this.activeChannels.delete(remoteNodeId);
            this.emit('channel_disconnected', remoteNodeId);
            console.log(`[LM] Channel disconnected from ${remoteNodeId}.`);
        }
        if (this.pendingConnections.has(remoteNodeId)) {
            const pending = this.pendingConnections.get(remoteNodeId);
            clearTimeout(pending!.timer);
            this.pendingConnections.delete(remoteNodeId);
        }
    }

    /**
     * 接続タイムアウト処理。
     */
    private handleConnectionTimeout(remoteNodeId: NodeId): void {
        console.warn(`[LM] Connection attempt to ${remoteNodeId} timed out.`);
        const pending = this.pendingConnections.get(remoteNodeId);
        if (pending) {
            pending.channel.close();
            this.pendingConnections.delete(remoteNodeId);
        }
    }
}
