import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_DOMAIN_RECORD_LIFETIME_MS,
    DOMAIN_GLOBAL_ZONE,
    DOMAIN_RECORD_VERSION,
    DomainRecordError,
    MAX_DOMAIN_RECORD_BYTES,
    MAX_DOMAIN_RECORD_LIFETIME_MS,
    canonicalDomainRecordBodyBytes,
    commitDomainRecord,
    createDomainOwnershipRecord,
    createDomainOwnershipVerifier,
    decodeBase64Url,
    decodePublicKey,
    domainRecordToJSON,
    encodeBase64Url,
    encodePublicKey,
    isValidDomainName,
    normalizeDomainName,
    parseDomainOwnershipRecord,
    parseDomainRecordBody,
    serializeDomainRecord,
    NodeKeyManager,
} from '../dist/index.js';

// specification.md §14.1 / §14.2 の名前規則と所有権レコード形式。
test('domain-record: names are normalized and restricted to LDH labels in domain.global', () => {
    assert.equal(DOMAIN_GLOBAL_ZONE, 'domain.global');
    assert.equal(normalizeDomainName('Shop.Domain.Global.'), 'shop.domain.global');
    assert.equal(isValidDomainName('a-b.example'), true);
    assert.equal(isValidDomainName('-bad.example'), false);
    assert.equal(isValidDomainName('bad-.example'), false);
    assert.equal(isValidDomainName('under_score.example'), false);
    assert.equal(isValidDomainName(`${'x'.repeat(63)}.y`), true, '63 文字ラベルは許容');
    assert.equal(isValidDomainName(`${'x'.repeat(64)}.y`), false, '64 文字ラベルは拒否');
    assert.throws(() => normalizeDomainName('shop.example'), /domain\.global/);
    assert.throws(() => normalizeDomainName('shop'), /domain\.global/);
    assert.throws(() => normalizeDomainName('a..b.domain.global'), /invalid domain label/);
});

test('domain-record: canonical bytes fix the key order, always emit revoked and omit absent fields', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await createDomainOwnershipRecord({
        domain: 'shop.domain.global',
        keyManager,
        serial: 1,
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_000_000 + 3_600_000,
    });
    const text = new TextDecoder().decode(canonicalDomainRecordBodyBytes(record.body));
    assert.equal(
        text,
        `{"version":1,"domain":"shop.domain.global","nodeId":"${record.body.nodeId}",` +
            `"ownerPublicKey":"${record.body.ownerPublicKey}","serial":1,"issuedAt":1700000000000,` +
            `"expiresAt":1700003600000,"revoked":false}`,
    );
    assert.ok(!text.includes('"port"'));
    assert.ok(!text.includes('"txt"'));
    // `port` / `txt` は存在時のみ、この順で末尾に書く (§14.2)。
    const withExtras = await createDomainOwnershipRecord({
        domain: 'shop.domain.global',
        keyManager,
        serial: 2,
        port: 8443,
        txt: 'label=demo',
        lifetimeMs: 60_000,
    });
    const extras = new TextDecoder().decode(canonicalDomainRecordBodyBytes(withExtras.body));
    assert.ok(extras.endsWith(',"port":8443,"txt":"label=demo"}'), extras.slice(-80));
});

test('domain-record: commitment is hex SHA-256 of the canonical bytes and survives JSON round trips', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await createDomainOwnershipRecord({ domain: 'a.domain.global', keyManager, serial: 7 });
    const commitment = await commitDomainRecord(record.body);
    assert.match(commitment, /^[0-9a-f]{64}$/);
    const json = domainRecordToJSON(record);
    assert.equal(json.version, DOMAIN_RECORD_VERSION);
    assert.equal(await commitDomainRecord(parseDomainRecordBody(json.body)), commitment);
    const restored = await parseDomainOwnershipRecord(json);
    assert.equal(restored.signature, record.signature);
    assert.equal(await commitDomainRecord(restored.body), commitment);
    // UTF-8 JSON バイト列からも解析できる（レジストリの `application/json` 経路）。
    assert.equal((await parseDomainOwnershipRecord(serializeDomainRecord(record))).body.domain, 'a.domain.global');
});

