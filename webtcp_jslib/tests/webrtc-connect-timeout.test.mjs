/**
 * 接続タイムアウトの原因の説明（#61）。
 *
 * 収集が完了しても ICE 候補が 1 件も無いとき（node-datachannel の自動バインドでリンクローカルのみのホスト）、
 * タイムアウトのエラーに bind の設定を示す。候補がある場合・収集中の場合は原因を付けない。
 * 実 `node-datachannel` を使うテストは、そのパッケージが無い環境では skip する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { NodeWebRTCChannel, SignalingAdapterHub, noopLogger } from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const REMEDY = 'peerConnectionOptions.bindAddress';

/** 収集状態と SDP の候補行を指定できる fake PC。 */
class GatheringPeerConnection extends FakeRTCPeerConnection {
    constructor(config, { gathering, candidateLines }) {
        super(config);
        this.gathering = gathering;
        this.candidateLines = candidateLines;
    }

    get iceGatheringState() {
        return this.gathering;
    }

    async setLocalDescription(description) {
        const extra = this.candidateLines
            ? Array.from({ length: this.candidateLines }, (_, i) => `\na=candidate:${i + 1} 1 udp 1 127.0.0.1 ${9000 + i} typ host`)
            : [];
        await super.setLocalDescription({ type: description.type, sdp: `${description.sdp}${extra.join('')}` });
    }
}

async function connectWith(pcOptions, channelOptions = {}) {
    resetFakeWebRTC();
    const hub = await startHub();
    const signaling = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 20, logger: noopLogger });
    const channel = new NodeWebRTCChannel(signaling, {
        createPeerConnection: (config) => new GatheringPeerConnection(config, pcOptions),
        connectTimeoutMs: 60,
        logger: noopLogger,
        ...channelOptions,
    });
    await channel.start();
    let message = null;
    try {
        await channel.connect(B);
    } catch (error) {
        message = error.message;
    } finally {
        channel.close();
        await hub.close();
    }
    assert.ok(message, 'connect must reject when no remote peer answers');
    return message;
}

test('webrtc-connect-timeout: gathering complete with 0 local candidates → the timeout names the bindAddress remedy (#61)', async () => {
    const message = await connectWith({ gathering: 'complete', candidateLines: 0 });
    assert.match(message, /timed out after 60ms/);
    assert.match(message, /0 local candidates/);
    assert.match(message, new RegExp(REMEDY.replace('.', '\\.')));
    assert.match(message, /issues\/61/);
});

test('webrtc-connect-timeout: gathering complete with a local candidate → plain timeout, no cause claimed', async () => {
    const message = await connectWith({ gathering: 'complete', candidateLines: 1 });
    assert.match(message, /timed out after 60ms$/);
    assert.doesNotMatch(message, /bindAddress/);
});

test('webrtc-connect-timeout: still gathering → plain timeout, no cause claimed', async () => {
    const message = await connectWith({ gathering: 'gathering', candidateLines: 0 });
    assert.match(message, /timed out after 60ms$/);
    assert.doesNotMatch(message, /bindAddress/);
});

const probeScript = fileURLToPath(new URL('./helpers/node-datachannel-timeout-probe.mjs', import.meta.url));

function runRealProbe() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [probeScript], { timeout: 90_000 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`probe failed: ${error.message}\n${stderr}`));
            resolve(JSON.parse(stdout.trim().split('\n').pop()));
        });
    });
}

test('webrtc-connect-timeout (real node-datachannel): auto-bind on this host either connects or names the bindAddress remedy', {
    timeout: 120_000,
}, async (t) => {
    // 子プロセスで実行する（ネイティブの PC がイベントループを保持するため）。結果は JSON で受け取る。
    const result = await runRealProbe();
    if (result.skipped) {
        t.skip(result.skipped);
        return;
    }
    if (result.candidates > 0) {
        t.skip(`auto-bind gathers ${result.candidates} candidate(s) on this host; the #61 condition is absent`);
        return;
    }
    assert.ok(result.message, 'auto-bind with 0 candidates must not connect');
    assert.match(result.message, /timed out after 3000ms/);
    assert.match(result.message, /0 local candidates/);
    assert.match(result.message, new RegExp(REMEDY.replace('.', '\\.')));
});
