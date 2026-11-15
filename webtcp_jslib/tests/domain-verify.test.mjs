import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DomainRecordError,
    canonicalDomainRecordBodyBytes,
    commitDomainRecord,
    createDomainLedger,
    createDomainOwnershipRecord,
    createDomainOwnershipVerifier,
    createDomainProofCache,
    decodeBase64Url,
    encodeBase64Url,
    sha256Domain,
    verifyDomainCheckpointChain,
    NodeKeyManager,
    noopLogger,
} from '../dist/index.js';

const encoder = new TextEncoder();
/** 台帳が「いま」発行するチェックポイントと時計を合わせるための基準時刻。 */
const LIVE = Date.now();
/** 検証専用で使う固定時計（2023-11-14）。 */
const NOW = 1_700_000_000_000;

const verifier = (options = {}) => createDomainOwnershipVerifier({ logger: noopLogger, ...options });

async function recordFor(keyManager, domain = 'shop.domain.global', overrides = {}) {
    return createDomainOwnershipRecord({
        domain,
        keyManager,
        serial: 1,
        issuedAt: NOW - 60_000,
        expiresAt: NOW + 3_600_000,
        ...overrides,
    });
}

/** 実時刻まわりのレコード（台帳アンカー付き検証に使う）。 */
async function liveRecord(keyManager, domain = 'shop.domain.global', overrides = {}) {
    return recordFor(keyManager, domain, {
        issuedAt: LIVE - 60_000,
        expiresAt: LIVE + 3_600_000,
        ...overrides,
    });
}

test('domain-verify: an owner-signed record without an anchor passes and reports the commitment', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await recordFor(keyManager);
    const proof = await verifier().verify(record, { nowMs: NOW });
    assert.equal(proof.ok, true);
    assert.equal(proof.code, 'ok');
    assert.equal(proof.anchorVerified, false);
    assert.equal(proof.chainVerified ?? null, null);
    assert.equal(proof.commitment, await commitDomainRecord(record.body));
    // canonical バイト列は署名対象として固定されている (§13.2)
    assert.equal(
        new TextDecoder().decode(canonicalDomainRecordBodyBytes(record.body)).length > 0,
        true,
    );
});

test('domain-verify: garbage input yields a failure result instead of throwing (§13.4.1 MUST)', async () => {
    for (const input of [null, undefined, 0, 'x', {}, { version: 1 }, { version: 1, body: {}, signature: '' }]) {
        const proof = await verifier().verify(input);
        assert.equal(proof.ok, false, `must reject ${JSON.stringify(input) ?? String(input)}`);
        assert.equal(typeof proof.code, 'string');
        assert.notEqual(proof.code, 'ok');
    }
});

test('domain-verify: expected-domain mismatch, expiry, not-yet-valid and stale serial are rejected', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await recordFor(keyManager);
    assert.equal(
        (await verifier().verify(record, { nowMs: NOW, expectedDomain: 'other.domain.global' })).code,
        'zone-mismatch',
    );
    // 既定 clockSkewMs = 300 000 ms（§11.3）の分だけ境界が動く
    assert.equal((await verifier().verify(record, { nowMs: NOW + 3_600_000 + 1 })).ok, true, '猶予内だから有効');
    assert.equal(
        (await verifier().verify(record, { nowMs: NOW + 3_600_000 + 300_001 })).code,
        'expired',
    );
    assert.equal(
        (await verifier().verify(record, { nowMs: NOW + 3_600_000 + 1, clockSkewMs: 0 })).code,
        'expired',
    );
    assert.equal(
        (await verifier().verify(record, { nowMs: NOW - 60_000 - 300_001 })).code,
        'not-yet-valid',
    );
    assert.equal((await verifier().verify(record, { nowMs: NOW, knownSerial: 2 })).code, 'stale-serial');
    assert.equal((await verifier().verify(record, { nowMs: NOW, knownSerial: 1 })).ok, true, '同一 serial は受理');
    const tooLong = await createDomainOwnershipRecord({
        domain: 'shop.domain.global',
        keyManager,
        serial: 1,
        issuedAt: NOW - 60_000,
        expiresAt: NOW + 400 * 24 * 3_600_000,
    }).then(
        () => null,
        (error) => error,
    );
    assert.ok(tooLong instanceof DomainRecordError, '寿命上限は生成時点で弾く (§13.2)');
});

