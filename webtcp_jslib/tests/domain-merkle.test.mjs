import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GENESIS_PREV_HASH,
    MERKLE_LEAF_PREFIX,
    MERKLE_NODE_PREFIX,
    buildDomainMerkleProof,
    bindDomainMerkleRoot,
    buildDomainMerkleRoot,
    bytesToHex,
    canonicalDomainCheckpointBytes,
    computeDomainMerkleRoot,
    decodeBase64Url,
    domainCheckpointHash,
    domainMerkleLeafHash,
    domainMerkleNodeHash,
    domainMerkleProofLength,
    encodeBase64Url,
    prefixByte,
    sha256Domain,
    signDomainCheckpoint,
    verifyDomainCheckpoint,
    verifyDomainCheckpointChain,
    verifyDomainMerkleProof,
    checkpointRollsBack,
    parseDomainAnchor,
    parseDomainCheckpoint,
    NodeKeyManager,
} from '../dist/index.js';

const encoder = new TextEncoder();

async function leaves(count) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
        const digest = await sha256Domain(encoder.encode(`leaf-${i}`));
        // commitment は 32 バイトのハッシュそのもの（specification.md §14.2）。
        out.push(digest);
    }
    return out;
}

test('domain-merkle: leaf and node hashes use distinct domain-separation prefixes (§14.3)', async () => {
    const data = encoder.encode('commitment');
    const leaf = await domainMerkleLeafHash(data);
    const node = await domainMerkleNodeHash(data, data);
    assert.equal(bytesToHex(leaf), bytesToHex(await sha256Domain(prefixByte(MERKLE_LEAF_PREFIX, data))));
    const { concatBytes } = await import('../dist/index.js');
    assert.equal(
        bytesToHex(node),
        bytesToHex(await sha256Domain(prefixByte(MERKLE_NODE_PREFIX, concatBytes([data, data])))),
        '内部ノードは H(0x01 || left || right)',
    );
    assert.notEqual(bytesToHex(leaf), bytesToHex(node));
    assert.equal(MERKLE_LEAF_PREFIX, 0x00);
    assert.equal(MERKLE_NODE_PREFIX, 0x01);
});

test('domain-merkle: proof length follows ceil(log2(treeSize)) with the promote rule for odd levels', () => {
    assert.equal(domainMerkleProofLength(1), 0);
    assert.equal(domainMerkleProofLength(2), 1);
    assert.equal(domainMerkleProofLength(3), 2);
    assert.equal(domainMerkleProofLength(4), 2);
    assert.equal(domainMerkleProofLength(5), 3);
    assert.equal(domainMerkleProofLength(8), 3);
    assert.equal(domainMerkleProofLength(9), 4);
});

test('domain-merkle: every leaf of every tree size verifies against the root', async () => {
    for (const size of [1, 2, 3, 4, 5, 8, 9, 16]) {
        const leafBytes = await leaves(size);
        const root = await buildDomainMerkleRoot(leafBytes);
        assert.equal(decodeBase64Url(root).length, 32, 'root is a 32-byte hash in Base64url');
        for (let index = 0; index < size; index += 1) {
            const proof = await buildDomainMerkleProof(leafBytes, index);
            assert.equal(proof.length, domainMerkleProofLength(size), `size ${size} index ${index}`);
            const ok = await verifyDomainMerkleProof({
                commitment: bytesToHex(leafBytes[index]),
                leafIndex: index,
                treeSize: size,
                root,
                proof,
            });
            assert.equal(ok, true, `size ${size} index ${index} must verify`);
        }
    }
});

