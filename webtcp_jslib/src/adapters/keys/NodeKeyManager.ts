import {
    ED25519_PUBLIC_KEY_BYTES,
    ED25519_SECRET_KEY_BYTES,
    Ed25519KeyManager,
    NodeId,
    bytesToHex,
    deriveNodeId,
    isValidNodeId,
} from '../../core/routing/keys.js';
import { KeyDirectory } from '../../core/routing/KeyDirectory.js';
import { loadNodeCrypto, MinimalKeyObject, MinimalNodeCrypto } from './nodeCrypto.js';

/**
 * Node.js 向け Ed25519 鍵管理（#28）。
 *
 * `node:crypto` の Web Crypto（`webcrypto.subtle`）と Ed25519 `KeyObject` を併用する。
 *
 * - 鍵の生成・復元は同期的な `KeyObject`（`generateKeyPairSync` / `createPrivateKey`）で行う。
 * - 署名・検証は Web Crypto の `subtle.sign()` / `subtle.verify()` で行う。
 * - 秘密鍵は PKCS#8（PEM）として `exportPrivateKeyPem()` で取り出せる。
 *   平文の秘密鍵であるため、保存時の権限（0600 等）は利用者の責任とする。
 *
 * ブラウザで使う場合は `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）を使う。
 */
export interface NodeKeyManagerOptions {
    /** 既存の秘密鍵（PKCS#8 PEM）。省略時は新規生成。 */
    privateKeyPem?: string;
    /** 32 バイトの秘密鍵シード（hex）。省略時は新規生成。 */
    secretKeyHex?: string;
    /** NodeId（省略時は公開鍵から導出）。指紋と一致しない場合は例外。 */
    nodeId?: NodeId;
    /**
     * ピアの公開鍵を解決するディレクトリ（任意）。
     * `Ed25519PacketVerifier` の `keyDirectory` にも同じインスタンスを渡す。
     */
    keyDirectory?: KeyDirectory;
}

export class NodeKeyManager implements Ed25519KeyManager {
    public readonly nodeId: NodeId;
    public readonly publicKey: Uint8Array;
    /** ピアの公開鍵を解決するディレクトリ（任意）。 */
    public readonly keyDirectory: KeyDirectory | null;

    private readonly crypto: MinimalNodeCrypto;
    private readonly privateKey: MinimalKeyObject;
    private readonly privateKeyPem: string;
    /** 署名用の非抽出 CryptoKey。 */
    private readonly signingKey: unknown;

    private constructor(params: {
        crypto: MinimalNodeCrypto;
        privateKey: MinimalKeyObject;
        privateKeyPem: string;
        publicKey: Uint8Array;
        nodeId: NodeId;
        signingKey: unknown;
        keyDirectory: KeyDirectory | null;
    }) {
        this.crypto = params.crypto;
        this.privateKey = params.privateKey;
        this.privateKeyPem = params.privateKeyPem;
        this.publicKey = params.publicKey;
        this.nodeId = params.nodeId;
        this.signingKey = params.signingKey;
        this.keyDirectory = params.keyDirectory;
    }

