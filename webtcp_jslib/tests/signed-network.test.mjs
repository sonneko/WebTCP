import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    Ed25519PacketVerifier,
    KeyDirectory,
    NodeKeyManager,
    WebTCPNetwork,
    createEd25519Verifier,
    encodePublicKey,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork, decode, waitFor } from './helpers/loopback.mjs';

/**
 * Ed25519 署名付きネットワーク（プロトコル v2）の統合テスト。
 *
 * NodeKeyManager で生成した鍵（NodeId = 公開鍵の指紋）を使い、
 * 2 ノード / 3 ノードの通信が署名検証を通過することを確認する。
 */

async function createSignedNetwork(loopback, keys, options = {}) {
    const channel = loopback.createChannel(keys.nodeId);
    const keyDirectory = new KeyDirectory();
    const { verifier } = createEd25519Verifier({ keyManager: keys, keyDirectory });
    const network = new WebTCPNetwork({
        channel,
        nodeId: keys.nodeId,
        keyManager: keys,
        keyDirectory,
        verifier,
        logger: noopLogger,
        transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
        ...options,
    });
    return { network, keyDirectory, channel };
}

test('signed-network: two signed nodes exchange data end-to-end (protocol v2)', async () => {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    // 公開鍵はシグナリング時に交換される想定。ここでは事前に登録する。
    const keyDirectory = new KeyDirectory();
    await keyDirectory.addPublicKey(keysA.nodeId, keysA.publicKey);
    await keyDirectory.addPublicKey(keysB.nodeId, keysB.publicKey);

    const { verifier: verifierA } = createEd25519Verifier({
        keyManager: keysA,
        keyDirectory,
    });
    const { verifier: verifierB } = createEd25519Verifier({
        keyManager: keysB,
        keyDirectory,
    });

    const a = new WebTCPNetwork({
        channel: loopback.createChannel(keysA.nodeId),
        nodeId: keysA.nodeId,
        keyManager: keysA,
        keyDirectory,
        verifier: verifierA,
        logger: noopLogger,
        transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(keysB.nodeId),
        nodeId: keysB.nodeId,
        keyManager: keysB,
        keyDirectory,
        verifier: verifierB,
        logger: noopLogger,
        transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
    });

    await a.start();
    await b.start();

    try {
        // NodeId は鍵指紋である
        assert.match(a.localNodeId, /^[0-9a-f]{32}$/);
        assert.equal(a.localNodeId, keysA.nodeId);
        assert.equal(a.verifier, verifierA);

        const received = [];
        b.listen(8080, (stream) => {
            stream.on('data', (data) => {
                const text = decode(data);
                received.push(text);
                void stream.send(`echo:${text}`);
            });
            stream.on('end', () => stream.end());
        });

        const stream = await a.connect(b.localNodeId, 8080);
        assert.equal(stream.state, 'ESTABLISHED');

        await stream.send('signed hello');
        await waitFor(() => received.length > 0, { timeoutMs: 3000 });
        assert.equal(received[0], 'signed hello');

        const reply = await stream.readExact('echo:signed hello'.length);
        assert.equal(decode(reply), 'echo:signed hello');

        const closed = new Promise((resolve) => stream.once('close', resolve));
        stream.end();
        await closed;
    } finally {
        a.close();
        b.close();
    }
});

