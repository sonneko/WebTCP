import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    RttEstimator,
    WebTCPNetwork,
    decodeSackBlocks,
    encodeSackBlocks,
    noopLogger,
    seqAdd,
    seqDiff,
    seqGt,
    seqLt,
} from '../dist/index.js';
import { LoopbackNetwork, decode, waitFor } from './helpers/loopback.mjs';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

/**
 * パケット遅延・選択的ドロップ・順序入れ替えを注入できるテスト用チャネルラッパー。
 */
function createImpairedLoopback() {
    const loopback = new LoopbackNetwork();
    const serializer = new BinaryPacketSerializer();
    const hooks = new Map(); // fromNodeId -> (packet, rawData) => 'deliver' | 'drop' | { delayMs }

    const createChannel = (nodeId) => {
        const base = loopback.createChannel(nodeId);
        const origSend = base.send.bind(base);
        base.send = async (targetId, data) => {
            const hook = hooks.get(nodeId);
            if (hook) {
                const packet = serializer.deserialize(data);
                const decision = hook(packet, data);
                if (decision === 'drop') {
                    return;
                }
                if (decision && typeof decision === 'object' && decision.delayMs > 0) {
                    setTimeout(() => {
                        void origSend(targetId, data).catch(() => {});
                    }, decision.delayMs);
                    return;
                }
            }
            return origSend(targetId, data);
        };
        return base;
    };

    return { loopback, createChannel, hooks };
}

test('tcp: RFC 1982 mod 2^32 sequence arithmetic & SACK codec', () => {
    assert.equal(seqAdd(0xffffffff, 1), 0);
    assert.equal(seqAdd(0xfffffff0, 32), 16);
    assert.equal(seqDiff(0, 0xffffffff), 1);
    assert.equal(seqDiff(0xffffffff, 0), -1);
    assert.equal(seqGt(5, 0xfffffffb), true);
    assert.equal(seqLt(0xfffffffb, 5), true);

    const blocks = [
        { leftEdge: 1000, rightEdge: 2000 },
        { leftEdge: 0xfffffff0, rightEdge: 0x00000020 },
    ];
    const encoded = encodeSackBlocks(blocks);
    assert.equal(encoded.byteLength, 2 + blocks.length * 8);
    assert.deepEqual(decodeSackBlocks(encoded), blocks);
    assert.deepEqual(decodeSackBlocks(new Uint8Array(0)), []);
});

test('tcp: RttEstimator follows RFC 6298 and exponential backoff', () => {
    const est = new RttEstimator({ initialRtoMs: 1000, minRtoMs: 200, maxRtoMs: 10_000 });
    assert.equal(est.getRtoMs(), 1000);
    assert.equal(est.getSrttMs(), null);

    // 初回サンプル: R = 100 -> SRTT = 100, RTTVAR = 50 -> RTO = 100 + max(50, 200) = 300
    est.recordSample(100);
    assert.equal(est.getSrttMs(), 100);
    assert.equal(est.getRttvarMs(), 50);
    assert.equal(est.getRtoMs(), 300);

    // 安定したサンプルが続くと RTO は下限（200ms）付近まで収束する
    for (let i = 0; i < 20; i += 1) {
        est.recordSample(40);
    }
    assert.ok(est.getSrttMs() < 50);
    assert.equal(est.getRtoMs(), 200);

    // タイムアウト時の指数バックオフ
    est.backoff();
    assert.equal(est.getRtoMs(), 400);
    est.backoff();
    assert.equal(est.getRtoMs(), 800);
});

