import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BrowserKeyManager,
    BinaryPacketSerializer,
    Ed25519PacketVerifier,
    KeyDirectory,
    WEBTCP_PROTOCOL_VERSION,
    createEd25519Verifier,
    decodePublicKey,
    deriveNodeId,
    encodePublicKey,
    isBrowserEd25519Supported,
} from '../dist/index.js';
import { FakeIndexedDB } from './helpers/fake-indexeddb.mjs';

/**
 * `BrowserKeyManager`（Web Crypto + IndexedDB）のテスト。
 *
 * Node.js 22 の Web Crypto は Ed25519 をサポートするため、
 * IndexedDB だけをテスト用シムに差し替えて検証できる。
 */

const encoder = new TextEncoder();

function createPacket(senderId, overrides = {}) {
    return {
        senderId,
        destinationId: 'b'.repeat(32),
        ttl: 64,
        signature: new Uint8Array(0),
        sourcePort: 50001,
        destinationPort: 8080,
        flags: 'DATA',
        seqNum: 1,
        ackNum: 2,
        payload: encoder.encode('hello'),
        ...overrides,
    };
}

test('browser-keys: creates an Ed25519 identity and derives the NodeId', async () => {
    const manager = await BrowserKeyManager.open({ indexedDB: new FakeIndexedDB() });

    assert.match(manager.nodeId, /^[0-9a-f]{32}$/);
    assert.equal(manager.publicKey.byteLength, 32);
    assert.equal(await deriveNodeId(manager.publicKey), manager.nodeId);
    assert.equal(manager.isValid(), true);
});

test('browser-keys: persists a non-extractable private key in IndexedDB and reloads it', async () => {
    const factory = new FakeIndexedDB();
    const first = await BrowserKeyManager.open({
        indexedDB: factory,
        databaseName: 'webtcp-test',
    });

    const stored = factory.databases.get('webtcp-test').stores.get('identity').get('local');
    assert.ok(stored, 'identity record persisted');
    assert.equal(stored.privateKey.extractable, false, 'private key must not be extractable');

    // 生バイトへはエクスポートできない
    await assert.rejects(
        () => globalThis.crypto.subtle.exportKey('pkcs8', stored.privateKey),
        /InvalidAccessError|not extractable|extractable/i,
    );

    const second = await BrowserKeyManager.open({
        indexedDB: factory,
        databaseName: 'webtcp-test',
    });
    assert.equal(second.nodeId, first.nodeId, 'reuses the persisted identity');
    assert.deepEqual([...second.publicKey], [...first.publicKey]);

    // 復元した鍵でも署名でき、公開鍵で検証できる
    const signature = await second.sign(encoder.encode('hello'));
    assert.equal(signature.byteLength, 64);
    assert.equal(await first.verify(first.publicKey, encoder.encode('hello'), signature), true);
});

test('browser-keys: regenerate replaces the stored identity', async () => {
    const factory = new FakeIndexedDB();
    const first = await BrowserKeyManager.open({ indexedDB: factory });
    const regenerated = await BrowserKeyManager.regenerate({ indexedDB: factory });

    assert.notEqual(regenerated.nodeId, first.nodeId);
    assert.equal((await BrowserKeyManager.open({ indexedDB: factory })).nodeId, regenerated.nodeId);
});

test('browser-keys: clearPersistedIdentity forces a new key pair', async () => {
    const factory = new FakeIndexedDB();
    const first = await BrowserKeyManager.open({ indexedDB: factory });
    await first.clearPersistedIdentity();

    const second = await BrowserKeyManager.open({ indexedDB: factory });
    assert.notEqual(second.nodeId, first.nodeId);
});

test('browser-keys: works without IndexedDB (session-only identity)', async () => {
    const manager = await BrowserKeyManager.open({ indexedDB: null });
    assert.match(manager.nodeId, /^[0-9a-f]{32}$/);
    const signature = await manager.sign(encoder.encode('x'));
    assert.equal(await manager.verify(manager.publicKey, encoder.encode('x'), signature), true);
});

test('browser-keys: rejects invalid public keys and signatures on verify', async () => {
    const manager = await BrowserKeyManager.open({ indexedDB: null });
    const data = encoder.encode('payload');
    const signature = await manager.sign(data);

    assert.equal(await manager.verify(manager.publicKey, data, signature), true);
    assert.equal(await manager.verify(new Uint8Array(16), data, signature), false);
    assert.equal(await manager.verify(manager.publicKey, data, signature.subarray(0, 10)), false);
    assert.equal(
        await manager.verify(manager.publicKey, encoder.encode('tampered'), signature),
        false,
    );
});

test('browser-keys: signs and verifies packets through Ed25519PacketVerifier', async () => {
    const manager = await BrowserKeyManager.open({ indexedDB: new FakeIndexedDB() });
    const directory = new KeyDirectory();
    await directory.addPublicKey(manager.nodeId, manager.publicKey);

    const { verifier } = createEd25519Verifier({ keyManager: manager, keyDirectory: directory });
    const signed = await verifier.signPacket(createPacket(manager.nodeId));

    assert.equal(signed.signature.byteLength, 64);
    assert.equal(await verifier.verifyPacket(signed), true);

    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(signed);
    assert.equal(encoded[1], WEBTCP_PROTOCOL_VERSION, 'signed packets use protocol v2');
    assert.equal(await verifier.verifyBytes(serializer.deserialize(encoded), encoded), true);
});

test('browser-keys: public keys round-trip through Base64url', async () => {
    const manager = await BrowserKeyManager.open({ indexedDB: null });
    const encoded = encodePublicKey(manager.publicKey);
    assert.deepEqual([...decodePublicKey(encoded)], [...manager.publicKey]);
});

test('browser-keys: exposes a runtime capability probe', () => {
    // Node.js 22 には indexedDB が無いため false（ブラウザでは true になる）
    assert.equal(typeof isBrowserEd25519Supported(), 'boolean');
});

test('browser-keys: shared directory resolves peer keys for verification', async () => {
    const alice = await BrowserKeyManager.open({ indexedDB: null });
    const bob = await BrowserKeyManager.open({ indexedDB: null });

    const aliceDirectory = new KeyDirectory();
    const bobDirectory = new KeyDirectory();
    // 公開鍵はシグナリング / RT_UPDATE で交換済みという想定
    await aliceDirectory.addPublicKey(alice.nodeId, alice.publicKey);
    await aliceDirectory.addPublicKey(bob.nodeId, bob.publicKey);
    await bobDirectory.addPublicKey(bob.nodeId, bob.publicKey);

    const aliceVerifier = new Ed25519PacketVerifier({
        keyManager: alice,
        keyDirectory: aliceDirectory,
    });
    const bobVerifier = new Ed25519PacketVerifier({ keyManager: bob, keyDirectory: bobDirectory });

    const packet = await bobVerifier.signPacket(createPacket(bob.nodeId));
    // alice は bob の公開鍵をディレクトリから解決できる
    assert.equal(await aliceVerifier.verifyPacket(packet), true);

    // 未登録のノードは検証できない
    const stranger = new Ed25519PacketVerifier({
        keyManager: alice,
        keyDirectory: new KeyDirectory(),
        keyWaitTimeoutMs: 0,
    });
    assert.equal(await stranger.verifyPacket(packet), false);
});