test('signed-network: requires signatures (unsigned v1 packets are dropped)', async () => {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    const keyDirectory = new KeyDirectory();
    await keyDirectory.addPublicKey(keysA.nodeId, keysA.publicKey);
    await keyDirectory.addPublicKey(keysB.nodeId, keysB.publicKey);
    const { verifier: verifierA } = createEd25519Verifier({ keyManager: keysA, keyDirectory });
    const { verifier: verifierB } = createEd25519Verifier({ keyManager: keysB, keyDirectory });

    const a = new WebTCPNetwork({
        channel: loopback.createChannel(keysA.nodeId),
        nodeId: keysA.nodeId,
        keyManager: keysA,
        keyDirectory,
        verifier: verifierA,
        logger: noopLogger,
    });
    // B は意図的に署名なし（v1）で動かす
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(keysB.nodeId),
        nodeId: keysB.nodeId,
        logger: noopLogger,
        transport: { connectTimeoutMs: 500, stream: { timeWaitMs: 0 } },
    });

    await a.start();
    await b.start();

    try {
        // B の着信は v1 のため破棄され、ハンドシェイクが完了しない
        let handlerCalled = false;
        b.listen(8080, () => {
            handlerCalled = true;
        });

        await assert.rejects(
            () => a.connect(b.localNodeId, 8080),
            /timed out|timeout/i,
        );
        assert.equal(handlerCalled, false);
    } finally {
        a.close();
        b.close();
    }
});

