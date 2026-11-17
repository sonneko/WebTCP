import test from 'node:test';
import assert from 'node:assert/strict';

import { HTTPClient, HTTPServer, WebTCPNetwork, noopLogger } from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

async function createPair(serverOptions = {}) {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000 },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { connectTimeoutMs: 2000 },
    });
    await a.start();
    await b.start();
    return { a, b, serverOptions };
}

function teardown(context) {
    context.server?.close();
    context.a.close();
    context.b.close();
}

test('http-server: serves a request and a response over the tunnel', async () => {
    const ctx = await createPair();
    try {
        let seenRemoteNodeId = null;
        const server = ctx.b.serveHTTP(8080, async (request, response) => {
            seenRemoteNodeId = request.remoteNodeId;
            assert.equal(request.method, 'GET');
            assert.equal(request.path, '/hello');
            assert.equal(request.query, '?x=1');
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            response.setHeader('x-custom', 'yes');
            await response.end(`hello ${request.query}`);
        });
        ctx.server = server;

        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/hello?x=1`);
        assert.equal(response.status, 200);
        assert.equal(response.statusText, 'OK');
        assert.equal(response.ok, true);
        assert.equal(response.headers.get('x-custom'), 'yes');
        assert.equal(await response.text(), 'hello ?x=1');
        assert.equal(seenRemoteNodeId, NODE_A);
    } finally {
        teardown(ctx);
    }
});

test('http-server: Connection: close gets its response after the client half-closes (FIN)', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('after-fin');
        });
        ctx.server = server;

        const client = new HTTPClient(ctx.a, { keepAlive: false });
        const response = await client.fetch(`webtcp://${NODE_B}:8080/close`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('connection'), 'close');
        assert.equal(await response.text(), 'after-fin');
        client.close();
    } finally {
        teardown(ctx);
    }
});

test('http-server: keep-alive reuses one connection for several requests', async () => {
    const ctx = await createPair();
    try {
        let connections = 0;
        const server = ctx.b.serveHTTP(8080, async (request, response) => {
            connections += 1;
            await response.end(`n=${request.path}`);
        });
        ctx.server = server;

        const client = new HTTPClient(ctx.a, { keepAlive: true });
        try {
            const first = await client.fetch(`webtcp://${NODE_B}:8080/one`);
            assert.equal(await first.text(), 'n=/one');
            const second = await client.fetch(`webtcp://${NODE_B}:8080/two`);
            assert.equal(await second.text(), 'n=/two');
            const third = await client.fetch(`webtcp://${NODE_B}:8080/three`);
            assert.equal(await third.text(), 'n=/three');
            assert.equal(connections, 3);
            assert.equal(client.pooledConnectionCount, 1);
        } finally {
            client.close();
        }
    } finally {
        teardown(ctx);
    }
});

test('http-server: POST body with Content-Length is delivered as a stream', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (request, response) => {
            const chunks = [];
            for await (const chunk of request.body) chunks.push(new TextDecoder().decode(chunk));
            response.setHeader('content-type', 'application/json');
            await response.end(JSON.stringify({ body: chunks.join(''), length: request.body.contentLength }));
        });
        ctx.server = server;

        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/echo`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'hello body',
        });
        assert.deepEqual(await response.json(), { body: 'hello body', length: 10 });
    } finally {
        teardown(ctx);
    }
});

test('http-server: POST body with chunked transfer encoding is decoded', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (request, response) => {
            await response.end(await request.body.text());
        });
        ctx.server = server;

        async function* body() {
            yield new TextEncoder().encode('abc');
            yield new TextEncoder().encode('def');
        }

        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/chunks`, {
            method: 'POST',
            body: body(),
        });
        assert.equal(await response.text(), 'abcdef');
    } finally {
        teardown(ctx);
    }
});

