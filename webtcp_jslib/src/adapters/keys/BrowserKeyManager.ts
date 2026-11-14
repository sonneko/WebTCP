import {
    ED25519_PUBLIC_KEY_BYTES,
    Ed25519KeyManager,
    NodeId,
    deriveNodeId,
    isValidNodeId,
} from '../../core/routing/keys.js';
import type { KeyDirectory } from '../../core/routing/KeyDirectory.js';
import { Logger } from '../../core/util/Logger.js';

/**
 * ブラウザ向け Ed25519 鍵管理（#28）。
 *
 * 設計方針（design.md §3.17）:
 * 1. **秘密鍵は IndexedDB に保存する**。CryptoKey は構造化複製（structured clone）で
 *    IndexedDB へそのまま保存でき、`subtle.sign()` に再び渡せる。
 * 2. **秘密鍵は `extractable = false`**。IndexedDB から取り出しても生バイトへ
 *    エクスポートできないため、XSS 等でストレージが読まれても鍵そのものは漏れない。
 * 3. 公開鍵（32 バイト）と NodeId（指紋）のみを `localStorage` にキャッシュし、
 *    起動時に IndexedDB の秘密鍵と突き合わせる。
 *
 * 必要環境:
 * - Web Crypto の Ed25519（Chrome 137+ / Firefox 129+ / Safari 17+ / Node.js 22+）
 * - IndexedDB（`globalThis.indexedDB`）
 *
 * 利用例:
 * ```ts
 * const keys = await BrowserKeyManager.open({ databaseName: 'webtcp-keys' });
 * const directory = new KeyDirectory();
 * const network = createBrowserNetwork({
 *   signaling,
 *   nodeId: keys.nodeId,
 *   verifier: createEd25519Verifier({ keyManager: keys, keyDirectory: directory }),
 * });
 * ```
 */
export interface BrowserKeyManagerOptions {
    /** IndexedDB のデータベース名。既定 `webtcp-keys`。 */
    databaseName?: string;
    /** オブジェクトストア名。既定 `identity`。 */
    storeName?: string;
    /** 保存レコードのキー。既定 `local`。 */
    recordKey?: string;
    /**
     * IndexedDB の代わりに使うストレージ（テスト・非ブラウザ環境用）。
     * 省略時は `globalThis.indexedDB`。
     */
    indexedDB?: IDBFactory | null;
    /** Web Crypto の subtle（テスト用に差し替え可能）。省略時は `globalThis.crypto.subtle`。 */
    subtle?: SubtleCrypto;
    /** 保存済みの鍵を使わず、新しい鍵ペアを生成して上書きする。 */
    regenerate?: boolean;
    /** ピアの公開鍵を解決するディレクトリ（任意）。 */
    keyDirectory?: KeyDirectory;
    /** ロガー（任意）。 */
    logger?: Logger;
}

interface StoredIdentity {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    publicKeyRaw: ArrayBuffer | Uint8Array;
    nodeId: NodeId;
    createdAt: number;
}

/** ブラウザでの Ed25519 利用可否を判定する。 */
export function isBrowserEd25519Supported(): boolean {
    return (
        typeof globalThis.crypto?.subtle?.generateKey === 'function' &&
        typeof globalThis.indexedDB !== 'undefined'
    );
}

export class BrowserKeyManager implements Ed25519KeyManager {
    public readonly nodeId: NodeId;
    public readonly publicKey: Uint8Array;
    /** ピアの公開鍵を解決するディレクトリ（任意）。 */
    public readonly keyDirectory: KeyDirectory | null;

    private readonly subtle: SubtleCrypto;
    private readonly signingKey: CryptoKey;
    private readonly storage: IdentityStorage | null;

    private constructor(params: {
        nodeId: NodeId;
        publicKey: Uint8Array;
        signingKey: CryptoKey;
        subtle: SubtleCrypto;
        storage: IdentityStorage | null;
        keyDirectory: KeyDirectory | null;
    }) {
        this.nodeId = params.nodeId;
        this.publicKey = params.publicKey;
        this.signingKey = params.signingKey;
        this.subtle = params.subtle;
        this.storage = params.storage;
        this.keyDirectory = params.keyDirectory;
    }

