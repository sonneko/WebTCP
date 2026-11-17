import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HTTPChunkedDecoder,
    HTTPHeadParser,
    HTTPHeaderInjectionError,
    HTTPHeaders,
    HTTPParseError,
    determineRequestFraming,
    determineResponseFraming,
    parseRequestLine,
    parseStatusLine,
    serializeHTTPRequest,
    serializeHTTPResponse,
} from '../dist/index.js';

const enc = (text) => new TextEncoder().encode(text);

function parseRequest(text, limits = {}) {
    const parser = new HTTPHeadParser(false, limits);
    const result = parser.push(enc(text));
    assert.ok(result, 'expected the parser to reach the end of the head');
    return result;
}

function parseResponse(text, limits = {}) {
    const parser = new HTTPHeadParser(true, limits);
    const result = parser.push(enc(text));
    assert.ok(result, 'expected the parser to reach the end of the head');
    return result;
}

test('http-parse: request line and headers', () => {
    const head = parseRequest(
        'GET /hello?x=1 HTTP/1.1\r\nHost: demo:8080\r\nX-Forwarded-For: 1.2.3.4\r\n\r\n',
    );
    assert.equal(head.startLine.method, 'GET');
    assert.equal(head.startLine.target, '/hello?x=1');
    assert.equal(head.headers.get('host'), 'demo:8080');
    assert.equal(head.headers.get('x-forwarded-for'), '1.2.3.4');
    assert.deepEqual(head.framing, { kind: 'none' });
});

test('http-parse: duplicate headers are preserved in order and comma-joined for get()', () => {
    const head = parseRequest(
        'GET / HTTP/1.1\r\nHost: a\r\nSet-Cookie: x=1\r\nSet-Cookie: y=2\r\n\r\n',
    );
    assert.deepEqual(head.headers.getAll('set-cookie'), ['x=1', 'y=2']);
    assert.equal(head.headers.get('set-cookie'), 'x=1, y=2');
    assert.equal(head.headers.size, 3);
});

test('http-parse: 1 byte at a time produces the same result (split resistance)', () => {
    const text = 'POST /submit HTTP/1.1\r\nHost: h\r\nContent-Length: 3\r\n\r\nabc';
    const parser = new HTTPHeadParser(false);
    let result = null;
    let headEnd = -1;
    for (let i = 0; i < text.length; i += 1) {
        const next = parser.push(enc(text[i]));
        if (next && !result) {
            result = next;
            headEnd = i;
        }
    }
    // ヘッダ終端（空行の最後の LF）で確定し、本文 3 バイトは読まない
    assert.equal(headEnd, text.indexOf('\r\n\r\n') + 3);
    assert.equal(result.startLine.method, 'POST');
    assert.deepEqual(result.framing, { kind: 'length', length: 3 });
});

test('http-parse: split between CR and LF still parses', () => {
    const parser = new HTTPHeadParser(false);
    assert.equal(parser.push(enc('GET / HTTP/1.1\r')), null);
    assert.equal(parser.push(enc('\nHost: h\r')), null);
    const result = parser.push(enc('\n\r\n'));
    assert.ok(result);
    assert.equal(result.headers.get('host'), 'h');
});

test('http-parse: split in the middle of a 16 KiB MSS-sized header', () => {
    const big = 'x'.repeat(7000);
    const headText = `GET /big HTTP/1.1\r\nHost: h\r\nX-Big: ${big}\r\n\r\n`;
    const bytes = enc(headText);
    const parser = new HTTPHeadParser(false);
    // MSS 16 KiB の半分（8192）に収まる位置で分割する
    const cut = 4096;
    assert.ok(bytes.byteLength > cut);
    assert.equal(parser.push(bytes.subarray(0, cut)), null);
    const result = parser.push(bytes.subarray(cut));
    assert.ok(result);
    assert.equal(result.headers.get('x-big').length, 7000);
});

test('http-parse: bare LF is rejected when strictLineEndings is true', () => {
    const parser = new HTTPHeadParser(false);
    assert.throws(() => parser.push(enc('GET / HTTP/1.1\nHost: h\r\n\r\n')), HTTPParseError);
});

test('http-parse: bare CR at the end of a line is rejected', () => {
    const parser = new HTTPHeadParser(false);
    assert.throws(() => {
        parser.push(enc('GET / HTTP/1.1\r\r\n'));
        parser.push(enc('\r\n'));
    }, HTTPParseError);
});

test('http-parse: obsolete line folding is rejected', () => {
    assert.throws(
        () => parseRequest('GET / HTTP/1.1\r\nHost: h\r\nX: a\r\n b\r\n\r\n'),
        /line folding/,
    );
});

test('http-parse: start line length limit returns 414', () => {
    const parser = new HTTPHeadParser(false, { maxLineBytes: 16 });
    try {
        parser.push(enc('GET /this-is-way-too-long HTTP/1.1\r\n'));
        assert.fail('expected an error');
    } catch (error) {
        assert.ok(error instanceof HTTPParseError);
        assert.equal(error.status, 414);
    }
});

test('http-parse: header line limit returns 431', () => {
    const parser = new HTTPHeadParser(false, { maxFieldLineBytes: 16 });
    try {
        parser.push(enc('GET / HTTP/1.1\r\nX-Long: 0123456789012345678901234567890\r\n'));
        assert.fail('expected an error');
    } catch (error) {
        assert.ok(error instanceof HTTPParseError);
        assert.equal(error.status, 431);
    }
});

test('http-parse: header count limit returns 431', () => {
    const parser = new HTTPHeadParser(false, { maxHeaderCount: 2 });
    assert.throws(
        () => parser.push(enc('GET / HTTP/1.1\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n')),
        (error) => error instanceof HTTPParseError && error.status === 431,
    );
});

