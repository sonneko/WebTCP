import test from 'node:test';
import assert from 'node:assert/strict';

import { WebTCPNetwork } from '../dist/index.js';
import { LoopbackNetwork, decode, waitFor } from './helpers/loopback.mjs';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

async function createPair(options = {}) {
    const loopback = new LoopbackNetwork();
    const channelA = loopback.createChannel(NODE_A);
    const channelB = loopback.createChannel(NODE_B);

    const a = new WebTCPNetwork({
        channel: channelA,
        nodeId: NODE_A,
        transport: { connectTimeoutMs: options.connectTimeoutMs ?? 2000 },
    });
    const b = new WebTCPNetwork({
        channel: channelB,
        nodeId: NODE_B,
        transport: { connectTimeoutMs: options.connectTimeoutMs ?? 2000 },
    });

    await a.start();
    await b.start();
    return { a, b, channelA, channelB };
}

test('e2e: SYN handshake, bidirectional data, and clean close', async () => {
    const { a, b } = await createPair();

    const receivedByServer = [];
    const receivedByClient = [];
    let serverStream = null;

    b.listen(8080, (stream) => {
        serverStream = stream;
        stream.on('data', (data) => {
            const text = decode(data);
            receivedByServer.push(text);
            // エコーサーバー
            void stream.send(`echo:${text}`);
        });
    });

    const clientStream = await a.connect(NODE_B, 8080, 50001);
    assert.equal(clientStream.state, 'ESTABLISHED');

    clientStream.on('data', (data) => receivedByClient.push(decode(data)));

    await clientStream.send('hello');
    await waitFor(() => receivedByServer.length === 1 && receivedByClient.length === 1);

    assert.deepEqual(receivedByServer, ['hello']);
    assert.deepEqual(receivedByClient, ['echo:hello']);
    assert.equal(serverStream.state, 'ESTABLISHED');

    // リンクとルーティングが学習されている
    await waitFor(() => a.getNeighbors().includes(NODE_B));
    assert.equal(a.getRoutingTable().getEntry(NODE_B)?.cost, 1);

    // 切断すると双方のセッションが解放される
    clientStream.close();
    await waitFor(
        () => a.transportLayer.sessionManager.size() === 0 && b.transportLayer.sessionManager.size() === 0,
    );

    a.close();
    b.close();
});

test('e2e: connecting to a port nobody listens on is rejected with RST', async () => {
    const { a, b } = await createPair();

    await assert.rejects(a.connect(NODE_B, 9999, 50002), /reset|RST|closed/i);

    a.close();
    b.close();
});

test('e2e: binary payloads survive the round trip', async () => {
    const { a, b } = await createPair();
    const payload = new Uint8Array([0, 1, 2, 3, 255, 254]);

    let received = null;
    b.listen(7000, (stream) => {
        stream.on('data', (data) => {
            received = data;
        });
    });

    const stream = await a.connect(NODE_B, 7000, 50003);
    await stream.send(payload);

    await waitFor(() => received !== null);
    assert.deepEqual([...received], [...payload]);

    stream.close();
    a.close();
    b.close();
});

test('e2e: listen() rejects a duplicate port', async () => {
    const { a, b } = await createPair();
    b.listen(6000, () => {});
    assert.throws(() => b.listen(6000, () => {}), /already listening/);

    a.close();
    b.close();
});
