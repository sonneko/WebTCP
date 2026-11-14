import { WebTCPPacket } from './packet.js';
import {
    WEBTCP_HEADER_SIZE,
    WEBTCP_MAGIC,
    WEBTCP_PROTOCOL_VERSION,
    WebTCPFlags,
} from './protocol.js';

/**
 * フラグのビット定義（specification.md §6.3）。
 */
export const FLAG_BITS = {
    DATA: 0b00000001,
    SYN: 0b00000010,
    ACK: 0b00000100,
    FIN: 0b00001000,
    RST: 0b00010000,
    SYN_ACK: 0b00100000,
    RT_UPDATE: 0b01000000,
} as const;

/** フラグ文字列をビットマスクへ変換する。 */
export function flagsToMask(flags: WebTCPFlags): number {
    return FLAG_BITS[flags];
}

/**
 * ビットマスクをフラグ文字列へ変換する。
 * `SYN|ACK` の組み合わせは `SYN_ACK` として正規化する。
 */
export function maskToFlags(mask: number): WebTCPFlags {
    if ((mask & FLAG_BITS.SYN_ACK) !== 0) return 'SYN_ACK';
    if ((mask & (FLAG_BITS.SYN | FLAG_BITS.ACK)) === (FLAG_BITS.SYN | FLAG_BITS.ACK)) {
        return 'SYN_ACK';
    }
    if ((mask & FLAG_BITS.RT_UPDATE) !== 0) return 'RT_UPDATE';
    if ((mask & FLAG_BITS.RST) !== 0) return 'RST';
    if ((mask & FLAG_BITS.FIN) !== 0) return 'FIN';
    if ((mask & FLAG_BITS.SYN) !== 0) return 'SYN';
    if ((mask & FLAG_BITS.DATA) !== 0) return 'DATA';
    if ((mask & FLAG_BITS.ACK) !== 0) return 'ACK';
    return 'DATA';
}

/**
 * WebTCPPacketとバイナリデータを相互変換するためのインターフェース。
 */
export interface IPacketSerializer {
    /**
     * WebTCPPacketをネットワーク送信可能なバイナリに変換する。
     * @throws フィールドが仕様の範囲外の場合
     */
    serialize(packet: WebTCPPacket): Uint8Array;

    /**
     * 受信したバイナリをWebTCPPacketへ復元する。
     * @throws マジック・バージョン・長さが不正な場合
     */
    deserialize(buffer: Uint8Array): WebTCPPacket;
}

export interface BinaryPacketSerializerOptions {
    /** ペイロードの最大バイト数。既定 60 KiB。 */
    maxPayloadBytes?: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 60 * 1024;
const UINT32_MAX = 0xffffffff;

/**
 * プロトコルバージョン1のバイナリシリアライザ。
 *
 * レイアウトは specification.md §6.1 を参照。
 * マルチバイト整数はすべてビッグエンディアン。
 */
export class BinaryPacketSerializer implements IPacketSerializer {
    private readonly encoder = new TextEncoder();
    private readonly decoder = new TextDecoder();
    private readonly maxPayloadBytes: number;

    constructor(options: BinaryPacketSerializerOptions = {}) {
        this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    }

