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
    /** Time-to-Live（中継ホップごとにデクリメント）。 */
    ttl: number;
    /** senderId による署名。M1–M2では空。 */
    signature: Signature;

    // === L4 (Transport Layer) ヘッダー ===
    /** 送信元ポート。 */
    sourcePort: VirtualPort;
    /** 宛先ポート。 */
    destinationPort: VirtualPort;
    /** SYN, ACK, FIN, RST, DATA, RT_UPDATE などのフラグ。 */
    flags: WebTCPFlags;
    /** バイト単位のシーケンス番号（mod 2^32）。 */
    seqNum: SequenceNumber;
    /** 次に期待する受信バイトのシーケンス番号（mod 2^32）。 */
    ackNum: SequenceNumber;

    // === L7 / Control Payload ===
    /** 実際のデータ（アプリケーションデータ、RT_UPDATE JSON、または ACK の SACK オプション）。 */
    payload: Uint8Array;
}
