import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackNetwork } from './helpers/loopback.mjs';
import {
    DomainRegistryError,
    NameServer,
    NodeKeyManager,
    WebTCPNetwork,
    createDomainAuthority,
    createDomainLedger,
    createDomainOwnershipRecord,
    createHttpDomainRegistryClient,
    encodePublicKey,
    domainRecordToJSON,
    memoryDomainRecordSource,
    noopLogger,
} from '../dist/index.js';

/**
 * `fetch` のスタブ（specification.md §13.6 の HTTP 契約だけを相手にする）。
 * 台帳そのものは `DomainLedger` を使い、レスポンス生成に流用する。
 */
function makeRegistry(ledger) {
    const calls = [];
    const handler = async (url, init = {}) => {
        const parsed = new URL(url, 'http://registry.test');
        calls.push({ url, method: init.method ?? 'GET', body: init.body });
        const respond = (status, payload) => ({
            ok: status >= 200 && status < 300,
            status,
            async json() {
                return payload;
            },
            async text() {
                return JSON.stringify(payload);
            },
        });
        if (parsed.pathname === '/domain/log') {
            const snapshot = await ledger.snapshot();
            return respond(200, { logId: snapshot.logId, publicKey: ledger.publicKeyEncoded });
        }
        if (parsed.pathname === '/domain/checkpoint') {
            const checkpoint = await ledger.checkpoint();
            return respond(200, { checkpoint });
        }
        if (parsed.pathname === '/domain/checkpoints') {
            const checkpoints = await ledger.checkpointsBetween({
                afterTreeSize: Number(parsed.searchParams.get('after')),
                toTreeSize: Number(parsed.searchParams.get('to')),
            });
            return respond(200, { checkpoints });
        }
        if (parsed.pathname === '/domain/record' && (init.method ?? 'GET') === 'POST') {
            const body = JSON.parse(init.body);
            try {
                const appended = await ledger.append(body.record);
                return respond(200, {
                    accepted: true,
                    leafIndex: appended.anchor.leafIndex,
                    treeSize: appended.anchor.checkpoint.treeSize,
                    checkpoint: appended.anchor.checkpoint,
                    anchor: appended.anchor,
                });
            } catch (error) {
                return respond(409, { accepted: false, error: error.message, code: error.name });
            }
        }
        if (parsed.pathname === '/domain/record') {
            const name = parsed.searchParams.get('name');
            const nodeId = parsed.searchParams.get('nodeId');
            const list = name
                ? [(await ledger.lookupByDomain(name)) ?? null].filter(Boolean)
                : await ledger.lookupByNodeId(nodeId);
            if (list.length === 0) return respond(404, { error: 'not found' });
            return respond(200, { records: list.map((record) => domainRecordToJSON(record)) });
        }
        return respond(404, { error: 'no such endpoint' });
    };
    return { calls, fetchImpl: handler };
}

test('domain-registry: submit, lookup and checkpoint endpoints follow the §13.6 contract', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const { calls, fetchImpl } = makeRegistry(ledger);
    const client = createHttpDomainRegistryClient({
        baseUrl: 'http://registry.test/',
        fetchImpl,
        logger: noopLogger,
    });

    const record = await createDomainOwnershipRecord({
        domain: 'shop.domain.global',
        keyManager: owner,
        serial: 1,
        lifetimeMs: 3_600_000,
    });
    const submitted = await client.submit(record);
    assert.equal(submitted.accepted, true);
    assert.equal(submitted.leafIndex, 0);
    assert.equal(submitted.treeSize, 1);
    assert.ok(submitted.anchor.proof !== undefined);
    assert.equal(calls[0].url, 'http://registry.test/domain/record');
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].body, /"domain":"shop\.domain\.global"/);

    const found = await client.lookupByDomain('shop.domain.global');
    assert.equal(found.length, 1);
    assert.equal(found[0].body.nodeId, owner.nodeId);
    assert.ok(found[0].anchor, 'レジストリはアンカー込みで返す');

    const byNode = await client.lookupByNodeId(owner.nodeId);
    assert.equal(byNode.length, 1);

    const checkpoint = await client.checkpoint();
    assert.equal(checkpoint.treeSize, 1);
    assert.equal((await client.checkpointsBetween({ logId: checkpoint.logId, afterTreeSize: 0, toTreeSize: 2 })).length, 1);

    // 404 は「候補 0 件」に写像される（解決側は例外にしない）
    assert.deepEqual(await client.lookupByDomain('nope.domain.global'), []);
    assert.deepEqual(await client.logInfo(), {
        logId: ledger.logId,
        publicKey: encodePublicKey(log.publicKey),
    });
});

