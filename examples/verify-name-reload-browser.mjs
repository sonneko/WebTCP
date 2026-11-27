#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、名前の保持者（owner）のページを再読み込みした後に、
 * 別のノード（client）が名前で解決・接続できることを確かめる（M9 項目 32 / #51 / specification.md §9.10）。
 *
 * 2 つのブラウザコンテキスト（別の鍵・別の IndexedDB）: client（再読み込みしない）と owner。
 * 接続は実 WebRTC、シグナリングはデモサーバーのハブ（`SignalingAdapterHub`）を使う。
 *
 * 検証の流れ（すべて実行して確認する）:
 * 0. 基準（リロードなし）: client が owner の名前 `svc.test` を、キャッシュを使わずにリモートで解決し、
 *    7002 のエコーが届く。
 * A. 主経路: owner のページを遷移（＝再読み込み）させ、`restoreState({ handlers })` で名前とポートを戻し、
 *    `reconnectNeighbors()` で保存された隣接（client）へ再接続する。client は、切断の検出から
 *    名前が解決できるまでの期間を記録する。
 * B. 対照: 同じ再読み込みで、`reconnectNeighbors()` を呼ばない。名前はどうなるかを 15 秒間記録する。
 *
 * 成功の条件: 解決が `source: 'remote'` で、owner の NodeId に一致し、解決先の 7002 でエコーが届くこと。
 * キャッシュからの解決は成功に数えない（キャッシュは `clearCache()` で毎回消す）。
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium node examples/verify-name-reload-browser.mjs
 */

import { createDemoServer } from './server.mjs';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error('Playwright が見つかりません: npm install --no-save playwright && npx playwright install chromium');
    process.exit(1);
}

const NAME = 'svc.test';
const PORT = 7002;
const server = createDemoServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = (query) => `${origin}/examples/verify-name-reload/index.html?${query}`;

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

async function navigate(page, query, timeoutMs = 120_000) {
    await page.goto(pageUrl(query));
    await page.waitForFunction(() => window.ready === true, null, { timeout: timeoutMs });
    const error = await page.evaluate(() => window.verifyError ?? null);
    if (error) throw new Error(`page error (${query}): ${error}`);
    return page.evaluate(() => window.verify);
}

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

const clientState = (page) => page.evaluate(() => ({ attempts: window.attempts.slice(), events: window.events.slice() }));

function summarize(attempts) {
    const errors = {};
    for (const a of attempts) {
        if (a.error) errors[a.error.split(':')[0]] = (errors[a.error.split(':')[0]] ?? 0) + 1;
    }
    return errors;
}

