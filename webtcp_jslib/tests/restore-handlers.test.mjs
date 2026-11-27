import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NodeKeyManager,
    WebTCPNetwork,
    MemoryServiceStateStorage,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork } from './helpers/loopback.mjs';

const PORT = 9100;

function makeNetwork(hub, keys, stateStorage) {
    return new WebTCPNetwork({
        channel: hub.createChannel(keys.nodeId),
        keyManager: keys,
        logger: noopLogger,
        ...(stateStorage ? { stateStorage } : {}),
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
}

/** サーバーを 1 回目（保存まで）と「リロード後」（同じ鍵・同じストレージ・新しいハブ）で作る。 */
async function savedServer() {
    const serverKeys = await NodeKeyManager.create();
    const clientKeys = await NodeKeyManager.create();
    const storage = new MemoryServiceStateStorage();
    const before = makeNetwork(new LoopbackNetwork(), serverKeys, storage);
    await before.start();
    before.listen(PORT, () => {});
    await before.persistState();
    before.close();
    const hub = new LoopbackNetwork();
    const server = makeNetwork(hub, serverKeys, storage);
    const client = makeNetwork(hub, clientKeys);
    await Promise.all([server.start(), client.start()]);
    return { server, client, serverKeys, storage };
}

const echo = (stream) => {
    stream.on('data', (data) => stream.send(data));
};

/** クライアントから接続して 1 往復させる。拒否されたら reject する。 */
async function roundTrip(client, serverId, port, text, timeoutMs = 5000) {
    const stream = await client.connect(serverId, port);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no echo')), timeoutMs);
        stream.on('data', (data) => {
            clearTimeout(timer);
            resolve(new TextDecoder().decode(data));
            stream.close?.();
        });
        stream.send(text).catch(reject);
    });
}

test('restore-handlers: a handler passed to restoreState is listening before it returns, and a peer gets an echo at once (no RST)', async () => {
    const { server, client, serverKeys } = await savedServer();
    try {
        const restored = await server.restoreState({ handlers: { [PORT]: echo } });
        assert.deepEqual(restored.listenPorts, [PORT]);
        assert.deepEqual(restored.listeningPorts, [PORT]);
        assert.deepEqual(restored.unhandledPorts, []);
        assert.ok(server.transportLayer.getListeningPorts().includes(PORT), 'listening on return');
        await client.connectToPeer(serverKeys.nodeId);
        assert.equal(await roundTrip(client, serverKeys.nodeId, PORT, 'ping'), 'ping');
    } finally {
        client.close();
        server.close();
    }
});

test('restore-handlers: without a handler the restored port is reported as unhandled and refuses connections (RST)', async () => {
    const { server, client, serverKeys } = await savedServer();
    try {
        const restored = await server.restoreState();
        assert.deepEqual(restored.listeningPorts, []);
        assert.deepEqual(restored.unhandledPorts, [PORT]);
        assert.ok(!server.transportLayer.getListeningPorts().includes(PORT));
        await client.connectToPeer(serverKeys.nodeId);
        await assert.rejects(
            () => roundTrip(client, serverKeys.nodeId, PORT, 'ping', 3000),
            /Connection reset by remote peer \(RST\)/,
        );
    } finally {
        client.close();
        server.close();
    }
});

test('restore-handlers: the Map form works, and handlers for ports that were not saved are ignored', async () => {
    const { server, client, serverKeys } = await savedServer();
    try {
        const restored = await server.restoreState({
            handlers: new Map([[PORT, echo], [9999, echo]]),
        });
        assert.deepEqual(restored.listeningPorts, [PORT]);
        assert.ok(!server.transportLayer.getListeningPorts().includes(9999));
        await client.connectToPeer(serverKeys.nodeId);
        assert.equal(await roundTrip(client, serverKeys.nodeId, PORT, 'map'), 'map');
    } finally {
        client.close();
        server.close();
    }
});

test('restore-handlers: a port that is already listening is a conflict, detected before anything is listened', async () => {
    const { server, client } = await savedServer();
    try {
        server.listen(PORT, () => {});
        await assert.rejects(() => server.restoreState({ handlers: { [PORT]: echo } }), /already listening/);
        assert.deepEqual(server.transportLayer.getListeningPorts(), [PORT]);
    } finally {
        client.close();
        server.close();
    }
});

test('restore-handlers: invalid handlers are rejected before any port is opened', async () => {
    const { server, client } = await savedServer();
    try {
        await assert.rejects(() => server.restoreState({ handlers: { [PORT]: 'not a function' } }), /must be a function/);
        await assert.rejects(() => server.restoreState({ handlers: { abc: echo } }), /port number/);
        await assert.rejects(() => server.restoreState({ handlers: { 70000: echo } }), /port number/);
        assert.deepEqual(server.transportLayer.getListeningPorts(), []);
    } finally {
        client.close();
        server.close();
    }
});
