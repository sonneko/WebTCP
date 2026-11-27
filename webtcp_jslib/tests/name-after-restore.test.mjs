import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NodeKeyManager,
    NameServer,
    NameNotFoundError,
    WebTCPNetwork,
    MemoryServiceStateStorage,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

// M9 項目 32 / specification.md §9.10: リロード（再起動）後に、保存された名前が
// 別のノードから名前で解決できること。Node の試験では両方のノードを再起動する
// （LoopbackNetwork では、生き続けた相手の古いリンクを再現できないため。実ブラウザの検証は
// examples/verify-name-reload-browser.mjs で、相手を再読み込みしない場合を確かめる）。

const NAME = 'svc.test';
const echo = (stream) => { stream.on('data', (data) => stream.send(data)); };

function makeNetwork(hub, keys, stateStorage) {
    return new WebTCPNetwork({
        channel: hub.createChannel(keys.nodeId),
        keyManager: keys,
        logger: noopLogger,
        ...(stateStorage ? { stateStorage } : {}),
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
}

function makeNameServer(network) {
    return new NameServer(network, {
        logger: noopLogger,
        queryTimeoutMs: 1000,
        resolveTimeoutMs: 3000,
    });
}

async function echoThrough(network, ns, owner) {
    ns.clearCache();
    const resolution = await ns.resolve(NAME);
    assert.equal(resolution.source, 'remote', 'the answer comes from a remote query, not the cache');
    assert.equal(resolution.nodeId, owner);
    const stream = await network.connect(resolution.nodeId, 7002);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no echo')), 5000);
        stream.on('data', (data) => { clearTimeout(timer); resolve(new TextDecoder().decode(data)); });
        stream.send('name-after-restore').catch(reject);
    });
}

test('name-after-restore: a restored name resolves from another node after reconnectNeighbors (remote, with echo)', async () => {
    const kA = await NodeKeyManager.create();
    const kB = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();

    // 名前の保持者 B: 名前を登録し、A へ接続して保存する
    const hub1 = new LoopbackNetwork();
    const a = makeNetwork(hub1, kA);
    const b = makeNetwork(hub1, kB, storage);
    const bNs = makeNameServer(b);
    const aNs = makeNameServer(a);
    await Promise.all([a.start(), b.start()]);
    try {
        await b.restoreState({ nameServer: bNs });
        bNs.listen();
        b.listen(7002, echo); // 保存されるのは待ち受けポートだけ。ハンドラは復元時に付ける
        bNs.registerA(NAME, kB.nodeId);
        await b.connectToPeer(kA.nodeId);
        await waitFor(() => b.getNeighbors().includes(kA.nodeId));
        await b.persistState({ nameServer: bNs });
        assert.deepEqual((await storage.load()).names.map((n) => n.name), [NAME]);
        assert.deepEqual((await storage.load()).neighbors, [kA.nodeId]);
    } finally {
        aNs.close();
        bNs.close();
        b.close();
        a.close();
    }

    // 再読み込み後: A は新しいハブへ移る（相手の旧リンクは持たない）。B は保存から復元する。
    const hub2 = new LoopbackNetwork();
    const a2 = makeNetwork(hub2, kA);
    const b2 = makeNetwork(hub2, kB, storage);
    const a2Ns = makeNameServer(a2);
    const b2Ns = makeNameServer(b2);
    await Promise.all([a2.start(), b2.start()]);
    try {
        const restored = await b2.restoreState({ nameServer: b2Ns, handlers: { 7002: echo } });
        assert.equal(restored.nameServer.names, 1, 'the name is restored');
        assert.deepEqual(restored.neighbors, [kA.nodeId]);
        assert.deepEqual(b2.getNeighbors(), [], 'restoreState does not connect by itself');

        // 再接続の前: A からは名前が見えない（保存だけでは解決できない）
        await assert.rejects(() => a2Ns.resolve(NAME), NameNotFoundError);

        const result = await b2.reconnectNeighbors(restored.neighbors);
        assert.deepEqual(result.connected, [kA.nodeId]);

        // 再接続の後: A は名前を解決し、解決先の 7002 へ接続してエコーを受け取れる
        assert.equal(await echoThrough(a2, a2Ns, kB.nodeId), 'name-after-restore');
    } finally {
        a2Ns.close();
        b2Ns.close();
        a2.close();
        b2.close();
    }
});

test('name-after-restore: control — without reconnectNeighbors the restored name is not resolvable from the other node', async () => {
    const kA = await NodeKeyManager.create();
    const kB = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();

    const hub1 = new LoopbackNetwork();
    const b = makeNetwork(hub1, kB, storage);
    const bNs = makeNameServer(b);
    await b.start();
    try {
        await b.restoreState({ nameServer: bNs });
        bNs.listen();
        b.listen(7002, echo);
        bNs.registerA(NAME, kB.nodeId);
        await b.persistState({ nameServer: bNs });
    } finally {
        bNs.close();
        b.close();
    }

    const hub2 = new LoopbackNetwork();
    const a2 = makeNetwork(hub2, kA);
    const b2 = makeNetwork(hub2, kB, storage);
    const a2Ns = makeNameServer(a2);
    const b2Ns = makeNameServer(b2);
    await Promise.all([a2.start(), b2.start()]);
    try {
        const restored = await b2.restoreState({ nameServer: b2Ns, handlers: { 7002: echo } });
        assert.equal(restored.nameServer.names, 1);
        assert.deepEqual(restored.neighbors, [], 'nothing was saved as a neighbour');
        // 待っても、A からは解決できない（自動では接続されない）
        await new Promise((resolve) => setTimeout(resolve, 300));
        await assert.rejects(() => a2Ns.resolve(NAME), NameNotFoundError);
        assert.deepEqual(a2.getNeighbors(), []);
    } finally {
        a2Ns.close();
        b2Ns.close();
        a2.close();
        b2.close();
    }
});
