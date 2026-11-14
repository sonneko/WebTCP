import test from 'node:test';
import assert from 'node:assert/strict';

import { WebTCPNetwork } from '../dist/index.js';
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
            transport: { connectTimeoutMs: 3000 },
        });
    });
    const [a, b, c] = nodes;

    await Promise.all(nodes.map((network) => network.start()));

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
    });

    // マルチホップであることを明示するため、リンク自動確立を経由せずトランスポート層へ直接要求する
    const stream = await a.transportLayer.connect(C, 9000, 51000);
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
    nodes.forEach((network) => network.close());
});

test('routing: a disconnected neighbor removes routes through it', async () => {
    const loopback = new LoopbackNetwork();
    const make = (nodeId) =>
        new WebTCPNetwork({ channel: loopback.createChannel(nodeId), nodeId });

    const a = make(A);
    const b = make(B);
    const c = make(C);
    await Promise.all([a.start(), b.start(), c.start()]);

    await a.connectToPeer(B);
    await b.connectToPeer(C);
    await waitFor(() => a.getRoutingTable().getEntry(C) !== null, { timeoutMs: 5000 });

    loopback.channels.get(B).disconnect(C);
    await waitFor(() => a.getRoutingTable().getEntry(C) === null, { timeoutMs: 5000 });

    [a, b, c].forEach((network) => network.close());
});
