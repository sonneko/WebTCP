// Child-process probe for tests/webrtc-connect-timeout.test.mjs (#61).
//
// With node-datachannel's auto-bind, measures the local ICE candidates after gathering, then (if there
// are none) connects through NodeWebRTCChannel with a short timeout and prints the error message.
// Prints one JSON line. The process must exit explicitly: the native peer connection keeps the event loop alive.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let provider;
try {
    const { resolveNodeRTCProvider } = await import('../../dist/index.js');
    provider = await resolveNodeRTCProvider({ packages: ['node-datachannel/polyfill'] });
} catch {
    console.log(JSON.stringify({ skipped: 'node-datachannel is not installed' }));
    process.exit(0);
}

const { NodeWebRTCChannel, SignalingAdapterHub, noopLogger } = await import('../../dist/index.js');
const { startHub } = await import('./hub.mjs');

const probe = provider.createPeerConnection({ iceServers: [] });
probe.createDataChannel('probe');
await probe.setLocalDescription(await probe.createOffer());
const started = Date.now();
while (probe.iceGatheringState !== 'complete' && Date.now() - started < 10_000) await wait(10);
const candidates = (probe.localDescription?.sdp.match(/^a=candidate:/gm) ?? []).length;
probe.close();

if (candidates > 0) {
    console.log(JSON.stringify({ candidates }));
    process.exit(0);
}

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const hub = await startHub();
const signaling = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 20, logger: noopLogger });
const channel = new NodeWebRTCChannel(signaling, {
    createPeerConnection: (config) => provider.createPeerConnection(config),
    connectTimeoutMs: 3000,
    logger: noopLogger,
});
await channel.start();
let message = null;
const t0 = Date.now();
try {
    await channel.connect(B);
} catch (error) {
    message = error.message;
} finally {
    channel.close();
    await hub.close();
}
console.log(JSON.stringify({ candidates, connected: message === null, elapsedMs: Date.now() - t0, message }));
process.exit(0);
