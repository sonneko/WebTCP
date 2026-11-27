// Child-process probe for tests/default-bind-address-node-datachannel.test.mjs (#61 / design §3.40).
//
// Two createNodeNetwork() peers over real node-datachannel, with the DEFAULT bind (no peerConnectionOptions),
// connected through a signaling hub. Prints one JSON line. The native peer connections keep the event loop
// alive, so the process must exit explicitly.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// RTC_PACKAGES=default uses the library's default resolution order (@roamhq/wrtc first); otherwise node-datachannel only.
const rtcPackages = process.env.RTC_PACKAGES === 'default' ? undefined : ['node-datachannel/polyfill'];

let provider;
try {
    const { resolveNodeRTCProvider } = await import('../../dist/index.js');
    provider = await resolveNodeRTCProvider(rtcPackages ? { packages: rtcPackages } : {});
} catch {
    console.log(JSON.stringify({ skipped: 'node-datachannel is not installed' }));
    process.exit(0);
}

const { createNodeNetwork, SignalingAdapterHub, noopLogger } = await import('../../dist/index.js');
const { startHub } = await import('./hub.mjs');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const hub = await startHub();
const make = async (nodeId) => {
    const signaling = new SignalingAdapterHub({ url: hub.url, nodeId, pollIntervalMs: 20, logger: noopLogger });
    return createNodeNetwork({
        signaling,
        nodeId,
        ...(rtcPackages ? { rtcPackages } : {}),
        iceServers: [],
        logger: noopLogger,
        connectTimeoutMs: 6000,
    });
};

let result;
const a = await make(A);
const b = await make(B);
try {
    await a.start();
    await b.start();
    const t0 = Date.now();
    let message = null;
    try {
        await a.connectToPeer(B);
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    result = { connected: message === null, elapsedMs: Date.now() - t0, message, provider: provider.name };
} finally {
    await a.close?.();
    await b.close?.();
    await hub.close();
}
// Precedence check (design §3.40): the default bind is logged only when it is applied. A user bindAddress must
// suppress it. Networks are created but not connected.
const capture = () => {
    const messages = [];
    const logger = {
        debug() {},
        info: (message) => messages.push(String(message)),
        warn() {},
        error() {},
    };
    return { messages, logger };
};
const isApplied = (messages) => messages.some((m) => m.includes('ICE bind address is'));
const plain = capture();
const plainNet = await createNodeNetwork({
    signaling: new SignalingAdapterHub({ url: hub.url, nodeId: 'c'.repeat(32), pollIntervalMs: 20, logger: noopLogger }),
    nodeId: 'c'.repeat(32),
    ...(rtcPackages ? { rtcPackages } : {}),
    logger: plain.logger,
});
const userBind = capture();
const userNet = await createNodeNetwork({
    signaling: new SignalingAdapterHub({ url: hub.url, nodeId: 'd'.repeat(32), pollIntervalMs: 20, logger: noopLogger }),
    nodeId: 'd'.repeat(32),
    ...(rtcPackages ? { rtcPackages } : {}),
    peerConnectionOptions: { bindAddress: '127.0.0.1' },
    logger: userBind.logger,
});
result.defaultAppliedWithoutOption = isApplied(plain.messages);
result.defaultAppliedWithUserBind = isApplied(userBind.messages);
await plainNet.close?.();
await userNet.close?.();

console.log(JSON.stringify(result));
process.exit(0);
