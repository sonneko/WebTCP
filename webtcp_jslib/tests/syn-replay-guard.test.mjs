import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SYN_EXTENSION_BYTES,
    SynReplayGuard,
    createSynExtension,
} from '../dist/index.js';

/**
 * #48 の受理規則（specification.md §11.6.1）の単体試験。
 * 時刻は注入して決定的にする。
 */

function synPacket(senderId, payload) {
    return {
        senderId,
        destinationId: 'f'.repeat(32),
        ttl: 0,
        flags: 'SYN',
        seqNum: 1,
        ackNum: 0,
        payload,
        signature: new Uint8Array(0),
        sourcePort: 1,
        destinationPort: 2,
    };
}

function clock(start = 1_000_000_000_000) {
    const state = { now: start };
    return { state, now: () => state.now };
}

const SENDER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

test('syn-replay-guard: extension is 28 bytes with magic and the given timestamp', () => {
    const ext = createSynExtension(1234567890123);
    assert.equal(ext.byteLength, SYN_EXTENSION_BYTES);
    assert.deepEqual([...ext.subarray(0, 4)], [0x57, 0x53, 0x4e, 0x31]);
    const view = new DataView(ext.buffer, ext.byteOffset, ext.byteLength);
    assert.equal(Number(view.getBigUint64(4, false)), 1234567890123);
});

test('syn-replay-guard: each extension carries a fresh nonce', () => {
    const a = createSynExtension(5);
    const b = createSynExtension(5);
    assert.notDeepEqual(a.subarray(12), b.subarray(12));
});

test('syn-replay-guard: legacy (empty payload) SYN is accepted by default', () => {
    const guard = new SynReplayGuard({ now: () => 0 });
    const decision = guard.check(synPacket(SENDER, new Uint8Array(0)));
    assert.deepEqual(decision, { accepted: true, legacy: true });
});

test('syn-replay-guard: legacy SYN is rejected when allowLegacySyn is false', () => {
    const guard = new SynReplayGuard({ now: () => 0, allowLegacySyn: false });
    const decision = guard.check(synPacket(SENDER, new Uint8Array(0)));
    assert.deepEqual(decision, { accepted: false, reason: 'legacy-disabled' });
});

test('syn-replay-guard: a fresh extension is accepted once', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now });
    const packet = synPacket(SENDER, createSynExtension(c.state.now));
    assert.deepEqual(guard.check(packet), { accepted: true, legacy: false });
    assert.equal(guard.size, 1);
});

test('syn-replay-guard: the same extension again is a replay and is rejected', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now });
    const packet = synPacket(SENDER, createSynExtension(c.state.now));
    assert.equal(guard.check(packet).accepted, true);
    assert.deepEqual(guard.check(packet), { accepted: false, reason: 'replayed' });
});

test('syn-replay-guard: the same nonce from a different sender is not a replay', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now });
    const payload = createSynExtension(c.state.now);
    assert.equal(guard.check(synPacket(SENDER, payload)).accepted, true);
    assert.equal(guard.check(synPacket(OTHER, payload)).accepted, true);
});

test('syn-replay-guard: timestamps outside the window are stale (past and future)', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now, windowMs: 300_000 });
    const past = createSynExtension(c.state.now - 300_001);
    const future = createSynExtension(c.state.now + 300_001);
    assert.deepEqual(guard.check(synPacket(SENDER, past)), { accepted: false, reason: 'stale' });
    assert.deepEqual(guard.check(synPacket(SENDER, future)), { accepted: false, reason: 'stale' });
});

test('syn-replay-guard: timestamps at the window edge are accepted', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now, windowMs: 300_000 });
    assert.equal(guard.check(synPacket(SENDER, createSynExtension(c.state.now - 300_000))).accepted, true);
    assert.equal(guard.check(synPacket(SENDER, createSynExtension(c.state.now + 300_000))).accepted, true);
});

test('syn-replay-guard: wrong length or magic is malformed', () => {
    const guard = new SynReplayGuard({ now: () => 0 });
    const short = new Uint8Array(10);
    const wrongMagic = createSynExtension(0);
    wrongMagic[0] = 0x00;
    assert.deepEqual(guard.check(synPacket(SENDER, short)), { accepted: false, reason: 'malformed' });
    assert.deepEqual(guard.check(synPacket(SENDER, wrongMagic)), { accepted: false, reason: 'malformed' });
});

test('syn-replay-guard: a full record fails closed until entries expire', () => {
    const c = clock();
    const guard = new SynReplayGuard({ now: c.now, maxEntries: 2, windowMs: 1000 });
    assert.equal(guard.check(synPacket(SENDER, createSynExtension(c.state.now))).accepted, true);
    assert.equal(guard.check(synPacket(SENDER, createSynExtension(c.state.now))).accepted, true);
    assert.deepEqual(guard.check(synPacket(SENDER, createSynExtension(c.state.now))), {
        accepted: false,
        reason: 'full',
    });
    // 期限（timestamp + windowMs）を過ぎた記録は消え、新しい SYN を受理できる
    c.state.now += 2001;
    assert.equal(guard.check(synPacket(SENDER, createSynExtension(c.state.now))).accepted, true);
});
