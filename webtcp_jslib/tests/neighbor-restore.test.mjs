import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NodeKeyManager,
    WebTCPNetwork,
    MemoryServiceStateStorage,
    noopLogger,
    parsePersistedServiceState,
    MAX_SAVED_NEIGHBORS,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

function makeNetwork(hub, keys, stateStorage) {
    return new WebTCPNetwork({
        channel: hub.createChannel(keys.nodeId),
        keyManager: keys,
        logger: noopLogger,
        ...(stateStorage ? { stateStorage } : {}),
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
}

const echo = (stream) => { stream.on('data', (data) => stream.send(data)); };

async function roundTrip(net, peerId, port, text) {
    const stream = await net.connect(peerId, port);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no echo')), 5000);
        stream.on('data', (data) => { clearTimeout(timer); resolve(new TextDecoder().decode(data)); });
        stream.send(text).catch(reject);
    });
}

test('neighbor-restore: persistState saves the active neighbours (not self); a restarted node reconnects and exchanges data', async () => {
    const kA = await NodeKeyManager.create();
    const kB = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();
    const hub1 = new LoopbackNetwork();
    const a = makeNetwork(hub1, kA, storage);
    const b = makeNetwork(hub1, kB);
    await Promise.all([a.start(), b.start()]);
    await a.connectToPeer(kB.nodeId);
    await waitFor(() => a.getNeighbors().includes(kB.nodeId));
    const saved = await a.persistState();
    assert.deepEqual(saved.neighbors, [kB.nodeId]);
    assert.deepEqual((await storage.load()).neighbors, [kB.nodeId]);
    a.close();
    b.close();

    // 再読み込み後: 同じ鍵・同じストレージ・新しいハブ（相手も新しいネットワーク）
    const hub2 = new LoopbackNetwork();
    const b2 = makeNetwork(hub2, kB);
    b2.listen(7002, echo);
    const a2 = makeNetwork(hub2, kA, storage);
    await Promise.all([a2.start(), b2.start()]);
    try {
        const restored = await a2.restoreState();
        assert.deepEqual(restored.neighbors, [kB.nodeId]);
        assert.deepEqual(a2.getNeighbors(), [], 'restoreState does not connect by itself');
        const result = await a2.reconnectNeighbors(restored.neighbors);
        assert.deepEqual(result.connected, [kB.nodeId]);
        assert.ok(a2.getNeighbors().includes(kB.nodeId));
        assert.equal(await roundTrip(a2, kB.nodeId, 7002, 'after-restore'), 'after-restore');
    } finally {
        a2.close();
        b2.close();
    }
});

test('neighbor-restore: control — a state saved without neighbours restores an empty list and reconnects nothing', async () => {
    const kA = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();
    const hub1 = new LoopbackNetwork();
    const a = makeNetwork(hub1, kA, storage);
    await a.start();
    await a.persistState();
    a.close();

    const a2 = makeNetwork(new LoopbackNetwork(), kA, storage);
    await a2.start();
    try {
        const restored = await a2.restoreState();
        assert.deepEqual(restored.neighbors, []);
        const result = await a2.reconnectNeighbors(restored.neighbors);
        assert.deepEqual(result, { connected: [], failed: [], attempts: 0 });
        assert.deepEqual(a2.getNeighbors(), []);
    } finally {
        a2.close();
    }
});

test('neighbor-restore: an offline saved neighbour fails with bounded retries and does not throw', async () => {
    const kA = await NodeKeyManager.create();
    const absent = (await NodeKeyManager.create()).nodeId;
    const a = makeNetwork(new LoopbackNetwork(), kA);
    await a.start();
    try {
        const result = await a.reconnectNeighbors([absent, absent, a.localNodeId], {
            maxRetries: 2,
            initialBackoffMs: 1,
            maxBackoffMs: 1,
            sleep: async () => {},
        });
        assert.deepEqual(result.connected, []);
        assert.equal(result.attempts, 2);
        assert.equal(result.failed.length, 2, 'one failure per attempt for the single valid candidate');
        assert.ok(result.failed.every((f) => f.nodeId === absent));
    } finally {
        a.close();
    }
});

test('neighbor-restore: invalid NodeIds and self are filtered before any connection attempt', async () => {
    const kA = await NodeKeyManager.create();
    const a = makeNetwork(new LoopbackNetwork(), kA);
    await a.start();
    try {
        const result = await a.reconnectNeighbors(['not-a-node-id', a.localNodeId], {
            maxRetries: 1,
            sleep: async () => {},
        });
        assert.deepEqual(result, { connected: [], failed: [], attempts: 0 });
    } finally {
        a.close();
    }
});

test('neighbor-restore: auto-persist saves a new neighbour without a persistState() call', async () => {
    const kA = await NodeKeyManager.create();
    const kB = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();
    const hub = new LoopbackNetwork();
    const a = makeNetwork(hub, kA, storage);
    const b = makeNetwork(hub, kB);
    await Promise.all([a.start(), b.start()]);
    a.enableAutoPersist({ debounceMs: 10, maxWaitMs: 50 });
    try {
        await a.connectToPeer(kB.nodeId);
        await waitFor(async () => ((await storage.load())?.neighbors ?? []).includes(kB.nodeId), { timeoutMs: 3000 });
    } finally {
        a.close();
        b.close();
    }
});

test('neighbor-restore: parsing — old states read as no neighbours; invalid or oversized lists are rejected; duplicates merge', async () => {
    const base = { version: 1, savedAt: 0, listenPorts: [], names: [], domainRecords: [] };
    assert.deepEqual(parsePersistedServiceState(base).neighbors, undefined, 'old state has no neighbors field');
    const id = 'a'.repeat(32);
    assert.deepEqual(parsePersistedServiceState({ ...base, neighbors: [id, id] }).neighbors, [id]);
    assert.equal(parsePersistedServiceState({ ...base, neighbors: ['xyz'] }), null);
    assert.equal(parsePersistedServiceState({ ...base, neighbors: 'nope' }), null);
    const many = Array.from({ length: MAX_SAVED_NEIGHBORS + 1 }, (_, i) => i.toString(16).padStart(32, '0'));
    assert.equal(parsePersistedServiceState({ ...base, neighbors: many }), null);
    assert.equal(MAX_SAVED_NEIGHBORS, 16);
});
