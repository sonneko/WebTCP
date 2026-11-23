import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { createDemoServer } from '../../examples/server.mjs';
import {
    SignalingAdapterHub,
    SseSignalingAdapter,
    WebSocketSignalingAdapter,
    noopLogger,
} from '../dist/index.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

/** デモサーバーを 0 番ポートで起動し、TCP プロキシ越しに接続できるようにする。 */
async function startServer() {
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    /** 押し込み型の接続（SSE の GET /events、WebSocket の Upgrade）の回数。 */
    const streams = { count: 0 };
    server.prependListener('request', (req) => {
        if (req.url?.startsWith('/events')) streams.count += 1;
    });
    server.prependListener('upgrade', () => {
        streams.count += 1;
    });
    return {
        server,
        streams,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

/**
 * 接続を中継する TCP プロキシ。`dropAll()` で中継中の接続をすべて切る（再接続の検証用）。
 */
async function startProxy(targetUrl) {
    const target = new URL(targetUrl);
    const sockets = new Set();
    const proxy = net.createServer((client) => {
        const upstream = net.connect(Number(target.port), target.hostname);
        sockets.add(client);
        sockets.add(upstream);
        const forget = () => {
            sockets.delete(client);
            sockets.delete(upstream);
        };
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.on('close', () => {
            upstream.destroy();
            forget();
        });
        upstream.on('close', () => {
            client.destroy();
            forget();
        });
        client.pipe(upstream);
        upstream.pipe(client);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${proxy.address().port}`,
        dropAll: () => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
        },
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            proxy.close(() => resolve());
        }),
    };
}

async function waitUntil(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitUntil: condition was not met');
}

const TRANSPORTS = {
    sse: (options) => new SseSignalingAdapter({ ...options, initialMs: 50, maxMs: 200 }),
    ws: (options) => new WebSocketSignalingAdapter({ ...options, initialMs: 50, maxMs: 200 }),
};

for (const [name, make] of Object.entries(TRANSPORTS)) {
    test(`signaling ${name}: messages are delivered between two adapters, in order, with identical content`, async () => {
        const hub = await startServer();
        const a = make({ url: hub.url, nodeId: A, logger: noopLogger });
        const b = make({ url: hub.url, nodeId: B, logger: noopLogger });
        try {
            await a.listen(() => {});
            const received = [];
            await b.listen((fromId, message) => received.push({ fromId, message }));

            const sent = [];
            for (let i = 0; i < 20; i += 1) {
                const message = { type: 'candidate', content: { candidate: `c${i}`, sdpMid: '0' }, fromId: A };
                sent.push(message);
                await a.sendMessage(B, message);
            }
            await waitUntil(() => received.length === sent.length);

            assert.deepEqual(
                received.map((entry) => entry.fromId),
                sent.map(() => A),
            );
            assert.deepEqual(
                received.map((entry) => entry.message.content),
                sent.map((message) => message.content),
            );
            assert.deepEqual(
                received.map((entry) => entry.message.type),
                sent.map((message) => message.type),
            );
        } finally {
            a.close();
            b.close();
            await hub.close();
        }
    });

    test(`signaling ${name}: messages sent while the adapter was disconnected are replayed once after reconnect`, async () => {
        const hub = await startServer();
        const proxy = await startProxy(hub.url);
        const a = make({ url: hub.url, nodeId: A, logger: noopLogger });
        const b = make({ url: proxy.url, nodeId: B, logger: noopLogger });
        try {
            await a.listen(() => {});
            const received = [];
            await b.listen((fromId, message) => received.push(message.content.n));

            await a.sendMessage(B, { type: 'offer', content: { n: 1 }, fromId: A });
            await waitUntil(() => received.length === 1);

            // B の接続だけを切る。その間に届いたメッセージは保持されているはず
            proxy.dropAll();
            await a.sendMessage(B, { type: 'public-key', content: { n: 2 }, fromId: A });
            await a.sendMessage(B, { type: 'candidate', content: { n: 3 }, fromId: A });

            await waitUntil(() => received.length === 3, 6000);
            assert.deepEqual(received, [1, 2, 3], 'replayed in order, without duplicates');
        } finally {
            a.close();
            b.close();
            await proxy.close();
            await hub.close();
        }
    });

    test(`signaling ${name}: a listener that connects late receives the retained messages`, async () => {
        const hub = await startServer();
        const a = make({ url: hub.url, nodeId: A, logger: noopLogger });
        const b = make({ url: hub.url, nodeId: B, logger: noopLogger });
        try {
            await a.listen(() => {});
            await a.sendMessage(B, { type: 'offer', content: { n: 1 }, fromId: A });
            await a.sendMessage(B, { type: 'answer', content: { n: 2 }, fromId: A });

            const received = [];
            await b.listen((fromId, message) => received.push(message.content.n));
            await waitUntil(() => received.length === 2);
            assert.deepEqual(received, [1, 2]);
        } finally {
            a.close();
            b.close();
            await hub.close();
        }
    });

    test(`signaling ${name}: a fresh listener does not receive messages that an earlier listener already got`, async () => {
        const hub = await startServer();
        const a = make({ url: hub.url, nodeId: A, logger: noopLogger });
        const first = make({ url: hub.url, nodeId: B, logger: noopLogger });
        const second = make({ url: hub.url, nodeId: B, logger: noopLogger });
        try {
            await a.listen(() => {});
            const firstReceived = [];
            await first.listen((fromId, message) => firstReceived.push(message.content.n));
            await a.sendMessage(B, { type: 'offer', content: { n: 1 }, fromId: A });
            await waitUntil(() => firstReceived.length === 1);
            first.close();

            // 同じ NodeId の新しいリスナー（別タブの再起動など）は、既に配られた 1 を受け取らない
            const secondReceived = [];
            await second.listen((fromId, message) => secondReceived.push(message.content.n));
            await a.sendMessage(B, { type: 'answer', content: { n: 2 }, fromId: A });
            await waitUntil(() => secondReceived.length === 1);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.deepEqual(secondReceived, [2]);
        } finally {
            a.close();
            first.close();
            second.close();
            await hub.close();
        }
    });

    test(`signaling ${name}: a failed first connection rejects listen()`, async () => {
        const adapter = make({ url: 'http://127.0.0.1:1', nodeId: A, logger: noopLogger });
        await assert.rejects(adapter.listen(() => {}));
        adapter.close();
    });

    test(`signaling ${name}: close() stops reconnecting`, async () => {
        const hub = await startServer();
        const proxy = await startProxy(hub.url);
        const b = make({ url: proxy.url, nodeId: B, logger: noopLogger });
        try {
            await b.listen(() => {});
            const before = hub.streams.count;
            b.close();
            proxy.dropAll();
            // 再接続が走れば（バックオフは 50〜200 ms）、ここで接続が増える
            await new Promise((resolve) => setTimeout(resolve, 700));
            assert.equal(hub.streams.count, before, 'no new stream after close()');
        } finally {
            await proxy.close();
            await hub.close();
        }
    });
}

for (const [name, make] of Object.entries(TRANSPORTS)) {
    test(`signaling ${name}: a large SDP (over 64 KiB) is delivered intact`, async () => {
        const hub = await startServer();
        const a = make({ url: hub.url, nodeId: A, logger: noopLogger });
        const b = make({ url: hub.url, nodeId: B, logger: noopLogger });
        try {
            await a.listen(() => {});
            const received = [];
            await b.listen((fromId, message) => received.push(message));
            const sdp = `v=0\r\n${'a=candidate:1 1 udp 2113937151 10.0.0.1 9 typ host\r\n'.repeat(3000)}`;
            assert.ok(Buffer.byteLength(sdp) > 65_536, 'payload exceeds the 16-bit length');
            await a.sendMessage(B, { type: 'offer', content: { type: 'offer', sdp }, fromId: A });
            await waitUntil(() => received.length === 1, 6000);
            assert.equal(received[0].content.sdp, sdp);
        } finally {
            a.close();
            b.close();
            await hub.close();
        }
    });
}

test('signaws: a fragmented client text frame (continuation) is reassembled and routed', async () => {
    const hub = await startServer();
    const port = Number(new URL(hub.url).port);
    const b = new WebSocketSignalingAdapter({ url: hub.url, nodeId: B, logger: noopLogger, initialMs: 50, maxMs: 200 });
    try {
        const received = [];
        await b.listen((fromId, message) => received.push({ fromId, message }));

        const payload = Buffer.from(
            JSON.stringify({ type: 'send', toId: B, message: { type: 'candidate', content: { candidate: 'fragmented' }, fromId: A } }),
        );
        const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
        const masked = (chunk) => Buffer.from(chunk.map((byte, i) => byte ^ mask[i % 4]));
        // 50 バイトずつの断片に分ける。先頭は FIN=0 のテキスト、
        // 中間と最後は continuation（最後だけ FIN=1）。すべてマスク付き
        const chunks = [];
        for (let offset = 0; offset < payload.length; offset += 50) {
            chunks.push(payload.subarray(offset, offset + 50));
        }
        assert.ok(chunks.length >= 3, 'the test payload spans several fragments');
        const frames = chunks.map((chunk, index) => {
            const first = index === 0;
            const last = index === chunks.length - 1;
            const b0 = (last ? 0x80 : 0x00) | (first ? 0x01 : 0x00);
            return Buffer.concat([Buffer.from([b0, 0x80 | chunk.length]), mask, masked(chunk)]);
        });

        const socket = net.connect(port, '127.0.0.1');
        await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.write(
                `GET /ws?nodeId=${A} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                    'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
            );
            socket.once('data', () => resolve());
        });
        for (const frame of frames) socket.write(frame);

        await waitUntil(() => received.length === 1);
        assert.equal(received[0].fromId, A);
        assert.equal(received[0].message.content.candidate, 'fragmented');
        socket.destroy();
    } finally {
        b.close();
        await hub.close();
    }
});

