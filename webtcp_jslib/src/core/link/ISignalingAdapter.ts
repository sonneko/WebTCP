import { NodeId } from '../types/protocol.js';

/**
 * シグナリングメッセージの種別（specification.md §10.2）。
 *
 * - `offer` / `answer` / `candidate`: WebRTC のネゴシエーション
 * - `public-key`: Ed25519 公開鍵の交換（#28、プロトコル v2）
 */
export type SignalMessageType = 'offer' | 'answer' | 'candidate' | 'public-key';

/**
 * `public-key` メッセージの内容（specification.md §10.2.1 / §11.4.1）。
 *
 * `publicKey` は 32 バイトの Ed25519 公開鍵を Base64url で表したもの。
 * `nodeId` は送信側の NodeId（= 公開鍵の指紋）。受信側は指紋の一致を検証する。
 */
export interface PublicKeyPayload {
    type: 'public-key';
    /** Ed25519 公開鍵（Base64url、32 バイト）。 */
    publicKey: string;
    /** 送信側の NodeId（任意。省略時は `fromId` を使う）。 */
    nodeId?: NodeId;
}

/**
 * シグナリングメッセージのペイロード構造（specification.md §10.2）。
 * WebRTCのSDP（Offer/Answer）やICE Candidateが入る。
 */
export interface SignalMessage {
    type: SignalMessageType;
    /** SDP / ICE candidate / `PublicKeyPayload`。 */
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

/** `content` が `PublicKeyPayload` かどうか。 */
export function isPublicKeyPayload(value: unknown): value is PublicKeyPayload {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<PublicKeyPayload>;
    return candidate.type === 'public-key' && typeof candidate.publicKey === 'string';
}
