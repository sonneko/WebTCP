/**
 * Issue #92 再現ドライバ: 初回 WebRTC 接続の停止（約 15 秒後のタイムアウト）を、
 * 同時に走らせた複数プロセスの負荷下で繰り返し計測する。
 *
 * 使い方（リポジトリ直下で、webtcp_jslib を build してから）:
 *   WEBTCP_CHROMIUM_PATH=/path/to/chromium \
 *   N=20 POLL=50 PARALLEL=8 OUT_DIR=/tmp/issue92 \
 *   node examples/probe-first-connect/run.mjs
 *
 * 1 プロセスは N 回の「ピア起動 → 別ノードが接続」を行い、結果を JSON に書く。
 * PARALLEL 個のプロセスを同時に起動し、負荷を再現する（付録: OUT_DIR/*.json）。
 * 出力の SUMMARY 行は次の形式: trials / timeouts / fingerprint-errors / p50 / p99 / max。
 *
 * ページ内の計測（RTCPeerConnection の状態遷移、ICE 候補の追加結果、シグナリング）は
 * ライブラリの挙動を変えずに記録する。ライブラリのログは noopLogger で捨てず、
 * probe ページの logger が window.logs に残す。
 */

import { createDemoServer } from '../server.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const N = Number(process.env.N ?? 20);
const POLL = Number(process.env.POLL ?? 50);
const PARALLEL = Number(process.env.PARALLEL ?? 1);
const OUT_DIR = process.env.OUT_DIR ?? path.join(process.env.TMPDIR ?? '/tmp', 'webtcp-issue92');
const CHILD = process.env.PROBE_CHILD === '1';

// ページ内の計測: 両ページで、RTCPeerConnection の状態遷移・ICE 候補・シグナリングを記録する。
const TRACE = `
(() => {
  const trace = (window.__trace = []);
  const T = () => Math.round(performance.now());
  const push = (...x) => trace.push([T(), ...x]);
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    let n = 0;
    const Wrapped = function (...args) {
      const pc = new Orig(...args);
      const id = ++n;
      push('pc', id, 'created');
      pc.addEventListener('iceconnectionstatechange', () => push('pc', id, 'ice', pc.iceConnectionState));
      pc.addEventListener('connectionstatechange', () => push('pc', id, 'conn', pc.connectionState));
      pc.addEventListener('icegatheringstatechange', () => push('pc', id, 'gather', pc.iceGatheringState));
      pc.addEventListener('signalingstatechange', () => push('pc', id, 'sig', pc.signalingState));
      pc.addEventListener('icecandidate', (e) => push('pc', id, 'localcand', e.candidate ? (e.candidate.type || 'x') : 'end'));
      pc.addEventListener('datachannel', () => push('pc', id, 'datachannel'));
      const addIce = pc.addIceCandidate.bind(pc);
      pc.addIceCandidate = (c) => addIce(c).then(() => push('pc', id, 'addIce ok'), (e) => { push('pc', id, 'addIce fail', String(e)); throw e; });
      return pc;
    };
    Wrapped.prototype = Orig.prototype;
    Object.assign(Wrapped, Orig);
    window.RTCPeerConnection = Wrapped;
  }
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? opts.body : '';
    const kind = /"kind":"(\\w+)"/.exec(body);
    push('post', kind ? kind[1] : '?', 'to', String(url).split('/').pop().slice(0, 8));
    return origFetch(url, opts);
  };
})();
`;

/** 1 回の試行: ピアを起動し、別のページ（ノード）から接続する。 */
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
            await peerPage.goto(`${origin}/examples/probe-first-connect/index.html?role=peer&poll=${POLL}`);
            await peerPage.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
            const peerId = await peerPage.evaluate(() => window.verify.nodeId);

            const nodePage = await nodeCtx.newPage();
            const started = Date.now();
            await nodePage.goto(`${origin}/examples/probe-first-connect/index.html?role=node&peer=${peerId}&poll=${POLL}`);
            await nodePage.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
            const v = await nodePage.evaluate(() => window.verify);
            results.push({
                i,
                ...v,
                pageMs: Date.now() - started,
                logs: await nodePage.evaluate(() => window.logs || []),
                trace: await nodePage.evaluate(() => window.__trace || []),
                peerLogs: await peerPage.evaluate(() => window.logs || []),
                peerTrace: await peerPage.evaluate(() => window.__trace || []),
            });
            console.log(JSON.stringify({ tag, i, connected: v.connected, ms: v.ms, error: v.error ? String(v.error).slice(0, 120) : null }));
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
    const ms = results.map((r) => r.ms ?? 0).sort((a, b) => a - b);
    const fingerprint = results.filter((r) => r.peerLogs.some((l) => String(l[3] ?? '').includes('no identity available'))).length;
    const timeouts = results.filter((r) => !r.connected).length;
    const pick = (q) => ms[Math.min(n - 1, Math.floor(n * q))];
    return `trials ${n} timeouts ${timeouts} fingerprint-errors ${fingerprint} p50 ${pick(0.5)} p99 ${pick(0.99)} max ${ms[n - 1]}`;
}

if (CHILD) {
    // 子プロセス: 1 本のサーバーに対して N 回試行し、結果を JSON に書く
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
    // 親: PARALLEL 個の子プロセスを同時に起動し、結果を集計する
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
