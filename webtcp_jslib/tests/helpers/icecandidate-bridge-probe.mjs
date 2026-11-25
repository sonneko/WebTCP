// Child-process probe for tests/icecandidate-bridge.test.mjs (#67 / design §3.38).
//
// usage: node tests/helpers/icecandidate-bridge-probe.mjs <raw|bridged> <loopback|auto>
// Creates one node-datachannel/polyfill peer connection, attaches listeners early (same tick),
// late (after gathering) through addEventListener, and late through onicecandidate, and prints one JSON line
// with the counts, the SDP candidate count, and the event order. The process must exit explicitly:
// the native peer connection keeps the event loop alive.

const [mode = 'raw', bind = 'loopback'] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let provider;
let bridge;
try {
    const dist = await import('../../dist/adapters/webrtc/nodeProvider.js');
    bridge = dist.bridgeIceCandidateEvents;
    provider = await dist.resolveNodeRTCProvider({ packages: ['node-datachannel/polyfill'] });
} catch (error) {
    console.log(JSON.stringify({ skipped: `node-datachannel is not installed (${String(error.message).split('\n')[0]})` }));
    process.exit(0);
}

const pc = provider.createPeerConnection({
    iceServers: [],
    ...(bind === 'loopback' ? { bindAddress: '127.0.0.1' } : {}),
});
if (mode === 'bridged') bridge(pc);

const timeline = [];
const early = { candidate: 0, null: 0 };
const late = { candidate: 0, null: 0 };
const lateProperty = { candidate: 0, null: 0 };
const record = (tally, label) => (event) => {
    const kind = event.candidate === null ? 'null' : 'candidate';
    tally[kind] += 1;
    timeline.push(`${label}:${kind}`);
};

pc.addEventListener('icecandidate', record(early, 'early'));
pc.createDataChannel('probe');
await pc.setLocalDescription(await pc.createOffer());
const started = Date.now();
while (pc.iceGatheringState !== 'complete' && Date.now() - started < 10_000) await wait(5);
await wait(300);

pc.addEventListener('icecandidate', record(late, 'late'));
pc.onicecandidate = record(lateProperty, 'lateProperty');
await wait(300);

const sdpCandidates = (pc.localDescription?.sdp.match(/^a=candidate:/gm) ?? []).length;
// per listener: every candidate arrives before its end marker, and the end marker is delivered once
const orderedPerListener = ['early', 'late', 'lateProperty'].every((label) => {
    const own = timeline.filter((item) => item.startsWith(`${label}:`));
    const nulls = own.filter((item) => item.endsWith(':null')).length;
    const lastCandidate = own.map((item) => item.endsWith(':candidate')).lastIndexOf(true);
    const firstNull = own.findIndex((item) => item.endsWith(':null'));
    return nulls <= 1 && (firstNull === -1 || lastCandidate < firstNull);
});
const result = {
    mode,
    bind,
    sdpCandidates,
    early,
    late,
    lateProperty,
    // the end marker must come after the candidates it closes, and only once per listener
    endAfterCandidates: orderedPerListener,
};
pc.close();
console.log(JSON.stringify(result));
process.exit(0);
