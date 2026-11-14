/**
 * テスト用の最小 IndexedDB 実装（#28, BrowserKeyManager 用）。
 *
 * 本物の IndexedDB は構造化複製（structured clone）でオブジェクトを保存するが、
 * このシムは参照をそのまま保持する。CryptoKey は非抽出のまま `subtle.sign()` に
 * 渡せるかを検証することが目的なので、これで十分である。
 */
export class FakeIndexedDB {
    constructor() {
        this.databases = new Map();
    }

    open(name, version = 1) {
        const request = new FakeRequest();

        queueMicrotask(() => {
            let record = this.databases.get(name);
            const created = !record;
            if (!record) {
                record = { version, stores: new Map() };
                this.databases.set(name, record);
            }

            const db = new FakeDatabase(record, this);
            if (created) {
                request.result = db;
                if (typeof request.onupgradeneeded === 'function') {
                    request.onupgradeneeded({ target: request });
                }
            }
            request.result = db;
            if (typeof request.onsuccess === 'function') {
                request.onsuccess({ target: request });
            }
        });

        return request;
    }
}

class FakeDatabase {
    constructor(record, factory) {
        this.record = record;
        this.factory = factory;
        this.objectStoreNames = {
            contains: (name) => record.stores.has(name),
        };
    }

    createObjectStore(name) {
        if (!this.record.stores.has(name)) {
            this.record.stores.set(name, new Map());
        }
        return new FakeObjectStore(this.record.stores.get(name));
    }

    transaction(name, _mode) {
        const store = this.record.stores.get(name);
        if (!store) throw new Error(`No object store named ${name}`);
        return new FakeTransaction(store);
    }

    close() {}
}

class FakeTransaction {
    constructor(store) {
        this.store = store;
        this.oncomplete = null;
        this.onerror = null;
        this.onabort = null;
    }

    objectStore() {
        const transaction = this;
        const store = new FakeObjectStore(this.store);
        const complete = () => {
            queueMicrotask(() => {
                if (typeof transaction.oncomplete === 'function') transaction.oncomplete();
            });
        };
        store._scheduleComplete = complete;
        return store;
    }
}

class FakeObjectStore {
    constructor(map) {
        this.map = map;
        this._scheduleComplete = null;
    }

    get(key) {
        const request = new FakeRequest();
        queueMicrotask(() => {
            request.result = this.map.get(key);
            if (typeof request.onsuccess === 'function') {
                request.onsuccess({ target: request });
            }
        });
        return request;
    }

    put(value, key) {
        this.map.set(key, value);
        this._scheduleComplete?.();
        return new FakeRequest();
    }

    delete(key) {
        this.map.delete(key);
        this._scheduleComplete?.();
        return new FakeRequest();
    }
}

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
    }
}
