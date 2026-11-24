// Child-process probe for tests/node-datachannel-polyfill.characterization.test.mjs (#67).
//
// Runs one scenario against node-datachannel/polyfill and prints one JSON line.
// The process must exit explicitly: the native peer connection keeps the event loop alive.
//
// usage: node tests/helpers/node-datachannel-probe.mjs <early|late|null-check>

const scenario = process.argv[2];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepUntilComplete = async (pc, timeoutMs = 8000) => {
    const started = Date.now();
    while (pc.iceGatheringState !== 'complete' && Date.now() - started < timeoutMs) await wait(10);
};
const kindOf = (event) => (event.candidate === null ? 'null' : 'candidate');
const tally = (events) => ({
    candidate: events.filter((kind) => kind === 'candidate').length,
    null: events.filter((kind) => kind === 'null').length,
});

let RTCPeerConnection;
try {
    ({ RTCPeerConnection } = await import('node-datachannel/polyfill'));
} catch {
    console.log(JSON.stringify({ skipped: 'node-datachannel is not installed' }));
    process.exit(0);
}

const pc = new RTCPeerConnection({ iceServers: [], bindAddress: '127.0.0.1' });
const byListener = [];
const byProperty = [];
let gatheringBeforeAttach = null;
const attach = () => {
    pc.addEventListener('icecandidate', (event) => byListener.push(kindOf(event)));
    pc.onicecandidate = (event) => byProperty.push(kindOf(event));
};

if (scenario === 'early' || scenario === 'null-check') {
    attach();
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await sleepUntilComplete(pc);
    await wait(300);
} else if (scenario === 'late') {
    pc.createDataChannel('x');
    await wait(300);
    gatheringBeforeAttach = pc.iceGatheringState;
    attach();
    await pc.setLocalDescription(await pc.createOffer());
    await wait(300);
} else {
    console.error(`unknown scenario ${scenario}`);
    process.exit(2);
}

const sdp = pc.localDescription?.sdp ?? '';
const result = {
    scenario,
    gathering: pc.iceGatheringState,
    sdpCandidateLines: (sdp.match(/^a=candidate:/gm) ?? []).length,
    addEventListener: tally(byListener),
    onicecandidate: tally(byProperty),
    ...(gatheringBeforeAttach === null ? {} : { gatheringBeforeAttach }),
};
console.log(JSON.stringify(result));
process.exit(0);
