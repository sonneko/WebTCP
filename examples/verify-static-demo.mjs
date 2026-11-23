#!/usr/bin/env node
/**
 * 公開デモ（GitHub Pages）と同じ静的配信で、サーバー無しに動く範囲を実ブラウザで検証する（サイクル11）。
 *
 * 検証内容（デモサーバーは起動しない）:
 *   1. サイトのトップが読め、公開デモへの導線（`/WebTCP/examples/demo/`）がある
 *   2. デモが静的モードで動き、自己チェック（`?selftest=1`）が PASS する。
 *      `/domain/*` に依存する 1d は「省略」として表示され、失敗にはならない
 *   3. 同じブラウザの 2 タブが BroadcastChannel で接続し、往復（テキスト・80 KiB）が PASS する
 *   4. 静的モードは台帳へ書き込まない（POST /domain/record が発生しない）
 *
 * 実行前提:
 *   - `webtcp_website` をビルド済み（`npm run build`）。既定の配信元は `webtcp_website/dist`。
 *   - Playwright と Chromium（`npm install --no-save playwright && npx playwright install chromium`）。
 *     既存の Chromium は `WEBTCP_CHROMIUM_PATH` で指定できる。共有ライブラリ不足には `LD_LIBRARY_PATH`。
 *
 * 実行方法:
 *   node examples/verify-static-demo.mjs [--dist webtcp_website/dist]
 *   WEBTCP_SITE_URL=https://sonneko.github.io/WebTCP node examples/verify-static-demo.mjs  （公開 URL に対して実行）
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const BASE = '/WebTCP';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error(
        'Playwright が見つかりません。次で導入してください:\n' +
            '  npm install --no-save playwright && npx playwright install chromium',
    );
    process.exit(2);
}

const distArg = process.argv.indexOf('--dist');
const distDir = path.resolve(
    distArg > 0 ? process.argv[distArg + 1] : path.join(repoRoot, 'webtcp_website', 'dist'),
);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml',
    '.txt': 'text/plain; charset=utf-8',
};

/** `base` 配下を `distDir` から配信する（GitHub Pages のサブパス配信を再現）。 */
function createSiteServer() {
    const posted = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST') posted.push(url.pathname);
        if (url.pathname === '/') {
            res.writeHead(302, { location: `${BASE}/` }).end();
            return;
        }
        if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) {
            res.writeHead(404).end('not found (outside base)');
            return;
        }
        let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || '/';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(distDir, `.${rel}`);
        if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return { server, posted };
}

const failures = [];
const check = (condition, message) => {
    if (condition) {
        console.log(`  PASS ${message}`);
    } else {
        console.log(`  FAIL ${message}`);
        failures.push(message);
    }
};

let siteServer = null;
let origin = process.env.WEBTCP_SITE_URL?.replace(/\/+$/, '') ?? null;
let posted = [];
if (!origin) {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        console.error(`ビルド成果物が見つかりません: ${distDir}（先に webtcp_website で npm run build）`);
        process.exit(2);
    }
    const created = createSiteServer();
    siteServer = created.server;
    posted = created.posted;
    await new Promise((resolve) => siteServer.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${siteServer.address().port}`;
} else {
    // 公開 URL: origin は `https://host` 、BASE は URL 側のパス（`/WebTCP`）に含まれる前提
    const url = new URL(origin);
    origin = url.origin;
    if (!url.pathname.startsWith(BASE)) {
        console.error(`WEBTCP_SITE_URL のパスは ${BASE} で終わる必要があります: ${process.env.WEBTCP_SITE_URL}`);
        process.exit(2);
    }
}
const siteRoot = `${origin}${BASE}`;
console.log(`[verify-static-demo] site: ${siteRoot}`);

// 既定の起動設定（訪問者と同じ ICE 経路: mDNS 候補）で検証する。mDNS を無効にすると経路が変わるため使わない（#73）
const launchOptions = {
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
};
const browser = await playwright.chromium.launch(launchOptions);
const context = await browser.newContext();

