import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveNodeRTCProvider,
    WebRTCProviderUnavailableError,
    DEFAULT_NODE_RTC_PACKAGES,
    createNodeNetwork,
    NodeKeyManager,
    noopLogger,
} from '../dist/index.js';

class FakePC {
    constructor(config) {
        this.config = config;
    }
}

test('node-provider: default order is @roamhq/wrtc then node-datachannel/polyfill (#52)', () => {
    assert.deepEqual([...DEFAULT_NODE_RTC_PACKAGES], ['@roamhq/wrtc', 'node-datachannel/polyfill']);
});

test('node-provider: resolves a named export, a default export and a global polyfill', async () => {
    const named = await resolveNodeRTCProvider({ importer: async () => ({ RTCPeerConnection: FakePC }) });
    assert.equal(named.name, '@roamhq/wrtc');
    const pc = named.createPeerConnection({ iceServers: [] });
    assert.ok(pc instanceof FakePC);
    assert.deepEqual(pc.config, { iceServers: [] });

    const fallback = [];
    const second = await resolveNodeRTCProvider({
        importer: async (name) => {
            fallback.push(name);
            if (name === '@roamhq/wrtc') throw new Error("Cannot find package '@roamhq/wrtc'");
            return { default: { RTCPeerConnection: FakePC } };
        },
    });
    assert.equal(second.name, 'node-datachannel/polyfill');
    assert.deepEqual(fallback, ['@roamhq/wrtc', 'node-datachannel/polyfill']);

    const previous = globalThis.RTCPeerConnection;
    globalThis.RTCPeerConnection = FakePC;
    try {
        const polyfilled = await resolveNodeRTCProvider({ importer: async () => ({}) , packages: ['x'] });
        assert.equal(polyfilled.name, 'x');
    } finally {
        globalThis.RTCPeerConnection = previous;
    }
});

test('node-provider: throws a typed error listing every attempt when nothing is installed', async () => {
    await assert.rejects(
        () =>
            resolveNodeRTCProvider({
                importer: async (name) => {
                    throw new Error(`Cannot find package '${name}'`);
                },
            }),
        (error) => {
            assert.ok(error instanceof WebRTCProviderUnavailableError);
            assert.equal(error.name, 'WebRTCProviderUnavailableError');
            assert.deepEqual([...error.tried], [...DEFAULT_NODE_RTC_PACKAGES]);
            assert.match(error.message, /npm install/);
            assert.match(error.message, /@roamhq\/wrtc/);
            return true;
        },
    );
});

test('node-provider: a module without RTCPeerConnection is reported, not used', async () => {
    await assert.rejects(
        () => resolveNodeRTCProvider({ importer: async () => ({ something: 1 }), packages: ['only-one'] }),
        (error) => error instanceof WebRTCProviderUnavailableError && /exposes no RTCPeerConnection/.test(error.message),
    );
});

test('node-provider: createNodeNetwork uses an injected factory and wires v2 keys (#52)', async () => {
    const keys = await NodeKeyManager.create();
    const signaling = {
        getLocalNodeId: () => keys.nodeId,
        sendMessage: async () => undefined,
        listen: async () => undefined,
        close: () => undefined,
    };
    const network = await createNodeNetwork({
        signaling,
        keyManager: keys,
        createPeerConnection: (config) => new FakePC(config),
        logger: noopLogger,
    });
    try {
        assert.equal(network.localNodeId, keys.nodeId);
        assert.equal(network.signaturesRequired, true);
        assert.ok(network.keyDirectory);
    } finally {
        network.close();
    }
});

test('node-provider: createNodeNetwork without any provider fails with the typed error', async () => {
    const keys = await NodeKeyManager.create();
    const signaling = { getLocalNodeId: () => keys.nodeId, sendMessage: async () => undefined, listen: async () => undefined };
    await assert.rejects(
        () => createNodeNetwork({ signaling, keyManager: keys, rtcPackages: ['webtcp-no-such-rtc-package'], logger: noopLogger }),
        WebRTCProviderUnavailableError,
    );
});

// #61: ICE 候補が 0 件のまま収集が完了したら警告する（既定の bind は変えない）
import { watchIceGathering } from '../dist/adapters/webrtc/nodeProvider.js';

class GatheringPC extends EventTarget {
    constructor(candidateCount) {
        super();
        this.iceGatheringState = 'new';
        this.candidateCount = candidateCount;
        this.localDescription = null;
    }
    finishGathering() {
        // 収集完了後の localDescription は候補を含む（非 trickle）。イベントは配送しない実装を想定する。
        const lines = ['v=0'];
        for (let i = 0; i < this.candidateCount; i += 1) lines.push(`a=candidate:${i} 1 UDP 1 127.0.0.1 9 typ host`);
        this.localDescription = { type: 'offer', sdp: lines.join('\r\n') + '\r\n' };
        this.iceGatheringState = 'complete';
        this.dispatchEvent(new Event('icegatheringstatechange'));
    }
}

function captureWarnings() {
    const warnings = [];
    return { warnings, logger: { ...noopLogger, warn: (message) => warnings.push(String(message)) } };
}

test('ICE gathering: warns when completion yields zero candidates (#61)', () => {
    const pc = new GatheringPC(0);
    const { warnings, logger } = captureWarnings();
    assert.equal(watchIceGathering(pc, logger), pc);
    pc.finishGathering();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bindAddress/);
    assert.match(warnings[0], /issues\/61/);
});

test('ICE gathering: no warning when local candidates were gathered', () => {
    const pc = new GatheringPC(2);
    const { warnings, logger } = captureWarnings();
    watchIceGathering(pc, logger);
    pc.finishGathering();
    assert.equal(warnings.length, 0);
});

test('ICE gathering: a peer connection without addEventListener is returned unchanged', () => {
    const plain = { iceGatheringState: 'complete' };
    const { warnings, logger } = captureWarnings();
    assert.equal(watchIceGathering(plain, logger), plain);
    assert.equal(warnings.length, 0);
});
