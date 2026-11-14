import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    FLAG_BITS,
    WEBTCP_HEADER_SIZE,
    WEBTCP_PROTOCOL_VERSION,
    WEBTCP_PROTOCOL_VERSION_V1,
    flagsToMask,
    maskToFlags,
} from '../dist/index.js';

const SENDER = 'a'.repeat(32);
const DEST = 'b'.repeat(32);

function createPacket(overrides = {}) {
    return {
        senderId: SENDER,
        destinationId: DEST,
        ttl: 64,
        signature: new Uint8Array(0),
        sourcePort: 50001,
        destinationPort: 8080,
        flags: 'DATA',
        seqNum: 1,
        ackNum: 2,
        payload: new TextEncoder().encode('hello'),
        ...overrides,
    };
}

test('serializer: round-trips every flag', () => {
    const serializer = new BinaryPacketSerializer();
    for (const flags of ['DATA', 'SYN', 'ACK', 'FIN', 'RST', 'SYN_ACK', 'RT_UPDATE']) {
        const packet = createPacket({ flags });
        const decoded = serializer.deserialize(serializer.serialize(packet));
        assert.equal(decoded.flags, flags);
    }
});

test('serializer: preserves fields and binary payload (v1, no signature)', () => {
    const serializer = new BinaryPacketSerializer();
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const packet = createPacket({
        ttl: 12,
        seqNum: 0xffffffff,
        ackNum: 7,
        payload,
        signature: new Uint8Array(0),
    });

    const encoded = serializer.serialize(packet);
    assert.equal(encoded.byteLength, WEBTCP_HEADER_SIZE + 32 + 32 + payload.byteLength);
    assert.equal(encoded[1], WEBTCP_PROTOCOL_VERSION_V1, 'unsigned packets use protocol v1');

    const decoded = serializer.deserialize(encoded);
    assert.equal(decoded.version, WEBTCP_PROTOCOL_VERSION_V1);
    assert.equal(decoded.senderId, SENDER);
    assert.equal(decoded.destinationId, DEST);
    assert.equal(decoded.ttl, 12);
    assert.equal(decoded.sourcePort, 50001);
    assert.equal(decoded.destinationPort, 8080);
    assert.equal(decoded.seqNum, 0xffffffff);
    assert.equal(decoded.ackNum, 7);
    assert.deepEqual([...decoded.payload], [...payload]);
    assert.equal(decoded.signature.byteLength, 0);
});

test('serializer: round-trips a v2 packet with a 64-byte Ed25519 signature', () => {
    const serializer = new BinaryPacketSerializer();
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const signature = new Uint8Array(64).fill(7);
    const packet = createPacket({ payload, signature, version: WEBTCP_PROTOCOL_VERSION });

    const encoded = serializer.serialize(packet);
    assert.equal(encoded[1], WEBTCP_PROTOCOL_VERSION);
    assert.equal(
        encoded.byteLength,
        WEBTCP_HEADER_SIZE + 32 + 32 + 64 + payload.byteLength,
    );

    const decoded = serializer.deserialize(encoded);
    assert.equal(decoded.version, WEBTCP_PROTOCOL_VERSION);
    assert.deepEqual([...decoded.signature], [...signature]);
    assert.deepEqual([...decoded.payload], [...payload]);
});

test('serializer: v2 rejects a non-Ed25519-length signature', () => {
    const serializer = new BinaryPacketSerializer();
    assert.throws(
        () =>
            serializer.serialize(
                createPacket({ version: WEBTCP_PROTOCOL_VERSION, signature: new Uint8Array(3) }),
            ),
        /requires a 64-byte signature/,
    );
});

test('serializer: v1 rejects a signature field', () => {
    const serializer = new BinaryPacketSerializer();
    assert.throws(
        () =>
            serializer.serialize(
                createPacket({ version: WEBTCP_PROTOCOL_VERSION_V1, signature: new Uint8Array(64) }),
            ),
        /protocol v1 packets must not carry a signature/,
    );
});