test('signaling: the default (polling) adapter is unchanged and still works against the reference server', async () => {
    const hub = await startServer();
    const a = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 20, logger: noopLogger });
    const b = new SignalingAdapterHub({ url: hub.url, nodeId: B, pollIntervalMs: 20, logger: noopLogger });
    try {
        await a.listen(() => {});
        const received = [];
        await b.listen((fromId, message) => received.push(message.content.n));
        await a.sendMessage(B, { type: 'offer', content: { n: 1 }, fromId: A });
        await waitUntil(() => received.length === 1);
        assert.deepEqual(received, [1]);
    } finally {
        a.close();
        b.close();
        await hub.close();
    }
});

test('signaling ws: a frame from a client that is not masked is rejected (RFC 6455 §5.1)', async () => {
    const hub = await startServer();
    const port = Number(new URL(hub.url).port);
    try {
        const response = await new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write(
                    `GET /ws?nodeId=${B} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
                );
            });
            let data = Buffer.alloc(0);
            socket.on('data', (chunk) => {
                data = Buffer.concat([data, chunk]);
                // 101 応答の後に、マスクなしのテキストフレーム（0x81 0x02 'hi'）を送る
                if (data.toString('latin1').includes('101 Switching Protocols') && !socket.sentFrame) {
                    socket.sentFrame = true;
                    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
                }
                if (data.length > 0 && data.includes(Buffer.from([0x88]))) {
                    resolve(data);
                    socket.destroy();
                }
            });
            socket.on('close', () => resolve(data));
            socket.on('error', reject);
        });
        assert.ok(response.toString('latin1').includes('101 Switching Protocols'));
        // 1002（protocol error）で閉じるクローズフレームが返る
        const closeIndex = response.indexOf(Buffer.from([0x88]));
        assert.ok(closeIndex >= 0, 'server sends a close frame');
        assert.equal(response.readUInt16BE(closeIndex + 2), 1002);
    } finally {
        await hub.close();
    }
});
