import test from 'node:test';
import assert from 'node:assert/strict';
import { NameServer, NameLoopError, NameNotFoundError, WebTCPNetwork, NodeKeyManager, noopLogger } from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

const ID = '0123456789abcdef0123456789abcdef';

function fakeNetwork() {
    return {
        localNodeId: 'f'.repeat(32),
        getNeighbors: () => [],
        getRoutingTable: () => ({ getAllEntries: () => new Map() }),
        listen: () => {},
        transportLayer: { unlisten: () => true },
        connect: async () => { throw new Error('no peers'); },
    };
}

test('nameserver: local A/CNAME resolution, normalization and local priority', async () => {
    const ns = new NameServer(fakeNetwork(), { logger: noopLogger });
    ns.registerA('Service.Example.', ID, 1000);
    ns.registerCNAME('alias', 'service.example', 1000);
    const a = await ns.resolve('SERVICE.example');
    assert.equal(a.nodeId, ID);
    assert.equal(a.source, 'local');
    const c = await ns.resolve('alias');
    assert.equal(c.nodeId, ID);
    assert.deepEqual(c.chain, ['alias', 'service.example']);
    assert.equal(ns.unregister('alias'), true);
    await assert.rejects(() => ns.resolve('alias'), NameNotFoundError);
    ns.close();
});

test('nameserver: detects CNAME loops and depth limit', async () => {
    const ns = new NameServer(fakeNetwork(), { maxCnameDepth: 3, logger: noopLogger });
    ns.registerCNAME('a', 'b');
    ns.registerCNAME('b', 'a');
    await assert.rejects(() => ns.resolve('a'), NameLoopError);
    ns.registerCNAME('x0', 'x1'); ns.registerCNAME('x1', 'x2'); ns.registerCNAME('x2', 'x3'); ns.registerCNAME('x3', 'x4');
    ns.registerA('x4', ID);
    await assert.rejects(() => ns.resolve('x0'), NameLoopError);
    ns.close();
});

test('nameserver: validates records and TTL cache eviction', async () => {
    const ns = new NameServer(fakeNetwork(), { maxCacheEntries: 1, logger: noopLogger });
    assert.throws(() => ns.registerA('bad', 'not-an-id'), /invalid A record/);
    assert.throws(() => ns.registerA(ID, ID), /reserved/);
    assert.throws(() => ns.registerA('ok', ID, -1), /ttlMs/);
    // exercise private cache via remote-like injection through resolve? use internal for unit boundary.
    ns.putCache({ type: 'A', name: 'one', target: ID, ttlMs: 1000 });
    ns.putCache({ type: 'A', name: 'two', target: ID, ttlMs: 1000 });
    assert.equal(ns.cacheSize, 1);
    assert.equal(ns.lookup('one'), null);
    assert.equal(ns.lookup('two').record.target, ID);
    ns.close();
});

test('nameserver: resolution over a real signed two-node stack and connectURL by name', async () => {
    const hub = new LoopbackNetwork();
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const a = new WebTCPNetwork({ channel: hub.createChannel(keysA.nodeId), keyManager: keysA, logger: noopLogger, transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } } });
    const b = new WebTCPNetwork({ channel: hub.createChannel(keysB.nodeId), keyManager: keysB, logger: noopLogger, transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } } });
    await a.start(); await b.start();
    const nsA = new NameServer(a, { logger: noopLogger, queryTimeoutMs: 1000, resolveTimeoutMs: 2000 });
    const nsB = new NameServer(b, { logger: noopLogger });
    nsB.registerA('my-service', keysB.nodeId);
    nsB.registerCNAME('alias', 'my-service');
    nsB.listen();
    try {
        await a.connectToPeer(b.localNodeId);
        await waitFor(() => a.keyDirectory.get(b.localNodeId) !== undefined);
        const resolved = await nsA.resolve('alias');
        assert.equal(resolved.nodeId, b.localNodeId);
        assert.equal(resolved.source, 'remote');
        assert.equal(nsA.cacheSize, 2);
        const cached = await nsA.resolve('alias');
        assert.equal(cached.source, 'cache');

        let received = '';
        b.listen(8080, (stream) => {
            stream.on('data', (data) => { received = new TextDecoder().decode(data); void stream.send('ok'); });
            stream.on('end', () => stream.end());
        });
        const stream = await a.connectURL('webtcp://my-service:8080/hello', { nameServer: nsA });
        const reply = stream.readExact(2);
        await stream.send('ping');
        assert.equal(new TextDecoder().decode(await reply), 'ok');
        assert.equal(received, 'ping');
        stream.destroy();
        await assert.rejects(() => a.connectURL('webtcp://unknown-name:8080/', { nameServer: nsA }), /not found/);
        await assert.rejects(() => a.connectURL('webtcp://my-service:8080/'), /NameServer is required/);
    } finally {
        nsA.close(); nsB.close(); a.close(); b.close();
    }
});

test('nameserver: abort signal stops resolution', async () => {
    const ns = new NameServer(fakeNetwork(), { logger: noopLogger });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => ns.resolve('missing', { signal: controller.signal }), /aborted/);
    ns.close();
});
