import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
    NodeWebRTCChannel,
    SignalingAdapterHub,
    TransportLayer,
    WebTCPNetwork,
    isAbortError,
} from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

// #44: connect() 系の API へ AbortSignal を伝播する。
// 中断は AbortError で即座に reject し、タイマー・リスナー・途中のネゴシエーションを残さない。

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

/** 呼ばれたすべてのログを記録するロガー（warn / error が出ないことを確かめる）。 */
function recordingLogger() {
    const calls = { debug: [], info: [], warn: [], error: [] };
    return {
        calls,
        logger: {
            debug: (...args) => calls.debug.push(args),
            info: (...args) => calls.info.push(args),
            warn: (...args) => calls.warn.push(args),
            error: (...args) => calls.error.push(args),
        },
    };
}

/**
 * setTimeout / clearTimeout を包み、未解除のタイマーを数える。
 * 戻り値の `liveWithDelay(ms)` は、指定の遅延で作られ、まだ解除されていないタイマーの数。
 */
function trackTimers() {
    const live = new Map();
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay, ...rest) => {
        const handle = originalSet(fn, delay, ...rest);
        live.set(handle, delay);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        live.delete(handle);
        return originalClear(handle);
    };
    return {
        liveWithDelay: (ms) => [...live.values()].filter((delay) => delay === ms).length,
        restore: () => {
            globalThis.setTimeout = originalSet;
            globalThis.clearTimeout = originalClear;
        },
    };
}

/** 応答しない（SYN に SYN_ACK を返さない）ルーティング層。相手が存在しない状態を模す。 */
function silentRouting() {
    const sent = [];
    return {
        sent,
        sendPacket: async (packet) => {
            sent.push(packet);
        },
        setTransportLayer: () => {},
    };
}

async function createWebRTCNode(nodeId, url, logger, pcs) {
    const signaling = new SignalingAdapterHub({ url, nodeId, pollIntervalMs: 20, logger });
    const channel = new NodeWebRTCChannel(signaling, {
        createPeerConnection: (config) => {
            const pc = new FakeRTCPeerConnection(config);
            pcs.push(pc);
            return pc;
        },
        connectTimeoutMs: 5000,
        logger,
    });
    const network = new WebTCPNetwork({
        channel,
        nodeId,
        signaling,
        logger,
        transport: { connectTimeoutMs: 5000 },
    });
    return { network, signaling, channel };
}

// ---------------------------------------------------------------
// TransportLayer.connect()
// ---------------------------------------------------------------

test('abort: a pre-aborted signal rejects TransportLayer.connect() without sending anything', async () => {
    const routing = silentRouting();
    const transport = new TransportLayer(A, routing, { connectTimeoutMs: 10_000 });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        transport.connect(B, 80, 5000, { signal: controller.signal }),
        (error) => isAbortError(error),
    );
    assert.equal(routing.sent.length, 0, 'no SYN is sent');
    assert.equal(transport.sessionManager.getStream(B, 5000, 80), undefined, 'no session is registered');
});

test('abort: aborting an in-flight TransportLayer.connect() rejects promptly and releases everything', async () => {
    const routing = silentRouting();
    const transport = new TransportLayer(A, routing, { connectTimeoutMs: 10_000 });
    const tracker = trackTimers();
    const controller = new AbortController();
    try {
        const started = Date.now();
        const pending = transport.connect(B, 80, 5000, { signal: controller.signal });
        await waitFor(() => routing.sent.length === 1, 1000);
        // 接続試行中（SYN 送信済み、SYN_ACK 待ち）に中断する
        assert.equal(tracker.liveWithDelay(10_000), 1, 'the connect timeout is armed while in flight');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'the abort listener is attached');
        assert.ok(transport.sessionManager.getStream(B, 5000, 80), 'the half-open session exists');

        controller.abort();
        await assert.rejects(pending, (error) => isAbortError(error));
        const elapsed = Date.now() - started;

        assert.ok(elapsed < 2000, `rejected promptly (took ${elapsed} ms, connect timeout is 10 s)`);
        assert.equal(tracker.liveWithDelay(10_000), 0, 'the connect timeout timer is cleared');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abort listener is removed');
        assert.equal(transport.sessionManager.getStream(B, 5000, 80), undefined, 'the session is removed');
        assert.equal(routing.sent.at(-1).flags, 'RST', 'the half-open connection is reset toward the peer');
    } finally {
        tracker.restore();
        transport.close();
    }
});

