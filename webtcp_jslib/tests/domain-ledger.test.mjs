import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DomainConflictError,
    DomainLedgerAppendError,
    DomainRecordError,
    MAX_DOMAIN_TREE_SIZE,
    canonicalDomainRecordBodyBytes,
    commitDomainRecord,
    conflictVerdict,
    createDomainLedger,
    createDomainOwnershipRecord,
    createDomainOwnershipVerifier,
    decodeBase64Url,
    domainCheckpointHex,
    memoryDomainRecordSource,
    parseDomainOwnershipRecord,
    signDomainCheckpoint,
    verifyDomainCheckpoint,
    verifyDomainMerkleProof,
    verifyDomainRecordSelfSignature,
    NodeKeyManager,
    noopLogger,
} from '../dist/index.js';

const encoder = new TextEncoder();

async function ownerRecord(keyManager, domain, overrides = {}) {
    return createDomainOwnershipRecord({
        domain,
        keyManager,
        serial: 1,
        lifetimeMs: 3_600_000,
        ...overrides,
    });
}

test('domain-ledger: appending an owner-signed record yields a verifiable anchor', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    assert.equal(ledger.logId, log.nodeId, '既定 logId はログ鍵の NodeId (§14.3)');
    assert.equal(ledger.size, 0);
    assert.equal(await ledger.root(), null);

    const record = await ownerRecord(owner, 'shop.domain.global');
    const { anchor, commitment } = await ledger.append(record);
    assert.equal(ledger.size, 1);
    assert.equal(commitment, await commitDomainRecord(record.body));
    assert.equal(anchor.leafIndex, 0);
    assert.deepEqual(anchor.proof, [], '単葉の木に兄弟は無い');
    assert.equal(anchor.checkpoint.treeSize, 1);
    assert.equal(
        await verifyDomainMerkleProof({
            commitment,
            leafIndex: 0,
            treeSize: 1,
            root: anchor.checkpoint.root,
            proof: anchor.proof,
        }),
        true,
    );
    const checkpointCheck = await verifyDomainCheckpoint(anchor.checkpoint, { logKeys: { [log.nodeId]: log.publicKey } });
    assert.equal(checkpointCheck.ok, true);
    assert.equal((await ledger.checkpoint()).treeSize, 1);
    // 追加済みレコードは anchor 込みで格納される (§14.5)
    const stored = await ledger.lookupByDomain('shop.domain.global');
    assert.ok(stored.anchor);
    assert.equal(stored.signature, record.signature);
    assert.deepEqual(await ledger.lookupByNodeId(owner.nodeId), [stored]);
    assert.equal(await ledger.lookupByDomain('missing.domain.global'), null);
});

test('domain-ledger: the ledger refuses records it cannot verify itself', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const record = await ownerRecord(owner, 'shop.domain.global');
    const bytes = decodeBase64Url(record.signature);
    bytes[0] ^= 0xff;
    const forged = { ...record, signature: `${record.signature.slice(0, 4)}${record.signature.slice(5)}` };
    await assert.rejects(() => ledger.append(forged), DomainRecordError);
    const tampered = { ...record, body: { ...record.body, txt: 'evil' } };
    await assert.rejects(() => ledger.append(tampered), (error) => error instanceof DomainLedgerAppendError);
    assert.equal(await verifyDomainRecordSelfSignature(record), true);
    assert.equal(await verifyDomainRecordSelfSignature(tampered), false);
    assert.equal(ledger.size, 0);
    // 検証を省略させれば入る（呼び出し側が検証する構成も許す、§14.7）
    const permissive = createDomainLedger({ keyManager: log, requireOwnerSignature: false, logger: noopLogger });
    await permissive.append(tampered);
    assert.equal(permissive.size, 1);
});

