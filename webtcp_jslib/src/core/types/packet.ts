import { NodeId, VirtualPort, Signature, WebTCPFlags } from './protocol';

/**
 * WebTCPネットワークを流れる単一パケットの構造。
 * L3 (Routing) と L4 (Transport) の両方のヘッダーを含む。
 */
export interface WebTCPPacket {
    // === L3 (Routing Layer) ヘッダー ===
    senderId: NodeId;            // 送信元ノードID (署名検証に使用)
    destinationId: NodeId;       // 最終宛先ノードID
    ttl: number;                 // Time-to-Live (ホップごとにデクリメント)
    signature: Signature;        // senderIdによるデジタル署名 (PacketVerifierが検証)

    // === L4 (Transport Layer) ヘッダー ===
    sourcePort: VirtualPort;     // 送信元ポート
    destinationPort: VirtualPort;// 宛先ポート
    flags: WebTCPFlags;          // SYN, ACK, FIN, RST, DATA, RT_UPDATEなどのフラグ
    seqNum: number;              // シーケンス番号 (データの順序保証)
    ackNum: number;              // 確認応答番号 (次に期待するシーケンス番号)

    // === L7 (Payload) ===
    payload: Buffer;             // 実際のデータ (アプリケーションデータまたは制御情報)
}
