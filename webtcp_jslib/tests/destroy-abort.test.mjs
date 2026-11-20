import test from 'node:test';
import assert from 'node:assert/strict';
import { WebTCPNetwork, noopLogger } from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

// #54: destroy() は RST で相手に通知し、相手側ストリームを CLOSED にする。
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

function makePair() {
    const hub = new LoopbackNetwork();
    const channels = [hub.createChannel(A), hub.createChannel(B)];
    let packets = 0;
    for (const channel of channels) {
        const send = channel.send.bind(channel);
        channel.send = async (...args) => {
            packets += 1;
            return send(...args);
        };
    }
    const nodes = channels.map((channel, index) =>
        new WebTCPNetwork({
            channel,
            nodeId: index === 0 ? A : B,
            logger: noopLogger,
            transport: { stream: { timeWaitMs: 0 } },
        }),
    );
    return { nodes, counter: () => packets };
}

test('destroy: the peer stream is reset to CLOSED and never stays ESTABLISHED (#54)', async () => {
    const { nodes: [a, b] } = makePair();
    try {
        await Promise.all([a.start(), b.start()]);
        let serverStream = null;
        let serverClosed = false;
        b.listen(8080, (stream) => {
            serverStream = stream;
            stream.on('data', () => {});
            stream.on('close', () => { serverClosed = true; });
            // error リスナーなし: RST を受けても例外にならないこと
        });
        const client = await a.connect(B, 8080);
        await client.send('x');
        await waitFor(() => serverStream !== null);
        await waitFor(() => serverStream.state === 'ESTABLISHED');

        client.destroy();
        assert.equal(client.state, 'CLOSED');
        await waitFor(() => serverClosed, { timeoutMs: 1000 });
        assert.equal(serverStream.state, 'CLOSED');
        a.close();
        b.close();
    } finally {
        a.close();
        b.close();
    }
});

test('destroy: the peer observes an error when it listens for one', async () => {
    const { nodes: [a, b] } = makePair();
    try {
        await Promise.all([a.start(), b.start()]);
        let peerError = null;
        b.listen(8081, (stream) => {
            stream.on('error', (error) => { peerError = error; });
            stream.on('data', () => {});
        });
        const client = await a.connect(B, 8081);
        await client.send('y');
        await new Promise((resolve) => setTimeout(resolve, 20));
        client.destroy();
        await waitFor(() => peerError !== null, { timeoutMs: 1000 });
        assert.match(peerError.message, /reset/i);
        a.close();
        b.close();
    } finally {
        a.close();
        b.close();
    }
});

test('destroy: simultaneous destroy on both sides does not ping-pong RSTs', async () => {
    const { nodes: [a, b], counter } = makePair();
    try {
        await Promise.all([a.start(), b.start()]);
        let serverStream = null;
        b.listen(8082, (stream) => {
            serverStream = stream;
            stream.on('data', () => {});
            stream.on('error', () => {});
        });
        const client = await a.connect(B, 8082);
        await client.send('z');
        await waitFor(() => serverStream !== null);
        await new Promise((resolve) => setTimeout(resolve, 20));

        const before = counter();
        client.destroy();
        serverStream.destroy();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const sent = counter() - before;
        // 両端が 1 つずつ RST を送る程度に収まること（無限の往復ならここで大きくなる）
        assert.ok(sent <= 4, `expected a bounded number of packets after simultaneous destroy, got ${sent}`);
        a.close();
        b.close();
    } finally {
        a.close();
        b.close();
    }
});

test('end() still performs a graceful close (regression guard for #54)', async () => {
    const { nodes: [a, b] } = makePair();
    try {
        await Promise.all([a.start(), b.start()]);
        let serverStream = null;
        let received = '';
        let serverEnded = false;
        b.listen(8083, (stream) => {
            serverStream = stream;
            stream.on('data', (chunk) => { received += new TextDecoder().decode(chunk); });
            stream.on('end', () => { serverEnded = true; });
            stream.on('error', (error) => { throw error; });
        });
        const client = await a.connect(B, 8083);
        await client.send('graceful');
        client.end();
        await waitFor(() => serverEnded, { timeoutMs: 1000 });
        assert.equal(received, 'graceful');
        assert.equal(serverStream.state, 'CLOSE_WAIT');
        serverStream.end();
        a.close();
        b.close();
    } finally {
        a.close();
        b.close();
    }
});
