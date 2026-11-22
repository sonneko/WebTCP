#!/usr/bin/env node
/**
 * 実ブラウザ（ヘッドレス Chromium / Playwright）による 2 タブデモ end-to-end 検証スクリプト。
 *
 * 実行前提:
 *   1. `cd webtcp_jslib && npm run build`
 *   2. Playwright + Chromium が利用可能であること（例: `npx playwright install chromium`）
 *
 * 実行方法:
 *   node examples/verify-browser.mjs
 *
 * 検証内容:
 *   1. 2 つの実ブラウザタブ（Tab A: サーバー、Tab B: クライアント）での UI 操作による
 *      実 WebRTC 接続・テキストエコー・80 KiB 大容量自動分割往復・Half-Close 切断
 *   2. `?role=server&autostart=1` + `?role=client&autostart=1` の 2 タブ自動検証
 *   3. `?selftest=1` の同一タブ 2 ピア自己チェック（Ed25519 署名検証・NameServer 名前解決・
 *      HTTP トンネル・`domain.global` の所有権レコード + 台帳アンカー検証・webtcp:// URL 接続を含む）
 *
 * M3（#28）以降、デモは既定で Ed25519 署名（プロトコル v2）を使う。
 * M4（#25）では NameServer / webtcp:// URL の検証を、M5（#25 継続）では `domain.global` の
 * 所有権レコード検証（台帳受理・チェックポイント PIN・改ざん拒否・未登録名の fail-closed）を、
 * M6（#50）では `serveHTTP` + `fetchURL` の HTTP 往復（path/query の転送と remoteNodeId）を追加した。
 * ブラウザが Web Crypto の Ed25519 を持たない場合は v1 にフォールバックする。
 */

import { createDemoServer } from './server.mjs';

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error(
        'Playwright が見つかりません。実ブラウザ検証を実行するには Playwright と Chromium を導入してください:\n' +
            '  npm install --no-save playwright && npx playwright install chromium\n' +
            'または `node examples/server.mjs` を起動し、ブラウザで\n' +
            '  http://localhost:8787/examples/demo/?selftest=1\n' +
            'を開いて自己チェックを実行できます。',
    );
    process.exit(1);
}

/**
 * 各テストで独立したデモサーバーを起動・破棄するヘルパー。
 * 前テストの終了済みノードが `/entrances` に残って bootstrap が遅延するのを防ぐ。
 */
async function withDemoServer(fn) {
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const baseUrl = `${origin}/examples/demo/`;
    try {
        return await fn({ origin, baseUrl });
    } finally {
        await new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        });
    }
}

/** 2 つの NodeId が異なることを確認する（鍵指紋がタブごとに独立していることの検証）。 */
function assertDistinct(nodeIdA, nodeIdB) {
    if (nodeIdA === nodeIdB) {
        throw new Error(`Both tabs share the same NodeId (${nodeIdA}); Ed25519 identities were not independent`);
    }
}