    public serialize(packet: WebTCPPacket): Uint8Array {
        const senderId = this.encoder.encode(packet.senderId);
        const destinationId = this.encoder.encode(packet.destinationId);
        const signature = packet.signature ?? new Uint8Array(0);
        const payload = packet.payload ?? new Uint8Array(0);

        if (senderId.length === 0 || senderId.length > 255) {
            throw new Error(`senderId length must be 1..255 bytes (got ${senderId.length})`);
        }
        if (destinationId.length === 0 || destinationId.length > 255) {
            throw new Error(`destinationId length must be 1..255 bytes (got ${destinationId.length})`);
        }
        if (signature.length > 0xffff) {
            throw new Error(`signature too large (${signature.length} bytes)`);
        }
        if (payload.length > this.maxPayloadBytes) {
            throw new Error(
                `payload exceeds maximum of ${this.maxPayloadBytes} bytes (got ${payload.length})`,
            );
        }
        this.assertUint(packet.ttl, 0xff, 'ttl');
        this.assertUint(packet.sourcePort, 0xffff, 'sourcePort');
        this.assertUint(packet.destinationPort, 0xffff, 'destinationPort');
        this.assertUint(packet.seqNum, UINT32_MAX, 'seqNum');
        this.assertUint(packet.ackNum, UINT32_MAX, 'ackNum');

        const totalLength =
            WEBTCP_HEADER_SIZE +
            senderId.length +
            destinationId.length +
            signature.length +
            payload.length;

        const buffer = new Uint8Array(totalLength);
        const view = new DataView(buffer.buffer);

        view.setUint8(0, WEBTCP_MAGIC);
        view.setUint8(1, WEBTCP_PROTOCOL_VERSION);
        view.setUint8(2, packet.ttl);
        view.setUint8(3, flagsToMask(packet.flags));
        view.setUint16(4, packet.sourcePort, false);
        view.setUint16(6, packet.destinationPort, false);
        view.setUint32(8, packet.seqNum, false);
        view.setUint32(12, packet.ackNum, false);
        view.setUint8(16, senderId.length);
        view.setUint8(17, destinationId.length);
        view.setUint16(18, signature.length, false);
        view.setUint32(20, payload.length, false);

        let offset = WEBTCP_HEADER_SIZE;
        buffer.set(senderId, offset);
        offset += senderId.length;
        buffer.set(destinationId, offset);
        offset += destinationId.length;
        buffer.set(signature, offset);
        offset += signature.length;
        buffer.set(payload, offset);

        return buffer;
    }

    public deserialize(buffer: Uint8Array): WebTCPPacket {
        if (buffer.length < WEBTCP_HEADER_SIZE) {
            throw new Error(`packet too short: ${buffer.length} bytes`);
        }

        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        const magic = view.getUint8(0);
        if (magic !== WEBTCP_MAGIC) {
            throw new Error(`invalid magic: 0x${magic.toString(16)}`);
        }
        const version = view.getUint8(1);
        if (version !== WEBTCP_PROTOCOL_VERSION) {
            throw new Error(`unsupported protocol version: ${version}`);
        }

        const ttl = view.getUint8(2);
        const flags = maskToFlags(view.getUint8(3));
        const sourcePort = view.getUint16(4, false);
        const destinationPort = view.getUint16(6, false);
        const seqNum = view.getUint32(8, false);
        const ackNum = view.getUint32(12, false);
        const senderIdLength = view.getUint8(16);
        const destinationIdLength = view.getUint8(17);
        const signatureLength = view.getUint16(18, false);
        const payloadLength = view.getUint32(20, false);

        const expectedLength =
            WEBTCP_HEADER_SIZE +
            senderIdLength +
            destinationIdLength +
            signatureLength +
            payloadLength;

        if (senderIdLength === 0 || destinationIdLength === 0) {
            throw new Error('senderId and destinationId must not be empty');
        }
        if (expectedLength !== buffer.length) {
            throw new Error(
                `length mismatch: header declares ${expectedLength} bytes but got ${buffer.length}`,
            );
        }
        if (payloadLength > this.maxPayloadBytes) {
            throw new Error(
                `payload exceeds maximum of ${this.maxPayloadBytes} bytes (got ${payloadLength})`,
            );
        }

        let offset = WEBTCP_HEADER_SIZE;
        const senderId = this.decoder.decode(buffer.subarray(offset, offset + senderIdLength));
        offset += senderIdLength;
        const destinationId = this.decoder.decode(
            buffer.subarray(offset, offset + destinationIdLength),
        );
        offset += destinationIdLength;
        const signature = buffer.slice(offset, offset + signatureLength);
        offset += signatureLength;
        const payload = buffer.slice(offset, offset + payloadLength);

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
        };
    }

    private assertUint(value: number, max: number, name: string): void {
        if (!Number.isInteger(value) || value < 0 || value > max) {
            throw new Error(`${name} out of range: ${value}`);
        }
    }
}
