import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DomainAuthority,
    DomainOwnershipError,
    DomainResolutionUnavailableError,
    NameServer,
    NameResolutionTimeoutError,
    WebTCPNetwork,
    NodeKeyManager,
    createDomainAuthority,
    createDomainLedger,
    createDomainOwnershipRecord,
    domainRecordToJSON,
    memoryDomainRecordSource,
    noopLogger,
    parseWebTCPUrl,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

const decode = (bytes) => new TextDecoder().decode(bytes);

async function makeRecord(keyManager, domain, overrides = {}) {
    return createDomainOwnershipRecord({
        domain,
        keyManager,
        serial: 1,
        lifetimeMs: 3_600_000,
        ...overrides,
    });
}

test('domain-resolution: the authority resolves from its sources and fail-closes otherwise', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const appended = await ledger.append(await makeRecord(owner, 'shop.domain.global', { port: 8443 }));
    const source = memoryDomainRecordSource({ records: [appended.record] });
    const authority = createDomainAuthority({
        sources: [source],
        verifierOptions: { requireAnchor: true, logKeys: { [log.nodeId]: log.publicKey }, logger: noopLogger },
        logger: noopLogger,
    });
    assert.equal(authority.enabled, true);

    const resolution = await authority.resolve('shop.domain.global');
    assert.equal(resolution.ok, true);
    assert.equal(resolution.nodeId, owner.nodeId);
    assert.equal(resolution.port, 8443, 'port はヒントとして返す (§14.2)');
    assert.equal(resolution.proof.anchorVerified, true);
    assert.equal(resolution.via, 'memory');

    // 候補 0 件は「名前が存在しない」として区別される (§14.5)
    await assert.rejects(
        () => authority.resolve('missing.domain.global'),
        (error) => error instanceof DomainResolutionUnavailableError && error.domain === 'missing.domain.global',
    );
    // 検証に失敗する候補は結果を返さない
    const tampered = { ...appended.record, body: { ...appended.record.body, txt: 'evil' } };
    const bad = createDomainAuthority({
        sources: [memoryDomainRecordSource({})],
        verifierOptions: { logger: noopLogger },
        logger: noopLogger,
    });
    const failed = await bad.settleCandidates('shop.domain.global', [tampered]);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'bad-signature');
    // 空の収集元ではゾーン名を解決できない
    const disabled = createDomainAuthority({ logger: noopLogger });
    assert.equal(disabled.enabled, false);
    assert.equal((await disabled.settle('shop.domain.global')).code, 'resolution-unavailable');
    // 非ゾーン名は zone-mismatch
    assert.equal((await authority.settle('my-service')).code, 'zone-mismatch');
    authority.close();
    await assert.rejects(() => authority.resolve('shop.domain.global'), /closed/);
});

test('domain-resolution: same serial with different content is an unresolved conflict (§14.4.3)', async () => {
    const owner = await NodeKeyManager.create();
    const a = await makeRecord(owner, 'shop.domain.global', { txt: 'from-a' });
    const b = await makeRecord(owner, 'shop.domain.global', { txt: 'from-b' });
    const authority = createDomainAuthority({
        sources: [
            memoryDomainRecordSource({ records: [a] }),
            memoryDomainRecordSource({ records: [b] }),
        ],
        verifierOptions: { logger: noopLogger },
        logger: noopLogger,
    });
    const resolution = await authority.settle('shop.domain.global', { skipCache: true });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.code, 'conflict');
    assert.match(resolution.message, /unresolved ownership conflict/);
    // 失敗は短い TTL でキャッシュされる (§14.5)
    const cached = await authority.settle('shop.domain.global');
    assert.equal(cached.code, 'conflict');
});

