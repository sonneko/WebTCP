import test from 'node:test';
import assert from 'node:assert/strict';

import { createDemoServer } from '../../examples/server.mjs';
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    noopLogger,
} from '../dist/index.js';

test('demo server: serves demo assets, built ESM library, and signaling/entrances API', async () => {
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const nodeA = 'a'.repeat(32);
    const nodeB = 'b'.repeat(32);
    const sigA = new SignalingAdapterHub({ url: baseUrl, nodeId: nodeA, pollIntervalMs: 30, logger: noopLogger });
    const sigB = new SignalingAdapterHub({ url: baseUrl, nodeId: nodeB, pollIntervalMs: 30, logger: noopLogger });

    try {
        // ルートからデモへのリダイレクト
        const rootRes = await fetch(`${baseUrl}/`, { redirect: 'manual' });
        assert.equal(rootRes.status, 302);
        assert.equal(rootRes.headers.get('location'), '/examples/demo/');

        // デモ HTML / JS とビルド済み dist ESM が正しく配信される
        const htmlRes = await fetch(`${baseUrl}/examples/demo/`);
        assert.equal(htmlRes.status, 200);
        const html = await htmlRes.text();
        assert.ok(html.includes('demo.js'));
        assert.ok(html.includes('selftest-btn'));

        const jsRes = await fetch(`${baseUrl}/examples/demo/demo.js`);
        assert.equal(jsRes.status, 200);
        const jsText = await jsRes.text();
        assert.ok(jsText.includes('../../webtcp_jslib/dist/index.js'));

        const distRes = await fetch(`${baseUrl}/webtcp_jslib/dist/index.js`);
        assert.equal(distRes.status, 200);
        assert.match(distRes.headers.get('content-type') ?? '', /javascript/);

        // 許可されていないパス（パストラバーサル・.git 等）は拒否される
        const deniedRes = await fetch(`${baseUrl}/package.json`);
        assert.equal(deniedRes.status, 404);

        // シグナリングと exclude 付きエントランス探索が動く
        const received = [];
        await sigA.listen(() => {});
        await sigB.listen((fromId, msg) => received.push({ fromId, msg }));

        const searcher = new EntranceSearcherAdapterHub({ url: baseUrl, exclude: nodeA });
        assert.deepEqual(await searcher.search(), [nodeB]);

        await sigA.sendMessage(nodeB, { type: 'offer', content: { sdp: 'test' }, fromId: nodeA });
        const deadline = Date.now() + 2000;
        while (received.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 15));
        }
        assert.equal(received.length, 1);
        assert.equal(received[0].fromId, nodeA);
    } finally {
        sigA.close();
        sigB.close();
        await new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        });
    }
});
