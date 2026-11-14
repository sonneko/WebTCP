#!/usr/bin/env node
/**
 * WebTCP デモサーバー。
 *
 * 1. `examples/demo/` と `webtcp_jslib/dist/` を静的配信する
 * 2. シグナリングハブ（specification.md §9.4）を提供する
 * 3. エントランス探索（specification.md §9.5）を提供する
 *
 * 依存パッケージはない。Node.js 20 以上で動作する。
 *
 *   node examples/server.mjs
 *   PORT=8787 HOST=0.0.0.0 node examples/server.mjs
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

const SIGNAL_TTL_MS = 60_000;
const PRESENCE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 1 << 20;

/** @type {Map<string, Array<{id: number, fromId: string, message: unknown, at: number}>>} */
const queues = new Map();
/** @type {Map<string, number>} */
const presence = new Map();
let nextMessageId = 1;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.map': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS（別オリジンにホストしたデモからも使えるようにする）
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }

    if (url.pathname === '/signal' && req.method === 'POST') {
        handleSignal(req, res);
        return;
    }
    if (url.pathname === '/messages' && req.method === 'GET') {
        handleMessages(url, res);
        return;
    }
    if (url.pathname === '/entrances' && req.method === 'GET') {
        handleEntrances(url, res);
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
    }

    void serveStatic(url, res, req.method === 'HEAD');
});

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function handleSignal(req, res) {
    let raw = '';
    let tooLarge = false;

    req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
            tooLarge = true;
            req.destroy();
        }
    });

    req.on('end', () => {
        if (tooLarge) return;

        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            sendJson(res, 400, { error: 'invalid json' });
            return;
        }

        if (
            typeof body?.fromId !== 'string' ||
            typeof body?.toId !== 'string' ||
            typeof body?.message !== 'object' ||
            body.message === null
        ) {
            sendJson(res, 400, { error: 'fromId, toId and message are required' });
            return;
        }

        pruneSignals();
        const queue = queues.get(body.toId) ?? [];
        queue.push({
            id: nextMessageId++,
            fromId: body.fromId,
            message: { ...body.message, fromId: body.fromId },
            at: Date.now(),
        });
        queues.set(body.toId, queue);
        presence.set(body.fromId, Date.now());

        res.writeHead(202).end();
    });
}

function handleMessages(url, res) {
    const nodeId = url.searchParams.get('nodeId');
    const after = Number(url.searchParams.get('after') ?? '0');

    if (!nodeId) {
        sendJson(res, 400, { error: 'nodeId is required' });
        return;
    }

    pruneSignals();
    presence.set(nodeId, Date.now());

    const queue = queues.get(nodeId) ?? [];
    const messages = queue
        .filter((entry) => entry.id > after)
        .map(({ id, fromId, message }) => ({ id, fromId, message }));

    // 配信済みメッセージは破棄する（ポーリング型のため、次回以降は不要）
    if (messages.length > 0) {
        const lastId = messages[messages.length - 1].id;
        queues.set(
            nodeId,
            queue.filter((entry) => entry.id > lastId),
        );
    }

    sendJson(res, 200, { messages });
}

function handleEntrances(url, res) {
    const exclude = url.searchParams.get('exclude');
    const now = Date.now();

    const nodes = [];
    for (const [nodeId, lastSeen] of presence.entries()) {
        if (now - lastSeen > PRESENCE_TTL_MS) continue;
        if (nodeId === exclude) continue;
        nodes.push(nodeId);
    }

    sendJson(res, 200, { nodes });
}

function pruneSignals() {
    const now = Date.now();
    for (const [nodeId, queue] of queues.entries()) {
        const remaining = queue.filter((entry) => now - entry.at <= SIGNAL_TTL_MS);
        if (remaining.length === 0) {
            queues.delete(nodeId);
        } else {
            queues.set(nodeId, remaining);
        }
    }
    for (const [nodeId, lastSeen] of presence.entries()) {
        if (now - lastSeen > PRESENCE_TTL_MS) presence.delete(nodeId);
    }
}

async function serveStatic(url, res, headOnly) {
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') {
        res.writeHead(302, { location: '/examples/demo/' }).end();
        return;
    }

    // パストラバーサルを拒否する（多層防御）
    if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
        sendJson(res, 400, { error: 'invalid path' });
        return;
    }

    // 配信対象を限定する（.git や node_modules を公開しない）
    const allowed =
        pathname.startsWith('/examples/') ||
        pathname.startsWith('/webtcp_jslib/dist/') ||
        pathname.startsWith('/webtcp_jslib/src/');
    if (!allowed) {
        sendJson(res, 404, { error: 'not found' });
        return;
    }

    if (pathname.endsWith('/')) {
        pathname += 'index.html';
    }

    const filePath = resolve(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT + sep)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }

    try {
        const info = await stat(filePath);
        if (!info.isFile()) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }

        const body = await readFile(filePath);
        res.writeHead(200, {
            'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
            'content-length': body.byteLength,
            'cache-control': 'no-cache',
        });
        res.end(headOnly ? undefined : body);
    } catch {
        sendJson(res, 404, { error: 'not found' });
    }
}

setInterval(pruneSignals, 30_000).unref();

server.listen(PORT, HOST, () => {
    console.log(`[WebTCP demo] http://localhost:${PORT}/examples/demo/`);
    console.log(`[WebTCP demo] signaling hub: POST /signal, GET /messages, GET /entrances`);
});
