import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWebTCPUrl, formatWebTCPUrl, normalizeWebTCPName } from '../dist/index.js';

const ID = '0123456789abcdef0123456789abcdef';

test('naming-url: parses NodeId and name URLs with mandatory port', () => {
    const a = parseWebTCPUrl(`webtcp://${ID}:8080/path?x=1#frag`);
    assert.equal(a.nodeId, ID);
    assert.equal(a.name, undefined);
    assert.equal(a.port, 8080);
    assert.equal(a.path, '/path');
    assert.equal(a.search, '?x=1');
    assert.equal(a.hash, '#frag');
    assert.equal(formatWebTCPUrl(a), `webtcp://${ID}:8080/path?x=1#frag`);

    const b = parseWebTCPUrl('webtcp://My-Service.WebTCP:443');
    assert.equal(b.host, 'my-service.webtcp');
    assert.equal(b.name, 'my-service.webtcp');
    assert.equal(b.path, '/');
    assert.equal(formatWebTCPUrl(b), 'webtcp://my-service.webtcp:443/');
    assert.equal(parseWebTCPUrl(`WEBTCP://${ID.toUpperCase()}:1/`).nodeId, ID);
});

test('naming-url: rejects malformed, ambiguous and unsafe URLs', () => {
    for (const bad of [
        '', 'http://example.com:80/', `webtcp://${ID}/`, `webtcp://${ID}:0/`, `webtcp://${ID}:65536/`,
        `webtcp://${ID}:abc/`, `webtcp://:80/`, `webtcp://user@host:80/`, 'webtcp://[::1]:80/',
        'webtcp://ho%73t:80/', 'webtcp://host:80:90/', 'webtcp://host:80\\path', 'webtcp://host:80/ path',
        'webtcp://-bad:80/', 'webtcp://bad-:80/', 'webtcp://bad..name:80/',
    ]) {
        assert.throws(() => parseWebTCPUrl(bad), undefined, bad);
    }
    assert.equal(parseWebTCPUrl(`webtcp://${ID}:80`).path, '/');
});

test('naming-url: name normalization reserves NodeId literals and validates LDH', () => {
    assert.equal(normalizeWebTCPName('Example.COM.'), 'example.com');
    assert.throws(() => normalizeWebTCPName(ID), /reserved/);
    assert.throws(() => normalizeWebTCPName('a'.repeat(64) + '.com'), /invalid/);
    assert.throws(() => normalizeWebTCPName('under_score'), /invalid/);
    assert.throws(() => normalizeWebTCPName(''), /empty/);
});