test('domain-merkle: tampering with commitment, index, tree size, root or proof is rejected', async () => {
    const leafBytes = await leaves(5);
    const root = await buildDomainMerkleRoot(leafBytes);
    const proof = await buildDomainMerkleProof(leafBytes, 2);
    const base = { commitment: bytesToHex(leafBytes[2]), leafIndex: 2, treeSize: 5, root, proof };
    assert.equal(await verifyDomainMerkleProof(base), true);
    assert.equal(await verifyDomainMerkleProof({ ...base, commitment: bytesToHex(await sha256Domain(encoder.encode('other'))) }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, leafIndex: 1 }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, treeSize: 6 }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, treeSize: 4 }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, leafIndex: 5 }), false, 'leafIndex must be < treeSize');
    assert.equal(await verifyDomainMerkleProof({ ...base, root: await buildDomainMerkleRoot(await leaves(6)) }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, proof: proof.slice(1) }), false);
    const swapped = [...proof];
    swapped[0] = encodeBase64Url(await domainMerkleNodeHash(leafBytes[0], leafBytes[0]));
    assert.equal(await verifyDomainMerkleProof({ ...base, proof: swapped }), false);
    assert.equal(await verifyDomainMerkleProof({ ...base, commitment: 'zz' }), false, 'malformed commitment');
});

test('domain-merkle: root computation matches a hand-built tree for three leaves (promote rule)', async () => {
    const leafBytes = await leaves(3);
    const h = (bytes) => domainMerkleLeafHash(bytes);
    const l0 = await h(leafBytes[0]);
    const l1 = await h(leafBytes[1]);
    const l2 = await h(leafBytes[2]);
    const n01 = await domainMerkleNodeHash(l0, l1);
    const n22 = await domainMerkleNodeHash(l2, l2);
    const top = await domainMerkleNodeHash(n01, n22);
    // ルートは木サイズへバインドする (§14.3)
    const expected = encodeBase64Url(await bindDomainMerkleRoot(top, 3));
    assert.equal(await buildDomainMerkleRoot(leafBytes), expected);
    assert.equal(
        bytesToHex(await computeDomainMerkleRoot(leafBytes)),
        bytesToHex(decodeBase64Url(expected)),
    );
});

test('domain-merkle: checkpoint canonical bytes, signing and log-key trust are enforced', async () => {
    const log = await NodeKeyManager.create();
    const checkpoint = {
        logId: log.nodeId,
        treeSize: 1,
        root: encodeBase64Url(await sha256Domain(encoder.encode('x'))),
        prevHash: GENESIS_PREV_HASH,
        timestamp: 1_700_000_000_000,
    };
    assert.equal(
        new TextDecoder().decode(canonicalDomainCheckpointBytes(checkpoint)),
        `{"logId":"${checkpoint.logId}","treeSize":1,"root":"${checkpoint.root}","prevHash":"${GENESIS_PREV_HASH}","timestamp":1700000000000}`,
    );
    const signed = await signDomainCheckpoint(checkpoint, log);
    assert.equal(decodeBase64Url(signed.signature).length, 64);
    assert.deepEqual(parseDomainCheckpoint(signed), signed);

    const verified = await verifyDomainCheckpoint(signed, { logKeys: { [log.nodeId]: log.publicKey } });
    assert.equal(verified.ok, true);
    assert.equal(verified.code, 'ok');

    // 未設定のログ鍵は fail-closed (§14.4.1 の 7)。
    const stranger = await NodeKeyManager.create();
    const untrusted = await verifyDomainCheckpoint(signed, { logKeys: { [stranger.nodeId]: stranger.publicKey } });
    assert.equal(untrusted.ok, false);
    assert.equal(untrusted.code, 'anchor-untrusted-log');
    const noKeys = await verifyDomainCheckpoint(signed, {});
    assert.equal(noKeys.code, 'anchor-untrusted-log');

    // 署名一致・時刻一致の検証。
    const tampered = await verifyDomainCheckpoint({ ...signed, treeSize: 2 }, { logKeys: { [log.nodeId]: log.publicKey } });
    assert.equal(tampered.code, 'anchor-bad-checkpoint');
    const stale = await verifyDomainCheckpoint(signed, {
        logKeys: { [log.nodeId]: log.publicKey },
        maxAgeMs: 1000,
        nowMs: 1_700_000_000_000 + 5000,
    });
    assert.equal(stale.code, 'anchor-bad-checkpoint');
    const future = await verifyDomainCheckpoint(signed, { logKeys: { [log.nodeId]: log.publicKey }, nowMs: 1 });
    assert.equal(future.code, 'anchor-bad-checkpoint');

    // 遅延解決でも受け付ける（KeyDirectory 再利用を想定、§14.4.1）。
    const resolved = await verifyDomainCheckpoint(signed, { resolveLogKey: () => encodeBase64Url(log.publicKey) });
    assert.equal(resolved.ok, true);
});