test('tcp: randomized ISN and 32-bit sequence wrap-around across 0xFFFFFFFF -> 0', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { initialSeqNum: 0xfffffff0, timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { initialSeqNum: 0xfffffffa, timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        const received = [];
        b.listen(8080, (stream) => {
            stream.on('data', (chunk) => {
                received.push(chunk);
                void stream.send(chunk);
            });
            stream.on('end', () => stream.end());
        });

        const client = await a.connect(NODE_B, 8080);
        const payload = new Uint8Array(128);
        for (let i = 0; i < payload.length; i += 1) payload[i] = i;

        const echoedPromise = client.readExact(payload.length);
        await client.send(payload);
        const echoed = await echoedPromise;

        assert.deepEqual([...echoed], [...payload]);
        // シーケンス番号が 0xFFFFFFFF をまたいでラップアラウンドしている
        assert.ok(client.getStats().nextSendSeqNum < 1000);

        client.end();
        await waitFor(
            () =>
                a.transportLayer.sessionManager.size() === 0 &&
                b.transportLayer.sessionManager.size() === 0,
        );
    } finally {
        a.close();
        b.close();
    }

    // ランダム ISN が固定 0 ではないこと（複数ストリームで異なる値が選ばれる）
    const loopback2 = new LoopbackNetwork();
    const n1 = new WebTCPNetwork({
        channel: loopback2.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    const n2 = new WebTCPNetwork({
        channel: loopback2.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    await Promise.all([n1.start(), n2.start()]);
    try {
        n2.listen(8080, (s) => s.on('end', () => s.end()));
        const s1 = await n1.connect(NODE_B, 8080);
        const s2 = await n1.connect(NODE_B, 8080);
        assert.notEqual(s1.initialSendSeqNum, s2.initialSendSeqNum);
        s1.end();
        s2.end();
    } finally {
        n1.close();
        n2.close();
    }
});

test('tcp: auto-segmentation & reassembly for payloads > 60 KiB (160 KiB binary)', async () => {
    const { createChannel, hooks } = createImpairedLoopback();
    const observedSegmentSizes = [];

    hooks.set(NODE_A, (packet) => {
        if (packet.flags === 'DATA') {
            observedSegmentSizes.push(packet.payload.byteLength);
        }
        return 'deliver';
    });

    const a = new WebTCPNetwork({
        channel: createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { mss: 16 * 1024, timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { mss: 16 * 1024, timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        const totalSize = 160 * 1024 + 321; // > 60 KiB、MSS の整数倍ではない端数あり
        const expected = new Uint8Array(totalSize);
        for (let i = 0; i < totalSize; i += 1) {
            expected[i] = (i * 31 + 7) & 0xff;
        }

        let serverReadPromise = null;
        b.listen(8080, (stream) => {
            serverReadPromise = stream.readExact(totalSize);
            stream.on('end', () => stream.end());
        });

        const client = await a.connect(NODE_B, 8080);
        await client.send(expected);

        await waitFor(() => serverReadPromise !== null);
        const received = await serverReadPromise;

        assert.equal(received.byteLength, totalSize);
        assert.deepEqual(received, expected);

        // すべての DATA セグメントが MSS (16 KiB) 以下に分割されている
        assert.ok(observedSegmentSizes.length >= 11);
        assert.ok(observedSegmentSizes.every((size) => size <= 16 * 1024));

        // Slow Start により cwnd が初期値（4 * MSS = 64 KiB）から成長している
        assert.ok(client.getStats().cwndBytes > 4 * 16 * 1024);

        client.end();
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

test('tcp: byte-stream partial reading via read(), readableLength, readable, and readExact()', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        let serverStream = null;
        let readableEvents = 0;
        b.listen(8080, (stream) => {
            serverStream = stream;
            stream.on('readable', () => {
                readableEvents += 1;
            });
            stream.on('end', () => stream.end());
        });

        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        // 2 回に分けて送信したデータから任意バイト数ずつ部分読み取りする
        await client.send('Hello, ');
        await client.send('WebTCP byte stream!');

        await waitFor(() => serverStream.readableLength === 26);
        assert.ok(readableEvents >= 1);

        assert.equal(decode(serverStream.read(5)), 'Hello');
        assert.equal(serverStream.readableLength, 21);
        assert.equal(decode(serverStream.read(2)), ', ');
        assert.equal(decode(serverStream.read(6)), 'WebTCP');
        assert.equal(decode(serverStream.read()), ' byte stream!');
        assert.equal(serverStream.read(), null);

        // 複数セグメントをまたぐ readExact()
        const exactPromise = serverStream.readExact(10);
        await client.send('1234');
        await client.send('567');
        await client.send('890XYZ');
        assert.equal(decode(await exactPromise), '1234567890');
        assert.equal(decode(serverStream.read()), 'XYZ');

        client.end();
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

test('tcp: fast retransmit on 3 duplicate ACKs with SACK (skips SACKed segments, no RTO wait)', async () => {
    const { createChannel, hooks } = createImpairedLoopback();

    let dataPacketsSeen = 0;
    let droppedSeq = null;
    const retransmittedSeqs = [];

    hooks.set(NODE_A, (packet) => {
        if (packet.flags === 'DATA') {
            dataPacketsSeen += 1;
            // 2番目のセグメントだけを初回のみドロップする
            if (dataPacketsSeen === 2 && droppedSeq === null) {
                droppedSeq = packet.seqNum;
                return 'drop';
            }
            if (droppedSeq !== null && packet.seqNum === droppedSeq) {
                retransmittedSeqs.push(packet.seqNum);
            }
        }
        return 'deliver';
    });

    const a = new WebTCPNetwork({
        channel: createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: {
            stream: {
                mss: 1000,
                initialCwndBytes: 10_000, // 6 セグメントを同時に in-flight にする
                initialRtoMs: 10_000, // RTO が非常に長くても Fast Retransmit で即復旧する
                minRtoMs: 5000,
                timeWaitMs: 0,
            },
        },
    });
    const b = new WebTCPNetwork({
        channel: createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { mss: 1000, timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        const totalSize = 6000;
        const payload = new Uint8Array(totalSize);
        for (let i = 0; i < totalSize; i += 1) payload[i] = i & 0xff;

        let serverStream = null;
        let readPromise = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
            readPromise = stream.readExact(totalSize);
            stream.on('end', () => stream.end());
        });

        const client = await a.connect(NODE_B, 8080);
        const startTime = Date.now();
        await client.send(payload);

        await waitFor(() => readPromise !== null);
        const received = await readPromise;
        const elapsedMs = Date.now() - startTime;

        assert.deepEqual(received, payload);
        // RTO (10 秒) を待たずに Fast Retransmit で高速復旧している
        assert.ok(elapsedMs < 2000, `Expected fast recovery, took ${elapsedMs}ms`);

        const clientStats = client.getStats();
        const serverStats = serverStream.getStats();
        assert.ok(clientStats.fastRetransmits >= 1, 'fastRetransmits should be >= 1');
        assert.ok(serverStats.sackBlocksSent >= 3, 'receiver should send SACK blocks');
        assert.ok(clientStats.sackBlocksReceived >= 3, 'sender should receive SACK blocks');
        assert.equal(retransmittedSeqs.length, 1, 'only the single dropped segment should be retransmitted');
        // Fast Recovery により ssthresh が縮小している
        assert.ok(clientStats.ssthreshBytes < 1024 * 1024);

        client.end();
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

test('tcp: RTO timeout triggers retransmission, cwnd collapse, and backoff', async () => {
    const { createChannel, hooks } = createImpairedLoopback();

    let droppedOnce = false;
    hooks.set(NODE_A, (packet) => {
        if (packet.flags === 'DATA' && !droppedOnce) {
            droppedOnce = true;
            return 'drop';
        }
        return 'deliver';
    });

    const a = new WebTCPNetwork({
        channel: createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: {
            stream: {
                mss: 512,
                initialCwndBytes: 4096,
                initialRtoMs: 120,
                minRtoMs: 80,
                maxRtoMs: 5000,
                timeWaitMs: 0,
            },
        },
    });
    const b = new WebTCPNetwork({
        channel: createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { mss: 512, timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        let serverData = null;
        b.listen(8080, (stream) => {
            stream.on('data', (chunk) => {
                serverData = decode(chunk);
            });
            stream.on('end', () => stream.end());
        });

        const client = await a.connect(NODE_B, 8080);
        // 1 セグメントのみ送信（重複 ACK が発生しないため RTO タイムアウトで再送される）
        await client.send('only-one-segment');

        await waitFor(() => serverData === 'only-one-segment', { timeoutMs: 3000 });
        const stats = client.getStats();
        assert.ok(stats.retransmissions >= 1);
        assert.equal(stats.fastRetransmits, 0);
        // RTO タイムアウトにより cwnd が一時的に 1 MSS まで縮小し、その後の ACK で回復し始める
        assert.ok(stats.cwndBytes < 4096);

        client.end();
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

test('tcp: proper half-close allows server in CLOSE_WAIT to keep sending to client in FIN_WAIT_2', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 50 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 50 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        let serverStream = null;
        const serverChunks = [];
        let serverEndFired = false;

        b.listen(8080, (stream) => {
            serverStream = stream;
            stream.on('data', (chunk) => serverChunks.push(decode(chunk)));
            stream.on('end', () => {
                serverEndFired = true;
            });
        });

        const client = await a.connect(NODE_B, 8080);
        const clientChunks = [];
        let clientEndFired = false;
        let clientClosed = false;
        client.on('data', (chunk) => clientChunks.push(decode(chunk)));
        client.on('end', () => {
            clientEndFired = true;
        });
        client.on('close', () => {
            clientClosed = true;
        });

        // クライアントがリクエストを送って送信側だけ half-close する
        await client.send('GET /status');
        client.end();

        // クライアントは send 不可、サーバーは CLOSE_WAIT で受信完了
        await assert.rejects(() => client.send('after-end'), /Cannot send data/);
        await waitFor(() => serverEndFired && serverStream.state === 'CLOSE_WAIT');
        await waitFor(() => client.state === 'FIN_WAIT_2');
        assert.equal(serverChunks.join(''), 'GET /status');

        // サーバーは CLOSE_WAIT のままレスポンスを返せる！
        await serverStream.send('200 OK - response after half-close');
        await waitFor(() => clientChunks.join('') === '200 OK - response after half-close');
        assert.equal(clientEndFired, false);
        assert.equal(clientClosed, false);

        // サーバーも end() すると双方 CLOSED へ
        serverStream.end();
        await waitFor(
            () =>
                clientEndFired &&
                clientClosed &&
                serverStream.state === 'CLOSED' &&
                a.transportLayer.sessionManager.size() === 0 &&
                b.transportLayer.sessionManager.size() === 0,
        );
    } finally {
        a.close();
        b.close();
    }
});

test('tcp: allowHalfOpen=false auto-closes server on client FIN', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { allowHalfOpen: false, timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { allowHalfOpen: false, timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        b.listen(8080, () => {
            // end ハンドラを書かなくても自動でクローズする
        });

        const client = await a.connect(NODE_B, 8080);
        client.close();

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

test('tcp: out-of-order FIN is deferred until missing DATA arrives', async () => {
    const { createChannel, hooks } = createImpairedLoopback();

    let delayedFirstData = false;
    hooks.set(NODE_A, (packet) => {
        if (packet.flags === 'DATA' && !delayedFirstData) {
            delayedFirstData = true;
            // DATA を遅らせて FIN を先に到着させる
            return { delayMs: 80 };
        }
        return 'deliver';
    });

    const a = new WebTCPNetwork({
        channel: createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0 } },
    });
    await Promise.all([a.start(), b.start()]);

    try {
        const events = [];
        b.listen(8080, (stream) => {
            stream.on('data', (chunk) => events.push(`data:${decode(chunk)}`));
            stream.on('end', () => {
                events.push('end');
                stream.end();
            });
        });

        const client = await a.connect(NODE_B, 8080);
        await client.send('must-arrive-before-end');
        client.end();

        await waitFor(
            () =>
                events.includes('end') &&
                a.transportLayer.sessionManager.size() === 0 &&
                b.transportLayer.sessionManager.size() === 0,
        );
        assert.deepEqual(events, ['data:must-arrive-before-end', 'end']);
    } finally {
        a.close();
        b.close();
    }
});