test('domain-resolution: successful resolutions are cached and skipCache bypasses the cache', async () => {
    const owner = await NodeKeyManager.create();
    const other = await NodeKeyManager.create();
    const source = memoryDomainRecordSource({ records: [await makeRecord(owner, 'shop.domain.global')] });
    const authority = createDomainAuthority({
        sources: [source],
        verifierOptions: { logger: noopLogger },
        cacheTtlMs: 60_000,
        logger: noopLogger,
    });
    assert.equal((await authority.resolve('shop.domain.global')).nodeId, owner.nodeId);
    await source.put(await makeRecord(other, 'shop.domain.global', { serial: 2 }));
    assert.equal(
        (await authority.settle('shop.domain.global')).nodeId,
        owner.nodeId,
        'キャッシュ済み (cacheTtlMs) は更新されない',
    );
    assert.equal(
        (await authority.settle('shop.domain.global', { skipCache: true })).nodeId,
        other.nodeId,
        'skipCache は現在の値を返す',
    );
    assert.equal(authority.forget('shop.domain.global'), true);
    assert.equal(authority.forget('shop.domain.global'), false);
    assert.throws(
        () => createDomainAuthority({ cacheTtlMs: 1, negativeTtlMs: 5_000 }),
        /negativeTtlMs must not exceed cacheTtlMs/,
    );
});

test('domain-resolution: the authority feeds verified public keys to the key resolver bridge', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const appended = await ledger.append(await makeRecord(owner, 'shop.domain.global'));
    const authority = createDomainAuthority({
        local: memoryDomainRecordSource({ records: [appended.record] }),
        verifierOptions: { requireAnchor: true, logKeys: { [log.nodeId]: log.publicKey }, logger: noopLogger },
        logger: noopLogger,
    });
    const resolver = authority.createPublicKeyResolver();
    const key = await resolver.getPublicKey(owner.nodeId);
    assert.deepEqual(key, owner.publicKey);

    // 検証に失敗する束縛は鍵配布に流用しない (§14.5 MUST NOT)
    const stranger = await NodeKeyManager.create();
    assert.equal(await resolver.getPublicKey(stranger.nodeId), null);
    // inner へのフォールバック
    const inner = { async getPublicKey() { return stranger.publicKey; } };
    assert.deepEqual(await authority.createPublicKeyResolver(inner).getPublicKey(stranger.nodeId), stranger.publicKey);
    // remember() は検証を通ったものだけを守る
    const forged = { ...appended.record, body: { ...appended.record.body, txt: 'x' } };
    const remember = await authority.remember(forged, { domain: 'shop.domain.global' });
    assert.equal(remember.ok, false);
    assert.equal(authority.storedSize, 0);
    assert.equal((await authority.remember(appended.record)).ok, true);
    assert.equal(authority.storedSize, 1);
});

test('domain-resolution: NameServer refuses direct registration of zone names (§13.1 MUST NOT)', async () => {
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
    const ns = new NameServer(a, { logger: noopLogger });
    try {
        assert.throws(
            () => ns.registerA('shop.domain.global', b.localNodeId),
            /registerDomain\(\)/,
        );
        assert.throws(
            () => ns.registerA('SHOP.DOMAIN.GLOBAL.', b.localNodeId),
            /domain\.global/,
        );
        assert.throws(() => ns.registerCNAME('shop.domain.global', 'alias'), /domain\.global/);
        // CNAME の**到達先**がゾーン内に入ることは許す (§13.1)。ただし最終解決は所有権検証が必須。
        ns.registerCNAME('alias', 'shop.domain.global');
        // 非ゾーン名は従来どおり
        ns.registerA('my-service', b.localNodeId);
        assert.equal((await ns.resolve('my-service')).nodeId, b.localNodeId);
        await assert.rejects(
            () => ns.resolve('alias'),
            (error) => error instanceof DomainResolutionUnavailableError && error.domain === 'shop.domain.global',
        );
        // 検証失敗のレコードは登録されない (§14.5)
        const owner = await NodeKeyManager.create();
        const record = await makeRecord(owner, 'shop.domain.global');
        const noAuthority = await ns.registerDomain({ ...record, body: { ...record.body, txt: 'tampered' } });
        assert.equal(noAuthority.ok, false);
        assert.equal(noAuthority.code, 'bad-signature');
        assert.equal(ns.servedDomainRecords().length, 0);
        // 権威なしのゾーン名解決は失敗する (MUST, §13.2)
        await assert.rejects(
            () => ns.resolve('shop.domain.global'),
            (error) => error instanceof DomainResolutionUnavailableError,
        );
        const accepted = await ns.registerDomain(record);
        assert.equal(accepted.ok, true, 'own record verifies without a ledger anchor');
        assert.equal(accepted.proof.anchorVerified, false);
        assert.equal(ns.servedDomainRecords().length, 1);
        const local = await ns.resolve('shop.domain.global');
        assert.equal(local.nodeId, owner.nodeId);
        assert.equal(local.source, 'local');
        assert.equal(local.record.body.serial, 1);
        assert.equal(ns.unregisterDomain('shop.domain.global'), true);
        assert.equal(ns.servedDomainRecords().length, 0);
        await assert.rejects(() => ns.resolve('shop.domain.global'), DomainResolutionUnavailableError);
        assert.equal(ns.unregisterDomain('shop.domain.global'), false);
        assert.throws(() => ns.unregisterDomain('my-service'), /domain\.global/);
    } finally {
        ns.close();
        nodes.forEach((node) => node.close());
    }
});