try {
    const clientCtx = await browser.newContext();
    const ownerCtx = await browser.newContext();

    // client（再読み込みしない）
    const clientPage = await clientCtx.newPage();
    const client = await navigate(clientPage, 'role=client');
    console.log(`  info client nodeId=${client.nodeId.slice(0, 8)}…`);

    // owner: 名前を登録し、client へ接続して保存する
    const ownerPage = await ownerCtx.newPage();
    const write = await navigate(ownerPage, `role=owner&phase=write&peer=${client.nodeId}`);
    const owner = write.nodeId;
    check(write.neighborsNow.includes(client.nodeId), 'owner connected to the client before the baseline');
    check(write.savedOk && write.savedNames.includes(NAME), `owner saved the name ${NAME} automatically`);
    check(write.savedNeighbors?.includes(client.nodeId) === true, 'owner saved the client as a neighbour');

    // 0. 基準（リロードなし）
    await clientPage.evaluate(({ name, owner }) => window.startPolling(name, owner), { name: NAME, owner });
    await waitUntil(async () => (await clientState(clientPage)).attempts.filter((a) => a.ok).length >= 3, 20_000);
    await clientPage.evaluate(() => window.stopPolling());
    const base = await clientState(clientPage);
    const baseOk = base.attempts.filter((a) => a.ok);
    check(baseOk.length >= 3, `baseline (no reload): ${baseOk.length} resolutions with remote echo`);
    const resolveMs = baseOk.map((a) => a.resolveMs).sort((x, y) => x - y);
    console.log(`  info baseline resolve ms: ${JSON.stringify(resolveMs)}, source: ${[...new Set(baseOk.map((a) => a.source))]}`);

    async function reloadScenario({ label, query, observeMs, expectSuccess }) {
        await clientPage.evaluate(({ name, owner }) => {
            window.attempts = [];
            window.events = [];
            window.startPolling(name, owner);
        }, { name: NAME, owner });
        const navStart = Date.now();
        const read = await navigate(ownerPage, query);
        // 成功、または観測時間の終わりまで待つ
        const deadline = navStart + observeMs;
        await waitUntil(async () => {
            if (!expectSuccess && Date.now() >= deadline) return true;
            const s = await clientState(clientPage);
            const drop = s.events.find((e) => e.ev === 'disconnected');
            if (!drop) return false;
            return s.attempts.some((a) => a.ok && a.abs >= drop.abs);
        }, observeMs + 10_000, 100);
        await clientPage.evaluate(() => window.stopPolling());
        await new Promise((resolve) => setTimeout(resolve, 300));
        const s = await clientState(clientPage);
        const drop = s.events.find((e) => e.ev === 'disconnected');
        const dropAbs = drop?.abs ?? navStart;
        const after = s.attempts.filter((a) => a.abs >= dropAbs);
        const firstOk = after.find((a) => a.ok) ?? null;
        console.log(`  info [${label}] client saw the owner drop ${dropAbs - navStart} ms after navigation started`);
        console.log(`  info [${label}] owner restore done ${read.restoreDoneAbs - navStart} ms, reconnect done ${read.reconnectDoneAbs - navStart} ms (after navigation start)`);
        console.log(`  info [${label}] attempts after drop: ${after.length}, errors: ${JSON.stringify(summarize(after))}`);
        if (firstOk) {
            console.log(`  info [${label}] first name resolution after the drop: ${firstOk.abs - navStart} ms after navigation (${firstOk.abs - dropAbs} ms after the drop), resolve ${firstOk.resolveMs} ms, source ${firstOk.source}`);
        } else {
            console.log(`  info [${label}] no name resolution after the drop within ${observeMs} ms`);
        }
        return { read, s, dropAbs, navStart, firstOk, after };
    }

    // A. 主経路: 再読み込み後に再接続する
    const a = await reloadScenario({
        label: 'reload + reconnectNeighbors',
        query: `role=owner&phase=read`,
        observeMs: 30_000,
        expectSuccess: true,
    });
    check(a.read.restoredNames === 1, `owner restored the name ${NAME} (localSize ${a.read.restoredNames})`);
    check(a.read.restoredNeighbors.includes(client.nodeId), 'restoreState returns the client as a saved neighbour');
    check(a.read.unhandledPorts.length === 0 && a.read.listeningPorts.includes(PORT), 'owner listens on 7002 at restore (handler attached)');
    check(a.read.reconnect?.connected?.includes(client.nodeId) === true, 'reconnectNeighbors reconnected the client');
    check(a.firstOk !== null, 'the client resolved the name after the owner reload');
    check(a.firstOk?.resolvedOwner === true && a.firstOk?.nodeId === owner, 'the resolution is the owner NodeId, from a remote answer');
    check(a.firstOk?.ok === true, `echo through the resolved name after reload (${a.firstOk?.echo ?? a.firstOk?.error ?? 'none'})`);

    // B. 対照: 同じ再読み込みで、再接続を呼ばない（保存された隣接先は同じ）
    const b = await reloadScenario({
        label: 'control: reload without reconnect',
        query: `role=owner&phase=read&noreconnect=1`,
        observeMs: 15_000,
        expectSuccess: false,
    });
    check(b.read.restoredNeighbors.includes(client.nodeId), 'control: the saved neighbour is the same as the main run');
    check(b.read.reconnect === undefined, 'control: reconnectNeighbors was not called');
    check(b.firstOk === null, 'control: no name resolution after the reload without reconnect (15 s)');
    const last = b.after.at(-1);
    console.log(`  info [control] client neighbours after 15 s: ${last?.neighbors ?? 'n/a'}, routing entries: ${last?.routes ?? 'n/a'}, route to the owner (cost): ${last?.routeToOwner ?? 'none'}`);

    await clientCtx.close();
    await ownerCtx.close();
} finally {
    await browser.close();
    server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
}
console.log('\nAll name-after-reload browser checks passed.');
