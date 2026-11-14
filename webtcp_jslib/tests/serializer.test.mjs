import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    FLAG_BITS,
    flagsToMask,
    maskToFlags,
    WEBTCP_HEADER_SIZE,
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

test('serializer: preserves fields and binary payload', () => {
    const serializer = new BinaryPacketSerializer();
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const packet = createPacket({
        ttl: 12,
        seqNum: 0xffffffff,
        ackNum: 7,
        payload,
        signature: new Uint8Array([9, 9, 9]),
    });

    const encoded = serializer.serialize(packet);
    assert.equal(encoded.byteLength, WEBTCP_HEADER_SIZE + 32 + 32 + 3 + payload.byteLength);

    const decoded = serializer.deserialize(encoded);
    assert.equal(decoded.senderId, SENDER);
    assert.equal(decoded.destinationId, DEST);
    assert.equal(decoded.ttl, 12);
    assert.equal(decoded.sourcePort, 50001);
    assert.equal(decoded.destinationPort, 8080);
    assert.equal(decoded.seqNum, 0xffffffff);
    assert.equal(decoded.ackNum, 7);
    assert.deepEqual([...decoded.payload], [...payload]);
    assert.deepEqual([...decoded.signature], [9, 9, 9]);
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