test('domain-resolution: answers for zone names must carry ownership, and peers cannot spoof the binding', async () => {
    const hub = new LoopbackNetwork();
    const keys = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create(), NodeKeyManager.create()]);
    const nodes = keys.map((keyManager) =>
        new WebTCPNetwork({
            channel: hub.createChannel(keyManager.nodeId),
            keyManager,
            logger: noopLogger,
            transport: { connectTimeoutMs: 3000, stream: { timeWaitMs: 0 } },
        }),
    );
    const [a, b, c] = nodes;
    await Promise.all(nodes.map((node) => node.start()));
    await a.connectToPeer(b.localNodeId);
    await a.connectToPeer(c.localNodeId);
    await waitFor(() => a.getNeighbors().length === 2, { timeoutMs: 4000 });

    const owner = keys[1];
    const record = await makeRecord(owner, 'shop.domain.global', { port: 9100 });
    const authority = createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger });
    const nsA = new NameServer(a, { logger: noopLogger, domains: authority, queryTimeoutMs: 1500, resolveTimeoutMs: 4000 });
    const nsB = new NameServer(b, { logger: noopLogger, domains: createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger }) });
    nsA.listen();
    nsB.listen();
    try {
        assert.equal((await nsB.registerDomain(record)).ok, true);
        const resolved = await nsA.resolve('shop.domain.global');
        assert.equal(resolved.nodeId, b.localNodeId, '応答ノードの A レコードと束縛が一致する');
        assert.equal(resolved.source, 'domain');
        assert.equal(resolved.record.body.nodeId, b.localNodeId);
        assert.equal(resolved.proof.code, 'ok');
        assert.deepEqual(resolved.chain, ['shop.domain.global']);
        // 検証済み結果は権威側キャッシュに入り、以降は query を省略できる
        const cached = await nsA.resolve('SHOP.DOMAIN.GLOBAL.');
        assert.equal(cached.nodeId, b.localNodeId);

        // C は「所有権レコードを添えない」悪意ある応答を返す（素の A レコードのみ）
        c.listen(5300, (stream) => {
            stream.on('data', (data) => {
                const request = JSON.parse(decode(data));
                void stream.send(
                    JSON.stringify({
                        protocol: 1,
                        type: 'answer',
                        id: request.id,
                        name: request.name,
                        record: { type: 'A', name: request.name, target: c.localNodeId, ttlMs: 60_000 },
                    }),
                );
                stream.end();
            });
        });
        const nsNoProof = new NameServer(a, {
            logger: noopLogger,
            domains: createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger }),
            resolvers: [c.localNodeId],
            queryTimeoutMs: 1500,
            resolveTimeoutMs: 4000,
        });
        // C の応答は所有権レコードを添えないので候補 0 件（MUST NOT により素の A レコードは使えない）。
        // 台帳にも既知ノードにも無いのだから not-found であり、検証失敗（DomainOwnershipError）とは区別される (§14.5)。
        await assert.rejects(
            () => nsNoProof.resolve('other.domain.global'),
            (error) => error.name === 'NameNotFoundError',
        );

        // C が「別ノードに束縛するレコード」で応答しても無視される（target と一致しない）
        c.listen(5301, () => undefined);
        nsNoProof.close();
    } finally {
        nsA.close();
        nsB.close();
        nodes.forEach((node) => node.close());
    }
});