test('domain-ledger: re-appending the identical record is idempotent, older serials are rejected', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const first = await ownerRecord(owner, 'shop.domain.global', { serial: 5 });
    const appended = await ledger.append(first);
    const again = await ledger.append(first);
    assert.equal(ledger.size, 1, '同一 commitment は再追加しない (§14.4.3)');
    assert.equal(again.commitment, appended.commitment);
    assert.equal(again.anchor.leafIndex, 0);
    await assert.rejects(
        async () => ledger.append(await ownerRecord(owner, 'shop.domain.global', { serial: 4 })),
        (error) => error instanceof DomainConflictError && error.domain === 'shop.domain.global',
    );
    // 同一 serial で内容が違う → 勝者を決めず拒否 (fail-closed)
    await assert.rejects(
        async () => ledger.append(await ownerRecord(owner, 'shop.domain.global', { serial: 5, txt: 'different' })),
        DomainConflictError,
    );
    // より新しい serial は素通し（新しい葉になる）
    const next = await ledger.append(await ownerRecord(owner, 'shop.domain.global', { serial: 6, port: 8443 }));
    assert.equal(ledger.size, 2);
    assert.equal(next.anchor.leafIndex, 1);
    assert.equal(next.anchor.checkpoint.treeSize, 2);
    assert.equal(next.anchor.checkpoint.prevHash, await domainCheckpointHex(appended.anchor.checkpoint));
    const stored = await ledger.lookupByDomain('shop.domain.global');
    assert.equal(stored.body.serial, 6);
});

test('domain-ledger: revocation is a newer serial, and verifiers report it as revoked', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    await ledger.append(await ownerRecord(owner, 'shop.domain.global', { serial: 1 }));
    const revoked = await ledger.append(
        await ownerRecord(owner, 'shop.domain.global', { serial: 2, revoked: true }),
    );
    assert.equal(revoked.record.body.revoked, true);
    const verifier = createDomainOwnershipVerifier({
        logger: noopLogger,
        logKeys: { [log.nodeId]: log.publicKey },
        requireAnchor: true,
    });
    const proof = await verifier.verify(revoked.record);
    assert.equal(proof.ok, false);
    assert.equal(proof.code, 'revoked');
    // 焼却済みドメインへの更新（serial 3）は検証上ふつうに通る = ガバナンス未定義 (#43)
    const revived = await ledger.append(
        await ownerRecord(owner, 'shop.domain.global', { serial: 3, txt: 'recovered' }),
    );
    assert.equal((await verifier.verify(revived.record)).ok, true);
});

test('domain-ledger: checkpoint chain and merkle roots stay consistent across appends', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const domains = ['a.domain.global', 'b.domain.global', 'c.domain.global', 'd.domain.global', 'e.domain.global'];
    const appended = [];
    for (const [index, domain] of domains.entries()) {
        const result = await ledger.append(await ownerRecord(owner, domain, { serial: index + 1 }));
        appended.push(result);
        // 各葉の包含証明は、追加時点の木で検証できる
        assert.equal(
            await verifyDomainMerkleProof({
                commitment: result.commitment,
                leafIndex: result.anchor.leafIndex,
                treeSize: result.anchor.checkpoint.treeSize,
                root: result.anchor.checkpoint.root,
                proof: result.anchor.proof,
            }),
            true,
            `leaf ${index} proof must verify at append time`,
        );
    }
    // prevHash 連鎖が途切れていないこと（§14.3）
    let previous = appended[0].anchor.checkpoint;
    for (const entry of appended.slice(1)) {
        assert.equal(entry.anchor.checkpoint.prevHash, await domainCheckpointHex(previous));
        previous = entry.anchor.checkpoint;
    }
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.root, appended[4].anchor.checkpoint.root, 'snapshot のルートは直近チェックポイントと一致');
    assert.deepEqual(
        (await ledger.checkpointsBetween({ afterTreeSize: 1, toTreeSize: 5 })).map((entry) => entry.treeSize),
        [2, 3, 4],
    );
    // 追記専用なので、古い葉の証明は現在の木でも検証できる (§14.3)
    const rebuilt = await ledger.buildAnchor(0);
    assert.equal(rebuilt.checkpoint.root, snapshot.root);
    assert.equal(
        await verifyDomainMerkleProof({
            commitment: appended[0].commitment,
            leafIndex: 0,
            treeSize: 5,
            root: await ledger.root(),
            proof: rebuilt.proof,
        }),
        true,
    );
    await assert.rejects(() => ledger.buildAnchor(5), DomainLedgerAppendError);
});

