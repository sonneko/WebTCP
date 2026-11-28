/**
 * 接続ごとに `connection-status(true)` が 1 回だけ発火すること（#93、仕様 §10.3 の 4、設計 §3.47）。
 *
 * ブラウザは、応答側で同じリモートのデータチャネルの `open` を 2 回通知することがある（Chromium 158 で観測）。
 * その通知をそのまま再現する fake を使い、発火が 1 回であることを確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeWebRTCChannel, SignalingAdapterHub, noopLogger } from '../dist/index.js';
import { FakeRTCPeerConnection, resetFakeWebRTC } from './helpers/fake-webrtc.mjs';
import { startHub } from './helpers/hub.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

/**
 * 応答側の `ondatachannel` の後に、同じチャネルの `onopen` をもう一度呼ぶ fake（重複通知の再現）。
 * `duplicateOpen` が false のときは通常どおり 1 回だけ open する。
 */
class DuplicateOpenPeerConnection extends FakeRTCPeerConnection {
    constructor(config, duplicateOpen) {
        super(config);
        this.duplicateOpen = duplicateOpen;
        this.handler = null;
    }

    get ondatachannel() {
        return this.handler;
    }

    set ondatachannel(handler) {
        if (!handler) {
            this.handler = null;
            return;
        }
        this.handler = (event) => {
            handler(event);
            if (this.duplicateOpen) {
                // ブラウザが同じデータチャネルの open を重ねて通知した場合を再現する
                event.channel.onopen?.({});
            }
        };
    }
}

async function connectAndCountOpenEvents({ duplicateOpen }) {
    resetFakeWebRTC();
    const hub = await startHub();
    const counts = [];

    // 応答側（A）の接続状態の発火を数える。重複通知は応答側で起きる。
    const sigA = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 20, logger: noopLogger });
    const answerer = new NodeWebRTCChannel(sigA, {
        createPeerConnection: (config) => new DuplicateOpenPeerConnection(config, duplicateOpen),
        connectTimeoutMs: 5000,
        logger: noopLogger,
    });
    answerer.on('connection-status', (peerId, isConnected) => counts.push([peerId, isConnected]));

    const sigB = new SignalingAdapterHub({ url: hub.url, nodeId: B, pollIntervalMs: 20, logger: noopLogger });
    const initiator = new NodeWebRTCChannel(sigB, {
        createPeerConnection: (config) => new FakeRTCPeerConnection(config),
        connectTimeoutMs: 5000,
        logger: noopLogger,
    });

    await answerer.start();
    await initiator.start();
    try {
        await initiator.connect(A);
        // 重複した open は、接続の確立の直後に届く。少し待ってから数える。
        await new Promise((resolve) => setTimeout(resolve, 50));
        return counts.filter(([, connected]) => connected).length;
    } finally {
        initiator.close();
        answerer.close();
        await hub.close();
    }
}

test('neighbor-connected-once: a duplicate DataChannel open still emits connection-status(true) once per connection (#93)', async () => {
    const connectedEvents = await connectAndCountOpenEvents({ duplicateOpen: true });
    assert.equal(connectedEvents, 1);
});

test('neighbor-connected-once (control): a single DataChannel open emits connection-status(true) once (#93)', async () => {
    const connectedEvents = await connectAndCountOpenEvents({ duplicateOpen: false });
    assert.equal(connectedEvents, 1);
});
