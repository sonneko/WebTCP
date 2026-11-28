/**
 * 応答側の DTLS identity 未準備による失敗からの作り直し（#92 / #97、仕様 §10.3 の 7、設計 §3.46）。
 *
 * 応答側の最初の N 個の接続が、answer の設定で identity の無い失敗を返す。
 * - 1 回の失敗: 作り直した接続で接続できる（作り直しは 1 回）。
 * - 上限（3 回）まで失敗: 作り直しは止まり、発信側はタイムアウトする。
 * - identity 以外の失敗: 作り直さない。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeWebRTCChannel, SignalingAdapterHub, noopLogger } from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

const IDENTITY_ERROR =
    "Failed to execute 'setLocalDescription' on 'RTCPeerConnection': Failed to set local answer sdp: " +
    "Failed to apply the description for m= section with mid='0': Fingerprint provided but no identity available.";

/** answer の設定で、指定したメッセージの失敗を返す fake 接続。 */
class FailingAnswerPeerConnection extends FakeRTCPeerConnection {
    constructor(config, failMessage) {
        super(config);
        this.failMessage = failMessage;
    }

    async setLocalDescription(description) {
        if (description.type === 'answer' && this.failMessage) {
            throw new Error(this.failMessage);
        }
        return super.setLocalDescription(description);
    }
}

/**
 * 応答側（A）の最初の `failures` 個の接続を失敗させる。発信側（B）は通常の接続。
 * 応答側のログ（warn）を集める。
 */
async function setup({ failures, failMessage, initiatorTimeoutMs }) {
    resetFakeWebRTC();
    const hub = await startHub();
    const warnings = [];
    const answerLogger = {
        debug() {},
        info() {},
        warn: (message) => warnings.push(String(message)),
        error() {},
    };

    const answererConnections = [];
    let remaining = failures;

    const sigA = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 20, logger: noopLogger });
    const answerer = new NodeWebRTCChannel(sigA, {
        createPeerConnection: (config) => {
            const pc = new FailingAnswerPeerConnection(config, remaining > 0 ? failMessage : null);
            if (remaining > 0) remaining -= 1;
            answererConnections.push(pc);
            return pc;
        },
        connectTimeoutMs: 15_000,
        logger: answerLogger,
    });

    const sigB = new SignalingAdapterHub({ url: hub.url, nodeId: B, pollIntervalMs: 20, logger: noopLogger });
    const initiator = new NodeWebRTCChannel(sigB, {
        createPeerConnection: (config) => new FakeRTCPeerConnection(config),
        connectTimeoutMs: initiatorTimeoutMs,
        logger: noopLogger,
    });

    await answerer.start();
    await initiator.start();

    return {
        initiator,
        answererConnections,
        warnings,
        async close() {
            initiator.close();
            answerer.close();
            await hub.close();
        },
    };
}

test('webrtc-identity-rebuild: one identity failure → the rebuilt answering connection connects (#97)', async () => {
    const env = await setup({ failures: 1, failMessage: IDENTITY_ERROR, initiatorTimeoutMs: 10_000 });
    try {
        const started = Date.now();
        await env.initiator.connect(A);
        const elapsed = Date.now() - started;

        assert.equal(env.initiator.connectedPeers.get(A), true, 'the initiator must be connected');
        assert.equal(env.answererConnections.length, 2, 'the answering side must rebuild exactly once');
        assert.ok(elapsed >= 900, `the rebuild must wait before retrying (elapsed ${elapsed}ms)`);
        assert.equal(
            env.warnings.filter((w) => /rebuilding/.test(w)).length,
            1,
            'exactly one rebuild must be logged',
        );
    } finally {
        await env.close();
    }
});

test('webrtc-identity-rebuild: identity failures on every attempt → at most 3 connections, then the initiator times out (#97)', async () => {
    const env = await setup({ failures: 99, failMessage: IDENTITY_ERROR, initiatorTimeoutMs: 4_000 });
    try {
        await assert.rejects(env.initiator.connect(A), /timed out/);
        assert.equal(env.answererConnections.length, 3, 'the answering side must stop at 3 attempts');
        assert.equal(
            env.warnings.filter((w) => /rebuilding/.test(w)).length,
            2,
            'two rebuilds are logged (the third attempt gives up without a rebuild)',
        );
    } finally {
        await env.close();
    }
});

test('webrtc-identity-rebuild: a non-identity failure is not rebuilt (#97)', async () => {
    const env = await setup({
        failures: 1,
        failMessage: "Failed to execute 'setLocalDescription' on 'RTCPeerConnection': something else went wrong.",
        initiatorTimeoutMs: 1_500,
    });
    try {
        await assert.rejects(env.initiator.connect(A), /timed out/);
        assert.equal(env.answererConnections.length, 1, 'a non-identity failure must not create a second connection');
        assert.equal(env.warnings.filter((w) => /rebuilding/.test(w)).length, 0);
    } finally {
        await env.close();
    }
});
