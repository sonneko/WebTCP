import { NodeId } from '../types/protocol.js';

/**
 * シグナリングメッセージのペイロード構造（specification.md §9.2）。
 * WebRTCのSDP（Offer/Answer）やICE Candidateが入る。
 */
export interface SignalMessage {
    type: 'offer' | 'answer' | 'candidate';
    content: unknown;
    fromId: NodeId;
}

/**
 * シグナリング層の抽象化インターフェース。
 * Offer/Answer/ICE候補の運搬のみを責務とする。
 */
export interface ISignalingAdapter {
    /**
     * ローカルノードのNodeIdを取得する。
     * `WebTCPNetwork` が使用するIDと一致しなければならない。
     */
    getLocalNodeId(): NodeId;

    /**
     * シグナリングメッセージを相手ノードへ送信する。
     * @param recipientId 宛先ノードID
     * @param message 送信するメッセージ
     */
    sendMessage(recipientId: NodeId, message: SignalMessage): Promise<void>;

    /**
     * 自身宛てのシグナリングメッセージの受信を開始する。
     * @param callback 受信時に呼び出される関数
     */
    listen(callback: (fromId: NodeId, message: SignalMessage) => void): Promise<void>;

    /**
     * 受信を停止し、リソースを解放する（任意）。
     */
    close?(): void;
}
