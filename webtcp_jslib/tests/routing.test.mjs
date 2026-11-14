import test from 'node:test';
import assert from 'node:assert/strict';

import { WebTCPNetwork, noopLogger } from '../dist/index.js';
import { LoopbackNetwork, decode, waitFor } from './helpers/loopback.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

test('routing: a 3-node chain forwards packets via the middle node', async () => {
    const loopback = new LoopbackNetwork();
    const nodes = [A, B, C].map((nodeId) => {
        const channel = loopback.createChannel(nodeId);
        return new WebTCPNetwork({
            channel,
            nodeId,
            logger: noopLogger,
            transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
        });
    });
    const [a, b, c] = nodes;

    await Promise.all(nodes.map((network) => network.start()));

    try {
        // A-B, B-C のみを接続する（A-C は直接つながらない）
        await a.connectToPeer(B);
        await b.connectToPeer(C);

        // B が A と C の経路を学習し、A/C に伝播するのを待つ
        await waitFor(() => a.getRoutingTable().getEntry(C)?.nextHopId === B, { timeoutMs: 5000 });
        await waitFor(() => c.getRoutingTable().getEntry(A)?.nextHopId === B, { timeoutMs: 5000 });

        let received = null;
        c.listen(9000, (stream) => {
            stream.on('data', (data) => {
                received = decode(data);
                void stream.send(`pong:${received}`);
            });
            stream.on('end', () => stream.end());
        });

        // A-C は直接つながっていないが、経路が学習済みなので公開APIからマルチホップ接続できる
        const stream = await a.connect(C, 9000, 51000);
        let reply = null;
        stream.on('data', (data) => {
            reply = decode(data);
        });

        await stream.send('ping');
        await waitFor(() => received !== null && reply !== null, { timeoutMs: 5000 });

        assert.equal(received, 'ping');
        assert.equal(reply, 'pong:ping');
        assert.deepEqual(a.getNeighbors(), [B]);
        assert.equal(a.getRoutingTable().getEntry(C)?.cost, 2);

        stream.close();
    } finally {
        nodes.forEach((network) => network.close());
    }
});

test('routing: a disconnected neighbor removes routes through it', async () => {
    const loopback = new LoopbackNetwork();
    const make = (nodeId) =>
        new WebTCPNetwork({
            channel: loopback.createChannel(nodeId),
            nodeId,
            logger: noopLogger,
        });

    const a = make(A);
    const b = make(B);
    const c = make(C);
    await Promise.all([a.start(), b.start(), c.start()]);

    try {
        await a.connectToPeer(B);
        await b.connectToPeer(C);
        await waitFor(() => a.getRoutingTable().getEntry(C) !== null, { timeoutMs: 5000 });

        loopback.channels.get(B).disconnect(C);
        await waitFor(() => a.getRoutingTable().getEntry(C) === null, { timeoutMs: 5000 });
    } finally {
        [a, b, c].forEach((network) => network.close());
    }
});

test('routing: periodic RT_UPDATE refreshes lastSeen for active routes past ageThresholdMs (#30)', async () => {
    const loopback = new LoopbackNetwork();
    const rtmOpts = { maintenancePeriodMs: 40, ageThresholdMs: 120 };
    const make = (nodeId) =>
        new WebTCPNetwork({
            channel: loopback.createChannel(nodeId),
            nodeId,
            logger: noopLogger,
            routingTableManager: rtmOpts,
        });

    const a = make(A);
    const b = make(B);
    const c = make(C);
    await Promise.all([a.start(), b.start(), c.start()]);

    try {
        await a.connectToPeer(B);
        await b.connectToPeer(C);
        await waitFor(() => a.getRoutingTable().getEntry(C)?.cost === 2, { timeoutMs: 2000 });

        const initialLastSeen = a.getRoutingTable().getEntry(C).lastSeen;
        // ageThresholdMs (120ms) を十分超える 260ms 待っても稼働中の経路が失効しない
        await new Promise((resolve) => setTimeout(resolve, 260));

        const entryB = a.getRoutingTable().getEntry(B);
        const entryC = a.getRoutingTable().getEntry(C);
        assert.equal(entryB?.cost, 1);
        assert.equal(entryC?.cost, 2);
        assert.ok(entryC.lastSeen > initialLastSeen, 'lastSeen should have been refreshed');
    } finally {
        [a, b, c].forEach((network) => network.close());
    }
});

test('routing: TTL=1 reaches direct neighbor but is dropped at intermediate router (#30)', async () => {
    const loopback = new LoopbackNetwork();
    const make = (nodeId, defaultTtl) =>
        new WebTCPNetwork({
            channel: loopback.createChannel(nodeId),
            nodeId,
            defaultTtl,
            logger: noopLogger,
            transport: { connectTimeoutMs: 300, stream: { initialRtoMs: 100, maxRetransmissions: 1, timeWaitMs: 0 } },
        });

    const a = make(A, 1);
    const b = make(B, 64);
    const c = make(C, 64);
    await Promise.all([a.start(), b.start(), c.start()]);

    try {
        await a.connectToPeer(B);
        await b.connectToPeer(C);
        await waitFor(() => a.getRoutingTable().getEntry(C)?.cost === 2, { timeoutMs: 2000 });

        let bReceived = false;
        let cReceived = false;
        b.listen(8001, (s) => {
            bReceived = true;
            s.on('end', () => s.end());
        });
        c.listen(8002, (s) => {
            cReceived = true;
            s.on('end', () => s.end());
        });

        // TTL=1 でも 1 ホップ直接隣接の B には届く
        const streamToB = await a.connect(B, 8001);
        await waitFor(() => bReceived === true);
        assert.equal(bReceived, true);
        streamToB.end();

        // TTL=1 では中継ノード B で TTL が 0 になり破棄されるため C には届かない
        await assert.rejects(() => a.connect(C, 8002), /timed out|Max retransmissions/i);
        assert.equal(cReceived, false);
    } finally {
        [a, b, c].forEach((network) => network.close());
    }
});
