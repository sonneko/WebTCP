import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    ED25519_PUBLIC_KEY_BYTES,
    ED25519_SIGNATURE_BYTES,
    Ed25519PacketVerifier,
    KeyDirectory,
    NodeKeyManager,
    WEBTCP_PROTOCOL_VERSION,
    WEBTCP_PROTOCOL_VERSION_V1,
    bytesToHex,
    createEd25519Verifier,
    decodeBase64Url,
    decodePublicKey,
    deriveNodeId,
    encodeBase64Url,
    encodePublicKey,
    hexToBytes,
    isValidNodeId,
    nodeIdMatchesPublicKey,
} from '../dist/index.js';

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

// =====================================================================
// NodeId の鍵指紋化
// =====================================================================

test('keys: NodeId is the first 16 bytes of SHA-256(raw Ed25519 public key)', async () => {
    const keys = await NodeKeyManager.create();
    const digest = new Uint8Array(
        await globalThis.crypto.subtle.digest('SHA-256', keys.publicKey),
    );
    const expected = bytesToHex(digest.subarray(0, 16));

    assert.equal(keys.nodeId, expected);
    assert.equal(keys.nodeId.length, 32);
    assert.match(keys.nodeId, /^[0-9a-f]{32}$/);
    assert.equal(await deriveNodeId(keys.publicKey), expected);
});

test('keys: NodeId derivation is deterministic and key-dependent', async () => {
    const a = await NodeKeyManager.create();
    const b = await NodeKeyManager.create();

    assert.equal(await deriveNodeId(a.publicKey), a.nodeId);
    assert.equal(await deriveNodeId(a.publicKey), a.nodeId);
    assert.notEqual(a.nodeId, b.nodeId);
    assert.ok(await nodeIdMatchesPublicKey(a.nodeId, a.publicKey));
    assert.equal(await nodeIdMatchesPublicKey(b.nodeId, a.publicKey), false);
    assert.equal(await nodeIdMatchesPublicKey('zzz', a.publicKey), false);
});

test('keys: deriveNodeId rejects malformed public keys', async () => {
    await assert.rejects(() => deriveNodeId(new Uint8Array(16)), /32 bytes/);
    await assert.rejects(() => deriveNodeId(new Uint8Array(33)), /32 bytes/);
});

test('keys: NodeKeyManager enforces the fingerprint on an explicit NodeId', async () => {
    const keys = await NodeKeyManager.create();
    const restored = await NodeKeyManager.create({
        privateKeyPem: keys.exportPrivateKeyPem(),
        nodeId: keys.nodeId,
    });
    assert.equal(restored.nodeId, keys.nodeId);
    assert.deepEqual([...restored.publicKey], [...keys.publicKey]);

    await assert.rejects(
        () =>
            NodeKeyManager.create({
                privateKeyPem: keys.exportPrivateKeyPem(),
                nodeId: 'f'.repeat(32),
            }),
        /does not match the Ed25519 public key fingerprint/,
    );
});

test('keys: hex and Base64url codecs round-trip', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    assert.equal(bytesToHex(bytes), '00017f80ff2a');
    assert.deepEqual([...hexToBytes('00017f80ff2a')], [...bytes]);
    assert.throws(() => hexToBytes('abc'), /invalid hex/);

    for (const sample of [
        new Uint8Array(0),
        new Uint8Array([0]),
        new Uint8Array([1, 2]),
        new Uint8Array([1, 2, 3]),
        new Uint8Array(32).fill(9),
        new Uint8Array(64).map((_, i) => i),
    ]) {
        const encoded = encodeBase64Url(sample);
        assert.deepEqual([...decodeBase64Url(encoded)], [...sample]);
    }
    assert.equal(decodeBase64Url('!!'), null);
});

test('keys: public keys encode/decode as Base64url', async () => {
    const keys = await NodeKeyManager.create();
    const encoded = encodePublicKey(keys.publicKey);
    assert.ok(!encoded.includes('='), 'no padding');
    assert.ok(!encoded.includes('+') && !encoded.includes('/'), 'url-safe alphabet');

    const decoded = decodePublicKey(encoded);
    assert.equal(decoded.byteLength, ED25519_PUBLIC_KEY_BYTES);
    assert.deepEqual([...decoded], [...keys.publicKey]);

    assert.equal(decodePublicKey('not-base64url!'), null);
    assert.equal(decodePublicKey(encodeBase64Url(new Uint8Array(16))), null, 'wrong length');
    assert.equal(decodePublicKey(undefined), null);
});