test('domain-registry: a ledger rejection becomes a typed 409 and errors are wrapped', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const { fetchImpl } = makeRegistry(ledger);
    const client = createHttpDomainRegistryClient({ baseUrl: 'http://registry.test', fetchImpl, logger: noopLogger });
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: owner, serial: 4 });
    await client.submit(record);
    await assert.rejects(
        async () =>
            client.submit(await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: owner, serial: 3 })),
        (error) => error instanceof DomainRegistryError && error.status === 409,
    );
    // 不正 JSON・障害はすべて DomainRegistryError
    const broken = createHttpDomainRegistryClient({
        baseUrl: 'http://registry.test',
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return 'nope'; }, async text() { return '[not json'; } }),
        logger: noopLogger,
    });
    await assert.rejects(() => broken.lookupByDomain('a.domain.global'), /malformed JSON/);
    const down = createHttpDomainRegistryClient({
        baseUrl: 'http://registry.test',
        fetchImpl: async () => {
            throw new TypeError('fetch failed');
        },
        logger: noopLogger,
    });
    await assert.rejects(() => down.lookupByDomain('a.domain.global'), /request failed/);
    const forbidden = createHttpDomainRegistryClient({
        baseUrl: 'http://registry.test',
        fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; }, async text() { return 'boom'; } }),
        tolerateNotFound: false,
        logger: noopLogger,
    });
    await assert.rejects(
        () => forbidden.lookupByDomain('a.domain.global'),
        (error) => error instanceof DomainRegistryError && error.status === 500,
    );
    assert.throws(() => createHttpDomainRegistryClient({}), /baseUrl/);
});

test('domain-registry: the authority resolves through the registry and caches like any source', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const { fetchImpl } = makeRegistry(ledger);
    const client = createHttpDomainRegistryClient({ baseUrl: 'http://registry.test', fetchImpl, logger: noopLogger });
    await client.submit(
        await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: owner, serial: 1, port: 8443 }),
    );
    const authority = createDomainAuthority({
        sources: [client],
        checkpointChain: client,
        verifierOptions: { requireAnchor: true, logKeys: { [ledger.logId]: log.publicKey }, logger: noopLogger },
        logger: noopLogger,
    });
    const resolution = await authority.resolve('shop.domain.global');
    assert.equal(resolution.ok, true);
    assert.equal(resolution.nodeId, owner.nodeId);
    assert.equal(resolution.port, 8443);
    assert.equal(resolution.via, 'http-registry');
    assert.equal(resolution.proof.anchorVerified, true);
    // 悪意あるレジストリが別ノードへ束縛し直しても、所有者署名が通らないので通らない
    const attacker = await NodeKeyManager.create();
    const forgedLedger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const forged = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager: attacker, serial: 9 });
    await forgedLedger.append(forged);
    const other = memoryDomainRecordSource({ records: [] });
    await other.put(forged);
    assert.equal((await other.lookupByDomain('shop.domain.global'))[0].body.nodeId, attacker.nodeId);
    void authority.proofState.size;
});

test('domain-registry: the registry timeout and abort do not hang resolution (§12.2 / #40)', async () => {
    const client = createHttpDomainRegistryClient({
        baseUrl: 'http://registry.test',
        timeoutMs: 120,
        fetchImpl: (_url, init = {}) =>
            new Promise((resolve, reject) => {
                const abort = () => reject(new Error('aborted'));
                if (init.signal?.aborted) abort();
                else init.signal?.addEventListener('abort', abort, { once: true });
            }),
        logger: noopLogger,
    });
    await assert.rejects(() => client.lookupByDomain('a.domain.global'), /request failed/);
    const authority = createDomainAuthority({
        sources: [client],
        verifierOptions: { logger: noopLogger },
        resolveTimeoutMs: 300,
        queryTimeoutMs: 120,
        logger: noopLogger,
    });
    const started = Date.now();
    const outcome = await authority.settle('shop.domain.global');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'resolution-unavailable');
    assert.ok(Date.now() - started < 1500, 'slow registry must not stall the resolver');
});

/** 相手が EOF するまで読んで JSON にデコードする（NameServer の要求/応答は 1 ストリーム 1 往復）。 */
function readJsonUntilEnd(stream, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const cleanup = () => {
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
        };
        const onData = (chunk) => {
            size += chunk.byteLength;
            if (size > maxBytes) {
                cleanup();
                reject(new Error('response too large'));
                return;
            }
            chunks.push(Buffer.from(chunk));
        };
        const onEnd = () => {
            cleanup();
            resolve(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))));
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

