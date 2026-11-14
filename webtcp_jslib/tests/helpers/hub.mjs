import http from 'node:http';

/**
 * テスト用のシグナリングハブ（specification.md §9.4 / §9.5）。
 */
export async function startHub() {
    /** @type {Map<string, Array<{id: number, fromId: string, message: unknown}>>} */
    const queues = new Map();
    /** @type {Map<string, number>} */
    const presence = new Map();
    let nextId = 1;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        const sendJson = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (req.method === 'POST' && url.pathname === '/signal') {
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', () => {
                try {
                    const body = JSON.parse(raw);
                    const queue = queues.get(body.toId) ?? [];
                    queue.push({ id: nextId++, fromId: body.fromId, message: body.message });
                    queues.set(body.toId, queue);
                    presence.set(body.fromId, Date.now());
                    res.writeHead(202).end();
                } catch {
                    sendJson(400, { error: 'invalid json' });
                }
            });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/messages') {
            const nodeId = url.searchParams.get('nodeId') ?? '';
            const after = Number(url.searchParams.get('after') ?? '0');
            presence.set(nodeId, Date.now());
            const queue = queues.get(nodeId) ?? [];
            sendJson(200, { messages: queue.filter((entry) => entry.id > after) });
            return;
        }

        if (req.method === 'GET' && url.pathname === '/entrances') {
            const exclude = url.searchParams.get('exclude');
            const nodes = [...presence.keys()].filter((nodeId) => nodeId !== exclude);
            sendJson(200, { nodes });
            return;
        }

        sendJson(404, { error: 'not found' });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(resolve);
            }),
    };
}
