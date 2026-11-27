#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、リロード後に復元されたポートへの接続が
 * RST にならないことを検証する（M9 項目 29 / #51 / specification.md §9.3）。
 *
 * 2 つのブラウザコンテキスト（別々の IndexedDB・別の鍵）をサーバー役とクライアント役にする。
 * 接続は実 WebRTC で、シグナリングはデモサーバーのハブ（POST /signal, GET /messages）を使う。
 *
 * 検証内容（すべて実行して確認する）:
 * 0. 基準: リロード前に、クライアントから 7002 へのエコーが届く。
 * 1. 対照（修正前の使い方）: サーバーを再読み込みし、ハンドラを 15 秒後に listen() する（クライアントの接続確立は約 6 秒かかるため、SYN が窓の中に届く長さにする）。
 *    その間にクライアントが接続すると、RST で拒否される（RST の件数を数える）。
 * 2. 修正: サーバーを再読み込みし、ハンドラを restoreState({ handlers }) に渡す。
 *    戻り値の時点で 7002 が待ち受けており、クライアントは RST 無しでエコーを受け取る。
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium node examples/verify-reconnect-browser.mjs
 */

import { createDemoServer } from './server.mjs';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error('Playwright が見つかりません: npm install --no-save playwright && npx playwright install chromium');
    process.exit(1);
}

const PORT = 7002;
const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = (query) => `${origin}/examples/verify-reconnect/index.html?${query}`;

const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
});

const failures = [];
function check(condition, message) {
    console.log(`  ${condition ? 'PASS' : 'FAIL'} ${message}`);
    if (!condition) failures.push(message);
}

async function openPage(context, query, timeoutMs = 90_000) {
    const page = await context.newPage();
    await navigate(page, query, timeoutMs);
    return page;
}

/** 同じページを遷移（＝再読み込み）させる。旧ページの JS と接続は破棄され、同じ鍵・同じ IndexedDB を使う。 */
async function navigate(page, query, timeoutMs = 90_000) {
    await page.goto(pageUrl(query));
    await page.waitForFunction(() => window.ready === true, null, { timeout: timeoutMs });
    const error = await page.evaluate(() => window.verifyError ?? null);
    if (error) throw new Error(`page error (${query}): ${error}`);
}

try {
    const serverCtx = await browser.newContext();
    const clientCtx = await browser.newContext();

    // サーバー役（初回）: 待ち受けて自動保存させる
    let serverPage = await openPage(serverCtx, 'phase=write');
    const serverId = (await serverPage.evaluate(() => window.verify)).nodeId;
    const deadline = Date.now() + 15_000;
    let saved = null;
    while (Date.now() < deadline) {
        saved = await serverPage.evaluate(async () => (await window.loadSaved())?.listenPorts ?? []);
        if (saved.includes(PORT)) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    check(saved?.includes(PORT) === true, `server saved listen port ${PORT} automatically (no persistState call)`);

    // 0. 基準（リロード前）
    let clientPage = await openPage(clientCtx, `phase=run&server=${serverId}&duration=30000`);
    let r = await clientPage.evaluate(() => window.verify);
    check(r.firstOkAt !== null, `baseline: client echo via ${PORT} before reload (first ok at ${r.firstOkAt} ms)`);
    await clientPage.close();

    // 1. 対照: ハンドラを 4 秒後に付ける（修正前の使い方）
    await navigate(serverPage, 'phase=read-late&delay=15000');
    r = await serverPage.evaluate(() => window.verify);
    check(r.restoredListenPorts.includes(PORT) && r.unhandledPorts.includes(PORT),
        `control: restoreState() reports ${PORT} as unhandled (no handler)`);
    check(!r.listeningNow.includes(PORT), 'control: port is not listening right after restore');
    clientPage = await openPage(clientCtx, `phase=run&server=${serverId}&duration=40000`);
    const control = await clientPage.evaluate(() => window.verify);
    console.log(`  info control: client attempts=${control.attempts.length} rst=${control.rstCount} failed=${control.failedCount} firstOkAt=${control.firstOkAt} ms`);
    console.log(`  info control errors: ${JSON.stringify(control.attempts.filter((a) => a.error).map((a) => [a.at, a.error]))}`);
    check(control.rstCount >= 1, 'control: at least one connection attempt is refused by RST before the handler is attached');
    const listenedAbs = await serverPage.evaluate(() => window.verify.listenedAbs ?? null);
    check(control.firstOkAbs !== null && listenedAbs !== null && control.firstOkAbs >= listenedAbs,
        'control: first successful echo only after the late listen()');
    await clientPage.close();

    // 2. 修正: ハンドラを restoreState に渡す
    await navigate(serverPage, 'phase=read-handler');
    r = await serverPage.evaluate(() => window.verify);
    check(r.restoredListenPorts.includes(PORT), `fix: restoreState returns saved port ${PORT}`);
    check(r.listeningPorts.includes(PORT) && r.listeningNow.includes(PORT),
        `fix: port ${PORT} is listening when restoreState returns`);
    check(r.unhandledPorts.length === 0, 'fix: no unhandled saved ports');
    clientPage = await openPage(clientCtx, `phase=run&server=${serverId}&duration=30000`);
    const fix = await clientPage.evaluate(() => window.verify);
    console.log(`  info fix: client attempts=${fix.attempts.length} rst=${fix.rstCount} failed=${fix.failedCount} firstOkAt=${fix.firstOkAt} ms`);
    console.log(`  info fix errors: ${JSON.stringify(fix.attempts.filter((a) => a.error).map((a) => [a.at, a.error]))}`);
    console.log(`  info fix events: ${JSON.stringify(fix.events)}`);
    check(fix.firstOkAt !== null, `fix: client gets an echo from restored port ${PORT} after reload`);
    check(fix.rstCount === 0, 'fix: no connection attempt is refused by RST');
    await clientPage.close();
    await serverPage.close();

    await serverCtx.close();
    await clientCtx.close();
} finally {
    await browser.close();
    server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
}
console.log('\nAll reconnect browser checks passed.');
