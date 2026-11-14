import test from 'node:test';
import assert from 'node:assert/strict';

import { WebTCPNetwork, noopLogger } from '../dist/index.js';
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
        logger: noopLogger,
        transport: { connectTimeoutMs: options.connectTimeoutMs ?? 2000, ...options.transport },
    });
    const b = new WebTCPNetwork({
        channel: channelB,
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { connectTimeoutMs: options.connectTimeoutMs ?? 2000, ...options.transport },
    });

    await a.start();
    await b.start();
    return { a, b, channelA, channelB };
}

test('e2e: SYN handshake, bidirectional data, and clean half-close/close', async () => {
    const { a, b } = await createPair();

    try {
        const receivedByServer = [];
        const receivedByClient = [];
        let serverStream = null;
        let serverSawEnd = false;

        b.listen(8080, (stream) => {
            serverStream = stream;
            assert.equal(stream.state, 'ESTABLISHED');
            stream.on('data', (data) => {
                const text = decode(data);
                receivedByServer.push(text);
                // エコーサーバー
                void stream.send(`echo:${text}`);
            });
            stream.on('end', () => {
                serverSawEnd = true;
                stream.end();
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

        // 切断すると half-close を経て双方のセッションが解放される
        clientStream.close();
        await waitFor(
            () =>
                serverSawEnd &&
                a.transportLayer.sessionManager.size() === 0 &&
                b.transportLayer.sessionManager.size() === 0,
        );
    } finally {
        a.close();
        b.close();
    }
});

test('e2e: connecting to a port nobody listens on is rejected with RST', async () => {
    const { a, b } = await createPair();

    try {
        await assert.rejects(a.connect(NODE_B, 9999, 50002), /reset|RST|closed/i);
    } finally {
        a.close();
        b.close();
    }
});

test('e2e: binary payloads survive the round trip', async () => {
    const { a, b } = await createPair();
    try {
        const payload = new Uint8Array([0, 1, 2, 3, 255, 254]);

        let received = null;
        b.listen(7000, (stream) => {
            stream.on('data', (data) => {
                received = data;
            });
            stream.on('end', () => stream.end());
        });

        const stream = await a.connect(NODE_B, 7000, 50003);
        await stream.send(payload);

        await waitFor(() => received !== null);
        assert.deepEqual([...received], [...payload]);

        stream.close();
    } finally {
        a.close();
        b.close();
    }
});

test('e2e: listen() rejects a duplicate port', async () => {
    const { a, b } = await createPair();
    try {
        b.listen(6000, () => {});
        assert.throws(() => b.listen(6000, () => {}), /already listening/);
    } finally {
        a.close();
        b.close();
    }
});

test('e2e: server can send immediately inside listen() callback (#31)', async () => {
    const { a, b } = await createPair();
    try {
        b.listen(8081, (stream) => {
            assert.equal(stream.state, 'ESTABLISHED');
            void stream.send('welcome-banner');
            stream.on('end', () => stream.end());
        });

        const clientStream = await a.connect(NODE_B, 8081);
        const banner = await clientStream.readExact('welcome-banner'.length);
        assert.equal(decode(banner), 'welcome-banner');

        clientStream.end();
        await waitFor(
            () =>
                a.transportLayer.sessionManager.size() === 0 &&
                b.transportLayer.sessionManager.size() === 0,
        );
    } finally {
        a.close();
        b.close();
    }
});
