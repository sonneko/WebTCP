#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）で、同じ 2 タブ自動検証を
 * HTTP ポーリング・SSE・WebSocket の 3 経路それぞれについて実行し、結果が一致することを確かめる（#45）。
 *
 * 各経路で `?signaling=poll|sse|ws` を両タブに付け、`?role=server/client&autostart=1` の
 * 実 WebRTC 接続（ICE・DataChannel・名前解決）が成功し、経路の表示が一致することを確認する。
 *
 * 実行方法:
 *   cd webtcp_jslib && npm run build && cd ..
 *   npm install --no-save playwright && npx playwright install chromium   （CI と同じ）
 *   node examples/verify-signaling-browser.mjs
 */

import { createDemoServer } from './server.mjs';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error('Playwright が見つかりません: npm install --no-save playwright && npx playwright install chromium');
    process.exit(1);
}

const TRANSPORTS = ['poll', 'sse', 'ws'];

async function waitForEntrance(origin, expectedNodeId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const res = await fetch(`${origin}/entrances`);
        if (res.ok) {
            const body = await res.json();
            if (Array.isArray(body.nodes) && body.nodes.includes(expectedNodeId)) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${expectedNodeId} to appear in /entrances`);
}

const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
});

const results = {};
let failed = false;
try {
    for (const transport of TRANSPORTS) {
        // 経路ごとに新しいサーバーを立てる（前の経路の入室情報・名前登録が混ざらないように）
        const server = createDemoServer();
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const baseUrl = `${origin}/examples/demo/`;
        const context = await browser.newContext();
        const srvPage = await context.newPage();
        const cliPage = await context.newPage();
        // 実際に使われた経路を記録する（ポーリングのまま成功して見えるのを防ぐ）
        const seen = { messages: 0, events: 0, ws: 0 };
        for (const page of [srvPage, cliPage]) {
            page.on('request', (req) => {
                const url = req.url();
                if (url.includes('/messages')) seen.messages += 1;
                else if (url.includes('/events')) seen.events += 1;
            });
            // WebSocket の Upgrade は request ではなく websocket イベントで届く
            page.on('websocket', (ws) => {
                if (ws.url().includes('/ws')) seen.ws += 1;
            });
        }
        const started = Date.now();
        try {
            await srvPage.goto(`${baseUrl}?e2e=1&role=server&autostart=1&signaling=${transport}`);
            await srvPage.waitForFunction(() =>
                document.getElementById('listen-status')?.textContent?.includes('待ち受け中'),
            );
            const srvNodeId = (await srvPage.locator('#node-id').textContent()).trim();
            await waitForEntrance(origin, srvNodeId);

            await cliPage.goto(`${baseUrl}?e2e=1&role=client&autostart=1&signaling=${transport}`);
            await cliPage.waitForFunction(() => document.documentElement.dataset.twotab !== undefined, undefined, {
                timeout: 30_000,
            });
            const twoTab = await cliPage.evaluate(() => window.__WEBTCP_TWOTAB__);
            results[transport] = {
                ok: Boolean(twoTab?.ok),
                resolvedName: twoTab?.resolvedName ?? null,
                durationMs: Date.now() - started,
                requests: { ...seen },
            };
            const usedExpectedPath =
                transport === 'poll' ? seen.messages > 0 && seen.events === 0 : transport === 'sse' ? seen.events > 0 : seen.ws > 0;
            if (!usedExpectedPath) {
                failed = true;
                console.error(`[verify-signaling-browser] ${transport}: expected path not used ${JSON.stringify(seen)}`);
            }
            if (!results[transport].ok || results[transport].resolvedName !== 'demo-alias') {
                failed = true;
                console.error(`[verify-signaling-browser] ${transport} FAILED: ${JSON.stringify(twoTab)}`);
            }
        } catch (error) {
            failed = true;
            results[transport] = { ok: false, error: String(error.message ?? error).slice(0, 300) };
            console.error(`[verify-signaling-browser] ${transport} ERROR: ${results[transport].error}`);
        } finally {
            await context.close();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        }
    }
} finally {
    await browser.close();
}

console.log('[verify-signaling-browser] 2-tab real WebRTC connection per transport:');
for (const transport of TRANSPORTS) {
    const r = results[transport];
    console.log(
        `  ${transport.padEnd(5)} connected=${r.ok ? 'yes' : 'NO'} resolvedName=${r.resolvedName ?? '-'} ` +
            `duration=${r.durationMs ?? '-'}ms requests=${JSON.stringify(r.requests ?? {})}`,
    );
}
const allOk = TRANSPORTS.every((t) => results[t]?.ok && results[t].resolvedName === 'demo-alias');
if (failed || !allOk) {
    console.error('[verify-signaling-browser] FAILED');
    process.exit(1);
}
console.log('[verify-signaling-browser] all transports connected with identical results');
