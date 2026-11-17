import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NameServer,
    WebTCPNetwork,
    NodeKeyManager,
    noopLogger,
    createDomainOwnershipRecord,
    MemoryServiceStateStorage,
    IndexedDBServiceStateStorage,
    parsePersistedServiceState,
    startBrowserKeepAlive,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';
import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs';

function makeNetwork(hub, keyManager, stateStorage) {
    return new WebTCPNetwork({
        channel: hub.createChannel(keyManager.nodeId),
        keyManager,
        logger: noopLogger,
        ...(stateStorage ? { stateStorage } : {}),
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
}

test('service-persistence: persistState saves ports, A/CNAME and domain records; a new tab restores them via IndexedDB', async () => {
    const hub = new LoopbackNetwork();
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const idb = new FakeIndexedDB();
    const storageA = new IndexedDBServiceStateStorage({ indexedDB: idb });

    const first = makeNetwork(hub, keys, storageA);
    await first.start();
    const ns1 = new NameServer(first, { logger: noopLogger });
    ns1.registerA('printer', owner.nodeId);
    ns1.registerCNAME('lp', 'printer');
    const record = await createDomainOwnershipRecord({
        domain: 'shop.domain.global', keyManager: owner, serial: 1, lifetimeMs: 3_600_000,
    });
    assert.equal((await ns1.registerDomain(record)).ok, true);
    first.listen(9100, () => {});
    await first.persistState({ nameServer: ns1 });
    first.close();

    // 再読み込み後: 新しいネットワーク・新しい NameServer で同じ状態を復元する
    const hub2 = new LoopbackNetwork();
    const second = makeNetwork(hub2, keys, new IndexedDBServiceStateStorage({ indexedDB: idb }));
    await second.start();
    const restoredNs = new NameServer(second, { logger: noopLogger });
    const restored = await second.restoreState({ nameServer: restoredNs });
    try {
        assert.ok(restored, 'state found');
        assert.deepEqual(restored.listenPorts, [9100]);
        assert.deepEqual(restored.nameServer, { names: 2, domainRecords: 1, rejected: 0 });
        assert.equal(restored.state.nodeId, keys.nodeId);
        const nsRestored = restored.nameServer ? second.transportLayer.getListeningPorts() : [];
        assert.ok(nsRestored.includes(5300), 'NameServer re-listens on its port');
        const ns2 = restoredNs;
        assert.equal((await ns2.resolve('lp')).nodeId, owner.nodeId);
        assert.equal((await ns2.resolve('shop.domain.global')).nodeId, owner.nodeId);
        ns2.close();
    } finally {
        second.close();
    }
});

test('service-persistence: restored NameServer answers local names and domain records', async () => {
    const hub = new LoopbackNetwork();
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();

    const net1 = makeNetwork(hub, keys, storage);
    await net1.start();
    const ns1 = new NameServer(net1, { logger: noopLogger });
    ns1.registerA('printer', owner.nodeId, 60_000);
    ns1.registerCNAME('lp', 'printer');
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: owner, serial: 3, lifetimeMs: 3_600_000 });
    await ns1.registerDomain(record);
    await net1.persistState({ nameServer: ns1 });
    net1.close();

    const net2 = makeNetwork(new LoopbackNetwork(), keys, storage);
    await net2.start();
    const ns2 = new NameServer(net2, { logger: noopLogger });
    try {
        await net2.restoreState({ nameServer: ns2 });
        assert.equal((await ns2.resolve('lp')).nodeId, owner.nodeId);
        const shop = await ns2.resolve('shop.domain.global');
        assert.equal(shop.nodeId, owner.nodeId);
        assert.equal(shop.source, 'local');
        assert.equal(ns2.servedDomainRecords()[0].body.serial, 3);
    } finally {
        ns2.close();
        net2.close();
    }
});