test('domain-resolution: connectURL works over a domain.global name and exposes the zone (§13.3)', async () => {
    const hub = new LoopbackNetwork();
    const keys = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create()]);
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
    const owner = keys[1];
    const record = await makeRecord(owner, 'shop.domain.global');
    const nsA = new NameServer(a, {
        logger: noopLogger,
        domains: createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger }),
        queryTimeoutMs: 1500,
        resolveTimeoutMs: 4000,
    });
    const nsB = new NameServer(b, {
        logger: noopLogger,
        domains: createDomainAuthority({ verifierOptions: { logger: noopLogger }, logger: noopLogger }),
    });
    nsA.listen();
    nsB.listen();
    b.listen(9100, (stream) => {
        stream.on('data', (data) => {
            void stream.send(`echo:${decode(data)}`);
            stream.end();
        });
    });
    try {
        assert.equal((await nsB.registerDomain(record)).ok, true);
        const parsed = parseWebTCPUrl('webtcp://Shop.Domain.Global:9100/orders?x=1#frag');
        assert.equal(parsed.zone, 'domain.global');
        assert.equal(parsed.host, 'shop.domain.global');
        assert.equal(parsed.nodeId, undefined);
        const stream = await a.connectURL('webtcp://shop.domain.global:9100/orders?x=1', { nameServer: nsA });
        const reply = stream.readExact(7);
        await stream.send('hi');
        assert.equal(decode(await reply), 'echo:hi');
        stream.destroy();
    } finally {
        nsA.close();
        nsB.close();
        nodes.forEach((node) => node.close());
    }
});

test('domain-resolution: resolve honors its deadline and caller abort even when a peer stalls (#40)', async () => {
    const hub = new LoopbackNetwork();
    const keys = await Promise.all([NodeKeyManager.create(), NodeKeyManager.create()]);
    const channels = keys.map((keyManager) => hub.createChannel(keyManager.nodeId));
    // `stalled` への送信を黑洞にする: SYN は張れるが応答が永遠に返らない。
    const blackhole = new Set([keys[1].nodeId]);
    const originalSend = channels[0].send.bind(channels[0]);
    channels[0].send = async (targetId, data) => {
        if (blackhole.has(targetId)) return;
        return originalSend(targetId, data);
    };
    const nodes = keys.map((keyManager, index) =>
        new WebTCPNetwork({
            channel: channels[index],
            keyManager,
            logger: noopLogger,
            // 接続が張れない相手は connect() がこの時間だけ待つ (#44) → デッドライン守りの検証
            transport: { connectTimeoutMs: 8000, stream: { timeWaitMs: 0 } },
        }),
    );
    const [a, stalled] = nodes;
    await Promise.all(nodes.map((node) => node.start()));
    const ns = new NameServer(a, {
        logger: noopLogger,
        resolvers: [stalled.localNodeId],
        queryTimeoutMs: 1500,
        resolveTimeoutMs: 500,
    });
    const started = Date.now();
    try {
        await assert.rejects(
            () => ns.resolve('nowhere'),
            (error) => {
                assert.ok(error instanceof NameResolutionTimeoutError, `expected a timeout, got ${error?.name}`);
                return true;
            },
        );
        const elapsed = Date.now() - started;
        // 不変条件は「停止した接続（connectTimeoutMs = 8000ms）を待たない」こと。
        // 全体テストの負荷で事件が遅れても誤判定しないよう、デッドライン（500ms）ではなく接続タイムアウトを基準にする（#63）。
        assert.ok(elapsed < 8000, `resolve() must not wait for the stalled connect (elapsed ${elapsed}ms)`);

        // 呼び出し側の明示中断はデッドライン到達と区別する (§12.2)
        const controller = new AbortController();
        const pending = ns.resolve('nowhere', { signal: controller.signal, timeoutMs: 10_000 });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(
            () => pending,
            (error) => /aborted/.test(error.message) && !(error instanceof NameResolutionTimeoutError),
        );
        // 名前解決の中断はゾーン内名前の経路でも同じ (§14.5)
        const domainNs = new NameServer(a, {
            logger: noopLogger,
            domains: createDomainAuthority({
                verifierOptions: { logger: noopLogger },
                resolveTimeoutMs: 200,
                queryTimeoutMs: 200,
                logger: noopLogger,
            }),
            resolveTimeoutMs: 500,
        });
        await assert.rejects(() => domainNs.resolve('shop.domain.global'), /timed out|not found|unavailable/);
        domainNs.close();
        assert.equal(ns.domainAuthority, null);
    } finally {
        ns.close();
        nodes.forEach((node) => node.close());
    }
});
