/**
 * Node.js の Web Crypto（`node:crypto` の `webcrypto`）を遅延ロードする。
 *
 * `node:crypto` を静的に import するとブラウザ向けバンドルに含まれてしまうため、
 * 動的 `import()` を使う。TypeScript の `types` は空（`[]`）なので、
 * 戻り値は最小限の構造的型として自前で宣言する。
 */

/** Web Crypto の `subtle` のうち、本ライブラリが使うメソッドだけを表す型。 */
export interface MinimalSubtleCrypto {
    generateKey(
        algorithm: { name: string },
        extractable: boolean,
        keyUsages: string[],
    ): Promise<unknown>;
    exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
    importKey(
        format: string,
        keyData: Uint8Array,
        algorithm: { name: string },
        extractable: boolean,
        keyUsages: string[],
    ): Promise<unknown>;
    sign(algorithm: { name: string }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
    verify(
        algorithm: { name: string },
        key: unknown,
        signature: Uint8Array,
        data: Uint8Array,
    ): Promise<boolean>;
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Node.js の Ed25519 `KeyObject` のうち本ライブラリが使う部分。 */
export interface MinimalKeyObject {
    export(options?: { format?: 'pem' | 'der'; type?: 'pkcs8' | 'spki' }): string | ArrayBuffer;
    readonly type?: string;
}

/** `node:crypto` のうち本ライブラリが使う API だけを表す構造的型。 */
export interface MinimalNodeCrypto {
    webcrypto: { subtle: MinimalSubtleCrypto; getRandomValues<T extends ArrayBufferView>(array: T): T };
    generateKeyPairSync(
        type: 'ed25519',
        options: { extractable?: boolean },
    ): { publicKey: MinimalKeyObject; privateKey: MinimalKeyObject };
    createPrivateKey(options: {
        key: string | ArrayBuffer | Uint8Array;
        format: 'pem' | 'der';
        type: 'pkcs8';
    }): MinimalKeyObject;
    createPublicKey(key: MinimalKeyObject): MinimalKeyObject;
    sign(algorithm: null | undefined, data: Uint8Array, key: MinimalKeyObject): ArrayBuffer;
    verify(
        algorithm: null | undefined,
        data: Uint8Array,
        key: MinimalKeyObject,
        signature: Uint8Array,
    ): boolean;
}

let cached: Promise<MinimalNodeCrypto> | null = null;

/**
 * `node:crypto` を読み込む。Node.js 以外の環境では reject する。
 *
 * 動的 import を使うことで、ブラウザ向けのビルドに Node 組み込みが混入しない。
 */
export function loadNodeCrypto(): Promise<MinimalNodeCrypto> {
    if (!cached) {
        cached = (async () => {
            const moduleName = 'node:' + 'crypto';
            const mod = (await import(moduleName)) as unknown as MinimalNodeCrypto;
            if (!mod?.webcrypto?.subtle) {
                throw new Error('node:crypto does not expose Web Crypto in this runtime');
            }
            return mod;
        })();
    }
    return cached;
}

/** `node:crypto` が利用可能かを判定する（ブラウザ検出用）。 */
export async function isNodeCryptoAvailable(): Promise<boolean> {
    try {
        await loadNodeCrypto();
        return true;
    } catch {
        return false;
    }
}
