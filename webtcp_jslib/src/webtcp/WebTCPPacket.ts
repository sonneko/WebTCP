/**
 * グローバルに一意なノード識別子。
 */
export type NodeId = string; 

/**
 * 仮想TCPセッションの一意な識別子。
 */
export type SessionId = number; 

/**
 * WebTCPプロトコル内のパケット構造。
 * ルーティングヘッダーと模擬TCPヘッダーを含む。
 */
export class WebTCPPacket {
    // --- Layer 2: ルーティングヘッダー ---
    public sourceId: NodeId;
    public destinationId: NodeId;
    public nextHopId: NodeId;
    public ttl: number;
    public serviceType: number; // 0x01=模擬TCP, 0x02=WebTCP-DNS

    // --- Layer 3: 模擬TCPヘッダー ---
    public sessionId: SessionId;
    public sequenceNum: number;
    public flags: number; // SYN, ACK, FIN など
    public port: number;

    // --- ペイロード ---
    public payload: ArrayBuffer;

    constructor(init: Partial<WebTCPPacket>) {
        Object.assign(this, init);
    }

    // 簡略化のため、ここでは実際のシリアライズ/デシリアライズロジックは省略します。
    // 実際のアプリケーションではバイナリ効率的なシリアライズが必要です。
    public static serialize(packet: WebTCPPacket): ArrayBuffer { /* ... */ return new ArrayBuffer(0); }
    public static deserialize(buffer: ArrayBuffer): WebTCPPacket { /* ... */ return new WebTCPPacket({}); }
}