test('domain-record: the owner signature covers the canonical bytes and tampering is detected', async () => {
    const keyManager = await NodeKeyManager.create();
    const verifier = createDomainOwnershipVerifier({});
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager, serial: 1 });
    const publicKey = decodePublicKey(record.body.ownerPublicKey);
    assert.equal(publicKey.length, 32);
    assert.equal(
        await keyManager.verify(publicKey, canonicalDomainRecordBodyBytes(record.body), decodeBase64Url(record.signature)),
        true,
    );
    assert.equal((await verifier.verify(record)).ok, true);

    const tampered = { ...record, body: { ...record.body, port: 9999 } };
    const tamperProof = await verifier.verify(tampered);
    assert.equal(tamperProof.ok, false);
    assert.equal(tamperProof.code, 'bad-signature');

    const rebind = { ...record, body: { ...record.body, nodeId: 'f'.repeat(32) } };
    assert.equal((await verifier.verify(rebind)).code, 'fingerprint-mismatch');

    const bytes = decodeBase64Url(record.signature);
    bytes[0] ^= 0xff;
    const flipped = { ...record, signature: encodeBase64Url(bytes) };
    assert.equal((await verifier.verify(flipped)).code, 'bad-signature');
});

test('domain-record: strict parsing rejects unknown fields, bad types and out-of-range values', async () => {
    const keyManager = await NodeKeyManager.create();
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager, serial: 1 });
    assert.equal(
        record.body.expiresAt - record.body.issuedAt,
        DEFAULT_DOMAIN_RECORD_LIFETIME_MS,
        '既定寿命は 30 日 (§12.3)',
    );
    const json = domainRecordToJSON(record);
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, extra: 1 }),
        (error) =>
            error instanceof DomainRecordError && /unknown field "extra" in record/.test(error.message),
    );
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, body: { ...json.body, extra: 1 } }),
        (error) => error instanceof DomainRecordError && /unknown field "extra" in record\.body/.test(error.message),
    );
    await assert.rejects(() => parseDomainOwnershipRecord('nope'), DomainRecordError);
    await assert.rejects(() => parseDomainOwnershipRecord({ ...json, version: 2 }), /version/);
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, body: { ...json.body, serial: 0 } }),
        /serial/,
    );
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, body: { ...json.body, expiresAt: json.body.issuedAt } }),
        /expiresAt/,
    );
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, body: { ...json.body, nodeId: 'XYZ' } }),
        /nodeId/,
    );
    await assert.rejects(() => parseDomainOwnershipRecord({ ...json, signature: 'not base64!' }), /signature/);
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, anchor: { leafIndex: 0 } }),
        /anchor/,
    );
    // 指紋と公開鍵の組替えは構造検証段階で拒否する (§14.2)。
    const other = await NodeKeyManager.create();
    await assert.rejects(
        () => parseDomainOwnershipRecord({ ...json, body: { ...json.body, nodeId: other.nodeId } }),
        /fingerprint/,
    );
});

test('domain-record: lifetime, port and txt limits are enforced (§14.2 / §14.7)', async () => {
    const keyManager = await NodeKeyManager.create();
    await assert.rejects(
        () =>
            createDomainOwnershipRecord({
                domain: 'shop.domain.global',
                keyManager,
                serial: 1,
                lifetimeMs: MAX_DOMAIN_RECORD_LIFETIME_MS * 2,
            }),
        /lifetime/,
    );
    const record = await createDomainOwnershipRecord({ domain: 'shop.domain.global', keyManager, serial: 1 });
    assert.equal(
        record.body.expiresAt - record.body.issuedAt,
        DEFAULT_DOMAIN_RECORD_LIFETIME_MS,
        '既定寿命は 30 日 (§12.3)',
    );
    const json = domainRecordToJSON(record);
    assert.throws(() => parseDomainRecordBody({ ...json.body, port: 0 }), /port/);
    assert.throws(() => parseDomainRecordBody({ ...json.body, port: 70000 }), /port/);
    assert.throws(() => parseDomainRecordBody({ ...json.body, port: 1.5 }), /port/);
    assert.throws(() => parseDomainRecordBody({ ...json.body, txt: 'multi\nline' }), /txt/);
    assert.throws(() => parseDomainRecordBody({ ...json.body, txt: 'x'.repeat(256) }), /txt/);
    assert.throws(
        () => parseDomainRecordBody({ ...json.body, txt: 'z'.repeat(MAX_DOMAIN_RECORD_BYTES) }),
        (error) => error instanceof DomainRecordError,
    );
});

test('domain-record: public key encoding is Base64url without padding and reversible', async () => {
    const keyManager = await NodeKeyManager.create();
    const encoded = encodePublicKey(keyManager.publicKey);
    assert.ok(!encoded.includes('='));
    assert.ok(!encoded.match(/[+/]/));
    assert.equal(decodePublicKey(encoded).length, 32);
    assert.equal(encodePublicKey(decodePublicKey(encoded)), encoded);
    assert.equal(decodePublicKey(`${encoded}A`), null);
});
