import test from 'node:test';
import assert from 'node:assert/strict';

import { HTTPClient, WebTCPNetwork, noopLogger } from '../dist/index.js';
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
    return { a, b, servers: [] };
}

function teardown(ctx) {
    ctx.client?.close();
    for (const server of ctx.servers) server.close();
    ctx.a.close();
    ctx.b.close();
}

function serve(ctx, port, handler, options) {
    const server = ctx.b.serveHTTP(port, handler, options);
    ctx.servers.push(server);
    return server;
}

const okHandler = async (_request, response) => {
    await response.end('ok');
};

test('http-client-pool: maxPooledConnections is validated', async () => {
    const ctx = await createPair();
    try {
        for (const bad of [0, -1, 1.5, Number.NaN]) {
            assert.throws(() => new HTTPClient(ctx.a, { maxPooledConnections: bad }), /maxPooledConnections/);
        }
        const client = new HTTPClient(ctx.a, { maxPooledConnections: 4 });
        ctx.client = client;
        assert.equal(client.getPoolStats().max, 4);
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: the pool never holds more idle connections than the cap, and evicts the least recently used one', async () => {
    const ctx = await createPair();
    try {
        const servers = [8001, 8002, 8003].map((port) => serve(ctx, port, okHandler));
        const client = new HTTPClient(ctx.a, { maxPooledConnections: 2, idleTimeoutMs: 10_000 });
        ctx.client = client;
        for (const port of [8001, 8002, 8003]) {
            await (await client.fetch(`webtcp://${NODE_B}:${port}/`)).text();
        }
        // 8001 が最も古く使われたので、3 本目の取得で追い出される（サーバー側が FIN を受けて接続数 0）
        await waitFor(() => servers[0].connectionCount === 0, { timeoutMs: 4000 });
        assert.equal(servers[1].connectionCount, 1, '8002 stays pooled');
        assert.equal(servers[2].connectionCount, 1, '8003 stays pooled');
        const stats = client.getPoolStats();
        assert.equal(stats.total, 2);
        assert.equal(stats.idle, 2);
        assert.equal(stats.busy, 0);
        assert.equal(stats.evictedLru, 1);
        assert.equal(client.pooledConnectionCount, 2);
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: a connection in use is never evicted, even over the cap', async () => {
    const ctx = await createPair();
    try {
        let openGate;
        const gate = new Promise((resolve) => {
            openGate = resolve;
        });
        const servers = [
            serve(ctx, 8011, async (_request, response) => {
                await gate;
                await response.end('slow');
            }),
            serve(ctx, 8012, okHandler),
        ];
        const client = new HTTPClient(ctx.a, { maxPooledConnections: 1, idleTimeoutMs: 10_000 });
        ctx.client = client;
        const slow = client.fetch(`webtcp://${NODE_B}:8011/`, { timeoutMs: 5000 });
        await waitFor(() => client.getPoolStats().busy === 1, { timeoutMs: 4000 });
        // 使用中の 8011 がある間に 8012 を取得する: 上限を一時的に超えてよい
        await (await client.fetch(`webtcp://${NODE_B}:8012/`)).text();
        const during = client.getPoolStats();
        assert.equal(during.busy, 1, 'the slow request is still busy');
        assert.equal(during.total, 1, 'the idle 8012 connection is evicted to respect the cap');
        assert.equal(during.evictedLru, 1);
        await waitFor(() => servers[1].connectionCount === 0, { timeoutMs: 4000 });
        assert.equal(servers[0].connectionCount, 1, 'the busy connection was not closed');
        openGate();
        assert.equal(await (await slow).text(), 'slow');
        const after = client.getPoolStats();
        assert.equal(after.busy, 0);
        assert.equal(after.total, 1);
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: an idle connection is closed by its own timer, without another request', async () => {
    const ctx = await createPair();
    try {
        const server = serve(ctx, 8021, okHandler);
        const client = new HTTPClient(ctx.a, { idleTimeoutMs: 60, keepAlive: true });
        ctx.client = client;
        await (await client.fetch(`webtcp://${NODE_B}:8021/`)).text();
        assert.equal(client.pooledConnectionCount, 1);
        // 次のリクエストは送らない。タイマーだけで回収されること
        await waitFor(() => client.pooledConnectionCount === 0, { timeoutMs: 4000 });
        await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
        const stats = client.getPoolStats();
        assert.equal(stats.expiredIdle, 1);
        assert.equal(stats.total, 0);
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: a peer that closes an idle connection removes it from the pool at once', async () => {
    const ctx = await createPair();
    try {
        // サーバー側のアイドルタイムアウトで相手が FIN を送る。クライアントの期限（10 秒）より前に外れること
        const server = serve(ctx, 8031, okHandler, { idleTimeoutMs: 40 });
        const client = new HTTPClient(ctx.a, { idleTimeoutMs: 10_000 });
        ctx.client = client;
        await (await client.fetch(`webtcp://${NODE_B}:8031/`)).text();
        await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
        await waitFor(() => client.pooledConnectionCount === 0, { timeoutMs: 4000 });
        assert.equal(client.getPoolStats().closedByPeer, 1);
        // 外れた後も次のリクエストは新しい接続で成功する
        assert.equal(await (await client.fetch(`webtcp://${NODE_B}:8031/again`)).text(), 'ok');
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: concurrent requests to one key leave only one pooled connection, and nothing is orphaned', async () => {
    const ctx = await createPair();
    try {
        let openGate;
        const gate = new Promise((resolve) => {
            openGate = resolve;
        });
        const server = serve(ctx, 8041, async (_request, response) => {
            await gate;
            await response.end('x');
        });
        const client = new HTTPClient(ctx.a, { idleTimeoutMs: 10_000 });
        ctx.client = client;
        const requests = [1, 2, 3].map(() => client.fetch(`webtcp://${NODE_B}:8041/`, { timeoutMs: 5000 }));
        await waitFor(() => server.connectionCount === 3, { timeoutMs: 4000 });
        openGate();
        const responses = await Promise.all(requests);
        for (const response of responses) assert.equal(await response.text(), 'x');
        // 戻すのは 1 本だけ。余分な 2 本はサーバー側でも閉じられる（以前は上書きされて閉じられず残った）
        await waitFor(() => server.connectionCount === 1, { timeoutMs: 4000 });
        assert.equal(client.pooledConnectionCount, 1);
        assert.equal(client.getPoolStats().idle, 1);
        // close() は残りの 1 本も閉じる（上書きされた接続が残らないこと）
        client.close();
        await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: close() closes every pooled connection', async () => {
    const ctx = await createPair();
    try {
        const servers = [8051, 8052, 8053].map((port) => serve(ctx, port, okHandler));
        const client = new HTTPClient(ctx.a, { idleTimeoutMs: 10_000 });
        ctx.client = client;
        for (const port of [8051, 8052, 8053]) await (await client.fetch(`webtcp://${NODE_B}:${port}/`)).text();
        assert.equal(client.pooledConnectionCount, 3);
        client.close();
        for (const server of servers) await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
        assert.equal(client.pooledConnectionCount, 0);
    } finally {
        teardown(ctx);
    }
});

test('http-client-pool: a response with Connection: close removes the connection from the pool at once', async () => {
    const ctx = await createPair();
    try {
        const server = serve(ctx, 8061, async (_request, response) => {
            response.setHeader('connection', 'close');
            await response.end('bye');
        });
        const client = new HTTPClient(ctx.a, { idleTimeoutMs: 10_000 });
        ctx.client = client;
        assert.equal(await (await client.fetch(`webtcp://${NODE_B}:8061/`)).text(), 'bye');
        await waitFor(() => client.pooledConnectionCount === 0, { timeoutMs: 4000 });
        await waitFor(() => server.connectionCount === 0, { timeoutMs: 4000 });
    } finally {
        teardown(ctx);
    }
});