    /**
     * 鍵管理を生成（または復元）する。
     *
     * - `privateKeyPem` / `secretKeyHex` が無ければ Ed25519 鍵ペアを新規生成する。
     * - `nodeId` を指定した場合、公開鍵の指紋と一致しなければ例外を投げる。
     */
    public static async create(options: NodeKeyManagerOptions = {}): Promise<NodeKeyManager> {
        const crypto = await loadNodeCrypto();
        const subtle = crypto.webcrypto.subtle;

        let privateKey: MinimalKeyObject;
        let privateKeyPem: string;

        if (options.privateKeyPem) {
            privateKey = crypto.createPrivateKey({
                key: options.privateKeyPem,
                format: 'pem',
                type: 'pkcs8',
            });
            privateKeyPem = options.privateKeyPem;
        } else if (options.secretKeyHex) {
            const der = pkcs8FromSeedHex(options.secretKeyHex);
            privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
            privateKeyPem = String(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
        } else {
            const pair = crypto.generateKeyPairSync('ed25519', { extractable: true });
            privateKey = pair.privateKey;
            privateKeyPem = String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
        }

        // 公開鍵は秘密鍵から導出し、SPKI の末尾 32 バイト（生の Ed25519 公開鍵）を取り出す
        const publicKeyObject = crypto.createPublicKey(privateKey);
        const spki = new Uint8Array(
            publicKeyObject.export({ format: 'der', type: 'spki' }) as ArrayBuffer,
        );
        const publicKey = spki.slice(spki.byteLength - ED25519_PUBLIC_KEY_BYTES);

        // 署名用の秘密鍵を非抽出 CryptoKey として保持する
        const pkcs8Der = new Uint8Array(
            privateKey.export({ format: 'der', type: 'pkcs8' }) as ArrayBuffer,
        );
        const signingKey = await subtle.importKey('pkcs8', pkcs8Der, { name: 'Ed25519' }, false, [
            'sign',
        ]);

        const derived = await deriveNodeId(publicKey);
        const nodeId = options.nodeId ?? derived;
        if (!isValidNodeId(nodeId)) {
            throw new Error(`invalid NodeId: ${nodeId}`);
        }
        if (nodeId !== derived) {
            throw new Error(
                `NodeId ${nodeId} does not match the Ed25519 public key fingerprint ${derived}`,
            );
        }

        return new NodeKeyManager({
            crypto,
            privateKey,
            privateKeyPem,
            publicKey,
            nodeId,
            signingKey,
            keyDirectory: options.keyDirectory ?? null,
        });
    }

    /** ローカル秘密鍵でデータに署名する（64 バイト）。 */
    public async sign(data: Uint8Array): Promise<Uint8Array> {
        const signature = await this.crypto.webcrypto.subtle.sign(
            { name: 'Ed25519' },
            this.signingKey,
            data,
        );
        return new Uint8Array(signature);
    }

    /** 公開鍵で署名を検証する。 */
    public async verify(
        publicKey: Uint8Array,
        data: Uint8Array,
        signature: Uint8Array,
    ): Promise<boolean> {
        if (publicKey.byteLength !== ED25519_PUBLIC_KEY_BYTES) return false;
        if (signature.byteLength !== 64) return false;
        const subtle = this.crypto.webcrypto.subtle;
        const key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, [
            'verify',
        ]);
        return subtle.verify({ name: 'Ed25519' }, key, signature, data);
    }

    /** 公開鍵から NodeId を導出する。 */
    public async deriveNodeId(publicKey: Uint8Array): Promise<NodeId> {
        return deriveNodeId(publicKey);
    }

    /** NodeId に対応する公開鍵を解決する（ディレクトリ設定時）。 */
    public async resolvePublicKey(nodeId: NodeId): Promise<Uint8Array | null> {
        return this.keyDirectory?.get(nodeId) ?? null;
    }

    /** 公開鍵の生バイト列（32 バイト）。 */
    public getRawPublicKey(): Uint8Array {
        return this.publicKey;
    }

    /** PKCS#8（PEM）形式の秘密鍵。取り扱いに注意すること。 */
    public exportPrivateKeyPem(): string {
        return this.privateKeyPem;
    }

    /** 32 バイトの秘密鍵シード（hex）。ネットワークへ送出してはならない。 */
    public exportSecretKeyHex(): string {
        const pkcs8 = new Uint8Array(
            this.privateKey.export({ format: 'der', type: 'pkcs8' }) as ArrayBuffer,
        );
        return bytesToHex(pkcs8.slice(pkcs8.byteLength - ED25519_SECRET_KEY_BYTES));
    }
}

/**
 * 32 バイトのシードから PKCS#8 DER を組み立てる（Ed25519 / OID 1.3.101.112）。
 *
 * `node:crypto` の `createPrivateKey({ key, format: 'der' })` に渡すために使う。
 * （Node.js は生シードからの直接インポート API を持たない）
 */
function pkcs8FromSeedHex(secretKeyHex: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/i.test(secretKeyHex)) {
        throw new Error('secretKeyHex must be 32 bytes of hex');
    }
    const der = new Uint8Array(48);
    // SEQUENCE (46 bytes)
    der.set([0x30, 0x2e], 0);
    // INTEGER 0（version）
    der.set([0x02, 0x01, 0x00], 2);
    // SEQUENCE { OID 1.3.101.112 }（Ed25519）
    der.set([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70], 5);
    // OCTET STRING (34) { OCTET STRING (32) seed }
    der.set([0x04, 0x22, 0x04, 0x20], 12);
    for (let i = 0; i < ED25519_SECRET_KEY_BYTES; i += 1) {
        der[16 + i] = Number.parseInt(secretKeyHex.slice(i * 2, i * 2 + 2), 16);
    }
    return der;
}
