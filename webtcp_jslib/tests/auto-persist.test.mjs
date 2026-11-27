import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NameServer,
    WebTCPNetwork,
    NodeKeyManager,
    noopLogger,
    IndexedDBServiceStateStorage,
    MemoryServiceStateStorage,
    createAutoPersistScheduler,
    AUTO_PERSIST_DEBOUNCE_MS,
    AUTO_PERSIST_MAX_WAIT_MS,
} from '../dist/index.js';
import { LoopbackNetwork } from './helpers/loopback.mjs';
import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countingStorage(inner) {
    const storage = { saves: 0, async save(state) { storage.saves += 1; return inner.save(state); }, load: () => inner.load() };
    return storage;
}

function makeNetwork(keys, stateStorage) {
    return new WebTCPNetwork({
        channel: new LoopbackNetwork().createChannel(keys.nodeId),
        keyManager: keys,
        logger: noopLogger,
        ...(stateStorage ? { stateStorage } : {}),
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
}

test('auto-persist defaults are the design values', () => {
    assert.equal(AUTO_PERSIST_DEBOUNCE_MS, 500);
    assert.equal(AUTO_PERSIST_MAX_WAIT_MS, 5000);
});

test('scheduler: a burst of changes is coalesced into one save after the debounce', async () => {
    let saves = 0;
    const s = createAutoPersistScheduler({ save: async () => { saves += 1; }, debounceMs: 30, maxWaitMs: 500 });
    for (let i = 0; i < 10; i += 1) { s.notify(); await sleep(5); }
    assert.equal(saves, 0, 'no save while changes keep arriving within the debounce');
    await sleep(60);
    assert.equal(saves, 1);
    assert.equal(s.pending, false);
    await s.stop();
});

test('scheduler: maxWaitMs bounds staleness even under continuous changes', async () => {
    let saves = 0;
    const s = createAutoPersistScheduler({ save: async () => { saves += 1; }, debounceMs: 40, maxWaitMs: 100 });
    const started = Date.now();
    const timer = setInterval(() => s.notify(), 10);
    await sleep(130);
    clearInterval(timer);
    assert.ok(saves >= 1, 'a save happened although changes never paused');
    assert.ok(Date.now() - started < 400);
    await s.stop();
});

test('scheduler: flush saves synchronously and waits for in-flight save; stop ignores later changes', async () => {
    const order = [];
    let release;
    const s = createAutoPersistScheduler({
        save: () => { order.push('start'); return new Promise((r) => { release = () => { order.push('end'); r(); }; }); },
        debounceMs: 1000, maxWaitMs: 5000,
    });
    s.notify();
    const flushing = s.flush();
    assert.deepEqual(order, ['start'], 'save starts synchronously in flush()');
    release();
    await flushing;
    assert.deepEqual(order, ['start', 'end']);
    assert.equal(s.saves, 1);
    await s.stop();
    s.notify();
    assert.equal(s.pending, false, 'no changes accepted after stop()');
});

test('scheduler: a failed save keeps the change pending and retries after the debounce', async () => {
    let attempts = 0;
    const errors = [];
    const s = createAutoPersistScheduler({
        save: async () => { attempts += 1; if (attempts === 1) throw new Error('quota'); },
        debounceMs: 20, maxWaitMs: 200, onError: (e) => errors.push(e.message),
    });
    s.notify();
    await sleep(60);
    assert.equal(attempts, 2, 'retried once');
    assert.deepEqual(errors, ['quota']);
    assert.equal(s.failures, 1);
    assert.equal(s.saves, 1);
    await s.stop();
});

test('scheduler: rejects invalid timing options', () => {
    assert.throws(() => createAutoPersistScheduler({ save: async () => {}, debounceMs: 100, maxWaitMs: 50 }), /debounceMs/);
    assert.throws(() => createAutoPersistScheduler({ save: async () => {}, debounceMs: -1, maxWaitMs: 50 }), /debounceMs/);
});

test('auto-persist: off by default; enabling alone does not write, the first change does', async () => {
    const keys = await NodeKeyManager.create();
    const storage = countingStorage(new MemoryServiceStateStorage());
    const net = makeNetwork(keys, storage);
    await net.start();
    net.listen(9201, () => {});
    await sleep(60);
    assert.equal(storage.saves, 0, 'disabled by default');
    net.enableAutoPersist({ debounceMs: 10, maxWaitMs: 50 });
    await sleep(40);
    assert.equal(storage.saves, 0, 'enabling alone does not write (no clobbering before restore)');
    net.listen(9205, () => {});
    await sleep(30);
    assert.equal(storage.saves, 1, 'first change after enable is saved');
    assert.throws(() => net.enableAutoPersist(), /already enabled/);
    net.close();
});

test('auto-persist: listen/unlisten and NameServer changes are saved without persistState()', async () => {
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const inner = new MemoryServiceStateStorage();
    const storage = countingStorage(inner);
    const net = makeNetwork(keys, storage);
    await net.start();
    const ns = new NameServer(net, { logger: noopLogger });
    net.enableAutoPersist({ nameServer: ns, debounceMs: 10, maxWaitMs: 50 });
    await sleep(30);
    const base = storage.saves;

    net.listen(9202, () => {});
    await sleep(30);
    assert.equal(storage.saves, base + 1);
    assert.deepEqual((await inner.load()).listenPorts, [9202]);

    ns.registerA('printer', owner.nodeId);
    await sleep(30);
    assert.equal(storage.saves, base + 2);
    assert.equal((await inner.load()).names.length, 1);

    ns.unregister('printer');
    await sleep(30);
    assert.equal((await inner.load()).names.length, 0);

    net.transportLayer.unlisten(9202);
    await sleep(30);
    assert.deepEqual((await inner.load()).listenPorts, []);
    net.close();
});

test('auto-persist: restoreState re-listens but the follow-up save writes the same restored state', async () => {
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const inner = new MemoryServiceStateStorage();
    const first = makeNetwork(keys, inner);
    await first.start();
    const ns1 = new NameServer(first, { logger: noopLogger });
    ns1.registerA('printer', owner.nodeId);
    await first.persistState({ nameServer: ns1 });
    const saved = await inner.load();
    first.close();

    const storage = countingStorage(inner);
    const second = makeNetwork(keys, storage);
    await second.start();
    const ns2 = new NameServer(second, { logger: noopLogger });
    try {
        second.enableAutoPersist({ nameServer: ns2, debounceMs: 10, maxWaitMs: 50 });
        await sleep(30);
        await second.restoreState({ nameServer: ns2 });
        await sleep(40);
        const after = await inner.load();
        assert.deepEqual(after.names, saved.names, 'names unchanged by restore + auto-save');
        assert.deepEqual(after.domainRecords, saved.domainRecords);
        assert.deepEqual(after.listenPorts, saved.listenPorts);
        assert.equal((await ns2.resolve('printer')).nodeId, owner.nodeId);
    } finally {
        ns2.close();
        second.close();
    }
});

test('auto-persist: enabling before restoreState would clobber; restore-first order keeps saved names', async () => {
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const inner = new MemoryServiceStateStorage();
    const first = makeNetwork(keys, inner);
    await first.start();
    const ns1 = new NameServer(first, { logger: noopLogger });
    ns1.registerA('printer', owner.nodeId);
    await first.persistState({ nameServer: ns1 });
    first.close();

    const second = makeNetwork(keys, inner);
    await second.start();
    const ns2 = new NameServer(second, { logger: noopLogger });
    try {
        await second.restoreState({ nameServer: ns2 });
        second.enableAutoPersist({ nameServer: ns2, debounceMs: 10, maxWaitMs: 50 });
        ns2.registerA('scanner', owner.nodeId);
        await sleep(40);
        const names = (await inner.load()).names.map((n) => n.name).sort();
        assert.deepEqual(names, ['printer', 'scanner'], 'restored name kept, new name added');
    } finally {
        ns2.close();
        second.close();
    }
});

test('auto-persist: close() saves pending changes before transports close (IndexedDB, reload resilience)', async () => {
    const keys = await NodeKeyManager.create();
    const idb = new FakeIndexedDB();
    const storage = new IndexedDBServiceStateStorage({ indexedDB: idb });
    const net = makeNetwork(keys, storage);
    await net.start();
    net.enableAutoPersist({ debounceMs: 60_000, maxWaitMs: 60_000 }); // no timer-based save will happen
    await sleep(20);
    net.listen(9203, () => {});
    assert.equal((await storage.load())?.listenPorts?.includes(9203) ?? false, false, 'not saved yet');
    net.close();
    // close() は同期的に保存を開始する。完了を待ってから読み直す。
    await sleep(100);
    const reloaded = await new IndexedDBServiceStateStorage({ indexedDB: idb }).load();
    assert.deepEqual(reloaded.listenPorts, [9203]);
});

test('auto-persist: a save failure is logged and does not throw into listen()', async () => {
    const keys = await NodeKeyManager.create();
    const failing = { async save() { throw new Error('disk full'); }, async load() { return null; } };
    const net = makeNetwork(keys, failing);
    await net.start();
    net.enableAutoPersist({ debounceMs: 10, maxWaitMs: 50 });
    assert.doesNotThrow(() => net.listen(9204, () => {}));
    await sleep(60);
    net.close();
});
