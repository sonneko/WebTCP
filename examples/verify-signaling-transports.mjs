#!/usr/bin/env node
/**
 * シグナリングの 3 つのトランスポート（ポーリング / SSE / WebSocket）が同じ結果を返すことを実行で確かめ、
 * 送信から受信までの遅延を比べる（specification.md §10.4.1、#45）。
 *
 * 検証内容:
 * - 同じメッセージ列（candidate・offer・public-key・80 KiB の SDP を含む）を 3 つで送る
 * - 受信側が受け取った結果（送信者・型・内容・順序）が 3 つで一致すること（不一致なら終了コード 1）
 * - 送信から受信までの遅延（中央値・最大）
 *
 * 実行方法:
 *   cd webtcp_jslib && npm ci && npm run build && cd ..
 *   node examples/verify-signaling-transports.mjs
 */

import { createDemoServer } from './server.mjs';
import {
    SignalingAdapterHub,
    SseSignalingAdapter,
    WebSocketSignalingAdapter,
    noopLogger,
} from '../webtcp_jslib/dist/index.js';

const MESSAGE_COUNT = 30;

const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

/** 同じ入力列を作る（送信のたびに送信時刻を内容へ入れて遅延を測る）。 */
function buildMessages(fromId) {
    const messages = [];
    for (let i = 0; i < MESSAGE_COUNT; i += 1) {
        if (i === 0) {
            messages.push({ type: 'offer', content: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' }, fromId });
        } else if (i === 1) {
            messages.push({ type: 'public-key', content: { type: 'public-key', publicKey: 'x'.repeat(43), nodeId: fromId }, fromId });
        } else if (i === 2) {
            // 80 KiB の SDP（64 KiB を超える。16 ビット長では表せないフレームを含む）
            const sdp = `v=0\r\n${'a=candidate:1 1 udp 2113937151 10.0.0.1 9 typ host\r\n'.repeat(1700)}`;
            messages.push({ type: 'offer', content: { type: 'offer', sdp }, fromId });
        } else {
            messages.push({ type: 'candidate', content: { candidate: `candidate:${i}`, sdpMid: '0', sdpMLineIndex: 0 }, fromId });
        }
    }
    return messages;
}

/** 受信結果から比較用の値だけを取り出す（時刻は除く）。 */
function normalize(entry) {
    return { fromId: entry.fromId, type: entry.message.type, content: entry.message.content };
}

const transports = {
    poll: (options) => new SignalingAdapterHub({ ...options, pollIntervalMs: 1000, logger: noopLogger }),
    sse: (options) => new SseSignalingAdapter({ ...options, logger: noopLogger }),
    ws: (options) => new WebSocketSignalingAdapter({ ...options, logger: noopLogger }),
};

const ID_BY_TRANSPORT = {
    poll: { sender: '10'.repeat(16), receiver: '11'.repeat(16) },
    sse: { sender: '20'.repeat(16), receiver: '21'.repeat(16) },
    ws: { sender: '30'.repeat(16), receiver: '31'.repeat(16) },
};

const results = {};
for (const [name, make] of Object.entries(transports)) {
    // トランスポートごとに別の NodeId を使い、前の実行の保持メッセージが混ざらないようにする
    const senderId = ID_BY_TRANSPORT[name].sender;
    const receiverId = ID_BY_TRANSPORT[name].receiver;
    const sender = make({ url, nodeId: senderId });
    const receiver = make({ url, nodeId: receiverId });
    const received = [];
    const latencies = [];
    const sentAt = new Map();

    await sender.listen(() => {});
    await receiver.listen((fromId, message) => {
        const sentAtMs = sentAt.get(message.content.candidate ?? message.type + ':' + (message.content.sdp?.length ?? 0));
        received.push({ fromId, message });
        if (sentAtMs !== undefined) latencies.push(performance.now() - sentAtMs);
    });

    const messages = buildMessages(senderId);
    const startedAt = performance.now();
    for (const message of messages) {
        const key = message.content.candidate ?? message.type + ':' + (message.content.sdp?.length ?? 0);
        sentAt.set(key, performance.now());
        await sender.sendMessage(receiverId, message);
    }

    const deadline = Date.now() + 15_000;
    while (received.length < messages.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const elapsedMs = performance.now() - startedAt;

    sender.close();
    receiver.close();

    results[name] = {
        senderId,
        count: received.length,
        normalized: received.map(normalize),
        elapsedMs: Math.round(elapsedMs),
        medianLatencyMs: latencies.length ? Math.round(median(latencies)) : null,
        maxLatencyMs: latencies.length ? Math.round(Math.max(...latencies)) : null,
    };
}

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

function median(values) {
    const sorted = [...values].sort((x, y) => x - y);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

let failed = false;
console.log(`[verify-signaling-transports] ${MESSAGE_COUNT} messages (incl. an 80 KiB SDP) per transport`);
for (const [name, result] of Object.entries(results)) {
    const expected = buildMessages(result.senderId).map((message) => ({ fromId: message.fromId, type: message.type, content: message.content }));
    const same = JSON.stringify(result.normalized) === JSON.stringify(expected);
    if (!same || result.count !== MESSAGE_COUNT) failed = true;
    console.log(
        `  ${name.padEnd(4)} received=${result.count}/${MESSAGE_COUNT} identical-to-input=${same ? 'yes' : 'NO'} ` +
            `total=${result.elapsedMs}ms latency(median)=${result.medianLatencyMs}ms latency(max)=${result.maxLatencyMs}ms`,
    );
}

if (failed) {
    console.error('[verify-signaling-transports] FAILED: transports disagree or lost messages');
    process.exit(1);
}
console.log('[verify-signaling-transports] all transports delivered identical results');
