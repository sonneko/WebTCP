import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
    WebTCPNetwork,
    NodeKeyManager,
    noopLogger,
} from '../dist/index.js';
import { TcpBridge, BridgeSecurityError, assertBridgeSecurity, isLoopbackHost } from '../dist/adapters/bridge/TcpBridge.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

const transport = { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } };

function node(hub, keyManager) {
    return new WebTCPNetwork({
        channel: hub.createChannel(keyManager.nodeId),
        keyManager,
        logger: noopLogger,
        transport,
    });
}

/** 2 ノード（v2）を接続し、公開鍵の伝播まで待つ。 */
async function signedPair() {
    const hub = new LoopbackNetwork();
    const [ka, kb] = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create()]);
    const a = node(hub, ka);
    const b = node(hub, kb);
    await Promise.all([a.start(), b.start()]);
    await a.connectToPeer(b.localNodeId);
    await waitFor(() => a.keyDirectory.get(b.localNodeId) !== undefined, { timeoutMs: 4000 });
    return { hub, a, b };
}

/** 送信バッファ満杯を待ちながら分割送信する（テスト用のエコーサービス）。 */
async function sendAll(stream, data) {
    for (let off = 0; off < data.length; off += 16 * 1024) {
        const part = data.subarray(off, off + 16 * 1024);
        for (;;) {
            try {
                await stream.send(part);
                break;
            } catch (error) {
                if (!/Send buffer full/.test(error.message)) throw error;
                await new Promise((resolve) => stream.once('drain', resolve));
            }
        }
    }
}

function echoService(network, port) {
    network.listen(port, (stream) => {
        let chain = Promise.resolve();
        stream.on('data', (data) => {
            chain = chain.then(() => sendAll(stream, data));
        });
        stream.on('end', () => {
            void chain.then(() => stream.end());
        });
        stream.on('error', () => undefined);
    });
}

function tcpConnect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
    });
}

function collect(socket) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.once('end', () => resolve(Buffer.concat(chunks)));
        socket.once('error', reject);
    });
}

test('bridge: loopback host check and security gates (§17.3)', async () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
    assert.equal(isLoopbackHost('192.168.1.5'), false);

    const hub = new LoopbackNetwork();
    const keyed = node(hub, await NodeKeyManager.create());
    const unsigned = new WebTCPNetwork({ channel: hub.createChannel('u'.repeat(32)), logger: noopLogger, transport });
    try {
        assert.doesNotThrow(() => assertBridgeSecurity(keyed, { host: '127.0.0.1' }));
        assert.throws(
            () => assertBridgeSecurity(unsigned, { host: '127.0.0.1' }),
            (error) => error instanceof BridgeSecurityError && error.code === 'signatures-required',
        );
        assert.throws(
            () => assertBridgeSecurity(keyed, { host: '0.0.0.0' }),
            (error) => error instanceof BridgeSecurityError && error.code === 'non-loopback-bind',
        );
        assert.doesNotThrow(() => assertBridgeSecurity(keyed, { host: '0.0.0.0', allowNonLoopbackBind: true }));
        // 生成時点で拒否する（待ち受けを開かない）
        assert.throws(
            () => new TcpBridge({ network: unsigned, target: { nodeId: 'a'.repeat(32), port: 1 } }),
            BridgeSecurityError,
        );
    } finally {
        keyed.close();
        unsigned.close();
    }
});

test('bridge: TCP round trip with half-close and access log (§17.4)', async () => {
    const { a, b } = await signedPair();
    echoService(b, 9001);
    const log = [];
    const bridge = new TcpBridge({
        network: a,
        target: { nodeId: b.localNodeId, port: 9001 },
        port: 0,
        onAccess: (entry) => log.push(entry),
        logger: noopLogger,
    });
    const { port } = await bridge.start();
    try {
        const socket = await tcpConnect(port);
        const reply = collect(socket);
        socket.write('hello through the tunnel');
        // クライアントの半クローズ: 送信を終えても応答は受け取れる
        socket.end();
        assert.equal((await reply).toString(), 'hello through the tunnel');

        await waitFor(() => log.some((e) => e.event === 'close'), { timeoutMs: 3000 });
        const events = log.map((e) => e.event);
        assert.deepEqual(events.filter((e) => e === 'open' || e === 'close'), ['open', 'close']);
        const close = log.find((e) => e.event === 'close');
        assert.equal(close.bytesUp, 'hello through the tunnel'.length);
        assert.equal(close.bytesDown, 'hello through the tunnel'.length);
        assert.equal(close.target, `${b.localNodeId}:9001`);
        assert.match(close.client, /^127\.0\.0\.1:\d+$/);
    } finally {
        await bridge.close();
        a.close();
        b.close();
    }
});

