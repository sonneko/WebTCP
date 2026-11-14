import test from 'node:test';
import assert from 'node:assert/strict';
import { WebTCPNetwork, VirtualStream, noopLogger } from '../dist/index.js';

test('lifecycle: start failure can be retried (#38)', async () => {
    let calls = 0;
    const channel = {
        connectedPeers: new Map(),
        async start() { calls += 1; if (calls === 1) throw new Error('transient'); },
        async connect() {}, async send() {}, disconnect() {}, close() {}, on() { return this; },
    };
    const network = new WebTCPNetwork({ channel, nodeId: 'c'.repeat(32), logger: noopLogger });
    await assert.rejects(() => network.start(), /transient/);
    await network.start();
    assert.equal(calls, 2);
    network.close();
});

test('lifecycle: end listener observes CLOSE_WAIT (#38)', async () => {
    const context = { localNodeId: 'a'.repeat(32), sendPacket: async () => {}, deregisterStream: () => {} };
    const stream = new VirtualStream(context, 'b'.repeat(32), 1001, 80, false, { initialSeqNum: 20, logger: noopLogger, timeWaitMs: 0 });
    stream.handleIncomingPacket({ flags: 'SYN', seqNum: 200, ackNum: 0, payload: new Uint8Array(0) });
    stream.handleIncomingPacket({ flags: 'ACK', seqNum: 201, ackNum: 21, payload: new Uint8Array(0) });
    let observed = '';
    stream.on('end', () => { observed = stream.state; });
    stream.handleIncomingPacket({ flags: 'FIN', seqNum: 201, ackNum: 21, payload: new Uint8Array(0) });
    assert.equal(observed, 'CLOSE_WAIT');
    stream.destroy();
});


test('lifecycle: ICE restart exception below maxIceRestarts keeps the peer (#38)', async () => {
    const { NodeWebRTCChannel, SignalingAdapterHub, WebTCPNetwork } = await import('../dist/index.js');
    const { FakeRTCPeerConnection, resetFakeWebRTC } = await import('./helpers/fake-webrtc.mjs');
    const { startHub } = await import('./helpers/hub.mjs');
    const { waitFor } = await import('./helpers/loopback.mjs');
    resetFakeWebRTC();
    const hub = await startHub();
    const A = 'a'.repeat(32), B = 'b'.repeat(32);
    const make = (nodeId) => {
        const signaling = new SignalingAdapterHub({ url: hub.url, nodeId, pollIntervalMs: 20, logger: noopLogger });
        const created = [];
        const channel = new NodeWebRTCChannel(signaling, {
            createPeerConnection: (config) => { const pc = new FakeRTCPeerConnection(config); created.push(pc); return pc; },
            maxIceRestarts: 2, logger: noopLogger,
        });
        const network = new WebTCPNetwork({ channel, nodeId, signaling, logger: noopLogger });
        return { signaling, channel, network, created };
    };
    const a = make(A), b = make(B);
    try {
        await a.network.start(); await b.network.start();
        await a.network.connectToPeer(B);
        const pc = a.created[0];
        const original = pc.createOffer.bind(pc);
        let failures = 0;
        pc.createOffer = async (options) => {
            if (options?.iceRestart && failures === 0) { failures += 1; throw new Error('transient offer failure'); }
            return original(options);
        };
        pc.simulateIceState('failed');
        await waitFor(() => failures === 1);
        assert.equal(a.network.getNeighbors().includes(B), true);
        pc.simulateIceState('failed');
        await waitFor(() => pc.iceConnectionState === 'connected', { timeoutMs: 5000 });
        assert.equal(a.network.getNeighbors().includes(B), true);
    } finally {
        a.network.close(); b.network.close(); a.signaling.close(); b.signaling.close(); await hub.close();
    }
});


test('lifecycle: fast-recovery cwnd inflation stays capped by maxWindowBytes (#38)', async () => {
    const context = { localNodeId: 'a'.repeat(32), sendPacket: async () => {}, deregisterStream: () => {} };
    const stream = new VirtualStream(context, 'b'.repeat(32), 1001, 80, true, {
        initialSeqNum: 100, mss: 1024, maxWindowBytes: 4096, maxSendBufferBytes: 64 * 1024, logger: noopLogger, timeWaitMs: 0,
    });
    stream.handleIncomingPacket({ flags: 'SYN_ACK', seqNum: 500, ackNum: 101, payload: new Uint8Array(0) });
    void stream.send(new Uint8Array(16 * 1024)).catch(() => {});
    for (let i = 0; i < 20; i += 1) {
        stream.handleIncomingPacket({ flags: 'ACK', seqNum: 501, ackNum: 101, payload: new Uint8Array(0) });
        assert.ok(stream.getStats().cwndBytes <= 4096);
    }
    stream.destroy();
});