async function waitForEntrance(origin, expectedNodeId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const res = await fetch(`${origin}/entrances`);
        if (res.ok) {
            const body = await res.json();
            if (Array.isArray(body.nodes) && body.nodes.includes(expectedNodeId)) {
                return;
            }
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expectedNodeId} to appear in /entrances`);
}

// 既存の Chromium を使う場合は WEBTCP_CHROMIUM_PATH を指定できる（verify-bridge-browser.mjs と同じ）
const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
});

try {
    // ------------------------------------------------------------------
    // テスト 1: 実ブラウザ 2 タブ UI 操作検証
    // ------------------------------------------------------------------
    await withDemoServer(async ({ origin, baseUrl }) => {
        console.log(`[verify-browser] Test 1: 2-tab manual UI flow (${baseUrl})...`);
        const context = await browser.newContext();
        const pageA = await context.newPage();
        const pageB = await context.newPage();

        const pageErrors = [];
        pageA.on('pageerror', (err) => pageErrors.push(`TabA: ${err.message}`));
        pageB.on('pageerror', (err) => pageErrors.push(`TabB: ${err.message}`));

        // タブごとに独立した Ed25519 識別子を作る（鍵指紋が NodeId になる）
        await Promise.all([pageA.goto(`${baseUrl}?e2e=1`), pageB.goto(`${baseUrl}?e2e=1`)]);

        // 両タブの NodeId 初期化完了を待つ
        await Promise.all([
            pageA.waitForFunction(() =>
                /^[0-9a-f]{32}$/.test(document.getElementById('node-id')?.textContent ?? ''),
            ),
            pageB.waitForFunction(() =>
                /^[0-9a-f]{32}$/.test(document.getElementById('node-id')?.textContent ?? ''),
            ),
        ]);

        const nodeIdA = (await pageA.locator('#node-id').textContent()).trim();
        const nodeIdB = (await pageB.locator('#node-id').textContent()).trim();
        assertDistinct(nodeIdA, nodeIdB);
        console.log(`[verify-browser]   Tab A=${nodeIdA.slice(0, 8)}…, Tab B=${nodeIdB.slice(0, 8)}…`);

        const identityA = (await pageA.locator('#identity-status').textContent()).trim();
        const identityB = (await pageB.locator('#identity-status').textContent()).trim();
        console.log(`[verify-browser]   Tab A: ${identityA} / Tab B: ${identityB}`);
        if (!identityA.includes('Ed25519: 有効')) {
            console.warn(
                '[verify-browser]   WARN: このブラウザは Web Crypto の Ed25519 非対応のため v1 で検証しています',
            );
        }

        // Tab A の初回ポーリングがハブへ登録されるのを待つ
        await waitForEntrance(origin, nodeIdA);

        // Tab A: ポート 8080 で待ち受け
        await pageA.click('#listen-btn');
        await pageA.waitForFunction(() =>
            document.getElementById('listen-status')?.textContent?.includes('待ち受け中'),
        );

        // Tab B: 接続先を探して Tab A を選択 -> 接続
        await pageB.click('#discover-btn');
        await pageB.waitForFunction(
            (target) =>
                [...document.querySelectorAll('#peer-select option')].some(
                    (o) => o.value === target,
                ),
            nodeIdA,
        );
        await pageB.selectOption('#peer-select', nodeIdA);
        await pageB.click('#connect-btn');

        await pageB.waitForFunction(
            () => document.getElementById('client-status')?.textContent?.includes('ESTABLISHED'),
            undefined,
            { timeout: 15_000 },
        );

        // テキスト送信 -> エコー受信確認
        await pageB.fill('#message-input', 'hello-from-chromium-tab-B');
        await pageB.click('#send-btn');
        await pageB.waitForFunction(() =>
            document.getElementById('client-log')?.textContent?.includes('echo:hello-from-chromium-tab-B'),
        );

        // 80 KiB 大容量自動分割送信テスト
        await pageB.click('#send-large-btn');
        await pageB.waitForFunction(
            () => document.getElementById('client-log')?.textContent?.includes('大容量エコー検証 PASS'),
            undefined,
            { timeout: 15_000 },
        );

        // 切断（half-close -> CLOSED）
        await pageB.click('#disconnect-btn');
        await pageB.waitForFunction(() =>
            document.getElementById('client-status')?.textContent?.includes('切断されました'),
        );
        await pageA.waitForFunction(() =>
            document.getElementById('server-log')?.textContent?.includes('CLOSED'),
        );

        // M4: 名前解決 + webtcp:// URL 接続（リンク確立済みの隣接から NameServer で引く）
        await pageB.click('#resolve-name-btn');
        await pageB.waitForFunction(() =>
            document.getElementById('client-log')?.textContent?.includes('名前解決: demo-service ->'),
        );
        await pageB.fill('#url-input', 'webtcp://demo-alias:8080/hello?x=1#frag');
        await pageB.click('#connect-url-btn');
        await pageB.waitForFunction(
            () => document.getElementById('client-status')?.textContent?.includes('ESTABLISHED'),
            undefined,
            { timeout: 15_000 },
        );
        await pageB.waitForFunction(() =>
            document.getElementById('client-log')?.textContent?.includes('webtcp:// 接続成功'),
        );
        await pageB.fill('#message-input', 'hello-over-webtcp-url');
        await pageB.click('#send-btn');
        await pageB.waitForFunction(() =>
            document.getElementById('client-log')?.textContent?.includes('echo:hello-over-webtcp-url'),
        );
        await pageB.click('#disconnect-btn');
        await pageB.waitForFunction(() =>
            document.getElementById('client-status')?.textContent?.includes('切断されました'),
        );

        if (pageErrors.length > 0) {
            throw new Error(`Page errors in Test 1: ${pageErrors.join('; ')}`);
        }
        await context.close();
        console.log('[verify-browser]   Test 1 PASS!');
    });

    // ------------------------------------------------------------------
    // テスト 2: 2 タブ自動検証モード (?role=server/client&autostart=1)
    // ------------------------------------------------------------------
    await withDemoServer(async ({ origin, baseUrl }) => {
        console.log(`[verify-browser] Test 2: 2-tab automated verification mode (${baseUrl})...`);
        const ctx2 = await browser.newContext();
        const srvPage = await ctx2.newPage();
        const cliPage = await ctx2.newPage();

        await srvPage.goto(`${baseUrl}?e2e=1&role=server&autostart=1`);
        await srvPage.waitForFunction(() =>
            document.getElementById('listen-status')?.textContent?.includes('待ち受け中'),
        );
        const srvNodeId = (await srvPage.locator('#node-id').textContent()).trim();
        await waitForEntrance(origin, srvNodeId);

        await cliPage.goto(`${baseUrl}?e2e=1&role=client&autostart=1`);
        await cliPage.waitForFunction(
            () => document.documentElement.dataset.twotab !== undefined,
            undefined,
            { timeout: 20_000 },
        );
        const twoTabResult = await cliPage.evaluate(() => window.__WEBTCP_TWOTAB__);
        if (!twoTabResult?.ok || twoTabResult.resolvedName !== 'demo-alias') {
            const clientLog = await cliPage.locator('#client-log').textContent();
            const serverLog = await srvPage.locator('#server-log').textContent();
            throw new Error(
                `Test 2 failed: ${JSON.stringify(twoTabResult)}\nClient:\n${clientLog}\nServer:\n${serverLog}`,
            );
        }
        await ctx2.close();
        console.log(`[verify-browser]   Test 2 PASS (${twoTabResult.durationMs}ms)!`);
    });

    // ------------------------------------------------------------------
    // テスト 3: 1 タブ自己チェック (?selftest=1)
    // ------------------------------------------------------------------
    await withDemoServer(async ({ baseUrl }) => {
        console.log(`[verify-browser] Test 3: Single-tab self-test (${baseUrl}?selftest=1)...`);
        const ctx3 = await browser.newContext();
        const selfPage = await ctx3.newPage();
        await selfPage.goto(`${baseUrl}?selftest=1`);
        await selfPage.waitForFunction(
            () => document.documentElement.dataset.selftest !== undefined,
            undefined,
            { timeout: 20_000 },
        );
        const selfResult = await selfPage.evaluate(() => window.__WEBTCP_SELFTEST__);
        if (!selfResult?.ok) {
            throw new Error(`Test 3 failed: ${JSON.stringify(selfResult)}`);
        }
        await ctx3.close();
        const namingStep = selfResult.steps.find((step) => step.name.includes('NameServer'));
        if (!namingStep?.ok) {
            throw new Error(`Test 3 missing NameServer step: ${JSON.stringify(selfResult)}`);
        }
        const domainStep = selfResult.steps.find((step) => step.name.includes('domain.global'));
        if (!domainStep?.ok) {
            throw new Error(`Test 3 missing or failed domain.global step: ${JSON.stringify(domainStep ?? selfResult)}`);
        }
        console.log(`[verify-browser]   Test 3 domain step: ${domainStep.detail}`);
        // M6 / #50: 実ブラウザでの HTTP トンネル（serveHTTP + fetchURL）
        const httpStep = selfResult.steps.find((step) => step.name.includes('HTTP トンネル'));
        if (!httpStep?.ok) {
            throw new Error(`Test 3 missing or failed HTTP tunnel step: ${JSON.stringify(httpStep ?? selfResult)}`);
        }
        console.log(`[verify-browser]   Test 3 HTTP step: ${httpStep.detail}`);
        // #51: サービス状態の永続化・復元（IndexedDB）
        const persistStep = selfResult.steps.find((step) => step.name.includes('永続化'));
        if (!persistStep?.ok) {
            throw new Error(`Test 3 missing or failed persistence step: ${JSON.stringify(persistStep ?? selfResult)}`);
        }
        console.log(`[verify-browser]   Test 3 persistence step: ${persistStep.detail}`);
        console.log(
            `[verify-browser]   Test 3 PASS (${selfResult.durationMs}ms, ${selfResult.steps.length} steps)!`,
        );
    });

    console.log('[verify-browser] ALL REAL BROWSER TESTS PASSED!');
} finally {
    await browser.close();
}
