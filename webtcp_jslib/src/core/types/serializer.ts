import { WebTCPPacket } from '../types/packet';
import { NodeId, VirtualPort, Signature, WebTCPFlags } from '../types/protocol';

// フラグのビット定義 (実際のTCPと同様にビット単位で管理)
const FLAG_MASKS: { [key in WebTCPFlags]: number } = {
    'DATA': 0b00000001,
    'SYN': 0b00000010,
    'ACK': 0b00000100,
    'FIN': 0b00001000,
    'RST': 0b00010000,
    'SYN_ACK': 0b00100000,
    'RT_UPDATE': 0b01000000,
};

/**
 * WebTCPPacketとバイナリデータ (Buffer) を相互変換するためのインターフェース。
 */
export interface IPacketSerializer {
    /**
     * WebTCPPacketオブジェクトをネットワーク送信可能なバイナリデータに変換する。
     * @param packet - シリアライズするパケット
     * @returns バイナリBuffer
     */
    serialize(packet: WebTCPPacket): Buffer;

    /**
     * 受信したバイナリデータをWebTCPPacketオブジェクトに復元する。
     * @param buffer - ネットワークから受信したバイナリBuffer
     * @returns 復元されたWebTCPPacket
     */
    deserialize(buffer: Buffer): WebTCPPacket;
}

/**
 * WebTCPプロトコルパケットのバイナリシリアライザ実装。
 * Node.jsのBufferクラスを使用して、ネットワーク効率を考慮したバイナリ変換を行う。
 */
export class BinaryPacketSerializer implements IPacketSerializer {

    /**
     * フラグ文字列からビットマスクを生成する。
     */
    private flagsToMask(flag: WebTCPFlags): number {
        // 実際のプロトコルではフラグを組み合わせて設定するが、ここでは単一フラグを想定
        return FLAG_MASKS[flag] || 0;
    }

    /**
     * ビットマスクからフラグ文字列を復元する。
     */
    private maskToFlags(mask: number): WebTCPFlags {
        for (const [key, value] of Object.entries(FLAG_MASKS)) {
            if ((mask & value) === value) {
                return key as WebTCPFlags;
            }
        }
        return 'DATA'; // デフォルト
    }

    /**
     * WebTCPPacketオブジェクトをバイナリデータに変換する。
     */
    public serialize(packet: WebTCPPacket): Buffer {
        const senderIdBuf = Buffer.from(packet.senderId, 'utf8');
        const destIdBuf = Buffer.from(packet.destinationId, 'utf8');
        const signatureBuf = Buffer.from(packet.signature, 'utf8');
        const payloadBuf = packet.payload;

        // 固定長部分: TTL(1), Flags(1), Ports(4), SeqNum(4), AckNum(4) = 14 bytes
        const fixedHeaderSize = 14;

        // 可変長フィールドの長さ情報: NodeId(x2), Signature, Payload (各1 or 4 bytes)
        const variableHeaderSize = 
            1 + senderIdBuf.length +
            1 + destIdBuf.length +
            1 + signatureBuf.length +
            4 + payloadBuf.length; // Payload size (4 bytes) + Payload data

        const totalLength = fixedHeaderSize + variableHeaderSize;
        const buffer = Buffer.alloc(totalLength);
        let offset = 0;

        // --- 1. Routing Header ---
        buffer.writeUInt8(packet.ttl, offset); offset += 1;
        
        buffer.writeUInt8(senderIdBuf.length, offset); offset += 1; // Sender ID Length
        senderIdBuf.copy(buffer, offset); offset += senderIdBuf.length;

        buffer.writeUInt8(destIdBuf.length, offset); offset += 1; // Destination ID Length
        destIdBuf.copy(buffer, offset); offset += destIdBuf.length;

        buffer.writeUInt8(signatureBuf.length, offset); offset += 1; // Signature Length
        signatureBuf.copy(buffer, offset); offset += signatureBuf.length;

        // --- 2. Transport Header ---
        buffer.writeUInt8(this.flagsToMask(packet.flags), offset); offset += 1; // Flags
        buffer.writeUInt16BE(packet.sourcePort, offset); offset += 2; // Source Port
        buffer.writeUInt16BE(packet.destinationPort, offset); offset += 2; // Destination Port
        buffer.writeUInt32BE(packet.seqNum, offset); offset += 4; // Sequence Number
        buffer.writeUInt32BE(packet.ackNum, offset); offset += 4; // ACK Number

        // --- 3. Payload ---
        buffer.writeUInt32BE(payloadBuf.length, offset); offset += 4; // Payload Length
        payloadBuf.copy(buffer, offset); offset += payloadBuf.length;
        
        return buffer;
    }

    /**
     * 受信したバイナリデータをWebTCPPacketオブジェクトに復元する。
     */
    public deserialize(buffer: Buffer): WebTCPPacket {
        let offset = 0;
        
        // --- 1. Routing Header ---
        const ttl = buffer.readUInt8(offset); offset += 1;

        const senderIdSize = buffer.readUInt8(offset); offset += 1;
        const senderId = buffer.slice(offset, offset + senderIdSize).toString('utf8'); offset += senderIdSize;

        const destIdSize = buffer.readUInt8(offset); offset += 1;
        const destinationId = buffer.slice(offset, offset + destIdSize).toString('utf8'); offset += destIdSize;

        const signatureSize = buffer.readUInt8(offset); offset += 1;
        const signature = buffer.slice(offset, offset + signatureSize).toString('utf8'); offset += signatureSize;

        // --- 2. Transport Header ---
        const flagsMask = buffer.readUInt8(offset); offset += 1;
        const flags = this.maskToFlags(flagsMask);

        const sourcePort = buffer.readUInt16BE(offset); offset += 2;
        const destinationPort = buffer.readUInt16BE(offset); offset += 2;
        const seqNum = buffer.readUInt32BE(offset); offset += 4;
        const ackNum = buffer.readUInt32BE(offset); offset += 4;

        // --- 3. Payload ---
        const payloadSize = buffer.readUInt32BE(offset); offset += 4;
        const payload = buffer.slice(offset, offset + payloadSize);

        return {
            senderId,
            destinationId,
            ttl,
            signature,
            sourcePort,
            destinationPort,
            flags,
            seqNum,
            ackNum,
            payload,
        } as WebTCPPacket;
    }
}