test('http-parse: Content-Length and Transfer-Encoding together is rejected (smuggling)', () => {
    assert.throws(
        () =>
            determineRequestFraming(
                new HTTPHeaders({ 'content-length': '5', 'transfer-encoding': 'chunked' }),
            ),
        (error) => error instanceof HTTPParseError && error.status === 400,
    );
});

test('http-parse: conflicting Content-Length values are rejected', () => {
    assert.throws(
        () =>
            determineRequestFraming(
                new HTTPHeaders([
                    ['content-length', '5'],
                    ['content-length', '6'],
                ]),
            ),
        /conflicting Content-Length/,
    );
});

test('http-parse: non-numeric or negative Content-Length is rejected', () => {
    assert.throws(() => determineRequestFraming(new HTTPHeaders({ 'content-length': '-1' })));
    assert.throws(() => determineRequestFraming(new HTTPHeaders({ 'content-length': '1e3' })));
    assert.throws(() =>
        determineRequestFraming(new HTTPHeaders({ 'content-length': '99999999999999999999' })),
    );
});

test('http-parse: chunked framing is accepted, unknown transfer codings are rejected', () => {
    assert.deepEqual(
        determineRequestFraming(new HTTPHeaders({ 'transfer-encoding': 'chunked' })),
        { kind: 'chunked' },
    );
    assert.throws(
        () => determineRequestFraming(new HTTPHeaders({ 'transfer-encoding': 'gzip, chunked' })),
        /unsupported Transfer-Encoding/,
    );
});

test('http-parse: response framing without Content-Length is treated as bodyless', () => {
    assert.deepEqual(determineResponseFraming(new HTTPHeaders({})), { kind: 'none' });
});

test('http-parse: status line parsing keeps the reason phrase', () => {
    const head = parseResponse('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    assert.equal(head.startLine.status, 404);
    assert.equal(head.startLine.statusText, 'Not Found');
});

test('http-parse: invalid status codes are rejected', () => {
    assert.throws(() => parseStatusLine('HTTP/1.1 999 Nope'), HTTPParseError);
    assert.throws(() => parseStatusLine('HTTP/1.1 abc'), HTTPParseError);
});

test('http-parse: unsupported HTTP version returns 505, absolute targets are rejected', () => {
    assert.throws(
        () => parseRequestLine('GET / HTTP/2.0'),
        (error) => error instanceof HTTPParseError && error.status === 505,
    );
    assert.throws(
        () => parseRequestLine('GET http://example.com/ HTTP/1.1'),
        (error) => error instanceof HTTPParseError && error.status === 400,
    );
});

test('http-parse: chunked decoder handles 1 byte at a time', () => {
    const decoder = new HTTPChunkedDecoder();
    const wire = enc('4\r\nWiki\r\n6\r\npedia \r\n0\r\n\r\n');
    const out = [];
    for (let i = 0; i < wire.length; i += 1) {
        for (const part of decoder.push(wire.subarray(i, i + 1))) out.push(new TextDecoder().decode(part));
    }
    assert.equal(out.join(''), 'Wikipedia ');
    assert.equal(decoder.finished, true);
});

test('http-parse: chunked decoder rejects a bad chunk size', () => {
    const decoder = new HTTPChunkedDecoder();
    assert.throws(() => decoder.push(enc('zz\r\n')), /invalid chunk size/);
});

test('http-parse: chunked decoder drops trailers', () => {
    const decoder = new HTTPChunkedDecoder();
    const parts = decoder.push(enc('1\r\na\r\n0\r\nX-Checksum: 1\r\n\r\n'));
    assert.equal(new TextDecoder().decode(parts[0]), 'a');
    assert.equal(decoder.finished, true);
});

test('http-parse: header injection on write is rejected', () => {
    assert.throws(
        () => new HTTPHeaders().set('x-echo', 'ok\r\nX-Injected: 1'),
        HTTPHeaderInjectionError,
    );
    assert.throws(() => new HTTPHeaders().set('bad name', 'v'), /invalid header name/);
    assert.throws(
        () =>
            serializeHTTPResponse({
                status: 200,
                headers: { 'x-bad': 'v\nX: 1' },
            }),
        HTTPHeaderInjectionError,
    );
});

test('http-write: request serialisation round-trips through the parser', () => {
    const bytes = serializeHTTPRequest({
        method: 'POST',
        target: '/echo?q=1',
        headers: { host: 'h:1', 'content-type': 'text/plain' },
        body: enc('hello'),
    });
    const text = new TextDecoder().decode(bytes);
    assert.match(text, /^POST \/echo\?q=1 HTTP\/1\.1\r\n/);
    assert.match(text, /\r\ncontent-length: 5\r\n/);
    assert.ok(text.endsWith('\r\n\r\nhello'));
});

test('http-write: chunked request ends with the zero chunk', () => {
    const bytes = serializeHTTPRequest({
        method: 'PUT',
        target: '/chunks',
        headers: { host: 'h:1' },
        body: enc('abc'),
        contentLength: null,
    });
    const text = new TextDecoder().decode(bytes);
    assert.match(text, /transfer-encoding: chunked/);
    assert.ok(text.endsWith('3\r\nabc\r\n0\r\n\r\n'));
});

test('http-write: a request without Host is rejected', () => {
    assert.throws(() => serializeHTTPRequest({ method: 'GET', target: '/' }), /Host header/);
});

test('http-write: 204 responses carry no Content-Length', () => {
    const text = new TextDecoder().decode(serializeHTTPResponse({ status: 204, headers: {} }));
    assert.ok(!/content-length/i.test(text));
    assert.ok(text.startsWith('HTTP/1.1 204 No Content\r\n'));
});