test('keys: isValidNodeId only accepts 32 lowercase hex characters', () => {
    assert.equal(isValidNodeId('a'.repeat(32)), true);
    assert.equal(isValidNodeId('A'.repeat(32)), false);
    assert.equal(isValidNodeId('a'.repeat(31)), false);
    assert.equal(isValidNodeId('g'.repeat(32)), false);
    assert.equal(isValidNodeId(42), false);
});

// =====================================================================
// 署名・検証
// =====================================================================

test('verifier: signs the serialized packet without the signature field and verifies it', async () => {
    const keys = await NodeKeyManager.create();
    const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });
    const serializer = new BinaryPacketSerializer();

    const packet = createPacket(keys.nodeId, { destinationId: keys.nodeId });
    const signed = await verifier.signPacket(packet);

    assert.equal(signed.signature.byteLength, ED25519_SIGNATURE_BYTES);
    assert.equal(signed.signature.byteLength, 64);
    // 元のパケットは変更しない
    assert.equal(packet.signature.byteLength, 0);

    // 署名対象は「署名フィールドを除くシリアライズ済みパケット」
    const expectedInput = serializer.serializeForSigning({ ...packet, ttl: 0 });
    const manual = await keys.verify(keys.publicKey, expectedInput, signed.signature);
    assert.equal(manual, true);

    // 通信相手のディレクトリに公開鍵があれば検証できる
    await keyDirectory.addPublicKey(keys.nodeId, keys.publicKey);
    assert.equal(await verifier.verifyPacket(signed), true);

    // v2 でシリアライズされ、raw bytes 経路でも検証できる
    const encoded = serializer.serialize(signed);
    assert.equal(encoded[1], WEBTCP_PROTOCOL_VERSION);
    const received = serializer.deserialize(encoded);
    assert.equal(await verifier.verifyBytes(received, encoded), true);
});

test('verifier: rejects tampered fields, signatures, and foreign senders', async () => {
    const keys = await NodeKeyManager.create();
    const other = await NodeKeyManager.create();
    const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });
    const serializer = new BinaryPacketSerializer();

    await keyDirectory.addPublicKey(keys.nodeId, keys.publicKey);

    const signed = await verifier.signPacket(createPacket(keys.nodeId));
    assert.equal(await verifier.verifyPacket(signed), true);

    // ペイロード改ざん
    const tamperedPayload = {
        ...signed,
        payload: encoder.encode('hellO'),
    };
    assert.equal(
        await verifier.verifyBytes(tamperedPayload, serializer.serialize(tamperedPayload)),
        false,
    );

    // 宛先改ざん
    const tamperedDestination = { ...signed, destinationId: 'c'.repeat(32) };
    assert.equal(await verifier.verifyPacket(tamperedDestination), false);

    // 署名改ざん
    const tamperedSignature = { ...signed, signature: new Uint8Array(64).fill(3) };
    assert.equal(await verifier.verifyPacket(tamperedSignature), false);

    // senderId のなりすまし（他者の公開鍵で署名しても指紋が一致しない）
    const impersonated = await verifier.signPacket(createPacket(other.nodeId));
    await keyDirectory.addPublicKey(other.nodeId, other.publicKey);
    assert.equal(
        await verifier.verifyPacket(impersonated),
        false,
        'signature from a different private key must not verify',
    );

    // 秘密鍵が一致しない署名を、正しい公開鍵で検証しても失敗する
    const forged = {
        ...signed,
        signature: await other.sign(serializer.serializeForSigning({ ...signed, ttl: 0 })),
    };
    assert.equal(await verifier.verifyPacket(forged), false);
});

test('verifier: rejects unsigned, truncated and unknown-signer packets', async () => {
    const keys = await NodeKeyManager.create();
    const { verifier } = createEd25519Verifier({ keyManager: keys, keyWaitTimeoutMs: 0 });

    assert.equal(
        await verifier.verifyPacket(createPacket(keys.nodeId)),
        false,
        'v1 packets must not verify under v2',
    );

    const signed = await verifier.signPacket(createPacket(keys.nodeId));
    assert.equal(
        await verifier.verifyPacket({ ...signed, signature: signed.signature.subarray(0, 32) }),
        false,
        'truncated signature',
    );
    assert.equal(
        await verifier.verifyPacket({ ...signed, senderId: 'g'.repeat(32) }),
        false,
        'malformed NodeId',
    );
    assert.equal(
        await verifier.verifyPacket({ ...signed, senderId: 'c'.repeat(32) }),
        false,
        'unknown signer (no public key available)',
    );
});

