import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    NodeKeyManager, NodeIdCollisionError, KeyDirectory, WebTCPNetwork, noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork } from './helpers/loopback.mjs';

test('identity-persistence: NodeKeyManager.open creates 0600 PEM and reuses NodeId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webtcp-keys-'));
    const keyFile = join(dir, 'nested', 'identity.pem');
    try {
        const first = await NodeKeyManager.open({ keyFile });
        const mode = (await stat(keyFile)).mode & 0o777;
        assert.equal(mode, 0o600);
        assert.match(await readFile(keyFile, 'utf8'), /BEGIN PRIVATE KEY/);
        const second = await NodeKeyManager.open({ keyFile });
        assert.equal(second.nodeId, first.nodeId);
        assert.deepEqual([...second.publicKey], [...first.publicKey]);
        const sig = await second.sign(new TextEncoder().encode('reuse'));
        assert.equal(await first.verify(first.publicKey, new TextEncoder().encode('reuse'), sig), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('identity-persistence: expected NodeId mismatch raises NodeIdCollisionError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webtcp-keys-'));
    const keyFile = join(dir, 'identity.pem');
    try {
        const first = await NodeKeyManager.open({ keyFile });
        await assert.rejects(
            () => NodeKeyManager.open({ keyFile, nodeId: 'f'.repeat(32) }),
            (error) => error instanceof NodeIdCollisionError,
        );
        assert.equal((await NodeKeyManager.open({ keyFile, nodeId: first.nodeId })).nodeId, first.nodeId);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('identity-persistence: KeyDirectory.setPublicKey refuses conflicting keys', async () => {
    const a = await NodeKeyManager.create();
    const b = await NodeKeyManager.create();
    const directory = new KeyDirectory();
    directory.setPublicKey(a.nodeId, a.publicKey);
    assert.throws(() => directory.setPublicKey(a.nodeId, b.publicKey), NodeIdCollisionError);
    assert.deepEqual([...directory.get(a.nodeId)], [...a.publicKey]);
    assert.throws(() => directory.setPublicKey('bad', a.publicKey), /valid NodeId/);
});

test('identity-persistence: WebTCPNetwork detects local NodeId/key collision', async () => {
    const a = await NodeKeyManager.create();
    const b = await NodeKeyManager.create();
    const directory = new KeyDirectory();
    // setPublicKey は指紋検証済みの信頼済み同期 API なので、壊れたディレクトリを模せる。
    directory.setPublicKey(b.nodeId, a.publicKey);
    const hub = new LoopbackNetwork();
    assert.throws(
        () => new WebTCPNetwork({ channel: hub.createChannel(b.nodeId), keyManager: b, keyDirectory: directory, logger: noopLogger }),
        NodeIdCollisionError,
    );
});


test('identity-persistence: BrowserKeyManager.open verifies expectedNodeId and signing challenge', async () => {
    const { FakeIndexedDB } = await import('./helpers/fake-indexeddb.mjs');
    const { BrowserKeyManager } = await import('../dist/index.js');
    const factory = new FakeIndexedDB();
    const first = await BrowserKeyManager.open({ indexedDB: factory, databaseName: 'persist' });
    const restored = await BrowserKeyManager.open({ indexedDB: factory, databaseName: 'persist', expectedNodeId: first.nodeId });
    assert.equal(restored.nodeId, first.nodeId);
    await assert.rejects(
        () => BrowserKeyManager.open({ indexedDB: factory, databaseName: 'persist', expectedNodeId: 'f'.repeat(32) }),
        (error) => error instanceof NodeIdCollisionError,
    );

    // 保存レコードの秘密鍵だけを別鍵に差し替えると、署名チャレンジで検出して再生成する。
    const other = await BrowserKeyManager.open({ indexedDB: null });
    const stored = factory.databases.get('persist').stores.get('identity').get('local');
    const otherStored = new FakeIndexedDB();
    const otherManager = await BrowserKeyManager.open({ indexedDB: otherStored, databaseName: 'other' });
    const otherRecord = otherStored.databases.get('other').stores.get('identity').get('local');
    stored.privateKey = otherRecord.privateKey;
    const repaired = await BrowserKeyManager.open({ indexedDB: factory, databaseName: 'persist' });
    assert.notEqual(repaired.nodeId, first.nodeId);
    const data = new TextEncoder().encode('challenge');
    const sig = await repaired.sign(data);
    assert.equal(await repaired.verify(repaired.publicKey, data, sig), true);
    void other; void otherManager;
});
