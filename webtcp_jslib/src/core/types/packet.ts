import { NodeId, SequenceNumber, Signature, VirtualPort, WebTCPFlags } from './protocol.js';

/**
 * WebTCPネットワークを流れる単一パケットの構造。
 * L3 (Routing) と L4 (Transport) の両方のヘッダーを含む。
 *
 * ワイヤー上の表現は `BinaryPacketSerializer` が担う（specification.md §6）。
 */
export interface WebTCPPacket {
    // === L3 (Routing Layer) ヘッダー ===
    /** 送信元ノードID（署名検証に使用）。 */
    senderId: NodeId;
    /** 最終宛先ノードID。 */
    destinationId: NodeId;
    /** Time-to-Live（ホップごとにデクリメント）。 */
    ttl: number;
    /** senderId による署名。M1では空。 */
    signature: Signature;

    // === L4 (Transport Layer) ヘッダー ===
    /** 送信元ポート。 */
    sourcePort: VirtualPort;
    /** 宛先ポート。 */
    destinationPort: VirtualPort;
    /** SYN, ACK, FIN, RST, DATA, RT_UPDATE などのフラグ。 */
    flags: WebTCPFlags;
    /** シーケンス番号（パケット単位）。 */
    seqNum: SequenceNumber;
    /** 次に期待する受信シーケンス番号。 */
    ackNum: SequenceNumber;

    // === L7 (Payload) ===
    /** 実際のデータ（アプリケーションデータまたは制御情報）。 */
    payload: Uint8Array;
}
