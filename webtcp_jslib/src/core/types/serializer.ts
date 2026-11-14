import { WebTCPPacket } from './packet.js';
import {
    SUPPORTED_PROTOCOL_VERSIONS,
    WEBTCP_HEADER_SIZE,
    WEBTCP_MAGIC,
    WEBTCP_PROTOCOL_VERSION,
    WEBTCP_PROTOCOL_VERSION_V1,
    WEBTCP_SIGNATURE_BYTES,
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

    /**
     * 署名フィールドを除いた「署名対象バイト列」を生成する（プロトコル v2、specification.md §10.3）。
     *
     * 署名対象は「署名フィールドを除くシリアライズ済みパケット」、すなわち
     * ヘッダー（`signatureLen` は 0）+ senderId + destinationId + payload である。
     *
     * 省略可能。未実装のシリアライザでは `Ed25519PacketVerifier` が
     * 署名を空にしたパケットを再シリアライズして同じ結果を得る。
     */
    serializeForSigning?(packet: WebTCPPacket): Uint8Array;

    /**
     * 受信バッファから署名対象バイト列を取り出す（再シリアライズせずに検証するための高速経路）。
     *
     * 署名フィールドを除去した以外は受信バイト列と同一のバイト列を返す。
     * バイト列が不正な場合は `null` を返す（例外を投げない）。
     */
    signatureInputFromBytes?(buffer: Uint8Array): Uint8Array | null;
}

export interface BinaryPacketSerializerOptions {
    /** ペイロードの最大バイト数。既定 60 KiB。 */
    maxPayloadBytes?: number;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 60 * 1024;
const UINT32_MAX = 0xffffffff;

/**
 * WebTCP のバイナリシリアライザ（プロトコル v1 / v2）。
 *
 * レイアウトは specification.md §6.1 を参照。v1 と v2 は 24 バイト固定ヘッダーが
 * 完全に共通で、`version` フィールドと `signature` の有無だけが異なる。
 * マルチバイト整数はすべてビッグエンディアン。
 *
 * 送信時のバージョンは次の規則で決まる（specification.md §13）。
 * - `packet.version` が明示されていればそれを使う。
 * - それ以外は `signature` が 64 バイト（Ed25519 署名）なら v2、空なら v1。
 *
 * したがって `Ed25519PacketVerifier` で署名したパケットは v2、
 * `NullPacketVerifier`（レガシー）のパケットは v1 で送信される。
 */
export class BinaryPacketSerializer implements IPacketSerializer {
    private readonly encoder = new TextEncoder();
    private readonly decoder = new TextDecoder();
    private readonly maxPayloadBytes: number;

    constructor(options: BinaryPacketSerializerOptions = {}) {
        this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    }

    /**
     * パケットが送信されるプロトコルバージョンを返す。
     */
    public resolveVersion(packet: WebTCPPacket): number {
        if (packet.version !== undefined) return packet.version;
        return (packet.signature?.byteLength ?? 0) === 0
            ? WEBTCP_PROTOCOL_VERSION_V1
            : WEBTCP_PROTOCOL_VERSION;
    }

    public serialize(packet: WebTCPPacket): Uint8Array {
        const version = this.resolveVersion(packet);
        const signatureLength = packet.signature?.byteLength ?? 0;

        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
            throw new Error(`unsupported protocol version: ${version}`);
        }
        if (version === WEBTCP_PROTOCOL_VERSION && signatureLength !== WEBTCP_SIGNATURE_BYTES) {
            throw new Error(
                `protocol v2 requires a ${WEBTCP_SIGNATURE_BYTES}-byte signature (got ${signatureLength})`,
            );
        }
        if (version === WEBTCP_PROTOCOL_VERSION_V1 && signatureLength !== 0) {
            throw new Error('protocol v1 packets must not carry a signature');
        }

        return this.encode(packet, version, false);
    }

    /**
     * 署名対象となるバイト列（署名フィールドを除く）を生成する。
     *
     * ヘッダー・senderId・destinationId・payload をこの順に連結したもので、
     * `signatureLen` フィールドは 0 として書き込む。受信側の
     * `signatureInputFromBytes()` が返すバイト列と同一になる。
     *
     * `packet.version` が未指定の場合は v2 として扱う（署名は v2 の機能のため）。
     */
    public serializeForSigning(packet: WebTCPPacket): Uint8Array {
        const version = packet.version ?? WEBTCP_PROTOCOL_VERSION;
        return this.encode(packet, version, true);
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
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
            throw new Error(`unsupported protocol version: ${version}`);
        }