test('verifier: ignores ttl changes made by relay nodes', async () => {
    const keys = await NodeKeyManager.create();
    const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });
    const serializer = new BinaryPacketSerializer();
    await keyDirectory.addPublicKey(keys.nodeId, keys.publicKey);

    const signed = await verifier.signPacket(createPacket(keys.nodeId, { ttl: 64 }));
    const encoded = serializer.serialize(signed);

    // 中継ノードが TTL を 1 減らして転送した状況を再現する
    const relayed = new Uint8Array(encoded);
    relayed[2] = 63;

    assert.equal(await verifier.verifyBytes(serializer.deserialize(relayed), relayed), true);
    // 同じ署名対象なので、古い TTL のままでも検証は通る
    assert.equal(await verifier.verifyPacket({ ...signed, ttl: 63 }), true);
});

test('verifier: senders are self-certifying via the public key embedded in RT_UPDATE', async () => {
    const keys = await NodeKeyManager.create();
    const strangerKeys = await NodeKeyManager.create();
    const verifier = new Ed25519PacketVerifier({
        keyManager: keys,
        keyDirectory: new KeyDirectory(),
        keyWaitTimeoutMs: 0,
    });

    const update = await verifier.signPacket(
        createPacket(keys.nodeId, {
            flags: 'RT_UPDATE',
            sourcePort: 0,
            destinationPort: 0,
            payload: encoder.encode(
                JSON.stringify({
                    senderId: keys.nodeId,
                    entries: [],
                    publicKey: encodePublicKey(keys.publicKey),
                }),
            ),
        }),
    );
    assert.equal(await verifier.verifyPacket(update), true);
    assert.equal(await verifier.verifyBytes(update, new BinaryPacketSerializer().serialize(update)), true);

    // 同梱鍵が senderId の指紋と一致しなければ拒否する（学習済み鍵は使わない別インスタンスで確認）
    const freshVerifier = new Ed25519PacketVerifier({
        keyManager: keys,
        keyDirectory: new KeyDirectory(),
        keyWaitTimeoutMs: 0,
    });
    const strangerVerifier = new Ed25519PacketVerifier({ keyManager: strangerKeys });
    const mismatched = await strangerVerifier.signPacket(
        createPacket(strangerKeys.nodeId, {
            flags: 'RT_UPDATE',
            sourcePort: 0,
            destinationPort: 0,
            payload: encoder.encode(
                JSON.stringify({
                    senderId: strangerKeys.nodeId,
                    entries: [],
                    // 他人（keys）の公開鍵を同梱してなりすましを試みる
                    publicKey: encodePublicKey(keys.publicKey),
                }),
            ),
        }),
    );
    assert.equal(await freshVerifier.verifyPacket(mismatched), false);
});

test('verifier: waits for a public key to arrive through the KeyDirectory', async () => {
    const keys = await NodeKeyManager.create();
    const verifier = new Ed25519PacketVerifier({
        keyManager: keys,
        keyDirectory: new KeyDirectory(),
        keyWaitTimeoutMs: 2000,
    });

    const signed = await verifier.signPacket(createPacket(keys.nodeId));
    // 公開鍵は先にディレクトリへ登録されていないが、検証中に登録される
    setTimeout(() => {
        void verifier['directory'].addPublicKey(keys.nodeId, keys.publicKey);
    }, 50);

    assert.equal(await verifier.verifyPacket(signed), true);
});

test('verifier: gives up when the public key never arrives', async () => {
    const keys = await NodeKeyManager.create();
    const verifier = new Ed25519PacketVerifier({
        keyManager: keys,
        keyDirectory: new KeyDirectory(),
        keyWaitTimeoutMs: 120,
    });
    const signed = await verifier.signPacket(createPacket(keys.nodeId));

    const startedAt = Date.now();
    assert.equal(await verifier.verifyPacket(signed), false);
    assert.ok(Date.now() - startedAt >= 100, 'should wait for the configured timeout');
});

// =====================================================================
// KeyDirectory
// =====================================================================

