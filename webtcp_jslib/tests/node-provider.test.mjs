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
