#!/usr/bin/env node
/**
 * WebTCP デモサーバー。
 *
 * 1. `examples/demo/` と `webtcp_jslib/dist/` を静的配信する
 * 2. シグナリングハブ（specification.md §10.4）を提供する
 * 3. エントランス探索（specification.md §10.5）を提供する
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
import { createDomainRegistry } from './domain-registry.mjs';
import { acceptWebSocket } from './lib/ws-server.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SIGNAL_TTL_MS = 60_000;
const PRESENCE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 1 << 20;
/** `/domain/record` のリクエストボディ上限（レコード 1 件 + 多少の余裕、specification.md §14.6）。 */
const MAX_RECORD_BODY_BYTES = 64 * 1024;

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

/**
 * デモ用 HTTP サーバー（静的配信 + シグナリングハブ + エントランス探索）を生成する。
 */
export function createDemoServer() {
    /** @type {Map<string, Array<{id: number, fromId: string, message: unknown, at: number}>>} */
    const queues = new Map();
    /** @type {Map<string, number>} */
    const presence = new Map();
    let nextMessageId = 1;
    /** 押し込み型（SSE / WebSocket）の購読者。nodeId -> Set<(entry) => void>（specification.md §10.4.1）。 */
    /** @type {Map<string, Set<(entry: any) => void>>} */
    const subscribers = new Map();
    /** `domain.global` の参照レジストリ（specification.md §14.6）。 */
    const domains = createDomainRegistry();

    function sendJson(res, status, body) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
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

            enqueue(body.fromId, body.toId, body.message);
            res.writeHead(202).end();
        });
    }

    /**
     * メッセージを宛先の待ち行列へ積み、押し込み型の購読者へ即時に渡す。
     * ポーリング（`/messages`）と押し込み型（`/events`、`/ws`）の両方が同じ列を使う。
     */
    function enqueue(fromId, toId, message) {
        pruneSignals();
        const entry = {
            id: nextMessageId++,
            fromId,
            message: { ...message, fromId },
            at: Date.now(),
            delivered: false,
        };
        const queue = queues.get(toId) ?? [];
        queue.push(entry);
        queues.set(toId, queue);
        presence.set(fromId, Date.now());
        const listeners = subscribers.get(toId);
        if (listeners && listeners.size > 0) {
            entry.delivered = true;
            for (const deliver of listeners) deliver(entry);
        }
        return entry;
    }

    /**
     * 押し込み型の購読を開始する。先に再生し、以後の新着は即時に渡す。削除はしない。
     * - 再接続（`resume`）: `after` より新しい未失効メッセージをすべて再生する。
     * - 初回（`resume` なし）: 未配信のものだけを再生する（ポーリングと同じ「一度だけ配る」）。
     * （specification.md §10.4.1）
     * @returns {() => void} 購読を解除する関数
     */
    function subscribe(nodeId, after, resume, deliver) {
        pruneSignals();
        for (const entry of queues.get(nodeId) ?? []) {
            if (entry.id > after && (resume || !entry.delivered)) {
                entry.delivered = true;
                deliver(entry);
            }
        }
        const set = subscribers.get(nodeId) ?? new Set();
        set.add(deliver);
        subscribers.set(nodeId, set);
        presence.set(nodeId, Date.now());
        return () => {
            const current = subscribers.get(nodeId);
            if (!current) return;
            current.delete(deliver);
            if (current.size === 0) subscribers.delete(nodeId);
        };
    }

    /** `GET /events?nodeId=&after=`（SSE、specification.md §10.4.1）。 */
    function handleEvents(req, url, res) {
        const nodeId = url.searchParams.get('nodeId');
        if (!nodeId) {
            sendJson(res, 400, { error: 'nodeId is required' });
            return;
        }
        const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0') || 0;
        const resume = url.searchParams.get('resume') === '1' || after > 0;

        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');

        const unsubscribe = subscribe(nodeId, after, resume, (entry) => {
            res.write(
                `id: ${entry.id}\nevent: signal\ndata: ${JSON.stringify({
                    fromId: entry.fromId,
                    message: entry.message,
                })}\n\n`,
            );
        });
        const keepAlive = setInterval(() => {
            presence.set(nodeId, Date.now());
            res.write(': keepalive\n\n');
        }, 15_000);
        keepAlive.unref();

        req.on('close', () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
    }

    /** `GET /ws?nodeId=&after=` の Upgrade（WebSocket、specification.md §10.4.1）。 */
    function handleUpgrade(req, socket, head) {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/ws' || !String(req.headers.upgrade ?? '').toLowerCase().includes('websocket')) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }
        const nodeId = url.searchParams.get('nodeId');
        if (!nodeId || !req.headers['sec-websocket-key']) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }
        const after = Number(url.searchParams.get('after') ?? '0') || 0;
        const resume = url.searchParams.get('resume') === '1' || after > 0;

        let unsubscribe = () => {};
        const connection = acceptWebSocket(req, socket, head, {
            maxPayload: MAX_BODY_BYTES,
            onText: (text) => {
                let body;
                try {
                    body = JSON.parse(text);
                } catch {
                    return;
                }
                if (body?.type !== 'send' || typeof body.toId !== 'string' || typeof body.message !== 'object' || body.message === null) {
                    return;
                }
                enqueue(nodeId, body.toId, body.message);
            },
            onClose: () => unsubscribe(),
        });
        unsubscribe = subscribe(nodeId, after, resume, (entry) => {
            connection.send(JSON.stringify({ id: entry.id, fromId: entry.fromId, message: entry.message }));
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

    /** JSON ボディを読みながら `/domain/*` を処理する（specification.md §14.6）。 */
    async function handleDomain(request, url, res) {
        const route = url.pathname;
        if (route === '/domain/record' && request.method === 'POST') {
            let raw = '';
            let tooLarge = false;
            await new Promise((resolveBody) => {
                request.on('data', (chunk) => {
                    raw += chunk;
                    if (raw.length > MAX_RECORD_BODY_BYTES) {
                        tooLarge = true;
                        request.destroy();
                        resolveBody();
                    }
                });
                request.on('end', resolveBody);
                request.on('error', resolveBody);
            });
            if (tooLarge) {
                sendJson(res, 413, { error: `request body exceeds ${MAX_RECORD_BODY_BYTES} bytes` });
                return;
            }
            let body;
            try {
                body = raw.length > 0 ? JSON.parse(raw) : null;
            } catch {
                sendJson(res, 400, { error: 'invalid json' });
                return;
            }
            const outcome = await domains.submit(body);
            sendJson(res, outcome.status, outcome.body);
            return;
        }
        if (request.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        const outcome =
            route === '/domain/record'
                ? await domains.lookup(url.searchParams)
                : route === '/domain/checkpoint'
                  ? await domains.checkpoint()
                  : route === '/domain/checkpoints'
                    ? await domains.checkpoints(url.searchParams)
                    : route === '/domain/log'
                      ? await domains.log()
                      : null;
        if (!outcome) {
            sendJson(res, 404, { error: 'no such domain endpoint' });
            return;
        }
        sendJson(res, outcome.status, outcome.body);
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

    async function serveStatic(url, res, headOnly) {
        let pathname;
        try {
            pathname = decodeURIComponent(url.pathname);
        } catch {
            sendJson(res, 400, { error: 'invalid url encoding' });
            return;
        }

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
        if (url.pathname === '/events' && req.method === 'GET') {
            handleEvents(req, url, res);
            return;
        }
        if (url.pathname === '/entrances' && req.method === 'GET') {
            handleEntrances(url, res);
            return;
        }
        if (url.pathname.startsWith('/domain/')) {
            void handleDomain(req, url, res).catch((error) => {
                sendJson(res, 500, { error: String(error?.message ?? error) });
            });
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }

        void serveStatic(url, res, req.method === 'HEAD');
    });

    server.on('upgrade', handleUpgrade);

    const pruneTimer = setInterval(pruneSignals, 30_000);
    pruneTimer.unref();

    server.on('close', () => {
        clearInterval(pruneTimer);
    });

    return server;
}

const isMain =
    process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const PORT = Number(process.env.PORT ?? 8787);
    const HOST = process.env.HOST ?? '0.0.0.0';
    const server = createDemoServer();

    server.listen(PORT, HOST, () => {
        console.log(`[WebTCP demo] http://localhost:${PORT}/examples/demo/`);
        console.log(`[WebTCP demo] self-test: http://localhost:${PORT}/examples/demo/?selftest=1`);
        console.log(`[WebTCP demo] signaling hub: POST /signal, GET /messages (poll), GET /events (SSE), GET /ws (WebSocket), GET /entrances`);
        console.log(`[WebTCP demo] domain registry: POST /domain/record, GET /domain/record|checkpoint|checkpoints|log`);
    });
}
