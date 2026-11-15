import { ED25519_PUBLIC_KEY_BYTES } from '../routing/keys.js';

/**
 * ドメイン所有権まわりで使う暗号プリミティブの最小ラッパ（specification.md §13.2 / §13.3）。
 *
 * `src/core` の制約（ブラウザ・Node.js どちらにも依存しない）を守るため、
 * Web Crypto（`globalThis.crypto.subtle`）だけを使う。実チェーン検証のように
 * 追加プリミティブ（keccak-256 等）を要するものは `IChainAnchorVerifier` の側へ逃がす
 * （specification.md §13.4.2、plan.md §4.3 の #42）。
 */

/** ハッシュ関数の型（テスト用に差し替え可能）。 */
export type DomainHashFn = (data: Uint8Array) => Promise<Uint8Array>;

/** `SubtleCrypto` のうち本モジュールが使う部分。 */
export interface DomainSubtleCrypto {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
    importKey(
        format: string,
        keyData: Uint8Array,
        algorithm: unknown,
        extractable: boolean,
        keyUsages: string[],
    ): Promise<unknown>;
    verify(
        algorithm: unknown,
        key: unknown,
        signature: Uint8Array,
        data: Uint8Array,
    ): Promise<boolean>;
}

/** Web Crypto の SHA-256。 */
export async function sha256Domain(data: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle as unknown as DomainSubtleCrypto | undefined;
    if (!subtle?.digest) {
        throw new Error('Web Crypto (crypto.subtle.digest) is not available in this environment');
    }
    return new Uint8Array(await subtle.digest('SHA-256', data));
}

/** 既定のハッシュ関数（Web Crypto SHA-256）。 */
export const defaultDomainHash: DomainHashFn = sha256Domain;

/**
 * 生の Ed25519 公開鍵（32 バイト）で署名を検証する。
 *
 * 失敗（形不正・検証 false・例外）はすべて `false` として返す。例外を上位へ漏らさない。
 */
export async function verifyDomainEd25519(
    publicKey: Uint8Array,
    data: Uint8Array,
    signature: Uint8Array,
    subtle?: DomainSubtleCrypto | null,
): Promise<boolean> {
    if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) return false;
    if (signature.byteLength !== 64) return false;
    const cryptoObj = (subtle ??
        (globalThis.crypto?.subtle as unknown as DomainSubtleCrypto | undefined)) as
        | DomainSubtleCrypto
        | undefined;
    if (!cryptoObj?.importKey || !cryptoObj.verify) return false;
    try {
        const key = await cryptoObj.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
            'verify',
        ]);
        return await cryptoObj.verify({ name: 'Ed25519' }, key, signature, data);
    } catch {
        return false;
    }
}

/** バイト列の連結（ハッシュ前缀付け用）。 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** 先頭に 1 バイトのプレフィックスを付ける。 */
export function prefixByte(prefix: number, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.byteLength + 1);
    out[0] = prefix;
    out.set(data, 1);
    return out;
}