test('domain-registry: the ownership answer format on the wire matches §12.2', async () => {
    const hub = new LoopbackNetwork();
    const keys = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create()]);
    const nodes = keys.map((keyManager) =>
        new WebTCPNetwork({
            channel: hub.createChannel(keyManager.nodeId),
            keyManager,
            logger: noopLogger,
            transport: { connectTimeoutMs: 2000, stream: { timeWaitMs: 0 } },
        }),
    );
    const [a, b] = nodes;
    await Promise.all(nodes.map((node) => node.start()));
    await a.connectToPeer(b.localNodeId);
    const authority = () => createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger });
    const nsA = new NameServer(a, { logger: noopLogger, domains: authority() });
    const nsB = new NameServer(b, { logger: noopLogger, domains: authority() });
    nsB.listen();
    try {
        const record = await createDomainOwnershipRecord({
            domain: 'solo.domain.global',
            keyManager: keys[1],
            serial: 3,
            port: 9100,
        });
        assert.equal((await nsB.registerDomain(record)).ok, true);
        assert.deepEqual(nsB.servedDomainRecords().map((entry) => entry.body.domain), ['solo.domain.global']);

        // 素のプロトコル対話で応答形を検証する (M4 の JSON 1 往復 + M5 の ownership 拡張)
        const stream = await a.connect(b.localNodeId, nsB.port);
        const received = readJsonUntilEnd(stream);
        await stream.send(
            JSON.stringify({ protocol: 1, type: 'query', id: 'abc', name: 'solo.domain.global', wantOwnership: true }),
        );
        stream.end();
        const answer = await received;
        assert.equal(answer.protocol, 1);
        assert.equal(answer.type, 'answer');
        assert.equal(answer.id, 'abc');
        assert.equal(answer.record.type, 'A');
        assert.equal(answer.record.target, b.localNodeId);
        assert.ok(Array.isArray(answer.ownership) && answer.ownership.length === 1, 'ownership は 1 件以上 MUST');
        assert.equal(answer.ownership[0].body.domain, 'solo.domain.global');
        assert.equal(answer.ownership[0].body.serial, 3);
        assert.equal(typeof answer.ownership[0].signature, 'string');
        stream.destroy();

        // A 側はNameServer 経由でも同じレコードを候補に取れる (§13.5 の (3))
        nsA.listen();
        const resolved = await nsA.resolve('solo.domain.global');
        assert.equal(resolved.nodeId, b.localNodeId);
        assert.equal(resolved.source, 'domain');
        assert.equal(resolved.record.body.serial, 3);
        // ゾーン外の名前は NXDOMAIN を返す (§12.2)
        const missing = await a.connect(b.localNodeId, nsB.port);
        const missingReply = readJsonUntilEnd(missing);
        await missing.send(JSON.stringify({ protocol: 1, type: 'query', id: 'zz', name: 'other.domain.global' }));
        missing.end();
        assert.equal((await missingReply).code, 'NXDOMAIN');
        missing.destroy();
    } finally {
        nsA.close();
        nsB.close();
        nodes.forEach((node) => node.close());
    }
});

test('domain-registry: a node serves an ANCHORED record that peers verify through the pinned log key', async () => {
    // デモ自己テスト 1d と同じ流れを Node 側でなぞる (§13.4.1 / §13.5):
    // 台帳受理 → サーバー側が登録 → ピアは wantOwnership 応答だけで解決する。
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const { fetchImpl } = makeRegistry(ledger);
    const client = createHttpDomainRegistryClient({ baseUrl: 'http://registry.test', fetchImpl, logger: noopLogger });
    const logKeys = { [ledger.logId]: ledger.publicKeyEncoded };
    const verifierOptions = { requireAnchor: true, logKeys, logger: noopLogger };

    const hub = new LoopbackNetwork();
    const keys = [owner, await NodeKeyManager.create()];
    const nodes = keys.map((keyManager) =>
        new WebTCPNetwork({
            channel: hub.createChannel(keyManager.nodeId),
            keyManager,
            logger: noopLogger,
            transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
        }),
    );
    const [a, b] = nodes;
    await Promise.all(nodes.map((node) => node.start()));
    await a.connectToPeer(b.localNodeId);

    // サーバー側は台帳鍵を PIN した権威で登録する (NameServer 単体では fail-closed)
    const nsServer = new NameServer(b, {
        logger: noopLogger,
        domains: createDomainAuthority({ sources: [client], verifierOptions, logger: noopLogger }),
    });
    // クライアント側は台帳を引かず、ピア応答のアンカー検証だけを頼りにする
    const nsClient = new NameServer(a, {
        logger: noopLogger,
        domains: createDomainAuthority({ verifierOptions, logger: noopLogger }),
        queryTimeoutMs: 1500,
        resolveTimeoutMs: 4000,
    });
    nsServer.listen();
    nsClient.listen();
    try {
        const record = await createDomainOwnershipRecord({
            domain: 'anchored.domain.global',
            keyManager: owner,
            serial: 2,
            port: 9100,
        });
        const submitted = await client.submit(record);
        assert.equal(submitted.accepted, true);
        const anchored = { ...record, anchor: submitted.anchor };

        const withoutAuthority = await new NameServer(b, { logger: noopLogger }).registerDomain(anchored);
        assert.equal(withoutAuthority.ok, false);
        assert.equal(withoutAuthority.code, 'anchor-untrusted-log');

        const registered = await nsServer.registerDomain(anchored);
        assert.equal(registered.ok, true, registered.message);
        assert.deepEqual(nsServer.servedDomainRecords().map((entry) => entry.body.domain), ['anchored.domain.global']);

        const resolved = await nsClient.resolve('anchored.domain.global');
        assert.equal(resolved.nodeId, owner.nodeId);
        assert.equal(resolved.source, 'domain');
        assert.equal(resolved.proof?.anchorVerified, true);
        assert.equal(resolved.proof?.code, 'ok');
        assert.equal(resolved.record?.anchor?.checkpoint.treeSize, 1);
    } finally {
        nsServer.close();
        nsClient.close();
        nodes.forEach((node) => node.close());
    }
});