test('domain-ledger: the leaf cap is enforced and snapshot exposes current records', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, maxEntries: 2, logger: noopLogger });
    await ledger.append(await ownerRecord(owner, 'a.domain.global'));
    await ledger.append(await ownerRecord(owner, 'b.domain.global'));
    await assert.rejects(
        async () => ledger.append(await ownerRecord(owner, 'c.domain.global')),
        (error) => error instanceof DomainLedgerAppendError && /full/.test(error.message),
    );
    const snapshot = await ledger.snapshot();
    assert.equal(snapshot.treeSize, 2);
    assert.equal(Object.keys(snapshot.current).length, 2);
    assert.equal(snapshot.checkpoint.treeSize, 2);
    assert.equal(snapshot.logId, log.nodeId);
    ledger.clear();
    assert.equal(ledger.size, 0);
    assert.equal(await ledger.root(), null);
    assert.equal(await ledger.checkpoint(), null);
    assert.throws(
        () => createDomainLedger({ keyManager: log, maxEntries: 0 }),
        /maxEntries/,
    );
    assert.equal(MAX_DOMAIN_TREE_SIZE > 0, true);
});

test('domain-ledger: conflict resolution follows the documented order (§14.4.3)', () => {
    const a = { serial: 2, commitment: 'aa', anchorLeafIndex: 4 };
    const b = { serial: 3, commitment: 'bb', anchorLeafIndex: 1 };
    assert.equal(conflictVerdict(a, b), 'candidate', 'max(serial) が勝つ');
    assert.equal(conflictVerdict(b, a), 'current');
    assert.equal(conflictVerdict(a, { ...a }), 'identical');
    assert.equal(conflictVerdict(a, { serial: 2, commitment: 'zz', anchorLeafIndex: 3 }), 'candidate', '先に台帳へ入った（葉番号が小さい）ほうが勝つ');
    assert.equal(conflictVerdict(a, { serial: 2, commitment: 'zz', anchorLeafIndex: 9 }), 'current');
    assert.equal(conflictVerdict(a, { serial: 2, commitment: 'zz' }), 'conflict', '決め手が無ければ conflict');
});

test('domain-ledger: the ledger doubles as an IDomainRecordSource for the memory source', async () => {
    const owner = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logger: noopLogger });
    const record = await ownerRecord(owner, 'shop.domain.global');
    await ledger.append(record);
    const source = memoryDomainRecordSource({ records: [await ledger.lookupByDomain('shop.domain.global')] });
    const found = await source.lookupByDomain('shop.domain.global');
    assert.equal(found[0].body.nodeId, owner.nodeId);
    assert.ok(found[0].anchor, 'アンカーごと渡される');
    assert.equal(await source.lookupByDomain('nope.domain.global'), null);
    assert.equal((await source.lookupByNodeId(owner.nodeId)).length, 1);
    const other = await NodeKeyManager.create();
    assert.equal((await source.lookupByNodeId(other.nodeId)).length, 0);
    // put / remove で追える
    await source.put(await ownerRecord(other, 'other.domain.global', { serial: 9 }));
    assert.equal(source.list().length, 2);
    assert.equal(source.remove('other.domain.global'), true);
    assert.equal(source.list().length, 1);
    await assert.rejects(async () => source.put({ bogus: true }), DomainRecordError);
    const parsed = await parseDomainOwnershipRecord(JSON.parse(JSON.stringify({
        version: 1,
        body: record.body,
        signature: record.signature,
    })));
    assert.equal(parsed.body.domain, 'shop.domain.global');
});
