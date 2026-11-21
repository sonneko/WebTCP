#!/usr/bin/env node
/**
 * curl 相当の TCP クライアント → ブリッジ（`examples/bridge.mjs`）→ 実 WebRTC → 実ブラウザの HTTP サービス、
 * の end-to-end 検証（M8 の残検証 / #52、仕様 §19）。
 *
 * 実行前提:
 *   1. `cd webtcp_jslib && npm install --no-save @roamhq/wrtc`（または node-datachannel）と `npm run build`
 *   2. Playwright（`npm install --no-save playwright`）と Chromium。
 *      既存の Chromium を使う場合は `WEBTCP_CHROMIUM_PATH=/path/to/chrome` を指定する。
 *      共有ライブラリが足りない環境では `LD_LIBRARY_PATH` も必要になることがある。
 *
 * 実行方法:
 *   node examples/verify-bridge-browser.mjs
 *
 * 検証内容:
 *   - ブラウザタブ（署名付き v2 ノード）が 8080 で HTTP を公開する（examples/bridge/browser-service.js）
 *   - ブリッジが `webtcp://<browser NodeId>:8080` へ接続して待ち受ける
 *   - Node の TCP クライアントから `GET /api/echo?x=1`（JSON・runtime=browser）
 *   - `GET /big?n=524288`（512 KiB の本文を sha256 で照合）
 *   - ブリッジのアクセスログに open / close が出る
 */

import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error(
        'Playwright が見つかりません。次で導入してください:\n' +
            '  npm install --no-save playwright\n' +
            '既存の Chromium を使う場合は WEBTCP_CHROMIUM_PATH を指定できます。',
    );
    process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitForLine(child, pattern, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`${label}: timed out`)), timeoutMs);
        const onData = (chunk) => {
            buffer += chunk.toString();
            const match = pattern.exec(buffer);
            if (match) {
                clearTimeout(timer);
                child.stdout.off('data', onData);
                resolve({ match, buffer });
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', (chunk) => {
            buffer += chunk.toString();
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`${label}: process exited (${code}) before ready\n${buffer.slice(-800)}`));
        });
    });
}

/** 実際の curl（外部コマンド）で取得する。ステータス・本文のバイト列・ハッシュを返す。 */
function curlGet(url, outFile) {
    return new Promise((resolve, reject) => {
        execFile(
            'curl',
            ['-sS', '--max-time', '60', '-o', outFile, '-w', '%{http_code}', url],
            { encoding: 'utf8' },
            (error, stdout, stderr) => {
                if (error) return reject(new Error(`curl failed: ${stderr || error.message}`));
                resolve({ status: Number(stdout.trim()), body: fs.readFileSync(outFile) });
            },
        );
    });
}

function getBytes(url) {
    return new Promise((resolve, reject) => {
        // curl と同じく 1 リクエストごとに接続を閉じる（keep-alive だと close ログは接続終了まで出ない）
        const req = http.get(url, { agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.setTimeout(60_000, () => req.destroy(new Error('request timed out')));
        req.on('error', reject);
    });
}

const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtcp-bridge-verify-'));
const bridgePort = await freePort();

const launchArgs = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'];
const browser = await playwright.chromium.launch({
    headless: true,
    args: launchArgs,
    ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
});
let bridge = null;

try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/examples/bridge/browser-service.html`);
    await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error, null, {
        timeout: 60_000,
    });
    const ready = await page.evaluate(() => ({
        ready: document.body.dataset.ready ?? null,
        error: document.body.dataset.error ?? null,
    }));
    check('browser service starts with a signed (v2) identity', ready.ready !== null, ready.error ?? '');
    if (!ready.ready) throw new Error(`browser service did not start: ${ready.error}`);
    const nodeId = ready.ready;

    const bridgeArgs = [
        path.join(repoRoot, 'examples', 'bridge.mjs'),
        `webtcp://${nodeId}:8080`,
        '--listen',
        `127.0.0.1:${bridgePort}`,
        '--signal',
        origin,
        '--key-file',
        path.join(keyDir, 'bridge.pem'),
        ...(process.env.WEBTCP_RTC_BIND ? ['--rtc-bind', process.env.WEBTCP_RTC_BIND] : []),
    ];
    bridge = spawn(process.execPath, bridgeArgs, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let bridgeLog = '';
    bridge.stdout.on('data', (c) => (bridgeLog += c.toString()));
    bridge.stderr.on('data', (c) => (bridgeLog += c.toString()));

    await waitForLine(bridge, /WebTCP bridge: http:\/\/[^\n]+/, 120_000, 'bridge');
    check('bridge listens on loopback and reaches the browser NodeId', true, `127.0.0.1:${bridgePort}`);

    const base = `http://127.0.0.1:${bridgePort}`;
    const echo = await getBytes(`${base}/api/echo?x=1`);
    const echoBody = JSON.parse(echo.body.toString('utf8'));
    check('GET /api/echo returns 200 from the browser service', echo.status === 200, `status ${echo.status}`);
    check(
        'the response was produced by the browser runtime',
        echoBody.runtime === 'browser' && echoBody.path === '/api/echo' && echoBody.query === '?x=1',
        JSON.stringify(echoBody),
    );

    const curlEcho = await curlGet(`${base}/api/echo?x=1`, path.join(keyDir, 'echo.out'));
    const curlEchoBody = JSON.parse(curlEcho.body.toString('utf8'));
    check(
        'real curl: GET /api/echo?x=1 is served by the browser runtime',
        curlEcho.status === 200 && curlEchoBody.runtime === 'browser' && curlEchoBody.query === '?x=1',
        `status ${curlEcho.status}`,
    );

    const n = 512 * 1024;
    const big = await getBytes(`${base}/big?n=${n}`);
    const expected = createHash('sha256').update('x'.repeat(n)).digest('hex');
    const actual = createHash('sha256').update(big.body).digest('hex');
    check('GET /big?n=524288 round-trips 512 KiB intact', big.status === 200 && big.body.length === n && actual === expected, `${big.body.length} bytes`);

    const curlBig = await curlGet(`${base}/big?n=${n}`, path.join(keyDir, 'big.out'));
    check(
        'real curl: GET /big?n=524288 round-trips 512 KiB intact',
        curlBig.status === 200 &&
            curlBig.body.length === n &&
            createHash('sha256').update(curlBig.body).digest('hex') === createHash('sha256').update('x'.repeat(n)).digest('hex'),
        `${curlBig.body.length} bytes`,
    );

    // アクセスログ（open / close）は接続の終了後に出るため、close が現れるまで短く待つ
    for (let i = 0; i < 100 && !/"event":"close"/.test(bridgeLog); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(
        'bridge access log records open and close',
        /"event":"open"/.test(bridgeLog) && /"event":"close"/.test(bridgeLog),
        bridgeLog.slice(-400).replace(/\s+/g, ' '),
    );
    check('no uncaught page errors in the browser service', pageErrors.length === 0, pageErrors.join('; '));
} catch (error) {
    check('end-to-end run completed', false, error.message);
} finally {
    if (bridge && bridge.exitCode === null) {
        bridge.kill('SIGTERM');
        await new Promise((resolve) => bridge.once('exit', resolve));
    }
    await browser.close();
    await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
    });
    fs.rmSync(keyDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
