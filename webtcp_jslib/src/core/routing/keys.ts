import { NodeId } from '../types/protocol.js';

export type { NodeId } from '../types/protocol.js';

/**
 * Ed25519 公開鍵指紋による NodeId の導出と、鍵表現のエンコード（#28, specification.md §5.1 / §10）。
 *
 * このモジュールはブラウザ・Node.js のどちらでも動く純粋関数だけを提供する。
 * ハッシュ計算には `globalThis.crypto.subtle`（Web Crypto）を使う。
 * Ed25519 の署名・検証そのものはプラットフォーム実装（`adapters/keys`）が担う。
 */

/** NodeId のバイト長。SHA-256 指紋の先頭 16 バイトを使う。 */
export const NODE_ID_BYTES = 16;

/** 同一 NodeId に異なる鍵/身元が対応する場合の型付きエラー（M4 / #36）。 */
export class NodeIdCollisionError extends Error {
    constructor(
        public readonly nodeId: NodeId,
        public readonly expectedPublicKey?: Uint8Array,
        public readonly actualPublicKey?: Uint8Array,
    ) {
        super(`NodeId collision detected for ${nodeId}: nodeId does not match the Ed25519 public key fingerprint or a different identity is already bound`);
        this.name = 'NodeIdCollisionError';
    }
}

/** NodeId の hex 文字列表現の長さ（32 文字）。 */
export const NODE_ID_HEX_LENGTH = NODE_ID_BYTES * 2;

/** NodeId の正規表現（specification.md §5.1、プロトコル v2）。 */
export const NODE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Ed25519 公開鍵のバイト長。 */
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Ed25519 秘密鍵（シード）のバイト長。 */
export const ED25519_SECRET_KEY_BYTES = 32;

/** Ed25519 署名のバイト長。 */
export const ED25519_SIGNATURE_BYTES = 64;

/** NodeId として妥当な文字列かどうか。 */
export function isValidNodeId(value: unknown): value is NodeId {
    return typeof value === 'string' && NODE_ID_PATTERN.test(value);
}

/** バイト列を小文字 hex へ変換する。 */
export function bytesToHex(bytes: Uint8Array): string {
    let result = '';
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, '0');
    }
    return result;
}

/** 小文字 hex をバイト列へ変換する。奇数長・非 hex はエラー。 */
export function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
        throw new Error(`invalid hex string: ${hex}`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * 公開鍵から NodeId を導出する（specification.md §5.1・§10）。
 *
 * `NodeId = hex( SHA-256(rawEd25519PublicKey)[0..16] )`
 *
 * 同じ公開鍵からは常に同じ NodeId が得られるため、NodeId は自己証明となる。
 */
export async function deriveNodeId(publicKey: Uint8Array): Promise<NodeId> {
    if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error(
            `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes (got ${publicKey.byteLength})`,
        );
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
    }
    const digest = await subtle.digest('SHA-256', publicKey as BufferSource);
    return bytesToHex(new Uint8Array(digest).subarray(0, NODE_ID_BYTES));
}

/** `nodeId` が `publicKey` の指紋と一致するかを検証する。 */
export async function nodeIdMatchesPublicKey(
    nodeId: NodeId,
    publicKey: Uint8Array,
): Promise<boolean> {
    if (!isValidNodeId(nodeId)) return false;
    try {
        return (await deriveNodeId(publicKey)) === nodeId;
    } catch {
        return false;
    }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** バイト列を Base64url（パディングなし）へ変換する。 */
export function encodeBase64Url(bytes: Uint8Array): string {
    let output = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        output += BASE64URL_ALPHABET[(chunk >> 18) & 0x3f];
        output += BASE64URL_ALPHABET[(chunk >> 12) & 0x3f];
        output += BASE64URL_ALPHABET[(chunk >> 6) & 0x3f];
        output += BASE64URL_ALPHABET[chunk & 0x3f];
    }
    const remaining = bytes.length - i;
    if (remaining === 1) {
        const chunk = bytes[i]! << 16;
        output += BASE64URL_ALPHABET[(chunk >> 18) & 0x3f];
        output += BASE64URL_ALPHABET[(chunk >> 12) & 0x3f];
    } else if (remaining === 2) {
        const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
        output += BASE64URL_ALPHABET[(chunk >> 18) & 0x3f];
        output += BASE64URL_ALPHABET[(chunk >> 12) & 0x3f];
        output += BASE64URL_ALPHABET[(chunk >> 6) & 0x3f];
    }
    return output;
}

/**
 * Base64url 文字列をバイト列へ変換する。不正な文字を含む場合は `null` を返す。
 * パディング（`=`）は任意で受理する。
 */
export function decodeBase64Url(text: string): Uint8Array | null {
    if (typeof text !== 'string') return null;
    const normalized = text.replace(/=+$/, '');
    if (normalized.length % 4 === 1) return null;

    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of normalized) {
        const value = BASE64URL_ALPHABET.indexOf(char);
        if (value < 0) return null;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 0xff);
        }
    }
    return new Uint8Array(bytes);
}

/** 公開鍵を Base64url 文字列へ変換する（シグナリング・RT_UPDATE での配布用）。 */
export function encodePublicKey(publicKey: Uint8Array): string {
    if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error(
            `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes (got ${publicKey.byteLength})`,
        );
    }
    return encodeBase64Url(publicKey);
}

/** Base64url 文字列を Ed25519 公開鍵（32 バイト）へ変換する。不正なら `null`。 */
export function decodePublicKey(text: unknown): Uint8Array | null {
    if (typeof text !== 'string') return null;
    const bytes = decodeBase64Url(text);
    if (!bytes || bytes.byteLength !== ED25519_PUBLIC_KEY_BYTES) return null;
    return bytes;
}

/**
 * Ed25519 鍵管理の抽象（#28）。
 *
 * 実装はプラットフォームごとに用意する。
 * - ブラウザ: `BrowserKeyManager`（Web Crypto + IndexedDB、秘密鍵は非抽出 CryptoKey）
 * - Node.js: `NodeKeyManager`（`node:crypto`）
 */
export interface Ed25519KeyManager {
    /** ローカルノードの NodeId（= 自身の公開鍵の指紋）。 */
    readonly nodeId: NodeId;
    /** ローカルノードの Ed25519 公開鍵（32 バイト）。 */
    readonly publicKey: Uint8Array;

    /** ローカル秘密鍵でデータに署名する（64 バイトの Ed25519 署名を返す）。 */
    sign(data: Uint8Array): Promise<Uint8Array>;

    /** 公開鍵を使って署名を検証する。 */
    verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean>;

    /** 公開鍵から NodeId を導出する（全実装で同一結果でなければならない）。 */
    deriveNodeId(publicKey: Uint8Array): Promise<NodeId>;
}

/** `Ed25519KeyManager` を実装したかどうかの型ガード。 */
export function isEd25519KeyManager(value: unknown): value is Ed25519KeyManager {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<Ed25519KeyManager>;
    return (
        isValidNodeId(candidate.nodeId) &&
        candidate.publicKey instanceof Uint8Array &&
        typeof candidate.sign === 'function' &&
        typeof candidate.verify === 'function' &&
        typeof candidate.deriveNodeId === 'function'
    );
}