test('abort: aborting after the connection is established has no effect', async () => {
    const lo = new LoopbackNetwork();
    const channels = [lo.createChannel(A), lo.createChannel(B)];
    const [a, b] = channels.map(
        (channel, index) =>
            new WebTCPNetwork({
                channel,
                nodeId: index === 0 ? A : B,
                logger: recordingLogger().logger,
                transport: { stream: { timeWaitMs: 0 } },
            }),
    );
    await a.start();
    await b.start();
    try {
        b.listen(80, () => {});
        const controller = new AbortController();
        const stream = await a.connect(B, 80, undefined, { signal: controller.signal });
        assert.equal(stream.state, 'ESTABLISHED');
        controller.abort();
        assert.equal(stream.state, 'ESTABLISHED', 'an established stream is not torn down by a late abort');
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------
// WebRTC link layer (疑似 RTCPeerConnection + 実際のシグナリング経路)
// ---------------------------------------------------------------

test('abort: aborting a pending connectToPeer() destroys the negotiation, closes the peer, and does not warn', async () => {
    resetFakeWebRTC();
    const hub = await startHub();
    const log = recordingLogger();
    const pcs = [];
    // B はまだ起動していない（応答が来ない）ので、A の接続試行は確立前で止まる
    const a = await createWebRTCNode(A, hub.url, log.logger, pcs);
    await a.network.start();
    const tracker = trackTimers();
    const controller = new AbortController();
    try {
        const pending = a.network.connectToPeer(B, { signal: controller.signal });
        await waitFor(() => pcs.length === 1, 2000);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(a.channel.connectedPeers.get(B), false, 'the link is still negotiating');
        assert.equal(tracker.liveWithDelay(5000), 1, 'the WebRTC open timer is armed while in flight');

        controller.abort();
        await assert.rejects(pending, (error) => isAbortError(error));

        assert.equal(pcs[0].connectionState, 'closed', 'the RTCPeerConnection is closed');
        assert.equal(tracker.liveWithDelay(5000), 0, 'the WebRTC open timer is cleared');
        assert.equal(a.channel.connectedPeers.get(B) === true, false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'the abort listener is removed');
        assert.equal(log.calls.warn.length, 0, 'no warn on abort');
        assert.equal(log.calls.error.length, 0, 'no error on abort');
    } finally {
        tracker.restore();
        a.network.close();
        a.signaling.close?.();
        await hub.close();
    }
});

test('abort: a later connection to the same peer still succeeds after an aborted attempt', async () => {
    resetFakeWebRTC();
    const hub = await startHub();
    const log = recordingLogger();
    const pcsA = [];
    const pcsB = [];
    const a = await createWebRTCNode(A, hub.url, log.logger, pcsA);
    await a.network.start();
    try {
        const controller = new AbortController();
        const first = a.network.connectToPeer(B, { signal: controller.signal });
        await waitFor(() => pcsA.length === 1, 2000);
        controller.abort();
        await assert.rejects(first, (error) => isAbortError(error));

        // 後から B が起動する。以前の中断を引きずらず、新しいネゴシエーションで接続できること
        const b = await createWebRTCNode(B, hub.url, log.logger, pcsB);
        await b.network.start();
        try {
            await a.network.connectToPeer(B);
            assert.equal(a.channel.connectedPeers.get(B), true, 'the retry connects');
            await waitFor(() => b.channel.connectedPeers.get(A) === true, 5000);
        } finally {
            b.network.close();
            b.signaling.close?.();
        }
    } finally {
        a.network.close();
        a.signaling.close?.();
        await hub.close();
    }
});

test('abort: aborting one caller keeps the shared negotiation for the other caller', async () => {
    resetFakeWebRTC();
    const hub = await startHub();
    const log = recordingLogger();
    const pcsA = [];
    const pcsB = [];
    const a = await createWebRTCNode(A, hub.url, log.logger, pcsA);
    await a.network.start();
    try {
        const controller = new AbortController();
        const aborted = a.network.connectToPeer(B, { signal: controller.signal });
        const kept = a.network.connectToPeer(B);
        await waitFor(() => pcsA.length === 1, 2000);

        controller.abort();
        await assert.rejects(aborted, (error) => isAbortError(error));
        assert.equal(pcsA[0].connectionState !== 'closed', true, 'the shared negotiation is still alive');

        const b = await createWebRTCNode(B, hub.url, log.logger, pcsB);
        await b.network.start();
        try {
            await kept;
            assert.equal(a.channel.connectedPeers.get(B), true, 'the remaining caller gets the link');
        } finally {
            b.network.close();
            b.signaling.close?.();
        }
    } finally {
        a.network.close();
        a.signaling.close?.();
        await hub.close();
    }
});

test('abort: connect() passes the signal through to link establishment and reports AbortError', async () => {
    resetFakeWebRTC();
    const hub = await startHub();
    const log = recordingLogger();
    const pcsA = [];
    const a = await createWebRTCNode(A, hub.url, log.logger, pcsA);
    await a.network.start();
    try {
        const controller = new AbortController();
        const pending = a.network.connect(B, 80, undefined, { signal: controller.signal });
        await waitFor(() => pcsA.length === 1, 2000);
        controller.abort();
        await assert.rejects(pending, (error) => isAbortError(error));
        assert.equal(pcsA[0].connectionState, 'closed');
        assert.equal(log.calls.warn.length, 0);
    } finally {
        a.network.close();
        a.signaling.close?.();
        await hub.close();
    }
});

test('abort: connectURL() with an aborted signal rejects with AbortError before any connection', async () => {
    const lo = new LoopbackNetwork();
    const net = new WebTCPNetwork({
        channel: lo.createChannel(A),
        nodeId: A,
        logger: recordingLogger().logger,
    });
    await net.start();
    try {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            net.connectURL(`webtcp://${B}:80/`, { signal: controller.signal }),
            (error) => isAbortError(error),
        );
    } finally {
        net.close();
    }
});

test('abort: default behavior without a signal is unchanged (connect works)', async () => {
    const lo = new LoopbackNetwork();
    const [ca, cb] = [lo.createChannel(A), lo.createChannel(B)];
    const a = new WebTCPNetwork({ channel: ca, nodeId: A, logger: recordingLogger().logger });
    const b = new WebTCPNetwork({ channel: cb, nodeId: B, logger: recordingLogger().logger });
    await a.start();
    await b.start();
    try {
        b.listen(81, () => {});
        const stream = await a.connect(B, 81);
        assert.equal(stream.state, 'ESTABLISHED');
    } finally {
        a.close();
        b.close();
    }
});