test('domain-merkle: prevHash chaining detects rollback and forks (§14.3)', async () => {
    const log = await NodeKeyManager.create();
    const logKeys = { [log.nodeId]: log.publicKey };
    const first = await signDomainCheckpoint(
        { logId: log.nodeId, treeSize: 1, root: encodeBase64Url(await sha256Domain(encoder.encode('a'))), prevHash: GENESIS_PREV_HASH, timestamp: 10 },
        log,
    );
    const second = await signDomainCheckpoint(
        {
            logId: log.nodeId,
            treeSize: 2,
            root: encodeBase64Url(await sha256Domain(encoder.encode('b'))),
            prevHash: await domainCheckpointHash(first),
            timestamp: 20,
        },
        log,
    );
    assert.equal((await verifyDomainCheckpoint(second, { logKeys })).ok, true);
    assert.equal((await verifyDomainCheckpointChain({ pinned: first, target: second })).ok, true, 'adjacent checkpoints need no range');
    const rolledBack = await verifyDomainCheckpointChain({ pinned: second, target: first });
    assert.equal(rolledBack.code, 'anchor-rollback');
    assert.equal(checkpointRollsBack(second, first), true);
    assert.equal(checkpointRollsBack(first, second), false);
    // 同一 treeSize でルートが違う = フォーク
    const forked = await signDomainCheckpoint(
        { logId: log.nodeId, treeSize: 2, root: encodeBase64Url(await sha256Domain(encoder.encode('evil'))), prevHash: GENESIS_PREV_HASH, timestamp: 21 },
        log,
    );
    assert.equal((await verifyDomainCheckpointChain({ pinned: first, target: forked })).code, 'anchor-rollback', 'adjacent but prevHash mismatch');
    assert.equal((await verifyDomainCheckpointChain({ pinned: second, target: forked })).code, 'anchor-rollback');
    // 3 件以上の区間は between を渡して追跡する
    const third = await signDomainCheckpoint(
        {
            logId: log.nodeId,
            treeSize: 3,
            root: encodeBase64Url(await sha256Domain(encoder.encode('c'))),
            prevHash: await domainCheckpointHash(second),
            timestamp: 30,
        },
        log,
    );
    assert.equal((await verifyDomainCheckpointChain({ pinned: first, target: third })).code, 'unavailable');
    assert.equal((await verifyDomainCheckpointChain({ pinned: first, target: third, between: [second] })).ok, true);
    const broken = { ...third, prevHash: GENESIS_PREV_HASH };
    assert.equal((await verifyDomainCheckpointChain({ pinned: first, target: broken, between: [second] })).code, 'anchor-rollback');
    // 非署名の third を署名なしで比較すると prevHash は一致しない（改ざん検出）
    assert.equal(
        (await verifyDomainCheckpointChain({ pinned: first, target: third, between: [{ ...second, prevHash: GENESIS_PREV_HASH }] })).code,
        'anchor-rollback',
    );
    assert.equal((await parseDomainCheckpoint(third)).logId, log.nodeId);
    assert.throws(() => parseDomainCheckpoint({ ...third, bogus: 1 }), /unknown field "bogus" in checkpoint/);
    assert.throws(() => parseDomainAnchor({ leafIndex: 0, proof: ['!!'], checkpoint: third }), /Base64url/);
    assert.throws(() => parseDomainAnchor({ leafIndex: -1, proof: [], checkpoint: third }), /leafIndex/);
});