    /**
     * 保存済みの Ed25519 鍵を復元する。存在しなければ生成して IndexedDB に保存する。
     *
     * 秘密鍵は `extractable = false` で生成・保存される。
     */
    public static async open(options: BrowserKeyManagerOptions = {}): Promise<BrowserKeyManager> {
        const subtle = options.subtle ?? globalThis.crypto?.subtle;
        if (!subtle) {
            throw new Error('Web Crypto (crypto.subtle) is not available');
        }

        const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
        const storage = factory
            ? new IdentityStorage(
                  factory,
                  options.databaseName ?? 'webtcp-keys',
                  options.storeName ?? 'identity',
                  options.recordKey ?? 'local',
              )
            : null;

        if (storage && !options.regenerate) {
            const existing = await storage.load();
            if (existing) {
                const publicKey =
                    existing.publicKeyRaw instanceof Uint8Array
                        ? existing.publicKeyRaw
                        : new Uint8Array(existing.publicKeyRaw);
                const derived = await deriveNodeId(publicKey);
                if (derived === existing.nodeId) {
                    return new BrowserKeyManager({
                        nodeId: existing.nodeId,
                        publicKey,
                        signingKey: existing.privateKey,
                        subtle,
                        storage,
                        keyDirectory: options.keyDirectory ?? null,
                    });
                }
                options.logger?.warn(
                    'Stored WebTCP identity does not match its public key fingerprint; regenerating',
                );
            }
        }

        const pair = (await subtle.generateKey({ name: 'Ed25519' }, false, [
            'sign',
            'verify',
        ])) as unknown as CryptoKeyPair;
        const exportedPublicKey = await subtle.exportKey('raw', pair.publicKey);
        const publicKeyRaw = new Uint8Array(exportedPublicKey);
        if (publicKeyRaw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
            throw new Error(
                `unexpected Ed25519 public key length: ${publicKeyRaw.byteLength}`,
            );
        }
        const nodeId = await deriveNodeId(publicKeyRaw);

        if (storage) {
            try {
                await storage.save({
                    privateKey: pair.privateKey,
                    publicKey: pair.publicKey,
                    publicKeyRaw: exportedPublicKey,
                    nodeId,
                    createdAt: Date.now(),
                });
            } catch (error) {
                options.logger?.warn('Failed to persist WebTCP identity to IndexedDB:', error);
            }
        }

        return new BrowserKeyManager({
            nodeId,
            publicKey: publicKeyRaw,
            signingKey: pair.privateKey,
            subtle,
            storage,
            keyDirectory: options.keyDirectory ?? null,
        });
    }

    /** ローカル秘密鍵でデータに署名する（非抽出 CryptoKey を使う）。 */
    public async sign(data: Uint8Array): Promise<Uint8Array> {
        const signature = await this.subtle.sign(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            this.signingKey,
            data as BufferSource,
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
        const key = await this.subtle.importKey(
            'raw',
            publicKey as BufferSource,
            { name: 'Ed25519' } as AlgorithmIdentifier,
            false,
            ['verify'],
        );
        return this.subtle.verify(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            key,
            signature as BufferSource,
            data as BufferSource,
        );
    }

    /** 公開鍵から NodeId を導出する。 */
    public async deriveNodeId(publicKey: Uint8Array): Promise<NodeId> {
        return deriveNodeId(publicKey);
    }

    /** NodeId に対応する公開鍵を解決する（ディレクトリ設定時）。 */
    public async resolvePublicKey(nodeId: NodeId): Promise<Uint8Array | null> {
        return this.keyDirectory?.get(nodeId) ?? null;
    }

    /** 秘密鍵を再生成して IndexedDB を上書きする（NodeId が変わる点に注意）。 */
    public static async regenerate(
        options: BrowserKeyManagerOptions = {},
    ): Promise<BrowserKeyManager> {
        return BrowserKeyManager.open({ ...options, regenerate: true });
    }

    /** 保存済みの身元を削除する。 */
    public async clearPersistedIdentity(): Promise<void> {
        await this.storage?.clear();
    }

    /** NodeId 文字列が妥当か。 */
    public isValid(): boolean {
        return isValidNodeId(this.nodeId);
    }
}

/**
 * IndexedDB 上の 1 レコード（`identity` ストア）を読み書きする薄いラッパー。
 *
 * CryptoKey は構造化複製に対応しているため、そのまま保存・復元できる。
 */
class IdentityStorage {
    private readonly factory: IDBFactory;
    private readonly databaseName: string;
    private readonly storeName: string;
    private readonly recordKey: string;
    private databasePromise: Promise<IDBDatabase> | null = null;

    constructor(
        factory: IDBFactory,
        databaseName: string,
        storeName: string,
        recordKey: string,
    ) {
        this.factory = factory;
        this.databaseName = databaseName;
        this.storeName = storeName;
        this.recordKey = recordKey;
    }

    public async load(): Promise<StoredIdentity | null> {
        const db = await this.openDatabase();
        return new Promise<StoredIdentity | null>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).get(this.recordKey);
            request.onsuccess = () => {
                const value = request.result as StoredIdentity | undefined;
                if (value && value.privateKey && value.publicKeyRaw && value.nodeId) {
                    resolve(value);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
        });
    }

    public async save(identity: StoredIdentity): Promise<void> {
        const db = await this.openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(identity, this.recordKey);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    }

    public async clear(): Promise<void> {
        const db = await this.openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).delete(this.recordKey);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
        });
    }

    private openDatabase(): Promise<IDBDatabase> {
        if (this.databasePromise) return this.databasePromise;
        this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = this.factory.open(this.databaseName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
            request.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
        return this.databasePromise;
    }
}
