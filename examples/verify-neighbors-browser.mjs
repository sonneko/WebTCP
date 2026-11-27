#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、リロード後に保存された隣接先へ再接続できることを検証する
 * （M9 項目 30 / #51 / specification.md §9.4）。
 *
 * 3 つのブラウザコンテキスト（別の鍵・別の IndexedDB）: 相手（peer）、ノード（node）、対照のノード（control）。
 * 接続は実 WebRTC、シグナリングはデモサーバーのハブ（`SignalingAdapterHub`）を使う。
 *
 * 検証内容（すべて実行して確認する）:
 * 1. 保存: ノードが相手へ接続すると、`persistState()` を呼ばなくても隣接先が IndexedDB に保存される（自動保存）。
 * 2. 再接続: ノードのページを遷移（＝再読み込み）させ、`restoreState()` で隣接先を取り出し、
 *    `reconnectNeighbors()` で相手へ再接続する。その後、相手の 7002 へのエコーが届く。
 * 3. 対照: 隣接先を保存していない状態（control）では、再読み込み後に待っても自動では接続されない。
 *    利用者が NodeId を手で入力した場合に限り接続できる。
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium node examples/verify-neighbors-browser.mjs
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
const pageUrl = (query) => `${origin}/examples/verify-neighbors/index.html?${query}`;

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

try {
    const peerCtx = await browser.newContext();
    const nodeCtx = await browser.newContext();
    const controlCtx = await browser.newContext();

    // 相手（再読み込みしない）
    const peerPage = await peerCtx.newPage();
    const peer = await navigate(peerPage, 'role=peer');
    console.log(`  info peer nodeId=${peer.nodeId.slice(0, 8)}…`);

    // 1. 保存: ノードが相手へ接続し、自動保存される
    const nodePage = await nodeCtx.newPage();
    const write = await navigate(nodePage, `role=node&phase=write&peer=${peer.nodeId}`);
    check(write.neighborsNow.includes(peer.nodeId), 'node connected to the peer before reload');
    check(write.savedOk && write.savedNeighbors?.includes(peer.nodeId),
        'the peer was saved as a neighbour automatically (no persistState() call)');

    // 2. 再読み込み後の再接続
    // 相手の状態（再読み込みの直前）: 相手側はまだノードとの接続を持っているか
    const peerBefore = await peerPage.evaluate(() => ({ neighbors: window.peerNetwork.getNeighbors().length, events: window.peerEvents.length }));
    console.log(`  info peer before node reload: neighbours=${peerBefore.neighbors}, events=${peerBefore.events}`);
    const navStart = Date.now();
    const read = await navigate(nodePage, `role=node&phase=read&peer=${peer.nodeId}`);
    const reconnectDoneAbs = Date.now();
    const peerAfter = await peerPage.evaluate(() => ({ neighbors: window.peerNetwork.getNeighbors().length, events: window.peerEvents.slice() }));
    console.log(`  info peer after reconnect: neighbours=${peerAfter.neighbors}, events=${JSON.stringify(peerAfter.events.map((e) => ({ ev: e.ev, at: e.at })))}`);
    const peerDisconnect = peerAfter.events.find((e) => e.ev === 'disconnected');
    if (peerDisconnect) console.log(`  info peer detected the node's drop ${peerDisconnect.abs - navStart} ms after the node navigation started; node reconnect finished ${reconnectDoneAbs - navStart} ms after it started`);
    check(read.restoredNeighbors.includes(peer.nodeId), 'restoreState returns the saved neighbour');
    check(read.neighborsAfterRestore.length === 0, 'restoreState does not connect by itself');
    check(read.reconnect?.connected?.includes(peer.nodeId) === true,
        `reconnectNeighbors reconnects the saved neighbour (${read.reconnect?.ms} ms, ${read.reconnect?.attempts} attempt(s))`);
    check(read.echo === 'after-reload', `echo from the peer's port 7002 after reload (${read.echoError ?? 'ok'})`);
    console.log(`  info reload result: ${JSON.stringify(read.reconnect)} echo=${read.echo ?? read.echoError}`);

    // 3. 対照: 隣接先を保存していないノード（control）
    const controlPage = await controlCtx.newPage();
    const controlWrite = await navigate(controlPage, 'role=node&phase=write');
    check(controlWrite.savedOk && Array.isArray(controlWrite.savedNeighbors) && controlWrite.savedNeighbors.length === 0,
        'control: state saved with no neighbours');
    const controlRead = await navigate(controlPage, 'role=node&phase=read');
    check(controlRead.restoredNeighbors.length === 0, 'control: restoreState returns no neighbours');
    check(controlRead.neighborsAfterWait.length === 0, 'control: nothing reconnects by itself after waiting 3 s');
    check(controlRead.echo === undefined, 'control: no echo without a known NodeId');

    // 対照の差: 利用者が NodeId を手で入力すれば接続できる（保存の有無による違い）
    const manual = await navigate(controlPage, `role=node&phase=read&manual=${peer.nodeId}`);
    check(manual.neighborsEnd.includes(peer.nodeId), 'control: a manually entered NodeId connects');
    console.log(`  info control: restored=${controlRead.restoredNeighbors.length}, after 3 s=${controlRead.neighborsAfterWait.length}, manual connect=${manual.neighborsEnd.includes(peer.nodeId)}`);

    await peerCtx.close();
    await nodeCtx.close();
    await controlCtx.close();
} finally {
    await browser.close();
    server.close();
}

if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed.`);
    process.exit(1);
}
console.log('\nAll neighbour reconnect browser checks passed.');
