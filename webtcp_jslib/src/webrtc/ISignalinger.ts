// WebRTCのシグナリングメッセージ型を定義
export type SignalingMessage = {
    // SDP本体 (Offer, Answer)
    sdp?: RTCSessionDescriptionInit; 
    // ICE Candidate 本体
    ice?: RTCIceCandidateInit;
};

// ピアを一意に識別するID
export type PeerId = string;

/**
 * WebTCPノード間のSDP Offer/Answer、ICE Candidateの交換手段を抽象化するインターフェース。
 */
export default interface ISignalinger {
    /**
     * 自身のノードIDを生成または登録し、シグナリングセッションを開始する。
     * @returns {Promise<PeerId>} ホストとなる自身のピアID
     */
    createSession(): Promise<PeerId>;

    /**
     * メッセージの受信を監視するロジックを開始する。
     * KVSignalingでは、このメソッド内でポーリングや、ホストからの明示的なメッセージ取得ロジックを実装する。
     * @param {PeerId} peerId - メッセージを受信する自身のID
     * @param {(message: SignalingMessage) => void} listener - メッセージ受信時のコールバック
     * @returns {() => void} リスニングを停止する関数 (クリーンアップ)
     */
    listen(peerId: PeerId, listener: (message: SignalingMessage) => void): () => void;

    /**
     * 指定したピアにシグナリングメッセージを送信する。
     * @param {PeerId} recipientId - メッセージの宛先ピアID
     * @param {SignalingMessage} message - 送信するSDPまたはICE Candidate
     * @returns {Promise<void>}
     */
    sendMessage(recipientId: PeerId, message: SignalingMessage): Promise<void>;
}