        const ttl = view.getUint8(2);
        const flagMask = view.getUint8(3);
        if ((flagMask & 0x7f) === 0) {
            throw new Error(`invalid flags: 0x${flagMask.toString(16)}`);
        }
        const flags = maskToFlags(flagMask);
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
        if (version === WEBTCP_PROTOCOL_VERSION_V1 && signatureLength !== 0) {
            throw new Error('protocol v1 packets must not carry a signature');
        }
        if (version === WEBTCP_PROTOCOL_VERSION && signatureLength !== WEBTCP_SIGNATURE_BYTES) {
            throw new Error(
                `protocol v2 requires a ${WEBTCP_SIGNATURE_BYTES}-byte signature (got ${signatureLength})`,
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
            version,
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

    /**
     * 受信バイト列から署名対象バイト列を生成する（署名フィールドを除去）。
     *
     * 送信側の `serializeForSigning()` と同一のバイト列になる。
     * 不正なバイト列なら `null`。
     */
    public signatureInputFromBytes(buffer: Uint8Array): Uint8Array | null {
        if (buffer.length < WEBTCP_HEADER_SIZE) return null;

        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        if (view.getUint8(0) !== WEBTCP_MAGIC) return null;

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
        if (expectedLength !== buffer.length) return null;

        const output = new Uint8Array(buffer.length - signatureLength);
        output.set(buffer.subarray(0, WEBTCP_HEADER_SIZE), 0);
        // signatureLen フィールド（オフセット 18）を 0 に上書きする
        new DataView(output.buffer).setUint16(18, 0, false);

        const signatureOffset = WEBTCP_HEADER_SIZE + senderIdLength + destinationIdLength;
        output.set(buffer.subarray(WEBTCP_HEADER_SIZE, signatureOffset), WEBTCP_HEADER_SIZE);
        output.set(buffer.subarray(signatureOffset + signatureLength), signatureOffset);
        return output;
    }

    private encode(packet: WebTCPPacket, version: number, forSigning: boolean): Uint8Array {
        const senderId = this.encoder.encode(packet.senderId);
        const destinationId = this.encoder.encode(packet.destinationId);
        const signature = forSigning ? new Uint8Array(0) : (packet.signature ?? new Uint8Array(0));
        const payload = packet.payload ?? new Uint8Array(0);

        if (senderId.length === 0 || senderId.length > 255) {
            throw new Error(`senderId length must be 1..255 bytes (got ${senderId.length})`);
        }
        if (destinationId.length === 0 || destinationId.length > 255) {
            throw new Error(`destinationId length must be 1..255 bytes (got ${destinationId.length})`);
        }
        if (signature.byteLength > 0xffff) {
            throw new Error(`signature too large (${signature.byteLength} bytes)`);
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
            signature.byteLength +
            payload.length;

        const buffer = new Uint8Array(totalLength);
        const view = new DataView(buffer.buffer);

        view.setUint8(0, WEBTCP_MAGIC);
        view.setUint8(1, version);
        view.setUint8(2, packet.ttl);
        view.setUint8(3, flagsToMask(packet.flags));
        view.setUint16(4, packet.sourcePort, false);
        view.setUint16(6, packet.destinationPort, false);
        view.setUint32(8, packet.seqNum, false);
        view.setUint32(12, packet.ackNum, false);
        view.setUint8(16, senderId.length);
        view.setUint8(17, destinationId.length);
        view.setUint16(18, signature.byteLength, false);
        view.setUint32(20, payload.length, false);

        let offset = WEBTCP_HEADER_SIZE;
        buffer.set(senderId, offset);
        offset += senderId.length;
        buffer.set(destinationId, offset);
        offset += destinationId.length;
        buffer.set(signature, offset);
        offset += signature.byteLength;
        buffer.set(payload, offset);

        return buffer;
    }

    private assertUint(value: number, max: number, name: string): void {
        if (!Number.isInteger(value) || value < 0 || value > max) {
            throw new Error(`${name} out of range: ${value}`);
        }
    }
}