test('bridge: 300 KiB in both directions survives send-buffer backpressure (§17.4)', async () => {
    const { a, b } = await signedPair();
    echoService(b, 9002);
    const bridge = new TcpBridge({
        network: a,
        target: { nodeId: b.localNodeId, port: 9002 },
        logger: noopLogger,
        onAccess: () => undefined,
    });
    const { port } = await bridge.start();
    try {
        const payload = Buffer.alloc(300 * 1024);
        for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff;
        const socket = await tcpConnect(port);
        const reply = collect(socket);
        socket.end(payload);
        const echoed = await reply;
        assert.equal(echoed.length, payload.length);
        assert.equal(
            createHash('sha256').update(echoed).digest('hex'),
            createHash('sha256').update(payload).digest('hex'),
        );
    } finally {
        await bridge.close();
        a.close();
        b.close();
    }
});

test('bridge: a plain HTTP client (curl-like) reaches serveHTTP on the remote node', async () => {
    const { a, b } = await signedPair();
    b.serveHTTP(8080, async (request, response) => {
        await response.end(JSON.stringify({ method: request.method, path: request.path, query: request.query }));
    });
    const bridge = new TcpBridge({
        network: a,
        target: { nodeId: b.localNodeId, port: 8080 },
        logger: noopLogger,
        onAccess: () => undefined,
    });
    const { port } = await bridge.start();
    try {
        const socket = await tcpConnect(port);
        const reply = collect(socket);
        socket.write('GET /api/echo?x=1 HTTP/1.1\r\nHost: service\r\nConnection: close\r\n\r\n');
        const text = (await reply).toString('utf8');
        assert.match(text, /^HTTP\/1\.1 200 /);
        assert.match(text, /"path":"\/api\/echo"/);
        assert.match(text, /"query":"\?x=1"/);
    } finally {
        await bridge.close();
        a.close();
        b.close();
    }
});

test('bridge: refuses a target whose public key is unknown (v1 peer) by default (§17.3)', async () => {
    const hub = new LoopbackNetwork();
    const keyed = node(hub, await NodeKeyManager.create());
    // 署名なし（v1）の相手
    const plain = new WebTCPNetwork({ channel: hub.createChannel('p'.repeat(32)), logger: noopLogger, transport });
    await keyed.start();
    await plain.start();
    const log = [];
    const bridge = new TcpBridge({
        network: keyed,
        target: { nodeId: plain.localNodeId, port: 9003 },
        keyWaitMs: 300,
        connectTimeoutMs: 1000,
        onAccess: (entry) => log.push(entry),
        logger: noopLogger,
    });
    const { port } = await bridge.start();
    try {
        const socket = await tcpConnect(port);
        const closed = new Promise((resolve) => socket.once('close', resolve));
        await closed;
        await waitFor(() => log.some((e) => e.event === 'refused'), { timeoutMs: 3000 });
        const refused = log.find((e) => e.event === 'refused');
        assert.match(refused.reason, /unknown|v1/);
        assert.equal(log.some((e) => e.event === 'open'), false, 'no tunnel may be opened to a v1 peer');
    } finally {
        await bridge.close();
        keyed.close();
        plain.close();
    }
});

test('bridge: a non-loopback bind is opt-in and the bridge can be closed', async () => {
    const { a, b } = await signedPair();
    const bridge = new TcpBridge({
        network: a,
        target: { nodeId: b.localNodeId, port: 9004 },
        host: '0.0.0.0',
        allowNonLoopbackBind: true,
        logger: noopLogger,
        onAccess: () => undefined,
    });
    const address = await bridge.start();
    assert.equal(address.host, '0.0.0.0');
    await bridge.close();
    assert.equal(bridge.activeConnections, 0);
    a.close();
    b.close();
});