test('http-server: HEAD returns headers without a body', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (_request, response) => {
            response.setHeader('content-length', '11');
            await response.end('hello world');
        });
        ctx.server = server;

        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/head`, { method: 'HEAD' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-length'), '11');
        assert.equal((await response.arrayBuffer()).byteLength, 0);
    } finally {
        teardown(ctx);
    }
});

test('http-server: handler rejections become 500 and do not kill the server', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (request, response) => {
            if (request.path === '/boom') throw new Error('handler exploded');
            await response.end('ok');
        });
        ctx.server = server;

        const failed = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/boom`);
        assert.equal(failed.status, 500);
        assert.match(await failed.text(), /internal server error/);

        const fine = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/fine`);
        assert.equal(await fine.text(), 'ok');
    } finally {
        teardown(ctx);
    }
});

test('http-server: malformed request lines get a 400 and close the connection', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('should not happen');
        });
        ctx.server = server;

        const stream = await ctx.a.connect(NODE_B, 8080);
        await stream.send(new TextEncoder().encode('BROKEN REQUEST\r\n\r\n'));
        const chunks = [];
        stream.on('data', (data) => chunks.push(new TextDecoder().decode(data)));
        await waitFor(() => chunks.length > 0 || stream.state === 'CLOSED');
        assert.match(chunks.join(''), /HTTP\/1\.1 400/);
    } finally {
        teardown(ctx);
    }
});

test('http-server: request bodies over the configured limit get a 413', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(
            8080,
            async (_request, response) => {
                await response.end('too late');
            },
            { maxRequestBodyBytes: 16 },
        );
        ctx.server = server;

        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/big`, {
            method: 'POST',
            body: 'x'.repeat(64),
        });
        assert.equal(response.status, 413);
    } finally {
        teardown(ctx);
    }
});

test('http-server: 100-continue is answered when enabled', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(
            8080,
            async (_request, response) => {
                await response.end('done');
            },
            { send100Continue: true },
        );
        ctx.server = server;

        const stream = await ctx.a.connect(NODE_B, 8080);
        const received = [];
        stream.on('data', (data) => received.push(new TextDecoder().decode(data)));
        await stream.send(
            new TextEncoder().encode(
                'POST /upload HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n',
            ),
        );
        await waitFor(() => received.join('').includes('100 Continue'));
        await stream.send(new TextEncoder().encode('ok'));
        await waitFor(() => received.join('').includes('200 OK'));
    } finally {
        teardown(ctx);
    }
});

test('http-server: close() releases the port so it can be listened on again', async () => {
    const ctx = await createPair();
    try {
        const first = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('first');
        });
        // 同じポートの二重待ち受けは `listen()` の既存契約どおり拒否される
        assert.throws(() => ctx.b.serveHTTP(8080, async () => undefined), /already listening/);
        first.close();
        assert.equal(first.connectionCount, 0);
        assert.deepEqual(ctx.b.transportLayer.getListeningPorts(), []);

        const second = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('second');
        });
        ctx.server = second;
        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/after-close`);
        assert.equal(await response.text(), 'second');
    } finally {
        teardown(ctx);
    }
});

test('http-server: idle timeout closes an unused connection', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('ok');
        }, { idleTimeoutMs: 30 });
        ctx.server = server;

        const stream = await ctx.a.connect(NODE_B, 8080);
        // サーバーは FIN を送るので、クライアントは CLOSE_WAIT で終了通知を受ける
        await waitFor(() => stream.state === 'CLOSE_WAIT' || stream.state === 'CLOSED', {
            timeoutMs: 4000,
        });
    } finally {
        teardown(ctx);
    }
});

test('http-server: server.close() sends FIN so the client stream is not left dangling', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('ok');
        });
        const stream = await ctx.a.connect(NODE_B, 8080);
        await stream.send(
            new TextEncoder().encode('GET / HTTP/1.1\r\nHost: h\r\nConnection: keep-alive\r\n\r\n'),
        );
        await waitFor(() => stream.state === 'ESTABLISHED');
        server.close();
        // `destroy()` だけで閉じると相手は ESTABLISHED のまま残る（既知の落とし穴）
        await waitFor(() => stream.state === 'CLOSE_WAIT' || stream.state === 'CLOSED', {
            timeoutMs: 4000,
        });
    } finally {
        teardown(ctx);
    }
});

test('http-server: exports are usable directly', () => {
    assert.equal(typeof HTTPServer, 'function');
    assert.equal(typeof HTTPServer, 'function');
});
