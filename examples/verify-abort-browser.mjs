#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、接続試行中の `AbortSignal` 中断を検証する（#44）。
 *
 * 検証内容（すべて実行して確認する）:
 * 1. 応答の無いピア（存在しない NodeId）への `network.connect(..., { signal })` を、
 *    実 RTCPeerConnection が作られ ICE 交換の途中にある時点で中断する
 * 2. 中断は `AbortError` で、待たずに返る（接続タイムアウトの 15 s を待たない）
 * 3. 実 RTCPeerConnection が `closed` になり、WebRTC の接続タイマーが残らない
 * 4. 中断時に warn / error が出ない（debug に収まる）
 * 5. その後、同じネットワークから実在するサーバーへの接続が成功する（後続接続が壊れない）
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium node examples/verify-abort-browser.mjs
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
const baseUrl = `${origin}/examples/demo/`;

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

    // 1. 実在するサーバー（待ち受け中）
    const serverPage = await context.newPage();
    await serverPage.goto(`${baseUrl}?e2e=1&role=server&autostart=1`);
    await serverPage.waitForFunction(() =>
        document.getElementById('listen-status')?.textContent?.includes('待ち受け中'),
    );
    const serverNodeId = (await serverPage.locator('#node-id').textContent()).trim();

    // 2. クライアント（中断の検証を行う）
    const clientPage = await context.newPage();
    await clientPage.goto(`${baseUrl}?e2e=1`);

    const result = await clientPage.evaluate(
        async ({ serverNodeId }) => {
            // 実 RTCPeerConnection の生成と close を数える
            const pcs = [];
            const OriginalPC = window.RTCPeerConnection;
            window.RTCPeerConnection = class extends OriginalPC {
                constructor(...args) {
                    super(...args);
                    pcs.push(this);
                }
            };

            // 接続タイマー（WebRTC 15 s / TransportLayer 10 s）が残っていないかを数える
            const timers = new Map();
            const originalSet = window.setTimeout;
            const originalClear = window.clearTimeout;
            window.setTimeout = (fn, delay, ...rest) => {
                const handle = originalSet(fn, delay, ...rest);
                timers.set(handle, delay);
                return handle;
            };
            window.clearTimeout = (handle) => {
                timers.delete(handle);
                return originalClear(handle);
            };
            const liveWithDelay = (ms) => [...timers.values()].filter((delay) => delay === ms).length;

            const lib = await import('/webtcp_jslib/dist/index.js');
            const { createBrowserNetwork } = await import('/webtcp_jslib/dist/browser.js');
            const warnings = [];
            const logger = {
                debug: () => {},
                info: () => {},
                warn: (...args) => warnings.push(['warn', args.map(String).join(' ')]),
                error: (...args) => warnings.push(['error', args.map(String).join(' ')]),
            };

            // デモのサーバーは署名付き（v2）を要求するため、デモと同じく Ed25519 の鍵を作る
            const keys = await lib.BrowserKeyManager.open({
                databaseName: `webtcp-keys-abort-${Math.random().toString(16).slice(2)}`,
                logger,
            });
            const signaling = new lib.SignalingAdapterHub({
                url: location.origin,
                nodeId: keys.nodeId,
                pollIntervalMs: 50,
                logger,
            });
            const network = createBrowserNetwork({ signaling, keyManager: keys, iceServers: [], logger });
            await network.start();

            // --- 中断の検証: 応答しないピアへ接続試行中に中断する ---
            const absentId = 'f'.repeat(32);
            const controller = new AbortController();
            const started = performance.now();
            const pending = network.connect(absentId, 80, undefined, { signal: controller.signal });
            const pendingOutcome = pending.then(
                () => ({ resolved: true }),
                (error) => ({ resolved: false, name: error.name, message: String(error.message) }),
            );

            // 実 RTCPeerConnection が作られ、ネゴシエーションが進行中になるまで待つ
            const waitUntil = async (predicate, timeoutMs) => {
                const deadline = performance.now() + timeoutMs;
                while (!predicate() && performance.now() < deadline) {
                    await new Promise((r) => originalSet(r, 20));
                }
                return predicate();
            };
            const inFlight = await waitUntil(() => pcs.length === 1, 3000);
            await new Promise((r) => originalSet(r, 300));
            const pcCountAtAbort = pcs.length;
            const pcStateBeforeAbort = pcs[0]?.connectionState ?? null;
            const timerBeforeAbort = liveWithDelay(15_000);

            const abortAt = performance.now();
            controller.abort();
            const outcome = await pendingOutcome;
            const rejectMs = Math.round(performance.now() - abortAt);

            // 中断後の状態（少し待ってから確認する）
            await new Promise((r) => originalSet(r, 100));
            const pcStateAfterAbort = pcs[0]?.connectionState ?? null;
            const timerAfterAbort = liveWithDelay(15_000);

            // --- 後続接続: 実在するサーバーへ接続できること ---
            let followUp = { ok: false };
            try {
                const stream = await network.connect(serverNodeId, 8080);
                followUp = { ok: stream.state === 'ESTABLISHED', state: stream.state };
                stream.destroy();
            } catch (error) {
                followUp = { ok: false, error: String(error.message) };
            }

            network.close();
            window.RTCPeerConnection = OriginalPC;
            window.setTimeout = originalSet;
            window.clearTimeout = originalClear;

            return {
                inFlight,
                pcCountAtAbort,
                pcStateBeforeAbort,
                pcStateAfterAbort,
                timerBeforeAbort,
                timerAfterAbort,
                outcome,
                rejectMs,
                warnings,
                elapsedMs: Math.round(performance.now() - started),
                followUp,
            };
        },
        { serverNodeId },
    );

    console.log('[verify-abort-browser] 接続試行中の中断（実 RTCPeerConnection）:');
    console.log(`  in-flight: pc=${result.pcCountAtAbort} state=${result.pcStateBeforeAbort} connect-timer=${result.timerBeforeAbort}`);
    console.log(`  abort -> ${result.outcome.name ?? 'resolved'} in ${result.rejectMs} ms`);
    console.log(`  after: pc=${result.pcStateAfterAbort} connect-timer=${result.timerAfterAbort} warnings=${result.warnings.length}`);
    console.log(`  follow-up connect to real server: ${JSON.stringify(result.followUp)}`);

    check(result.inFlight && result.pcCountAtAbort === 1, '接続試行中（実 RTCPeerConnection が作られた）に中断した');
    check(result.pcStateBeforeAbort !== 'closed', '中断の直前、接続はまだ確立していない');
    check(result.outcome.resolved === false && result.outcome.name === 'AbortError', '中断は AbortError で reject する');
    check(result.rejectMs < 2000, `中断は即座に返る（${result.rejectMs} ms、接続タイムアウト 15 s を待たない）`);
    check(result.pcStateAfterAbort === 'closed', '実 RTCPeerConnection が閉じられている');
    check(result.timerBeforeAbort >= 1 && result.timerAfterAbort === 0, '接続タイマーが解除されている');
    check(result.warnings.length === 0, `中断で warn / error が出ない（${JSON.stringify(result.warnings)}）`);
    check(result.followUp.ok === true, '中断の後、実在するサーバーへの接続が成功する（後続接続が壊れない）');
} catch (error) {
    failures.push(`exception: ${error.message}`);
    console.error(error);
} finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
}

if (failures.length > 0) {
    console.error(`[verify-abort-browser] FAILED (${failures.length})`);
    process.exit(1);
}
console.log('[verify-abort-browser] all checks passed');
