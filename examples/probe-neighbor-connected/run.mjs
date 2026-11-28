/**
 * Issue #93 再現ドライバ: 1 回の接続で `neighbor-connected` が 2 回発火することがあるかを計測する。
 *
 * 使い方（リポジトリ直下で、webtcp_jslib を build してから）:
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium N=30 POLL=50 PARALLEL=1 OUT_DIR=/tmp/issue93 \
 *   node examples/probe-neighbor-connected/run.mjs
 *
 * 1 試行: ピア（role=peer）を起動し、別のページ（role=node）が connectToPeer する。
 * 両側で `neighbor-connected` の発火回数と、DataChannel の作成・open 回数を記録する。
 * 「1 回の接続で 2 回以上発火」した試行を、重複発火として数える。
 *
 * ページ内の計測は、利用者の API（`network.on`）と、ライブラリの接続ログ（logger）を使う。
 */

import { createDemoServer } from '../server.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const N = Number(process.env.N ?? 30);
const POLL = Number(process.env.POLL ?? 50);
const PARALLEL = Number(process.env.PARALLEL ?? 1);
const OUT_DIR = process.env.OUT_DIR ?? path.join(process.env.TMPDIR ?? '/tmp', 'webtcp-issue93');
const CHILD = process.env.PROBE_CHILD === '1';

// DataChannel の作成・open を記録する（両側のページで同じ計測を入れる）
const TRACE = `
(() => {
  const trace = (window.__trace = []);
  const T = () => Math.round(performance.now());
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    let n = 0;
    const Wrapped = function (...args) {
      const pc = new Orig(...args);
      const id = ++n;
      trace.push([T(), 'pc', id, 'created']);
      pc.addEventListener('connectionstatechange', () => trace.push([T(), 'pc', id, 'conn', pc.connectionState]));
      pc.addEventListener('datachannel', (e) => {
        const dc = e.channel;
        trace.push([T(), 'pc', id, 'dc-remote', dc.label]);
        dc.addEventListener('open', () => trace.push([T(), 'pc', id, 'dc-open', 'remote', dc.label]));
      });
      const createDc = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (label, opts) => {
        const dc = createDc(label, opts);
        trace.push([T(), 'pc', id, 'dc-local', label]);
        dc.addEventListener('open', () => trace.push([T(), 'pc', id, 'dc-open', 'local', label]));
        return dc;
      };
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    Object.assign(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  }
})();
`;

async function runTrials(chromium, origin, tag) {
    const results = [];
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
        ...(process.env.WEBTCP_CHROMIUM_PATH ? { executablePath: process.env.WEBTCP_CHROMIUM_PATH } : {}),
    });
    try {
        for (let i = 0; i < N; i++) {
            const peerCtx = await browser.newContext();
            const nodeCtx = await browser.newContext();
            await peerCtx.addInitScript(TRACE);
            await nodeCtx.addInitScript(TRACE);
            const peerPage = await peerCtx.newPage();
            await peerPage.goto(`${origin}/examples/probe-neighbor-connected/index.html?role=peer&poll=${POLL}`);
            await peerPage.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
            const peerId = await peerPage.evaluate(() => window.verify.nodeId);

            const nodePage = await nodeCtx.newPage();
            await nodePage.goto(`${origin}/examples/probe-neighbor-connected/index.html?role=node&peer=${peerId}&poll=${POLL}`);
            await nodePage.waitForFunction(() => window.ready === true, null, { timeout: 90000 });

            const node = {
                verify: await nodePage.evaluate(() => window.verify),
                events: await nodePage.evaluate(() => window.events || []),
                trace: await nodePage.evaluate(() => window.__trace || []),
                logs: await nodePage.evaluate(() => window.logs || []),
            };
            const peer = {
                events: await peerPage.evaluate(() => window.events || []),
                trace: await peerPage.evaluate(() => window.__trace || []),
                logs: await peerPage.evaluate(() => window.logs || []),
            };
            const nodeConnected = node.events.filter((e) => e[0] === 'connected').length;
            const peerConnected = peer.events.filter((e) => e[0] === 'connected').length;
            results.push({ i, connected: node.verify.connected, nodeConnected, peerConnected, node, peer });
            console.log(JSON.stringify({ tag, i, nodeConnected, peerConnected, error: node.verify.error ? String(node.verify.error).slice(0, 100) : null }));
            await peerCtx.close();
            await nodeCtx.close();
        }
    } finally {
        await browser.close();
    }
    return results;
}

function summarize(results) {
    const n = results.length;
    const dupNode = results.filter((r) => r.nodeConnected > 1).length;
    const dupPeer = results.filter((r) => r.peerConnected > 1).length;
    const dupEither = results.filter((r) => r.nodeConnected > 1 || r.peerConnected > 1).length;
    const notConnected = results.filter((r) => !r.connected).length;
    return `trials ${n} not-connected ${notConnected} duplicate-node ${dupNode} duplicate-peer ${dupPeer} duplicate-either ${dupEither}`;
}

if (CHILD) {
    const { chromium } = await import('playwright').catch(() => {
        console.error('Playwright が見つかりません: npm install --no-save playwright');
        process.exit(1);
    });
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const tag = process.env.PROBE_TAG ?? 'run';
    try {
        const results = await runTrials(chromium, origin, tag);
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(path.join(OUT_DIR, `${tag}.json`), JSON.stringify(results, null, 1));
        console.log(`SUMMARY tag=${tag} ${summarize(results)}`);
    } finally {
        server.close();
    }
} else {
    const children = [];
    for (let k = 0; k < PARALLEL; k += 1) {
        children.push(new Promise((resolve) => {
            const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
                env: { ...process.env, PROBE_CHILD: '1', PROBE_TAG: `p${k + 1}` },
                stdio: ['ignore', 'inherit', 'inherit'],
            });
            child.on('exit', (code) => resolve(code));
        }));
    }
    const codes = await Promise.all(children);
    const all = [];
    for (let k = 0; k < PARALLEL; k += 1) {
        try {
            all.push(...JSON.parse(readFileSync(path.join(OUT_DIR, `p${k + 1}.json`), 'utf8')));
        } catch {
            console.error(`child p${k + 1} produced no results (exit ${codes[k]})`);
        }
    }
    console.log(`TOTAL parallel=${PARALLEL} poll=${POLL} ${summarize(all)}`);
}
