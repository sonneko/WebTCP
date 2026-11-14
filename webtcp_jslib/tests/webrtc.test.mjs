import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NodeWebRTCChannel,
    SignalingAdapterHub,
    WebTCPNetwork,
} from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';
import { decode, waitFor } from './helpers/loopback.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

async function createWebRTCNetwork(nodeId, url) {
    const signaling = new SignalingAdapterHub({ url, nodeId, pollIntervalMs: 20 });
    const channel = new NodeWebRTCChannel(signaling, {
        createPeerConnection: () => new FakeRTCPeerConnection(),
        connectTimeoutMs: 5000,
    });
    const network = new WebTCPNetwork({
        channel,
        nodeId,
        signaling,
        transport: { connectTimeoutMs: 5000 },
    });
    await network.start();
    return { network, signaling };
}

test('webrtc: two networks connect through signaling and exchange data', async () => {
    resetFakeWebRTC();
    const hub = await startHub();

    const a = await createWebRTCNetwork(A, hub.url);
    const b = await createWebRTCNetwork(B, hub.url);

    try {
        const receivedByServer = [];
        const receivedByClient = [];

        b.network.listen(8080, (stream) => {
            stream.on('data', (data) => {
                const text = decode(data);
                receivedByServer.push(text);
                void stream.send(`echo:${text}`);
            });
        });

        const stream = await a.network.connect(B, 8080);
        stream.on('data', (data) => receivedByClient.push(decode(data)));

        assert.equal(stream.state, 'ESTABLISHED');
        await stream.send('hello over webrtc');
        await waitFor(
            () => receivedByServer.length === 1 && receivedByClient.length === 1,
            { timeoutMs: 5000 },
        );

        assert.deepEqual(receivedByServer, ['hello over webrtc']);
        assert.deepEqual(receivedByClient, ['echo:hello over webrtc']);
        assert.deepEqual(a.network.getNeighbors(), [B]);

        // 仮想TCPセッションを閉じても WebRTC リンクは維持される
        stream.close();
        await waitFor(
            () =>
                a.network.transportLayer.sessionManager.size() === 0 &&
                b.network.transportLayer.sessionManager.size() === 0,
            { timeoutMs: 5000 },
        );
        assert.deepEqual(b.network.getNeighbors(), [A]);
    } finally {
        a.network.close();
        b.network.close();
        a.signaling.close();
        b.signaling.close();
        await hub.close();
    }
});