try {
    // 1. サイトのトップと導線
    console.log('[1] サイトのトップ');
    const home = await context.newPage();
    const homeErrors = [];
    home.on('pageerror', (error) => homeErrors.push(error.message));
    const homeResponse = await home.goto(`${siteRoot}/`, { waitUntil: 'load', timeout: 60_000 });
    check(homeResponse?.status() === 200, `トップが 200 で応答する（${homeResponse?.status()}）`);
    check((await home.title()).includes('WebTCP'), 'タイトルに WebTCP を含む');
    const demoLink = home.locator(`a[href="${BASE}/examples/demo/"]`);
    check((await demoLink.count()) > 0, `公開デモへの導線がある（a[href="${BASE}/examples/demo/"]）`);
    check(homeErrors.length === 0, `トップでページエラーが無い（${homeErrors.join(' / ') || 'なし'}）`);
    await home.close();

    // 2. 公開デモの自己チェック（静的モード）
    console.log('[2] 公開デモ: 自己チェック（?selftest=1）');
    const demo = await context.newPage();
    const demoErrors = [];
    demo.on('pageerror', (error) => demoErrors.push(error.message));
    const demoResponse = await demo.goto(`${siteRoot}/examples/demo/?selftest=1`, {
        waitUntil: 'load',
        timeout: 60_000,
    });
    check(demoResponse?.status() === 200, `デモページが 200 で応答する（${demoResponse?.status()}）`);
    await demo.waitForFunction(
        () => ['pass', 'fail'].includes(document.documentElement.dataset.selftest ?? ''),
        null,
        { timeout: 180_000 },
    );
    const selftest = await demo.evaluate(() => window.__WEBTCP_SELFTEST__ ?? null);
    const banner = await demo.textContent('#mode-banner');
    check(banner?.includes('公開版（静的）'), 'バナーが静的モードを示す');
    check(selftest?.ok === true, `自己チェックが PASS（${selftest?.error ?? 'ok'}）`);
    const steps = selftest?.steps ?? [];
    const skipped = steps.filter((step) => step.skipped);
    const failed = steps.filter((step) => !step.ok);
    check(failed.length === 0, `失敗した項目が無い（${failed.map((s) => s.name).join(', ') || 'なし'}）`);
    check(
        skipped.length === 1 && skipped[0].name.startsWith('1d.'),
        `省略は 1d（ドメイン台帳）だけ（${skipped.map((s) => s.name).join(', ') || 'なし'}）`,
    );
    check(steps.length >= 10, `実行された項目が 10 以上（${steps.length}）`);
    for (const step of steps.filter((s) => s.ok && !s.skipped)) {
        console.log(`       ${step.name}  ${step.detail ?? ''}`);
    }
    check(demoErrors.length === 0, `デモでページエラーが無い（${demoErrors.join(' / ') || 'なし'}）`);
    await demo.close();

    // 3. 同一ブラウザの 2 タブ（BroadcastChannel）
    console.log('[3] 同一ブラウザの 2 タブ（サーバータブ / クライアントタブ）');
    const serverTab = await context.newPage();
    const serverErrors = [];
    serverTab.on('pageerror', (error) => serverErrors.push(error.message));
    await serverTab.goto(`${siteRoot}/examples/demo/?role=server&autostart=1&e2e=1`, {
        waitUntil: 'load',
        timeout: 60_000,
    });
    await serverTab.waitForFunction(
        () => (document.getElementById('node-id')?.textContent ?? '').length >= 20,
        null,
        { timeout: 60_000 },
    );
    await serverTab.waitForTimeout(1_000);

    const clientTab = await context.newPage();
    const clientErrors = [];
    clientTab.on('pageerror', (error) => clientErrors.push(error.message));
    await clientTab.goto(`${siteRoot}/examples/demo/?role=client&autostart=1&e2e=1`, {
        waitUntil: 'load',
        timeout: 60_000,
    });
    await clientTab.waitForFunction(
        () => ['pass', 'fail'].includes(document.documentElement.dataset.twotab ?? ''),
        null,
        { timeout: 180_000 },
    );
    const twoTabLog = await clientTab.textContent('#client-log');
    check(
        (await clientTab.evaluate(() => document.documentElement.dataset.twotab)) === 'pass',
        `2 タブの自動検証が PASS（${twoTabLog?.split('\n').filter((l) => l.includes('FAIL')).join(' / ') || 'ok'}）`,
    );
    check(twoTabLog?.includes('テキスト往復 PASS'), '2 タブでテキスト往復が PASS');
    check(twoTabLog?.includes('80 KiB 大容量往復 PASS'), '2 タブで 80 KiB 往復が PASS');
    check(serverErrors.length + clientErrors.length === 0, 'タブでページエラーが無い');
    await serverTab.close();
    await clientTab.close();

    // 4. 台帳へ書き込まない
    console.log('[4] 静的モードは台帳へ書き込まない');
    const writes = posted.filter((p) => p.includes('/domain/'));
    check(writes.length === 0, `POST /domain/* が発生していない（${writes.length} 件）`);

    // 5. ICE 候補を出せない環境（UDP ホスト候補を遮断）: 約 45 秒の待ちではなく、早く理由を示して止まる（#73）
    console.log('[5] ICE 候補を出せない環境の自己チェック（早期診断）');
    const blockedBrowser = await playwright.chromium.launch({
        ...launchOptions,
        args: ['--no-sandbox', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    try {
        const blockedPage = await blockedBrowser.newPage();
        await blockedPage.goto(`${siteRoot}/examples/demo/?selftest=1`, { waitUntil: 'load', timeout: 60_000 });
        const startedAt = Date.now();
        await blockedPage.waitForFunction(
            () => ['pass', 'fail'].includes(document.documentElement.dataset.selftest ?? ''),
            null,
            { timeout: 60_000 },
        );
        const elapsed = Date.now() - startedAt;
        const blocked = await blockedPage.evaluate(() => window.__WEBTCP_SELFTEST__ ?? null);
        const blockedSteps = blocked?.steps ?? [];
        check(blocked?.ok === false, '候補ゼロのとき自己チェックは FAIL になる');
        check(
            blockedSteps[0]?.name?.startsWith('0.') && blockedSteps[0]?.ok === false,
            `失敗は事前診断（step 0）で起きる（${blockedSteps[0]?.name ?? 'なし'}）`,
        );
        check(
            (blockedSteps[0]?.error ?? '').includes('ICE 候補を 1 つも得られませんでした'),
            '候補ゼロの理由と対処が表示される',
        );
        check(blockedSteps.length === 1, `以降の項目は実行されない（${blockedSteps.length} 件）`);
        check(elapsed < 20_000, `早く止まる（${elapsed} ms、45 秒の待ちではない）`);
        console.log(`       ${blockedSteps[0]?.error ?? ''}`);
    } finally {
        await blockedBrowser.close();
    }
} finally {
    await browser.close();
    if (siteServer) siteServer.close();
}

if (failures.length > 0) {
    console.error(`\n[verify-static-demo] FAILED (${failures.length})`);
    process.exit(1);
}
console.log('\n[verify-static-demo] all checks passed');
