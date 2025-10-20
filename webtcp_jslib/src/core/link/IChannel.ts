import { NodeId } from '../types/protocol';

/**
 * P2Pリンク層の抽象化インターフェース (IChannel)。
 * WebRTC DataChannel (またはその他のP2P通信手段) の機能を抽象化し、
 * RoutingLayerがプラットフォームや技術に依存せずにデータを送受信できるようにする。
 */
export interface IChannel {
    /**
     * ピアIDをキーとして、接続済みのP2Pリンクのステータスを管理するマップ。
     * true: 接続完了 (DataChannel Open)
     * false: 接続処理中または切断
     */
    readonly connectedPeers: Map<NodeId, boolean>;

    /**
     * 指定されたノードID宛に生データを送信する。
     * このメソッドは、パケットのルーティングや信頼性保証の責務を持たない。
     * 単に、確立されたP2Pリンクを通じてデータを「ベストエフォート」で送る。
     * * @param targetId 宛先ノードID (直接接続された隣接ノード)。
     * @param data 送信する生データ (Uint8ArrayまたはArrayBuffer)。
     * @returns {Promise<void>} 送信キューへの投入が成功したら解決する。
     */
    send(targetId: NodeId, data: Uint8Array): Promise<void>;

    /**
     * P2Pリンクの確立を開始する。
     * シグナリングアダプターを利用してオファー/アンサー交換が行われ、
     * 接続が確立されるのを待つ。
     * * @param targetId 接続を試みるノードID。
     * @returns {Promise<void>} P2P接続が確立されたら解決する。
     */
    connect(targetId: NodeId): Promise<void>;

    /**
     * P2Pリンクを切断する。
     * @param targetId 切断するノードID。
     */
    disconnect(targetId: NodeId): void;

    /**
     * P2Pリンクを通じて生データを受信した際のイベントリスナーを登録する。
     * * @param eventName イベント名 ('data'または'connection-status')
     * @param listener イベント発生時に呼び出されるコールバック関数。
     */
    on(eventName: 'data', listener: (fromId: NodeId, data: Uint8Array) => void): this;
    on(eventName: 'connection-status', listener: (peerId: NodeId, isConnected: boolean) => void): this;
}
