/**
 * `icecandidate` の橋渡し（#67 / 設計 §3.38）の論理テスト（fake PC、ネイティブ依存なし）。
 *
 * 上流の polyfill と同じ構造の fake を使う: コンストラクタで内部リスナーを登録し、
 * `onicecandidate` をそのリスナーから呼ぶ。候補は発行の時点で配送され、再送されない。
 * 実 `node-datachannel` での検証は tests/helpers/icecandidate-bridge-probe.mjs（子プロセス）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { bridgeIceCandidateEvents, wrapNodePeerConnection } from '../dist/adapters/webrtc/nodeProvider.js';
import { noopLogger } from '../dist/index.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 上流 polyfill と同じ配送（候補は発行時だけ、再送なし、`onicecandidate` は内部リスナー経由）。 */
class UpstreamLikePeerConnection extends EventTarget {
    constructor() {
        super();
        this.onicecandidate = null;
        this.iceGatheringState = 'new';
        this.localDescription = null;
        this.connectionState = 'new';
        this.addEventListener('icecandidate', (event) => this.onicecandidate?.(event));
    }

    /** SDP に `count` 件の候補行を入れる（収集完了後の SDP を模擬）。 */
    setCandidateLines(count) {
        const lines = Array.from({ length: count }, (_, i) => `a=candidate:${i + 1} 1 udp 1 127.0.0.1 ${9000 + i} typ host`);
        this.localDescription = { type: 'offer', sdp: ['v=0', ...lines].join('\r\n') };
    }

    emitCandidate(index) {
        const event = new Event('icecandidate');
        Object.defineProperty(event, 'candidate', { value: { candidate: `candidate:${index}` } });
        this.dispatchEvent(event);
    }

    /** ネイティブ実装が自前で `null` を発行する場合（@roamhq/wrtc 相当）。 */
    emitNativeEnd() {
        const event = new Event('icecandidate');
        Object.defineProperty(event, 'candidate', { value: null });
        this.dispatchEvent(event);
    }

    setGatheringState(state) {
        this.iceGatheringState = state;
        this.dispatchEvent(new Event('icegatheringstatechange'));
    }
}

/** 候補の種類を記録するリスナー（候補は番号、終了は 'end'）。 */
function recorder() {
    const seen = [];
    const listener = (event) => seen.push(event.candidate === null ? 'end' : event.candidate.candidate);
    return { seen, listener };
}

test('icecandidate bridge: a listener added after gathering receives the buffered candidates in order, then one end marker', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.emitCandidate(2);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, ['candidate:1', 'candidate:2', 'end']);
});

test('icecandidate bridge: same-tick listeners get each candidate once and one end marker (no duplicates)', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    const early = recorder();
    pc.addEventListener('icecandidate', early.listener);
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);
    assert.deepEqual(early.seen, ['candidate:1', 'end']);
});

test('icecandidate bridge: attaching the same listener twice replays only once', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, ['candidate:1', 'end']);
});

test('icecandidate bridge: a late onicecandidate assignment receives what it missed, and re-assigning the same handler does not repeat', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.onicecandidate = late.listener;
    assert.deepEqual(late.seen, ['candidate:1', 'end']);
    pc.onicecandidate = late.listener;
    assert.deepEqual(late.seen, ['candidate:1', 'end'], 'the same handler must not get the events twice');
});

test('icecandidate bridge: a handler set at construction keeps receiving live events exactly once', async () => {
    const pc = new UpstreamLikePeerConnection();
    const live = recorder();
    pc.onicecandidate = live.listener;
    const bridged = bridgeIceCandidateEvents(pc);
    assert.equal(bridged, pc);
    bridged.setCandidateLines(1);
    bridged.setGatheringState('gathering');
    bridged.emitCandidate(1);
    bridged.setGatheringState('complete');
    await wait(20);
    assert.deepEqual(live.seen, ['candidate:1', 'end']);
});

test('icecandidate bridge: once listeners get exactly one event', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.emitCandidate(2);
    pc.setGatheringState('complete');
    await wait(20);

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    assert.deepEqual(once.seen, ['candidate:1']);
});

test('icecandidate bridge: the end marker waits for the candidates counted in the SDP', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    const early = recorder();
    pc.addEventListener('icecandidate', early.listener);
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');
    pc.setGatheringState('complete');
    pc.emitCandidate(1);
    await wait(30);
    assert.deepEqual(early.seen, ['candidate:1'], 'no end marker while a counted candidate is still missing');
    pc.emitCandidate(2);
    await wait(20);
    assert.deepEqual(early.seen, ['candidate:1', 'candidate:2', 'end']);
});

test('icecandidate bridge: zero candidates still ends with exactly one end marker', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    const early = recorder();
    pc.addEventListener('icecandidate', early.listener);
    pc.setCandidateLines(0);
    pc.setGatheringState('gathering');
    pc.setGatheringState('complete');
    await wait(20);
    assert.deepEqual(early.seen, ['end']);
});

test('icecandidate bridge: a native end marker is used as is and not doubled', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.emitNativeEnd();
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, ['candidate:1', 'end']);
});

test('icecandidate bridge: a new gathering round starts a new buffer', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);

    pc.setGatheringState('gathering');
    pc.setCandidateLines(1);
    pc.emitCandidate(2);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, ['candidate:2', 'end'], 'only the current round is replayed');
});

