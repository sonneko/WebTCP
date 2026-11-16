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

test('demo server: the /domain/* registry contract accepts owner-signed records only', async () => {
    const {
        NodeKeyManager,
        createDomainOwnershipRecord,
        createHttpDomainRegistryClient,
        createDomainOwnershipVerifier,
        verifyDomainCheckpoint,
        noopLogger,
    } = await import('../dist/index.js');
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const owner = await NodeKeyManager.create();

    try {
        const record = await createDomainOwnershipRecord({
            domain: 'demo.domain.global',
            keyManager: owner,
            serial: 1,
            port: 8080,
            txt: 'from the demo server',
            lifetimeMs: 3_600_000,
        });
        const accepted = await fetch(`${baseUrl}/domain/record`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record }),
        });
        assert.equal(accepted.status, 200);
        const submitted = await accepted.json();
        assert.equal(submitted.accepted, true);
        assert.equal(submitted.leafIndex, 0);
        assert.equal(submitted.treeSize, 1);
        assert.match(submitted.commitment, /^[0-9a-f]{64}$/);

        // 改ざんは 400（所有者署名が通らない）
        const forged = { ...record, body: { ...record.body, txt: 'evil' } };
        const rejected = await fetch(`${baseUrl}/domain/record`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record: forged }),
        });
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, 'bad-signature');

        // 同一 serial で別内容は 409 conflict（勝者を決めない fail-closed）
        const rival = await createDomainOwnershipRecord({
            domain: 'demo.domain.global',
            keyManager: owner,
            serial: 1,
            txt: 'other content',
            lifetimeMs: 3_600_000,
        });
        const conflict = await fetch(`${baseUrl}/domain/record`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record: rival }),
        });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json()).code, 'conflict');

        // 直近チェックポイントとログ鍵（TOFU ピン留め用）
        const checkpointRes = await fetch(`${baseUrl}/domain/checkpoint`);
        assert.equal(checkpointRes.status, 200);
        const { checkpoint, logId, root, treeSize } = await checkpointRes.json();
        assert.equal(treeSize, 1);
        assert.equal(checkpoint.root, root);
        const logRes = await fetch(`${baseUrl}/domain/log`);
        const logInfo = await logRes.json();
        assert.equal(logInfo.logId, logId);
        assert.equal(typeof logInfo.publicKey, 'string');
        assert.equal(
            (await verifyDomainCheckpoint(checkpoint, { logKeys: { [logId]: logInfo.publicKey } })).ok,
            true,
            'デモ台帳のチェックポイントはログ鍵で検証できる',
        );

        // 検索（アンカーつき）と 404
        const found = await (await fetch(`${baseUrl}/domain/record?name=demo.domain.global`)).json();
        assert.equal(found.records.length, 1);
        assert.equal(found.records[0].body.nodeId, owner.nodeId);
        const missingRes = await fetch(`${baseUrl}/domain/record?name=nope.domain.global`);
        assert.equal(missingRes.status, 404);

        // チェックポイント区間（`after` < treeSize < `to`）と不正パラメータ
        const range = await (await fetch(`${baseUrl}/domain/checkpoints?after=0&to=2`)).json();
        assert.deepEqual(range.checkpoints.map((entry) => entry.treeSize), [1]);
        assert.equal((await fetch(`${baseUrl}/domain/checkpoints?after=5&to=2`)).status, 400);
        // アンカーつきレコードは、ログ鍵を設定した検証器で完結に検証できる
        const verified = await createDomainOwnershipVerifier({
            logger: noopLogger,
            requireAnchor: true,
            logKeys: { [logId]: logInfo.publicKey },
        }).verify(found.records[0]);
        assert.equal(verified.ok, true);
        assert.equal(verified.anchorVerified, true);

        // 同アダプタ経由でも同じ結果になる（§13.6 の契約を実装が守っている）
        const client = createHttpDomainRegistryClient({ baseUrl, logger: noopLogger });
        assert.equal((await client.lookupByDomain('demo.domain.global'))[0].body.serial, 1);
        assert.deepEqual(await client.lookupByDomain('nope.domain.global'), []);
        assert.equal((await client.lookupByNodeId(owner.nodeId)).length, 1);
        assert.equal((await client.checkpoint()).treeSize, 1);
        assert.equal(typeof (await client.submit(record)).accepted, 'boolean');
    } finally {
        await new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        });
    }
});
