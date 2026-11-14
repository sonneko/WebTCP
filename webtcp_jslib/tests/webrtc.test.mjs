import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NodeWebRTCChannel,
    SignalingAdapterHub,
    WebTCPNetwork,
    noopLogger,
} from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';
import { decode, waitFor } from './helpers/loopback.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

async function createWebRTCNetwork(nodeId, url, channelOptions = {}) {
    const createdConnections = [];
    const signaling = new SignalingAdapterHub({
        url,
        nodeId,
        pollIntervalMs: 20,
        logger: noopLogger,
    });
    const channel = new NodeWebRTCChannel(signaling, {
        createPeerConnection: (config) => {
            const pc = new FakeRTCPeerConnection(config);
            createdConnections.push(pc);
            return pc;
        },
        connectTimeoutMs: 5000,
        logger: noopLogger,
        ...channelOptions,
    });
    const network = new WebTCPNetwork({
        channel,
        nodeId,
        signaling,
        logger: noopLogger,
        transport: { connectTimeoutMs: 5000 },
    });
    await network.start();
    return { network, signaling, channel, createdConnections };
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
            stream.on('end', () => stream.end());
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

test('webrtc: iceServersProvider injects dynamic TURN credentials and refreshes them on ICE restart (#24)', async () => {
    resetFakeWebRTC();
    const hub = await startHub();

    let tokenVersion = 0;
    const providerA = async () => {
        tokenVersion += 1;
        return [
            {
                urls: 'turn:turn.example.com:3478',
                username: `user-${tokenVersion}`,
                credential: `secret-${tokenVersion}`,
            },
        ];
    };

    const a = await createWebRTCNetwork(A, hub.url, {
        iceServersProvider: providerA,
        maxIceRestarts: 2,
    });
    const b = await createWebRTCNetwork(B, hub.url, {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    try {
        const received = [];
        b.network.listen(8080, (stream) => {
            stream.on('data', (data) => {
                received.push(decode(data));
                void stream.send(`ack:${decode(data)}`);
            });
            stream.on('end', () => stream.end());
        });

        const stream = await a.network.connect(B, 8080);
        const replies = [];
        stream.on('data', (data) => replies.push(decode(data)));

        // 初回接続時に動的 TURN 資格情報が渡されている
        assert.equal(a.createdConnections.length, 1);
        const pcA = a.createdConnections[0];
        assert.equal(pcA.configuration.iceServers[0].credential, 'secret-1');
        assert.equal(
            b.createdConnections[0].configuration.iceServers[0].urls,
            'stun:stun.l.google.com:19302',
        );

        await stream.send('before-restart');
        await waitFor(() => replies.length === 1);
        assert.equal(replies[0], 'ack:before-restart');

        // ICE failed をシミュレート -> 自動 ICE 再起動が走り、最新 TURN 資格情報が反映され、DataChannel は維持される
        pcA.simulateIceState('failed');

        await waitFor(
            () =>
                pcA.iceRestartOffersCreated === 1 &&
                pcA.iceConnectionState === 'connected' &&
                pcA.configurations.length >= 2,
            { timeoutMs: 5000 },
        );

        assert.equal(pcA.restartIceCalls, 1);
        assert.equal(pcA.configuration.iceServers[0].credential, 'secret-2');
        assert.equal(stream.state, 'ESTABLISHED');

        // ICE 再起動後も既存 VirtualStream で通信継続できる
        await stream.send('after-restart');
        await waitFor(() => replies.length === 2);
        assert.equal(replies[1], 'ack:after-restart');

        stream.end();
    } finally {
        a.network.close();
        b.network.close();
        a.signaling.close();
        b.signaling.close();
        await hub.close();
    }
});

test('webrtc: ICE failure tears down peer after exceeding maxIceRestarts (#24)', async () => {
    resetFakeWebRTC();
    const hub = await startHub();

    const a = await createWebRTCNetwork(A, hub.url, { maxIceRestarts: 1 });
    const b = await createWebRTCNetwork(B, hub.url, { maxIceRestarts: 1 });

    try {
        await a.network.connectToPeer(B);
        assert.deepEqual(a.network.getNeighbors(), [B]);

        const pcA = a.createdConnections[0];
        pcA.failIceRestarts = true;

        // 1回目の failed -> restart #1 実行 -> 再起動も failed -> 上限到達で切断
        pcA.simulateIceState('failed');

        await waitFor(() => !a.network.getNeighbors().includes(B), { timeoutMs: 5000 });
        assert.equal(pcA.iceRestartOffersCreated, 1);
    } finally {
        a.network.close();
        b.network.close();
        a.signaling.close();
        b.signaling.close();
        await hub.close();
    }
});

test('webrtc: simultaneous connect (glare) resolves cleanly via polite/impolite peer rule (#32)', async () => {
    resetFakeWebRTC();
    const hub = await startHub();

    const a = await createWebRTCNetwork(A, hub.url);
    const b = await createWebRTCNetwork(B, hub.url);

    try {
        // A と B が同時に connectToPeer() を呼ぶ
        await Promise.all([a.network.connectToPeer(B), b.network.connectToPeer(A)]);

        assert.deepEqual(a.network.getNeighbors(), [B]);
        assert.deepEqual(b.network.getNeighbors(), [A]);

        // そのまま仮想 TCP 送受信ができる
        let serverGot = null;
        b.network.listen(9090, (stream) => {
            stream.on('data', (data) => {
                serverGot = decode(data);
            });
            stream.on('end', () => stream.end());
        });

        const stream = await a.network.connect(B, 9090);
        await stream.send('glare-ok');
        await waitFor(() => serverGot === 'glare-ok', { timeoutMs: 5000 });
        stream.end();
    } finally {
        a.network.close();
        b.network.close();
        a.signaling.close();
        b.signaling.close();
        await hub.close();
    }
});
