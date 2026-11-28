import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    KeyDirectory,
    NodeKeyManager,
    WebTCPNetwork,
    createEd25519Verifier,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork, decode, waitFor } from './helpers/loopback.mjs';

/**
 * #48: セッション境界を跨ぐリプレイ（捕獲した v2 パケットの別セッションへの注入）。
 *
 * 手順:
 *   1. 署名付きの 2 ノード（A が接続側、B が待ち受け側）で 1 セッションを張り、A→B の
 *      リンク層入力（署名済みの生バイト列）をすべて捕獲する（SYN, ACK, DATA, FIN）。
 *   2. セッションを閉じた後、捕獲したバイト列を同じ順序で B のリンク層へ注入する。
 *      これはリンク層の外で記録した有効な署名付きパケットの再生に当たる。
 *   3. 再生で B のハンドラが呼ばれるか、データが二重に届くかを数える。
 *   4. 再生の後も、新しい正規のセッションは従来どおり届くことを確かめる。
 *
 * 期待値（強化後）: 再生は拒否され、ハンドラは正規のセッションの分だけ呼ばれる。
 * 強化前の挙動は設計 §3.48 の検証計画に記録している。
 */

const serializer = new BinaryPacketSerializer();

async function createSignedPair() {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    const keyDirectory = new KeyDirectory();
    await keyDirectory.addPublicKey(keysA.nodeId, keysA.publicKey);
    await keyDirectory.addPublicKey(keysB.nodeId, keysB.publicKey);
    const { verifier: verifierA } = createEd25519Verifier({ keyManager: keysA, keyDirectory });
    const { verifier: verifierB } = createEd25519Verifier({ keyManager: keysB, keyDirectory });

    const chA = loopback.createChannel(keysA.nodeId);
    const chB = loopback.createChannel(keysB.nodeId);
    const transport = { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } };

    const a = new WebTCPNetwork({
        channel: chA,
        nodeId: keysA.nodeId,
        keyManager: keysA,
        keyDirectory,
        verifier: verifierA,
        logger: noopLogger,
        transport,
    });
    const b = new WebTCPNetwork({
        channel: chB,
        nodeId: keysB.nodeId,
        keyManager: keysB,
        keyDirectory,
        verifier: verifierB,
        logger: noopLogger,
        transport,
    });
    await a.start();
    await b.start();
    return { a, b, chA, chB };
}

/** B のリンク層へ入ってくる、A 発のデータを捕獲する。 */
function recordInbound(chB, fromId) {
    const captured = [];
    const state = { recording: true };
    const originalEmit = chB.emit.bind(chB);
    chB.emit = (event, ...args) => {
        if (event === 'data' && args[0] === fromId && state.recording) {
            captured.push(new Uint8Array(args[1]));
        }
        return originalEmit(event, ...args);
    };
    return { captured, state };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

test('syn-replay: a captured signed session replayed into another session is rejected (#48)', async () => {
    const { a, b, chB } = await createSignedPair();
    const received = [];
    let handlerCalls = 0;

    try {
        b.listen(8080, (stream) => {
            handlerCalls += 1;
            stream.on('data', (data) => received.push(decode(data)));
            stream.on('end', () => stream.end());
        });

        const { captured, state } = recordInbound(chB, a.localNodeId);

        const stream = await a.connect(b.localNodeId, 8080);
        await stream.send('captured-once');
        await waitFor(() => received.length === 1, { timeoutMs: 3000 });
        const closed = new Promise((resolve) => stream.once('close', resolve));
        stream.end();
        await closed;
        await settle();

        state.recording = false;
        assert.equal(handlerCalls, 1, 'the legitimate session should invoke the handler once');
        assert.ok(captured.length >= 3, `expected SYN/ACK/DATA captured (got ${captured.length})`);
        const flags = captured.map((bytes) => serializer.deserialize(bytes).flags);
        assert.ok(flags.includes('SYN'), 'capture must include the SYN');

        // リンク層の外で記録したパケットを、同じ順序で注入する（再生）。
        for (const bytes of captured) {
            chB.emit('data', a.localNodeId, new Uint8Array(bytes));
        }
        await settle(300);

        assert.equal(handlerCalls, 1, 'replayed session must not invoke the handler again');
        assert.deepEqual(received, ['captured-once'], 'replayed data must not be delivered twice');

        // 再生の後も、正規の新しいセッションは届く。
        const next = await a.connect(b.localNodeId, 8080);
        await next.send('fresh');
        await waitFor(() => received.includes('fresh'), { timeoutMs: 3000 });
        assert.equal(handlerCalls, 2);
        assert.deepEqual(received, ['captured-once', 'fresh']);
        next.destroy?.();
    } finally {
        a.close();
        b.close();
    }
});
