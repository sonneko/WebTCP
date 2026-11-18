import { NodeId } from '../types/protocol.js';

/**
 * ランダムな NodeId を生成する（鍵管理を渡さない v1 構成のフォールバック）。
 *
 * 16 バイトの乱数を hex 化した 32 文字の文字列を返す（specification.md §5.1）。
 * プロトコル v2 で `keyManager` を渡した場合は、この関数ではなく
 * `deriveNodeId(publicKey)`（公開鍵の SHA-256 先頭 16 バイト）が NodeId になる（§5.1 / §11.3）。
 *
 * @param byteLength 乱数のバイト数（既定 16）
 */
export function generateNodeId(byteLength = 16): NodeId {
    if (!Number.isInteger(byteLength) || byteLength < 8 || byteLength > 64) {
        throw new Error(`byteLength must be an integer between 8 and 64 (got ${byteLength})`);
    }

    const bytes = new Uint8Array(byteLength);
    const cryptoObj = globalThis.crypto;

    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        cryptoObj.getRandomValues(bytes);
    } else {
        // 古い環境向けのフォールバック。暗号学的強度はない。
        for (let i = 0; i < bytes.length; i += 1) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    let result = '';
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, '0');
    }
    return result;
}

/**
 * クライアント側のローカルポートを自動割り当てする（specification.md §5.2）。
 * 49152–65535 の範囲からランダムに選ぶ。
 */
export function allocateEphemeralPort(): number {
    const min = 49152;
    const max = 65535;
    return min + Math.floor(Math.random() * (max - min + 1));
}