test('keyDirectory: stores keys and rejects fingerprint mismatches', async () => {
    const keys = await NodeKeyManager.create();
    const other = await NodeKeyManager.create();
    const directory = new KeyDirectory();

    assert.equal(await directory.getPublicKey(keys.nodeId), null);
    assert.equal(await directory.addPublicKey(keys.nodeId, keys.publicKey), true);
    assert.deepEqual([...await directory.getPublicKey(keys.nodeId)], [...keys.publicKey]);
    // 冪等
    assert.equal(await directory.addPublicKey(keys.nodeId, keys.publicKey), true);

    // 他人の鍵をすり替えようとしても拒否し、既存の信頼済み鍵を保持する
    assert.equal(await directory.addPublicKey(keys.nodeId, other.publicKey), false);
    assert.deepEqual([...directory.get(keys.nodeId)], [...keys.publicKey]);

    // 指紋と一致しない登録は拒否
    assert.equal(await directory.addPublicKey('c'.repeat(32), keys.publicKey), false);
    assert.equal(await directory.addPublicKey('c'.repeat(32), new Uint8Array(16)), false);
    assert.equal(directory.size, 1);
});

test('keyDirectory: accepts Base64url keys and waits for arrival', async () => {
    const keys = await NodeKeyManager.create();
    const directory = new KeyDirectory();

    const waiting = directory.waitForPublicKey(keys.nodeId, 1000);
    setTimeout(() => {
        void directory.addPublicKey(keys.nodeId, encodePublicKey(keys.publicKey));
    }, 30);
    const waited = await waiting;
    assert.deepEqual([...waited], [...keys.publicKey]);

    // タイムアウト
    const missing = await directory.waitForPublicKey('d'.repeat(32), 40);
    assert.equal(missing, null);
    // 既に登録済みなら即座に返る
    const immediate = await directory.waitForPublicKey(keys.nodeId, 0);
    assert.deepEqual([...immediate], [...keys.publicKey]);
});

test('keyDirectory: ingests public keys from routing info payloads', async () => {
    const keys = await NodeKeyManager.create();
    const directory = new KeyDirectory();

    assert.equal(
        await directory.ingestFromRoutingInfo(keys.nodeId, encodePublicKey(keys.publicKey)),
        true,
    );
    assert.equal(await directory.ingestFromRoutingInfo(keys.nodeId, 'bogus'), false);
    assert.equal(directory.exportPublicKey(keys.nodeId), encodePublicKey(keys.publicKey));
    assert.equal(directory.exportPublicKey('e'.repeat(32)), null);
});

test('keyDirectory: delete and clear', async () => {
    const a = await NodeKeyManager.create();
    const b = await NodeKeyManager.create();
    const directory = new KeyDirectory();

    await directory.addPublicKey(a.nodeId, a.publicKey);
    await directory.addPublicKey(b.nodeId, b.publicKey);
    assert.equal(directory.size, 2);
    assert.deepEqual(directory.nodeIds().sort(), [a.nodeId, b.nodeId].sort());

    assert.equal(directory.delete(a.nodeId), true);
    assert.equal(directory.size, 1);
    directory.clear();
    assert.equal(directory.size, 0);
});

// =====================================================================
// プロトコルバージョン
// =====================================================================

test('protocol: unsigned packets serialize as v1 and signed packets as v2', async () => {
    const keys = await NodeKeyManager.create();
    const { verifier } = createEd25519Verifier({ keyManager: keys });
    const serializer = new BinaryPacketSerializer();

    const unsigned = serializer.serialize(createPacket(keys.nodeId));
    assert.equal(unsigned[1], WEBTCP_PROTOCOL_VERSION_V1);

    const signed = await verifier.signPacket(createPacket(keys.nodeId));
    const encoded = serializer.serialize(signed);
    assert.equal(encoded[1], WEBTCP_PROTOCOL_VERSION);
    assert.equal(serializer.deserialize(encoded).version, WEBTCP_PROTOCOL_VERSION);
    assert.equal(WEBTCP_PROTOCOL_VERSION, 2);
    assert.equal(serializer.resolveVersion(signed), WEBTCP_PROTOCOL_VERSION);
    assert.equal(
        serializer.resolveVersion(createPacket(keys.nodeId)),
        WEBTCP_PROTOCOL_VERSION_V1,
    );
});