test('icecandidate bridge: without the bridge, a late listener gets nothing (the upstream behaviour, for comparison)', async () => {
    const pc = new UpstreamLikePeerConnection();
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, []);
});

test('icecandidate bridge: the factory wrapper used by createNodeNetwork applies the bridge to injected factories', async () => {
    const created = [];
    const factory = () => {
        const pc = new UpstreamLikePeerConnection();
        created.push(pc);
        return pc;
    };
    const wrapped = wrapNodePeerConnection(factory, noopLogger);
    const pc = wrapped({ iceServers: [] });
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.setGatheringState('complete');
    await wait(20);

    const late = recorder();
    pc.addEventListener('icecandidate', late.listener);
    assert.deepEqual(late.seen, ['candidate:1', 'end']);
    assert.equal(created.length, 1);
});

// `once` の意味論（PR #81 のフォローアップ / 設計 §3.38）: 発火した once リスナーは除去され、再登録できる。
// 発火していない once リスナーの再登録は重複として扱い、二重に登録しない。

test('icecandidate bridge: a once listener that has fired can be registered again (it is not dropped as a duplicate)', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.emitCandidate(1); // the once listener fires and is removed
    assert.deepEqual(once.seen, ['candidate:1']);

    pc.addEventListener('icecandidate', once.listener, { once: true }); // registered again after firing
    await wait(5);
    assert.deepEqual(once.seen, ['candidate:1'], 'the re-registration must not redeliver candidate 1 (#83)');
    pc.emitCandidate(2);
    assert.deepEqual(once.seen, ['candidate:1', 'candidate:2'], 'the re-registration must be accepted and fire for the next candidate');
});

test('icecandidate bridge: a once listener fires only once for live events', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.emitCandidate(1);
    pc.emitCandidate(2);
    assert.deepEqual(once.seen, ['candidate:1']);
});

test('icecandidate bridge: a once listener that has not fired yet is a duplicate when added again', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(1);
    pc.setGatheringState('gathering');

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.emitCandidate(1);
    assert.deepEqual(once.seen, ['candidate:1']);
});

test('icecandidate bridge: removing a once listener before it fires stops delivery, and it can be added again', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.removeEventListener('icecandidate', once.listener);
    pc.emitCandidate(1);
    assert.deepEqual(once.seen, []);

    // a new registration gets the buffered candidates first (design §3.38), once: only the first one
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.emitCandidate(2);
    assert.deepEqual(once.seen, ['candidate:1']);
});

test('icecandidate bridge: a once listener can register itself again from inside its own callback (removed before it runs)', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');

    const seen = [];
    const listener = (event) => {
        seen.push(event.candidate ? 'candidate' : 'end');
        if (seen.length === 1) pc.addEventListener('icecandidate', listener, { once: true });
    };
    pc.addEventListener('icecandidate', listener, { once: true });
    pc.emitCandidate(1);
    pc.emitCandidate(2);
    assert.deepEqual(seen, ['candidate', 'candidate']);
});

// Issue #83: 後から登録された once リスナーが、自己再登録しながら buffered 候補を順に読めること。
// 修正前は先頭の候補を再配送して、後続の候補を取りこぼした（candidate:1 を 3 回）。
test('icecandidate bridge (#83): a once listener that re-registers itself reads buffered candidates in order, without redelivery', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(3);
    pc.setGatheringState('gathering');
    pc.emitCandidate(1);
    pc.emitCandidate(2);

    const got = [];
    const listener = (event) => {
        got.push(event.candidate.candidate);
        if (got.length < 3) pc.addEventListener('icecandidate', listener, { once: true });
    };
    pc.addEventListener('icecandidate', listener, { once: true });
    pc.emitCandidate(3);
    assert.deepEqual(got, ['candidate:1', 'candidate:2', 'candidate:3']);
});

test('icecandidate bridge (#83): a once listener re-registered later resumes from its own position, not from the first candidate', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(3);
    pc.setGatheringState('gathering');

    const once = recorder();
    pc.addEventListener('icecandidate', once.listener, { once: true });
    pc.emitCandidate(1); // fires and is removed
    pc.emitCandidate(2); // not delivered: the once listener is not registered
    pc.addEventListener('icecandidate', once.listener, { once: true }); // buffered 2 is the next undelivered
    assert.deepEqual(once.seen, ['candidate:1', 'candidate:2']);
    pc.emitCandidate(3);
    assert.deepEqual(once.seen, ['candidate:1', 'candidate:2'], 'the replayed once listener is not registered for live events');
});

test('icecandidate bridge (#83): a non-once listener that is removed and added again receives only the candidates it missed', async () => {
    const pc = bridgeIceCandidateEvents(new UpstreamLikePeerConnection());
    pc.setCandidateLines(2);
    pc.setGatheringState('gathering');

    const rec = recorder();
    pc.addEventListener('icecandidate', rec.listener);
    pc.emitCandidate(1);
    pc.removeEventListener('icecandidate', rec.listener);
    pc.emitCandidate(2);
    pc.addEventListener('icecandidate', rec.listener);
    assert.deepEqual(rec.seen, ['candidate:1', 'candidate:2'], 'the candidate 1 must not be delivered twice');
});