test('signed-network: tampered packets injected into a link are dropped', async () => {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    // 公開鍵は事前配布済み（本番では RT_UPDATE / シグナリングで学習）
    const dirA = new KeyDirectory();
    const dirB = new KeyDirectory();
    for (const directory of [dirA, dirB]) {
        await directory.addPublicKey(keysA.nodeId, keysA.publicKey);
        await directory.addPublicKey(keysB.nodeId, keysB.publicKey);
    }
    const { verifier: verifierA } = createEd25519Verifier({ keyManager: keysA, keyDirectory: dirA });
    const { verifier: verifierB } = createEd25519Verifier({ keyManager: keysB, keyDirectory: dirB });

    // A の Channel は DATA のペイロードだけを差し替えて送信する（攻撃者を模す）
    const channelA = loopback.createChannel(keysA.nodeId);
    const originalSend = channelA.send.bind(channelA);
    const serializer = new BinaryPacketSerializer();
    let tamperedCount = 0;
    channelA.send = async (targetId, data) => {
        const packet = serializer.deserialize(data);
        if (packet.flags === 'DATA' && packet.payload.byteLength >= 8) {
            tamperedCount += 1;
            // 署名長・バージョン・ペイロード長を保ったままペイロードだけを差し替える
            const modified = serializer.serialize(packet);
            modified.set(
                new TextEncoder().encode('tampered!!'),
                modified.byteLength - packet.payload.byteLength,
            );
            await originalSend(targetId, modified);
            return;
        }
        await originalSend(targetId, data);
    };

    const a = new WebTCPNetwork({
        channel: channelA,
        nodeId: keysA.nodeId,
        keyManager: keysA,
        keyDirectory: dirA,
        verifier: verifierA,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(keysB.nodeId),
        nodeId: keysB.nodeId,
        keyManager: keysB,
        keyDirectory: dirB,
        verifier: verifierB,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
    await a.start();
    await b.start();

    try {
        const received = [];
        b.listen(8080, (stream) => {
            stream.on('data', (data) => received.push(decode(data)));
        });

        const stream = await a.connect(b.localNodeId, 8080);
        stream.send('original').catch(() => {});
        await waitFor(() => tamperedCount > 0, { timeoutMs: 2000 });

        // 改ざんされた DATA は署名検証で落ちるため、アプリには届かない
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(tamperedCount > 0, 'the attacker injected at least one packet');
        assert.deepEqual(received, [], 'tampered payload must not reach the application');
        stream.destroy();
    } finally {
        a.close();
        b.close();
    }
});

test('signed-network: three-node chain validates signatures on every hop', async () => {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const keysC = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    const nodes = [];
    for (const keys of [keysA, keysB, keysC]) {
        const channel = loopback.createChannel(keys.nodeId);
        const keyDirectory = new KeyDirectory();
        const { verifier } = createEd25519Verifier({ keyManager: keys, keyDirectory });
        const network = new WebTCPNetwork({
            channel,
            nodeId: keys.nodeId,
            keyManager: keys,
            keyDirectory,
            verifier,
            logger: noopLogger,
            transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
        });
        nodes.push({ network, channel, keyDirectory });
    }
    const [a, b, c] = nodes;

    // 事前に全ノードの公開鍵を配布する（本番では RT_UPDATE / シグナリングで学習）
    for (const entry of nodes) {
        for (const keys of [keysA, keysB, keysC]) {
            await entry.keyDirectory.addPublicKey(keys.nodeId, keys.publicKey);
        }
    }

    await Promise.all(nodes.map((entry) => entry.network.start()));

    try {
        await a.network.connectToPeer(b.network.localNodeId);
        await b.network.connectToPeer(c.network.localNodeId);

        await waitFor(
            () => a.network.getRoutingTable().getEntry(c.network.localNodeId)?.nextHopId,
            { timeoutMs: 5000 },
        );

        let received = null;
        c.network.listen(9000, (stream) => {
            stream.on('data', (data) => {
                received = decode(data);
                void stream.send(`pong:${received}`);
            });
            stream.on('end', () => stream.end());
        });

        const stream = await a.network.connect(c.network.localNodeId, 9000, 51000);
        let reply = null;
        stream.on('data', (data) => {
            reply = decode(data);
        });

        await stream.send('ping');
        await waitFor(() => received === 'ping' && reply === 'pong:ping', { timeoutMs: 5000 });

        assert.equal(a.network.getRoutingTable().getEntry(c.network.localNodeId)?.cost, 2);
        stream.close();
    } finally {
        for (const entry of nodes) entry.network.close();
    }
});

test('signed-network: RT_UPDATE distributes public keys to neighbours', async () => {
    const keysA = await NodeKeyManager.create();
    const keysB = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();

    const dirA = new KeyDirectory();
    const dirB = new KeyDirectory();
    const { verifier: verifierA } = createEd25519Verifier({
        keyManager: keysA,
        keyDirectory: dirA,
    });
    const { verifier: verifierB } = createEd25519Verifier({
        keyManager: keysB,
        keyDirectory: dirB,
    });

    const a = new WebTCPNetwork({
        channel: loopback.createChannel(keysA.nodeId),
        nodeId: keysA.nodeId,
        keyManager: keysA,
        keyDirectory: dirA,
        verifier: verifierA,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(keysB.nodeId),
        nodeId: keysB.nodeId,
        keyManager: keysB,
        keyDirectory: dirB,
        verifier: verifierB,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
    });
    await a.start();
    await b.start();

    try {
        await a.connectToPeer(b.localNodeId);
        // 相互に公開鍵を学習する（RT_UPDATE に同梱された公開鍵）
        await waitFor(() => dirA.get(keysB.nodeId) !== undefined, { timeoutMs: 5000 });
        await waitFor(() => dirB.get(keysA.nodeId) !== undefined, { timeoutMs: 5000 });

        assert.equal(dirA.exportPublicKey(keysB.nodeId), encodePublicKey(keysB.publicKey));
        assert.equal(dirB.exportPublicKey(keysA.nodeId), encodePublicKey(keysA.publicKey));
    } finally {
        a.close();
        b.close();
    }
});

test('signed-network: rejects a mismatched nodeId/keyManager combination', async () => {
    const keys = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();
    const channel = loopback.createChannel('f'.repeat(32));

    assert.throws(
        () =>
            new WebTCPNetwork({
                channel,
                nodeId: 'f'.repeat(32),
                keyManager: keys,
                logger: noopLogger,
            }),
        /does not match the Ed25519 key fingerprint/,
    );
});

test('signed-network: Ed25519PacketVerifier can be injected directly', async () => {
    const keys = await NodeKeyManager.create();
    const loopback = new LoopbackNetwork();
    const keyDirectory = new KeyDirectory();
    const verifier = new Ed25519PacketVerifier({ keyManager: keys, keyDirectory });

    const network = new WebTCPNetwork({
        channel: loopback.createChannel(keys.nodeId),
        nodeId: keys.nodeId,
        verifier,
        keyDirectory,
        logger: noopLogger,
    });
    assert.equal(network.localNodeId, keys.nodeId);
    // ディレクトリを共有した同等の検証器で構成される
    assert.equal(network.verifier.hasKeyDirectory, true);
    network.close();
});
