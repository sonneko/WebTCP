import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HTTPClient,
    HTTPConnectionClosedError,
    HTTPResponseTooLargeError,
    HTTPRouter,
    HTTPTimeoutError,
    NameServer,
    WebTCPNetwork,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

async function createPair() {
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
    return { a, b };
}

function teardown(ctx) {
    ctx.client?.close();
    ctx.server?.close();
    ctx.a.close();
    ctx.b.close();
}

test('http-client: fetchURL forwards path and query, drops the fragment', async () => {
    const ctx = await createPair();
    try {
        const seen = [];
        ctx.server = ctx.b.serveHTTP(8080, async (request, response) => {
            seen.push({ target: request.target, path: request.path, query: request.query });
            response.setHeader('content-type', 'application/json');
            await response.end(JSON.stringify({ ok: true }));
        });
        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/deep/path?a=1&b=2#ignored`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.deepEqual(seen, [
            { target: '/deep/path?a=1&b=2', path: '/deep/path', query: '?a=1&b=2' },
        ]);
    } finally {
        teardown(ctx);
    }
});

test('http-client: name resolution via NameServer is used for fetch(url) with a name', async () => {
    const ctx = await createPair();
    try {
        const nameServer = new NameServer({ nodeId: NODE_A, logger: noopLogger });
        nameServer.registerA('demo-service', NODE_B, 60_000);
        let seenHost = null;
        ctx.server = ctx.b.serveHTTP(8080, async (request, response) => {
            seenHost = request.headers.get('host');
            await response.end('resolved');
        });
        const client = new HTTPClient(ctx.a, { nameServer, keepAlive: false });
        ctx.client = client;
        const response = await client.fetch('webtcp://demo-service:8080/');
        assert.equal(await response.text(), 'resolved');
        assert.equal(seenHost, 'demo-service:8080');
    } finally {
        teardown(ctx);
    }
});

test('http-client: HTTPRouter dispatches by method and path parameter', async () => {
    const ctx = await createPair();
    try {
        const router = new HTTPRouter();
        router.get('/users/:id', async (request, response) => {
            response.setHeader('content-type', 'application/json');
            await response.end(JSON.stringify({ id: request.params.id }));
        });
        router.post('/users', async (_request, response) => {
            response.statusCode = 201;
            await response.end('created');
        });
        ctx.server = ctx.b.serveHTTP(8080, router.handle);

        const found = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/users/abc`);
        assert.deepEqual(await found.json(), { id: 'abc' });

        const created = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/users`, { method: 'POST' });
        assert.equal(created.status, 201);

        // パスは一致するがメソッドが違う → 405、どちらも違う → 404
        const notAllowed = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/users/abc`, { method: 'POST' });
        assert.equal(notAllowed.status, 405);
        const notFound = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/unknown`);
        assert.equal(notFound.status, 404);
    } finally {
        teardown(ctx);
    }
});

test('http-client: text() can only be consumed once', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('once');
        });
        const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/once`);
        assert.equal(await response.text(), 'once');
        await assert.rejects(() => response.text(), /already been consumed/);
    } finally {
        teardown(ctx);
    }
});

test('http-client: maxResponseBytes rejects instead of buffering unbounded data', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('x'.repeat(4096));
        });
        const client = new HTTPClient(ctx.a, { keepAlive: false, maxResponseBytes: 1024 });
        ctx.client = client;
        const response = await client.fetch(`webtcp://${NODE_B}:8080/big`);
        await assert.rejects(() => response.text(), HTTPResponseTooLargeError);
    } finally {
        teardown(ctx);
    }
});

test('http-client: the streaming API bypasses maxResponseBytes', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await response.end('y'.repeat(65536));
        });
        const client = new HTTPClient(ctx.a, { keepAlive: false, maxResponseBytes: 1024 });
        ctx.client = client;
        const response = await client.fetch(`webtcp://${NODE_B}:8080/stream`);
        let total = 0;
        for await (const chunk of response.body) total += chunk.byteLength;
        assert.equal(total, 65536);
    } finally {
        teardown(ctx);
    }
});

test('http-client: a slow handler triggers HTTPTimeoutError', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await response.end('late');
        });
        const client = new HTTPClient(ctx.a, { keepAlive: false, timeoutMs: 50 });
        ctx.client = client;
        await assert.rejects(() => client.fetch(`webtcp://${NODE_B}:8080/slow`), HTTPTimeoutError);
    } finally {
        teardown(ctx);
    }
});

test('http-client: AbortSignal cancels a pending request', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await response.end('late');
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(
            () =>
                ctx.a.fetchURL(`webtcp://${NODE_B}:8080/abort`, {
                    signal: controller.signal,
                }),
            (error) => error.name === 'AbortError',
        );
    } finally {
        teardown(ctx);
    }
});