test('domain-verify: tampered signatures, swapped keys and revocation are detected', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await recordFor(keyManager);
    const bytes = decodeBase64Url(record.signature);
    bytes[31] ^= 0x01;
    assert.equal(
        (await verifier().verify({ ...record, signature: encodeBase64Url(bytes) }, { nowMs: NOW })).code,
        'bad-signature',
    );
    const other = await NodeKeyManager.create();
    assert.equal(
        (await verifier().verify({ ...record, body: { ...record.body, nodeId: other.nodeId } }, { nowMs: NOW })).code,
        'fingerprint-mismatch',
    );
    const revoked = await recordFor(keyManager, 'shop.domain.global', { revoked: true });
    const proof = await verifier().verify(revoked, { nowMs: NOW });
    assert.equal(proof.ok, false);
    assert.equal(proof.code, 'revoked');
    assert.ok(proof.commitment, '失効でも commitment は返す');
});

test('domain-verify: anchors need a trusted log key and an intact proof (§13.4.1 の 7)', async () => {
    const keyManager = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logId: 'demo-log', logger: noopLogger });
    const record = await liveRecord(keyManager);
    const appended = await ledger.append(record);
    assert.equal(appended.anchor.checkpoint.logId, 'demo-log');
    assert.equal(appended.anchor.checkpoint.prevHash, '0'.repeat(64), 'first leaf is the genesis link');

    // ログ鍵が未設定なら fail-closed
    assert.equal(
        (await verifier({ requireAnchor: true }).verify(appended.record, { nowMs: Date.now() })).code,
        'anchor-untrusted-log',
    );
    const withKeys = { logKeys: { 'demo-log': log.publicKey } };
    const ok = await verifier({ requireAnchor: true, ...withKeys }).verify(appended.record, { nowMs: Date.now() });
    assert.equal(ok.ok, true);
    assert.equal(ok.anchorVerified, true);
    // アンカー必須の設定で素のレコード → anchor-missing
    assert.equal(
        (await verifier({ requireAnchor: true, ...withKeys }).verify(record, { nowMs: Date.now() })).code,
        'anchor-missing',
    );
    // 包含証明の改ざん
    const forged = encodeBase64Url(await sha256Domain(encoder.encode('x')));
    const badProof = {
        ...appended.record,
        anchor: { ...appended.anchor, proof: appended.anchor.proof.length > 0 ? [forged] : [forged] },
    };
    assert.equal(
        (await verifier({ requireAnchor: true, ...withKeys }).verify(badProof, { nowMs: Date.now() })).code,
        'anchor-bad-proof',
    );
    const badLeaf = { ...appended.record, anchor: { ...appended.anchor, leafIndex: appended.anchor.leafIndex + 1 } };
    assert.equal(
        (await verifier({ requireAnchor: true, ...withKeys }).verify(badLeaf, { nowMs: Date.now() })).code,
        'anchor-bad-proof',
    );
    // チェックポイント本文の改ざん（署名が合わなくなる）
    const badCheckpoint = {
        ...appended.record,
        anchor: { ...appended.anchor, checkpoint: { ...appended.anchor.checkpoint, root: forged } },
    };
    assert.equal(
        (await verifier({ requireAnchor: true, ...withKeys }).verify(badCheckpoint, { nowMs: Date.now() })).code,
        'anchor-bad-checkpoint',
    );
    // 別鍵をログ鍵として設定すると通らない
    const stranger = await NodeKeyManager.create();
    assert.equal(
        (
            await verifier({ requireAnchor: true, logKeys: { 'demo-log': stranger.publicKey } }).verify(
                appended.record,
                { nowMs: Date.now() },
            )
        ).code,
        'anchor-bad-checkpoint',
    );
    // KeyDirectory 相当の遅延解決でも検証できる
    assert.equal(
        (
            await verifier({ requireAnchor: true, resolveLogKey: (id) => (id === 'demo-log' ? log.publicKey : null) }).verify(
                appended.record,
                { nowMs: Date.now() },
            )
        ).ok,
        true,
    );
});

