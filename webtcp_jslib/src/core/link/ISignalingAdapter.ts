import { NodeId } from '../types/protocol';

/**
 * シグナリングメッセージのペイロード構造を定義します。
 * 実際には、WebRTCのSDP (Session Description Protocol) や ICE Candidate が入ります。
 */
export interface SignalMessage {
    type: 'offer' | 'answer' | 'candidate';
    content: unknown;
    fromId: NodeId;
}

/**
 * シグナリング層の抽象化インターフェース (ISignalingAdapter)。
 * P2P接続に必要なオファー/アンサーの交換、ICE候補の転送ロジックを担う。
 * 通信手段を抽象化する。
 */
export interface ISignalingAdapter {
    /**
     * ローカルノードのユニークなID (NodeId) を取得する。
     * このIDは通常、永続化された秘密鍵から導出される。
     */
    getLocalNodeId(): NodeId;

    /**
     * シグナリングメッセージを相手ノードに送信する。
     * このメソッドはメッセージをシグナリングバックエンドに書き込む責務を持つ。
     * @param recipientId 宛先ノードのID。
     * @param message 送信するシグナリングメッセージ（Offer, Answer, Candidate）。
     * @returns {Promise<void>}
     */
    sendMessage(recipientId: NodeId, message: SignalMessage): Promise<void>;

    /**
     * 自身宛てのシグナリングメッセージを受信するためのリスナーを開始する。
     * シグナリングバックエンドのリアルタイムな監視（例：FirestoreのonSnapshot）を担う。
     * @param callback メッセージを受信した際に呼び出される関数。
     * @returns {Promise<void>}
     */
    listen(callback: (fromId: NodeId, message: SignalMessage) => void): Promise<void>;
    
}