test('http-client: a connection closed mid-body rejects with HTTPConnectionClosedError', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (_request, response) => {
            // 100 バイト宣言して 12 バイトだけ書き、応答を終えずに終わる → 接続が切れる
            response.setHeader('content-length', '100');
            await response.write('only-a-little');
        });
        await assert.rejects(async () => {
            const response = await ctx.a.fetchURL(`webtcp://${NODE_B}:8080/truncated`);
            await response.text();
        }, HTTPConnectionClosedError);
    } finally {
        teardown(ctx);
    }
});

test('http-client: all concurrent fetches get their own connection', async () => {
    const ctx = await createPair();
    try {
        ctx.server = ctx.b.serveHTTP(8080, async (request, response) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await response.end(request.path);
        });
        const client = new HTTPClient(ctx.a, { keepAlive: true });
        ctx.client = client;
        const responses = await Promise.all([
            client.fetch(`webtcp://${NODE_B}:8080/r1`),
            client.fetch(`webtcp://${NODE_B}:8080/r2`),
            client.fetch(`webtcp://${NODE_B}:8080/r3`),
        ]);
        const bodies = await Promise.all(responses.map((response) => response.text()));
        assert.deepEqual(bodies.sort(), ['/r1', '/r2', '/r3']);
    } finally {
        teardown(ctx);
    }
});

test('http-client: 404 and 500 responses keep the connection reusable', async () => {
    const ctx = await createPair();
    try {
        let count = 0;
        ctx.server = ctx.b.serveHTTP(8080, async (request, response) => {
            count += 1;
            if (request.path === '/missing') {
                response.statusCode = 404;
                await response.end('not here');
                return;
            }
            response.statusCode = 500;
            await response.end('boom');
        });
        const client = new HTTPClient(ctx.a, { keepAlive: true });
        ctx.client = client;
        const missing = await client.fetch(`webtcp://${NODE_B}:8080/missing`);
        assert.equal(missing.status, 404);
        assert.equal(await missing.text(), 'not here');
        const broken = await client.fetch(`webtcp://${NODE_B}:8080/broken`);
        assert.equal(broken.status, 500);
        assert.equal(broken.ok, false);
        assert.equal(await broken.text(), 'boom');
        const again = await client.fetch(`webtcp://${NODE_B}:8080/missing`);
        assert.equal(again.status, 404);
        assert.equal(count, 3);
        assert.equal(client.pooledConnectionCount, 1);
    } finally {
        teardown(ctx);
    }
});

test('http-client: request() works with a nodeId and a custom port', async () => {
    const ctx = await createPair();
    try {
        let seenHost = null;
        ctx.server = ctx.b.serveHTTP(9090, async (request, response) => {
            seenHost = request.headers.get('host');
            await response.end(`direct ${request.path}`);
        });
        const client = new HTTPClient(ctx.a, { keepAlive: false });
        ctx.client = client;
        const response = await client.request({ nodeId: NODE_B, port: 9090, path: '/direct' });
        assert.equal(await response.text(), 'direct /direct');
        assert.equal(seenHost, `${NODE_B}:9090`);
    } finally {
        teardown(ctx);
    }
});

test('http-client: close() prevents further requests', async () => {
    const ctx = await createPair();
    try {
        const client = new HTTPClient(ctx.a);
        client.close();
        await assert.rejects(() => client.fetch(`webtcp://${NODE_B}:8080/`), /closed/);
    } finally {
        teardown(ctx);
    }
});

test('http-client: server closes the pool entry so the next request reconnects', async () => {
    const ctx = await createPair();
    try {
        const server = ctx.b.serveHTTP(
            8080,
            async (_request, response) => {
                await response.end('ok');
            },
            { idleTimeoutMs: 20 },
        );
        ctx.server = server;
        const client = new HTTPClient(ctx.a, { keepAlive: true, idleTimeoutMs: 10_000 });
        ctx.client = client;
        await (await client.fetch(`webtcp://${NODE_B}:8080/a`)).text();
        // サーバー側のアイドルタイムアウトで接続が閉じるのを待つ
        await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
        // FIN がクライアントに届くのを待つ（`waitFor` を挟まないと、プールの検査と
        // サーバーの `CLOSE_WAIT` 化が競合して「閉じた直後の接続を再利用」する）
        await waitFor(() => {
            const state = [...client.pool.values()][0]?.stream.state;
            return state === 'CLOSE_WAIT' || state === 'CLOSED' || state === undefined;
        }, { timeoutMs: 4000 });
        const response = await client.fetch(`webtcp://${NODE_B}:8080/b`, { timeoutMs: 5000 });
        assert.equal(await response.text(), 'ok');
    } finally {
        teardown(ctx);
    }
});