test('domain-verify: pinned checkpoints reject rolled-back anchors', async () => {
    const keyManager = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logId: 'pin-log', logger: noopLogger });
    const first = await ledger.append(await liveRecord(keyManager, 'a.domain.global'));
    await ledger.append(await liveRecord(keyManager, 'b.domain.global'));
    const later = await ledger.append(await liveRecord(keyManager, 'c.domain.global'));
    const options = { requireAnchor: true, logKeys: { 'pin-log': log.publicKey } };
    const rollback = await verifier(options).verify(first.record, {
        nowMs: Date.now(),
        pinnedCheckpoint: later.record.anchor.checkpoint,
    });
    assert.equal(rollback.code, 'anchor-rollback');
    assert.equal(
        (
            await verifier(options).verify(later.record, {
                nowMs: Date.now(),
                pinnedCheckpoint: later.record.anchor.checkpoint,
            })
        ).ok,
        true,
    );
    // 区間を渡せば prevHash 連鎖も追える（§13.3）
    const chain = await verifyDomainCheckpointChain({
        pinned: first.record.anchor.checkpoint,
        target: later.record.anchor.checkpoint,
        between: await ledger.checkpointsBetween({ afterTreeSize: 1, toTreeSize: 3 }),
    });
    assert.equal(chain.ok, true);
    assert.deepEqual(await ledger.checkpointsBetween({ afterTreeSize: 1, toTreeSize: 3 }).then((list) => list.map((entry) => entry.treeSize)), [2]);
});

test('domain-verify: on-chain anchors are delegated to IChainAnchorVerifier (§13.4.2)', async () => {
    const keyManager = await NodeKeyManager.create();
    const log = await NodeKeyManager.create();
    const ledger = createDomainLedger({ keyManager: log, logId: 'chain-log', logger: noopLogger });
    const appended = await ledger.append(await liveRecord(keyManager));
    const withChain = {
        ...appended.record,
        anchor: { ...appended.anchor, chain: { network: 'namecoin', txId: 'tx-1', blockHeight: 100 } },
    };
    const logKeys = { 'chain-log': log.publicKey };
    const now = Date.now();
    // 検証器未設定 → chainVerified: null（オフライン検証範囲であることを明示）
    const unverified = await verifier({ logKeys }).verify(withChain, { nowMs: now });
    assert.equal(unverified.ok, true);
    assert.equal(unverified.chainVerified, null);
    assert.equal(
        (await verifier({ logKeys, requireChainAnchor: true }).verify(withChain, { nowMs: now })).code,
        'chain-unverified',
    );
    const seen = [];
    const accepted = await verifier({
        logKeys,
        requireChainAnchor: true,
        chainAnchorVerifier: {
            name: 'stub',
            async verify(input) {
                seen.push(input);
                return { verified: true, finality: 6 };
            },
        },
    }).verify(withChain, { nowMs: now });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.chainVerified, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].chain.network, 'namecoin');
    assert.equal(seen[0].commitment, appended.commitment);
    assert.match(seen[0].checkpointHash, /^[0-9a-f]{64}$/);
    const rejected = await verifier({
        logKeys,
        requireChainAnchor: true,
        chainAnchorVerifier: { async verify() { return { verified: false, detail: 'reorged' }; } },
    }).verify(withChain, { nowMs: now });
    assert.equal(rejected.code, 'chain-unverified');
    assert.match(rejected.message, /reorged/);
    // 例外も結果へ写像する（検証器は例外を投げない MUST）
    const thrown = await verifier({
        logKeys,
        chainAnchorVerifier: {
            async verify() {
                throw new Error('rpc down');
            },
        },
    }).verify(withChain, { nowMs: now });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.code, 'chain-unverified');
});

test('domain-verify: the proof cache tracks serials and pinned checkpoints', async () => {
    const keyManager = await NodeKeyManager.create();
    const state = createDomainProofCache({ maxEntries: 2 });
    assert.equal(state.knownSerial('a.domain.global'), undefined);
    assert.equal(state.observe(await recordFor(keyManager, 'a.domain.global', { serial: 3 })), true);
    assert.equal(state.knownSerial('a.domain.global'), 3);
    assert.equal(
        state.observe(await recordFor(keyManager, 'a.domain.global', { serial: 2 })),
        false,
        '後退した serial は拒否',
    );
    assert.equal(state.observe(await recordFor(keyManager, 'a.domain.global', { serial: 4 })), true);
    assert.equal(state.knownSerial('a.domain.global'), 4);
    state.rememberCommitment('a.domain.global', 'ab'.repeat(32));
    assert.equal(state.knownCommitment('a.domain.global'), 'ab'.repeat(32));
    assert.equal(state.observe(await recordFor(keyManager, 'b.domain.global')), true);
    assert.equal(state.size, 2, 'maxEntries を超えた分は退避');
    state.clear();
    assert.equal(state.size, 0);
    assert.equal(state.knownCommitment('a.domain.global'), undefined);
});
