import {
    parsePersistedServiceState,
    PersistedServiceState,
    ServiceStateStorage,
} from '../../core/persistence/ServiceState.js';

/**
 * サービス役の状態を IndexedDB に保存する（#51 / specification.md §9.3）。
 *
 * `BrowserKeyManager` と同じく、注入可能な `indexedDB`（テストでは FakeIndexedDB）を使う。
 * 既定のデータベース名は `webtcp-service`、ストア名 `state`、キー `local`。
 */
export interface IndexedDBServiceStateStorageOptions {
    databaseName?: string;
    storeName?: string;
    recordKey?: string;
    /** 省略時は `globalThis.indexedDB`。`null` の場合は保存を行わない。 */
    indexedDB?: IDBFactory | null;
}

export class IndexedDBServiceStateStorage implements ServiceStateStorage {
    private readonly factory: IDBFactory | null;
    private readonly databaseName: string;
    private readonly storeName: string;
    private readonly recordKey: string;
    private databasePromise: Promise<IDBDatabase> | null = null;

    constructor(options: IndexedDBServiceStateStorageOptions = {}) {
        this.factory = options.indexedDB === undefined ? globalThis.indexedDB ?? null : options.indexedDB;
        this.databaseName = options.databaseName ?? 'webtcp-service';
        this.storeName = options.storeName ?? 'state';
        this.recordKey = options.recordKey ?? 'local';
    }

    /** IndexedDB が利用可能かどうか。 */
    public get available(): boolean {
        return this.factory !== null;
    }

    public async load(): Promise<PersistedServiceState | null> {
        if (!this.factory) return null;
        const db = await this.openDatabase();
        const raw = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const request = tx.objectStore(this.storeName).get(this.recordKey);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
        });
        return parsePersistedServiceState(raw);
    }

    public async save(state: PersistedServiceState): Promise<void> {
        if (!this.factory) return;
        const db = await this.openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.objectStore(this.storeName).put(state, this.recordKey);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    }

    public async clear(): Promise<void> {
        if (!this.factory) return;
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
        const factory = this.factory;
        if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
        this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(this.databaseName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        });
        // 失敗した接続を次回再利用しない
        this.databasePromise.catch(() => {
            this.databasePromise = null;
        });
        return this.databasePromise;
    }
}
