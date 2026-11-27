#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、自動保存（M9 / #51 / specification.md §9.8）を検証する。
 *
 * 検証内容（すべて実行して確認する）:
 * 1. phase=write: restoreState → enableAutoPersist の順で有効化し、名前の登録と待ち受けを行う。
 *    persistState() も close() も呼ばない。IndexedDB に自動保存された内容が現れる（ポートと名前）。
 * 2. 短時間の連続した変更（名前 11 件 + 待ち受け 1 件）は、保存 3 回以下にまとめられる（デバウンス）。
 * 3. ページを遷移させる（旧ページは close() なしで破棄される）。phase=read で、
 *    保存された待ち受けポートが復元結果に含まれ、登録名が解決でき、保存された nodeId が現在の nodeId と一致する。
 *    アプリのポートの再待ち受けは行わない（ハンドラの再接続は M9 項目 30）。
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium node examples/verify-persistence-browser.mjs
 */

import { createDemoServer } from './server.mjs';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error('Playwright が見つかりません: npm install --no-save playwright && npx playwright install chromium');
    process.exit(1);
}

const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}/examples/verify-persistence/index.html`;
const PORT = 9301;

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

try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. 書き込み側: 自動保存だけで状態が IndexedDB に現れる
    await page.goto(`${pageUrl}?phase=write`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
    const writeError = await page.evaluate(() => window.verifyError ?? null);
    check(writeError === null, `write phase runs without error${writeError ? `: ${writeError}` : ''}`);

    let saved = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        saved = await page.evaluate(async () => {
            const state = await window.loadSaved();
            return state ? { listenPorts: state.listenPorts, names: state.names.map((n) => n.name) } : null;
        });
        if (saved?.listenPorts?.includes(9301) && saved.names.includes('printer')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(saved?.listenPorts?.includes(PORT) === true, `auto-saved listen port ${PORT} appears in IndexedDB without persistState()`);
    check(saved?.names?.includes('printer') === true, 'auto-saved name "printer" appears in IndexedDB');
    const saves = await page.evaluate(() => window.savesSoFar());
    check(saves >= 1 && saves <= 3, `11 quick changes were coalesced into ${saves} save(s) (expected 1–3)`);

    // 2. ページ遷移（close() を呼ばない。旧ページの JS は破棄される）
    await page.goto(`${pageUrl}?phase=read`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
    const readError = await page.evaluate(() => window.verifyError ?? null);
    check(readError === null, `read phase runs without error${readError ? `: ${readError}` : ''}`);

    const r = await page.evaluate(() => window.verify);
    check(r?.restored === true, 'read phase restores saved state');
    // アプリのポートはハンドラ未接続のため自動では再待ち受けしない（plan §3.25 項目 30 で扱う）。
    // ここでは「保存された待ち受けポートが復元結果に含まれる」ことだけを確認する。
    check(r?.restoredListenPorts?.includes(PORT) === true, `restoreState reports saved listen port ${PORT} (handler re-attachment is M9 item 30)`);
    check(r?.printerNodeId !== null && r?.printerNodeId !== undefined, 'restored name "printer" resolves locally');
    check(r?.savedNodeId === r?.localNodeId, 'saved nodeId matches this browser identity');

    await context.close();
} finally {
    await browser.close();
    server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
}
console.log('\nAll persistence browser checks passed.');
