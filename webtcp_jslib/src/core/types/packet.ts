import { NodeId, SequenceNumber, Signature, VirtualPort, WebTCPFlags } from './protocol.js';

/**
 * WebTCPネットワークを流れる単一パケットの構造。
 * L3 (Routing) と L4 (Transport) の両方のヘッダーを含む。
 *
 * ワイヤー上の表現は `BinaryPacketSerializer` が担う（specification.md §6）。
 */
export interface WebTCPPacket {
    // === L3 (Routing Layer) ヘッダー ===
    /**
     * ワイヤーフォーマットのプロトコルバージョン。
     *
     * 送信時は既定で `WEBTCP_PROTOCOL_VERSION`（v2）が使われ、`signature` が設定されていれば
     * v2、空なら v1 としてシリアライズされる。受信パケットでは受信したバージョンが入る。
     */
    version?: number;
    /** 送信元ノードID（= Ed25519 公開鍵の指紋。署名検証に使用）。 */
    senderId: NodeId;
    /** 最終宛先ノードID。 */
    destinationId: NodeId;
    /** Time-to-Live（中継ホップごとにデクリメント）。 */
    ttl: number;
    /** senderId の秘密鍵による Ed25519 署名（v2）。v1 では空。 */
    signature: Signature;

    // === L4 (Transport Layer) ヘッダー ===
    /** 送信元ポート。 */
    sourcePort: VirtualPort;
    /** 宛先ポート。 */
    destinationPort: VirtualPort;
    /** SYN, ACK, FIN, RST, DATA, RT_UPDATE などのフラグ。 */
    flags: WebTCPFlags;
    /**
     * `WIN` ビット（フラグのビット 7、specification.md §6.3 / §8.3.4）。
     * 受信ウィンドウ対応を交渉した接続だけで使う。`SYN` / `SYN_ACK` では交渉、`ACK` では窓更新の問い合わせを表す。
     * 受信パケットで立っていなければ `undefined`（ビットが 0 の場合はプロパティを持たない）。
     */
    windowFlag?: boolean;
    /** バイト単位のシーケンス番号（mod 2^32）。 */
    seqNum: SequenceNumber;
    /** 次に期待する受信バイトのシーケンス番号（mod 2^32）。 */
    ackNum: SequenceNumber;

    // === L7 / Control Payload ===
    /** 実際のデータ（アプリケーションデータ、RT_UPDATE JSON、または ACK の SACK オプション）。 */
    payload: Uint8Array;
}