test('serializer: rejects unknown protocol versions on deserialize', () => {
    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(createPacket());
    encoded[1] = 9;
    assert.throws(() => serializer.deserialize(encoded), /unsupported protocol version/);
});

test('serializer: signature input excludes the signature field and zeroes ttl', () => {
    const serializer = new BinaryPacketSerializer();
    const signature = new Uint8Array(64).fill(1);
    const packet = createPacket({
        ttl: 42,
        signature,
        sinceVersion: undefined,
        version: WEBTCP_PROTOCOL_VERSION,
    });

    const forSigning = serializer.serializeForSigning({ ...packet, ttl: 0 });
    // 署名 64 バイト分だけ短い
    assert.equal(
        forSigning.byteLength,
        serializer.serialize({ ...packet, ttl: 0 }).byteLength - 64,
    );
    // signatureLen は 0
    assert.equal(new DataView(forSigning.buffer).getUint16(18, false), 0);
    // TTL も 0
    assert.equal(forSigning[2], 0);

    const encoded = serializer.serialize({ ...packet, ttl: 0 });
    const fromBytes = serializer.signatureInputFromBytes(encoded);
    assert.deepEqual([...fromBytes], [...forSigning]);
});

test('serializer: flag helpers normalize SYN|ACK', () => {
    assert.equal(flagsToMask('DATA'), FLAG_BITS.DATA);
    assert.equal(maskToFlags(FLAG_BITS.SYN | FLAG_BITS.ACK), 'SYN_ACK');
    assert.equal(maskToFlags(FLAG_BITS.SYN_ACK), 'SYN_ACK');
    assert.equal(maskToFlags(FLAG_BITS.RT_UPDATE), 'RT_UPDATE');
    assert.equal(maskToFlags(FLAG_BITS.FIN), 'FIN');
});

test('serializer: rejects a short buffer', () => {
    const serializer = new BinaryPacketSerializer();
    assert.throws(() => serializer.deserialize(new Uint8Array(10)), /too short/);
});

test('serializer: rejects an invalid magic byte', () => {
    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(createPacket());
    encoded[0] = 0x00;
    assert.throws(() => serializer.deserialize(encoded), /invalid magic/);
});

test('serializer: rejects a length mismatch', () => {
    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(createPacket());
    assert.throws(() => serializer.deserialize(encoded.subarray(0, encoded.length - 1)), /length mismatch/);
});

test('serializer: refuses payloads over the configured maximum', () => {
    const serializer = new BinaryPacketSerializer({ maxPayloadBytes: 8 });
    assert.throws(
        () => serializer.serialize(createPacket({ payload: new TextEncoder().encode('123456789') })),
        /maximum/,
    );
});

test('serializer: refuses out-of-range ports and ttl', () => {
    const serializer = new BinaryPacketSerializer();
    assert.throws(() => serializer.serialize(createPacket({ destinationPort: 70000 })), /out of range/);
    assert.throws(() => serializer.serialize(createPacket({ ttl: -1 })), /out of range/);
});

test('serializer: rejects a packet with zero flags', () => {
    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(createPacket());
    encoded[3] = 0x00;
    assert.throws(() => serializer.deserialize(encoded), /invalid flags/);
});

test('serializer: rejects a v2 packet with a truncated signature', () => {
    const serializer = new BinaryPacketSerializer();
    const encoded = serializer.serialize(
        createPacket({ version: WEBTCP_PROTOCOL_VERSION, signature: new Uint8Array(64) }),
    );
    // signatureLen を 0 に書き換えると v2 の制約に違反する
    encoded[18] = 0;
    encoded[19] = 0;
    assert.throws(
        () => serializer.deserialize(encoded.subarray(0, encoded.length)),
        /length mismatch|requires a 64-byte signature/,
    );
});

test('serializer: signatureInputFromBytes rejects malformed buffers', () => {
    const serializer = new BinaryPacketSerializer();
    assert.equal(serializer.signatureInputFromBytes(new Uint8Array(3)), null);
    const encoded = serializer.serialize(createPacket());
    encoded[0] = 0x00;
    assert.equal(serializer.signatureInputFromBytes(encoded), null);
});