test('service-persistence: restore rejects tampered domain records and foreign state', async () => {
    const storage = new MemoryServiceStateStorage();
    const keys = await NodeKeyManager.create();
    const owner = await NodeKeyManager.create();
    const net = makeNetwork(new LoopbackNetwork(), keys, storage);
    await net.start();
    const ns = new NameServer(net, { logger: noopLogger });
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: owner, serial: 1, lifetimeMs: 3_600_000 });
    await ns.registerDomain(record);
    await net.persistState({ nameServer: ns });
    const state = await storage.load();
    state.domainRecords[0].txt = 'tampered';
    await storage.save(state);
    const ns2 = new NameServer(net, { logger: noopLogger });
    try {
        const result = await net.restoreState({ nameServer: ns2 });
        assert.equal(result.nameServer.domainRecords, 0);
        assert.equal(result.nameServer.rejected, 1);
        assert.equal(ns2.servedDomainRecords().length, 0);
    } finally {
        ns.close(); ns2.close(); net.close();
    }

    assert.equal(parsePersistedServiceState({ version: 2 }), null);
    assert.equal(parsePersistedServiceState(null), null);
    assert.equal(parsePersistedServiceState({ version: 1, listenPorts: [70000], names: [], domainRecords: [] }), null);

    const other = makeNetwork(new LoopbackNetwork(), await NodeKeyManager.create(), storage);
    await other.start();
    await assert.rejects(() => other.restoreState(), /belongs to/);
    other.close();
});

test('service-persistence: persistState and restoreState require stateStorage; empty storage restores null', async () => {
    const keys = await NodeKeyManager.create();
    const net = makeNetwork(new LoopbackNetwork(), keys, null);
    await net.start();
    await assert.rejects(() => net.persistState(), /stateStorage/);
    await assert.rejects(() => net.restoreState(), /stateStorage/);
    net.close();

    const withStorage = makeNetwork(new LoopbackNetwork(), keys, new MemoryServiceStateStorage());
    await withStorage.start();
    assert.equal(await withStorage.restoreState(), null);
    withStorage.close();
});

test('service-persistence: neighbor events are re-emitted on WebTCPNetwork', async () => {
    const hub = new LoopbackNetwork();
    const [ka, kb] = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create()]);
    const a = makeNetwork(hub, ka);
    const b = makeNetwork(hub, kb);
    await Promise.all([a.start(), b.start()]);
    const seen = [];
    a.on('neighbor-connected', (id) => seen.push(['up', id]));
    try {
        await a.connectToPeer(b.localNodeId);
        await waitFor(() => seen.some(([kind, id]) => kind === 'up' && id === b.localNodeId));
    } finally {
        a.close(); b.close();
    }
});

function fakeDocument() {
    const listeners = new Map();
    return {
        visibilityState: 'hidden',
        addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
        removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
        fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn({ type })),
        count: (type) => (listeners.get(type) ?? []).length,
    };
}

test('service-persistence: keep-alive takes a wake lock, resumes on visible, and invokes onPageHide', async () => {
    const keys = await NodeKeyManager.create();
    const net = makeNetwork(new LoopbackNetwork(), keys, new MemoryServiceStateStorage());
    await net.start();
    const doc = fakeDocument();
    const win = fakeDocument();
    let released = false;
    let resumed = 0;
    let hidden = 0;
    const nav = {
        wakeLock: {
            request: async () => ({ released: false, release: async () => { released = true; } }),
        },
    };
    const keep = startBrowserKeepAlive(net, {
        document: doc,
        windowTarget: win,
        navigator: nav,
        audioContextFactory: null,
        onResume: () => { resumed += 1; },
        onPageHide: () => { hidden += 1; },
    });
    try {
        await waitFor(() => keep.wakeLockActive);
        assert.equal(keep.audioActive, false);
        doc.fire('visibilitychange'); // hidden のまま: 何もしない
        assert.equal(resumed, 0);
        doc.visibilityState = 'visible';
        doc.fire('visibilitychange');
        assert.equal(resumed, 1);
        win.fire('pagehide');
        assert.equal(hidden, 1);
    } finally {
        keep.stop();
        net.close();
    }
    assert.equal(released, true);
    assert.equal(doc.count('visibilitychange'), 0);
    assert.equal(win.count('pagehide'), 0);
});

test('service-persistence: keep-alive without wakeLock support is a no-op', async () => {
    const net = makeNetwork(new LoopbackNetwork(), await NodeKeyManager.create(), null);
    await net.start();
    const keep = startBrowserKeepAlive(net, {
        document: fakeDocument(),
        windowTarget: fakeDocument(),
        navigator: {},
        audioContextFactory: null,
    });
    assert.equal(keep.wakeLockActive, false);
    keep.stop();
    keep.stop();
    net.close();
});
