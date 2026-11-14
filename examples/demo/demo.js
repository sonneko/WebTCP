/**
 * WebTCP M2 デモのクライアントサイド。
 *
 * `webtcp_jslib` をビルドした ESM をそのまま import している（バンドラ不要）。
 * 事前に `npm run build`（webtcp_jslib）を実行しておくこと。
 *
 * クエリパラメータ:
 * - `?stun=1`: パブリック STUN サーバー例（EXAMPLE_STUN_ICE_SERVERS）を有効化
 * - `?selftest=1`: 起動時に同一タブ内の実 WebRTC 2 ピア自己チェックを自動実行
 * - `?role=server&autostart=1`: サーバーとしてポート 8080 で自動待ち受け
 * - `?role=client&autostart=1`: クライアントとして自動探索・接続・検証を実行
 */
import {
    EXAMPLE_STUN_ICE_SERVERS,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
    createLogger,
} from '../../webtcp_jslib/dist/index.js';

const SERVER_PORT = 8080;
const LARGE_TEST_BYTES = 80 * 1024 + 123; // > 60 KiB
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const params = new URLSearchParams(location.search);

const els = {
    nodeId: document.getElementById('node-id'),
    logLevelSelect: document.getElementById('log-level-select'),
    icePresetSelect: document.getElementById('ice-preset-select'),
    iceCustomWrap: document.getElementById('ice-custom-wrap'),
    iceCustomJson: document.getElementById('ice-custom-json'),
    applyIceBtn: document.getElementById('apply-ice-btn'),
    iceStatus: document.getElementById('ice-status'),
    listenBtn: document.getElementById('listen-btn'),
    openClientTabBtn: document.getElementById('open-client-tab-btn'),
    listenStatus: document.getElementById('listen-status'),
    serverLog: document.getElementById('server-log'),
    discoverBtn: document.getElementById('discover-btn'),
    bootstrapBtn: document.getElementById('bootstrap-btn'),
    peerSelect: document.getElementById('peer-select'),
    connectBtn: document.getElementById('connect-btn'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    clientStatus: document.getElementById('client-status'),
    streamStats: document.getElementById('stream-stats'),
    clientLog: document.getElementById('client-log'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    sendLargeBtn: document.getElementById('send-large-btn'),
    selftestBtn: document.getElementById('selftest-btn'),
    selftestStatus: document.getElementById('selftest-status'),
    selftestList: document.getElementById('selftest-list'),
};

let network = null;
let signaling = null;
let clientStream = null;
let listening = false;
let statsTimer = null;
let currentLogger = createLogger({ level: 'warn' });

function log(element, message) {
    const timestamp = new Date().toLocaleTimeString();
    element.textContent += `[${timestamp}] ${message}\n`;
    element.scrollTop = element.scrollHeight;
}

function setStatus(element, text, kind = '') {
    element.textContent = text;
    element.className = `status ${kind}`.trim();
}

function getSelectedIceServers() {
    const preset = els.icePresetSelect.value;
    if (preset === 'none') return [];
    if (preset === 'stun') return [...EXAMPLE_STUN_ICE_SERVERS];
    const parsed = JSON.parse(els.iceCustomJson.value);
    if (!Array.isArray(parsed)) {
        throw new Error('iceServers JSON は配列である必要があります');
    }
    return parsed;
}

async function initNetwork() {
    stopStatsPolling();
    if (clientStream) {
        clientStream.destroy();
        clientStream = null;
    }
    if (network) {
        network.close();
        network = null;
    }
    if (signaling) {
        signaling.close();
        signaling = null;
    }
    listening = false;
    els.listenBtn.disabled = false;
    setStatus(els.listenStatus, '未開始');
    setConnectedUi(false);

    let iceServers;
    try {
        iceServers = getSelectedIceServers();
    } catch (error) {
        setStatus(els.iceStatus, `JSON エラー: ${error.message}`, 'err');
        return false;
    }

    currentLogger = createLogger({ level: els.logLevelSelect.value });
    setStatus(
        els.iceStatus,
        iceServers.length === 0
            ? 'iceServers: []（LAN/同一ホスト）'
            : `iceServers: ${iceServers.length} 件設定済み`,
        'ok',
    );

    try {
        signaling = new SignalingAdapterHub({
            url: location.origin,
            pollIntervalMs: 250,
            logger: currentLogger,
        });

        network = createBrowserNetwork({
            signaling,
            iceServers,
            logger: currentLogger,
        });

        await network.start();
        els.nodeId.textContent = network.localNodeId;
        return true;
    } catch (error) {
        currentLogger.error('Failed to start WebTCPNetwork:', error);
        setStatus(els.listenStatus, '起動に失敗しました', 'err');
        log(els.serverLog, `起動失敗: ${error.message}`);
        return false;
    }
}

function makePatternBytes(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
        buf[i] = (i * 29 + 13) & 0xff;
    }
    return buf;
}

function bytesEqual(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function onListen() {
    if (listening || !network) return;

    try {
        network.listen(SERVER_PORT, (stream) => {
            log(
                els.serverLog,
                `接続を受け付けました (remote=${stream.remoteNodeId.slice(0, 8)}…, state=${stream.state})`,
            );

            // テキストメッセージと大容量バイナリ（先頭 4 バイト 'BIG!' + 4 バイト長）の両方に対応
            let expectedBinaryBytes = 0;
            let binaryChunks = [];
            let binaryReceived = 0;

            stream.on('data', (data) => {
                if (expectedBinaryBytes > 0) {
                    binaryChunks.push(data);
                    binaryReceived += data.byteLength;
                    if (binaryReceived >= expectedBinaryBytes) {
                        const merged = concatBytes(binaryChunks);
                        const payload = merged.subarray(0, expectedBinaryBytes);
                        log(els.serverLog, `大容量データ受信完了 (${payload.byteLength} B) -> エコー返送`);
                        expectedBinaryBytes = 0;
                        binaryChunks = [];
                        binaryReceived = 0;
                        void stream
                            .send(payload)
                            .catch((error) => log(els.serverLog, `返送失敗: ${error.message}`));
                    }
                    return;
                }

                if (
                    data.byteLength >= 8 &&
                    data[0] === 0x42 &&
                    data[1] === 0x49 &&
                    data[2] === 0x47 &&
                    data[3] === 0x21
                ) {
                    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                    expectedBinaryBytes = view.getUint32(4, false);
                    const rest = data.subarray(8);
                    binaryChunks = rest.byteLength > 0 ? [rest] : [];
                    binaryReceived = rest.byteLength;
                    log(els.serverLog, `大容量データ受信開始 (expected=${expectedBinaryBytes} B)`);
                    if (binaryReceived >= expectedBinaryBytes) {
                        const merged = concatBytes(binaryChunks);
                        const payload = merged.subarray(0, expectedBinaryBytes);
                        expectedBinaryBytes = 0;
                        binaryChunks = [];
                        binaryReceived = 0;
                        void stream
                            .send(payload)
                            .catch((error) => log(els.serverLog, `返送失敗: ${error.message}`));
                    }
                    return;
                }

                const text = decoder.decode(data);
                log(els.serverLog, `受信: ${text}`);
                void stream
                    .send(`echo:${text}`)
                    .catch((error) => log(els.serverLog, `送信失敗: ${error.message}`));
            });

            // Half-Close: クライアントの end() 受信時、必要なら応答を完了させてから閉じる
            stream.on('end', () => {
                log(els.serverLog, `EOF 受信 (state=${stream.state}) -> サーバー側も end()`);
                stream.end();
            });

            stream.on('close', () => log(els.serverLog, '接続が閉じられました (CLOSED)'));
            stream.on('error', (error) => log(els.serverLog, `エラー: ${error.message}`));
        });

        listening = true;
        els.listenBtn.disabled = true;
        setStatus(els.listenStatus, `待ち受け中 (port ${SERVER_PORT})`, 'ok');
    } catch (error) {
        log(els.serverLog, `待ち受け開始に失敗: ${error.message}`);
    }
}

function concatBytes(chunks) {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function onDiscover() {
    if (!network) return [];
    setStatus(els.clientStatus, '接続先を検索中...');
    try {
        const searcher = new EntranceSearcherAdapterHub({
            url: location.origin,
            exclude: network.localNodeId,
        });
        const nodes = await searcher.search();

        els.peerSelect.innerHTML = '';
        if (nodes.length === 0) {
            const option = document.createElement('option');
            option.textContent = '（他のタブが見つかりません）';
            option.value = '';
            els.peerSelect.append(option);
            setStatus(els.clientStatus, '接続先が見つかりません');
            return [];
        }

        for (const nodeId of nodes) {
            const option = document.createElement('option');
            option.value = nodeId;
            option.textContent = `${nodeId.slice(0, 10)}…`;
            els.peerSelect.append(option);
        }
        setStatus(els.clientStatus, `${nodes.length} 件見つかりました`, 'ok');
        return nodes;
    } catch (error) {
        setStatus(els.clientStatus, '検索に失敗しました', 'err');
        log(els.clientLog, `検索失敗: ${error.message}`);
        return [];
    }
}

async function onBootstrap() {
    if (!network) return;
    setStatus(els.clientStatus, 'bootstrap() で自動探索・接続中...');
    try {
        const searcher = new EntranceSearcherAdapterHub({
            url: location.origin,
            exclude: network.localNodeId,
        });
        const result = await network.bootstrap(searcher, {
            targetConnections: 1,
            maxRetries: 4,
            initialBackoffMs: 300,
        });
        if (result.connected.length === 0) {
            setStatus(els.clientStatus, `接続候補が見つかりませんでした (試行 ${result.attempts} 回)`, 'warn');
            log(els.clientLog, `bootstrap: 0 件接続 (失敗 ${result.failed.length} 件)`);
            return;
        }
        const peerId = result.connected[0];
        els.peerSelect.innerHTML = '';
        const option = document.createElement('option');
        option.value = peerId;
        option.textContent = `${peerId.slice(0, 10)}… (リンク確立済み)`;
        els.peerSelect.append(option);
        setStatus(els.clientStatus, `リンク確立済み (${peerId.slice(0, 8)}…)`, 'ok');
        log(els.clientLog, `bootstrap 成功: ${peerId} (試行 ${result.attempts} 回)`);
    } catch (error) {
        setStatus(els.clientStatus, 'bootstrap に失敗しました', 'err');
        log(els.clientLog, `bootstrap 失敗: ${error.message}`);
    }
}

let pendingLargeTest = null;

async function onConnect() {
    const targetId = els.peerSelect.value;
    if (!targetId || !network) {
        log(els.clientLog, '接続先を選択してください');
        return;
    }

    els.connectBtn.disabled = true;
    setStatus(els.clientStatus, '接続中...');
    let connected = false;

    try {
        clientStream = await network.connect(targetId, SERVER_PORT);
        connected = true;
        setStatus(els.clientStatus, '接続済み (ESTABLISHED)', 'ok');
        log(
            els.clientLog,
            `仮想TCPセッション確立 (remote=${targetId.slice(0, 8)}…, ISN=${clientStream.initialSendSeqNum})`,
        );

        clientStream.on('data', (data) => {
            if (pendingLargeTest) {
                pendingLargeTest.chunks.push(data);
                pendingLargeTest.received += data.byteLength;
                if (pendingLargeTest.received >= pendingLargeTest.expected.byteLength) {
                    const merged = concatBytes(pendingLargeTest.chunks).subarray(
                        0,
                        pendingLargeTest.expected.byteLength,
                    );
                    const ok = bytesEqual(merged, pendingLargeTest.expected);
                    const elapsed = Date.now() - pendingLargeTest.startedAt;
                    const testRef = pendingLargeTest;
                    pendingLargeTest = null;
                    log(
                        els.clientLog,
                        ok
                            ? `大容量エコー検証 PASS: ${merged.byteLength} B 一致 (${elapsed} ms)`
                            : `大容量エコー検証 FAIL: データ不一致`,
                    );
                    testRef.resolve(ok);
                }
                return;
            }
            log(els.clientLog, `受信: ${decoder.decode(data)}`);
        });

        clientStream.on('end', () => {
            log(els.clientLog, '相手から EOF (FIN) を受信しました');
        });

        clientStream.on('close', () => {
            setStatus(els.clientStatus, '切断されました');
            setConnectedUi(false);
            stopStatsPolling();
            clientStream = null;
        });

        clientStream.on('error', (error) => {
            log(els.clientLog, `エラー: ${error.message}`);
        });

        setConnectedUi(true);
        startStatsPolling();
    } catch (error) {
        setStatus(els.clientStatus, '接続に失敗しました', 'err');
        log(els.clientLog, `接続失敗: ${error.message}`);
    } finally {
        // 接続成功時は connectBtn を無効のまま保つ（#32 バグ修正）
        if (!connected) {
            els.connectBtn.disabled = false;
        }
    }
}

function onDisconnect() {
    if (!clientStream) return;
    log(els.clientLog, '切断開始 (end / half-close)');
    clientStream.end();
}

async function onSend() {
    if (!clientStream) return;
    const text = els.messageInput.value;
    if (!text) return;

    try {
        await clientStream.send(text);
        log(els.clientLog, `送信: ${text}`);
        els.messageInput.value = '';
    } catch (error) {
        log(els.clientLog, `送信失敗: ${error.message}`);
    }
}

async function onSendLarge() {
    if (!clientStream || pendingLargeTest) return;
    const expected = makePatternBytes(LARGE_TEST_BYTES);
    const frame = new Uint8Array(8 + expected.byteLength);
    frame.set(encoder.encode('BIG!'), 0);
    new DataView(frame.buffer).setUint32(4, expected.byteLength, false);
    frame.set(expected, 8);

    const promise = new Promise((resolve) => {
        pendingLargeTest = {
            expected,
            chunks: [],
            received: 0,
            startedAt: Date.now(),
            resolve,
        };
    });

    log(els.clientLog, `大容量データ送信開始 (${expected.byteLength} B > 60 KiB, 自動分割)...`);
    await clientStream.send(frame);
    return promise;
}

function setConnectedUi(connected) {
    els.messageInput.disabled = !connected;
    els.sendBtn.disabled = !connected;
    els.sendLargeBtn.disabled = !connected;
    els.disconnectBtn.disabled = !connected;
    els.connectBtn.disabled = connected;
    if (connected) {
        els.messageInput.focus();
    }
}

function startStatsPolling() {
    stopStatsPolling();
    const update = () => {
        if (!clientStream) {
            els.streamStats.textContent = 'TCP 統計: 未接続';
            return;
        }
        const s = clientStream.getStats();
        els.streamStats.textContent =
            `TCP 統計: state=${s.state} | RTO=${s.rtoMs}ms | SRTT=${s.srttMs !== null ? Math.round(s.srttMs) + 'ms' : '-'} | ` +
            `cwnd=${Math.round(s.cwndBytes / 1024)}KiB | inFlight=${s.inFlightBytes}B | retx=${s.retransmissions} (fast=${s.fastRetransmits})`;
    };
    update();
    statsTimer = setInterval(update, 300);
}

function stopStatsPolling() {
    if (statsTimer !== null) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    els.streamStats.textContent = 'TCP 統計: 未接続';
}

// =========================================================================
// 実ブラウザ自己チェック（同一ページ内で 2 つの実 RTCPeerConnection を検証）
// =========================================================================

function addSelfTestRow(label, status = 'run', detail = '') {
    const li = document.createElement('li');
    li.innerHTML = `<span class="badge ${status}">${status.toUpperCase()}</span><span>${label}</span>${detail ? ` — <span class="status">${detail}</span>` : ''}`;
    els.selftestList.append(li);
    return li;
}

function updateSelfTestRow(li, label, status, detail = '') {
    li.innerHTML = `<span class="badge ${status}">${status.toUpperCase()}</span><span>${label}</span>${detail ? ` — <span class="status">${detail}</span>` : ''}`;
}

async function runSelfTest() {
    els.selftestBtn.disabled = true;
    els.selftestList.innerHTML = '';
    setStatus(els.selftestStatus, '自己チェック実行中...', 'warn');
    const startedAt = Date.now();
    const steps = [];

    const iceServers = (() => {
        try {
            return getSelectedIceServers();
        } catch {
            return [];
        }
    })();

    const logger = createLogger({ level: els.logLevelSelect.value });
    const sigServer = new SignalingAdapterHub({ url: location.origin, pollIntervalMs: 120, logger });
    const sigClient = new SignalingAdapterHub({ url: location.origin, pollIntervalMs: 120, logger });
    const netServer = createBrowserNetwork({ signaling: sigServer, iceServers, logger });
    const netClient = createBrowserNetwork({ signaling: sigClient, iceServers, logger });

    const runStep = async (name, fn) => {
        const li = addSelfTestRow(name, 'run');
        const t0 = Date.now();
        try {
            const detail = (await fn()) ?? '';
            const ms = Date.now() - t0;
            updateSelfTestRow(li, name, 'pass', `${detail}${detail ? ' ' : ''}(${ms}ms)`);
            steps.push({ name, ok: true, detail, ms });
        } catch (error) {
            const ms = Date.now() - t0;
            updateSelfTestRow(li, name, 'fail', `${error.message} (${ms}ms)`);
            steps.push({ name, ok: false, error: error.message, ms });
            throw error;
        }
    };

    try {
        await netServer.start();
        await netClient.start();

        let serverStream = null;
        let serverSawEnd = false;

        netServer.listen(SERVER_PORT, (stream) => {
            serverStream = stream;
            stream.on('data', (chunk) => {
                void stream.send(chunk);
            });
            stream.on('end', () => {
                serverSawEnd = true;
                // Half-Close 中（CLOSE_WAIT）にさよならメッセージを送信してから閉じる
                void stream.send('HALF_CLOSE_OK').then(() => stream.end());
            });
        });

        // 1. エントランス探索 + bootstrap
        await runStep('1. エントランス探索 & bootstrap() による実 WebRTC リンク確立', async () => {
            const searcher = {
                search: async () => [netServer.localNodeId],
            };
            const res = await netClient.bootstrap(searcher, { maxRetries: 3, initialBackoffMs: 200 });
            if (!res.connected.includes(netServer.localNodeId)) {
                throw new Error('bootstrap がサーバーノードへ接続できませんでした');
            }
            return `peer=${netServer.localNodeId.slice(0, 8)}…`;
        });

        // 2. 仮想 TCP 接続（ランダム ISN & ESTABLISHED）
        let client = null;
        await runStep('2. 仮想 TCP 3 ウェイハンドシェイク & ランダム ISN', async () => {
            client = await netClient.connect(netServer.localNodeId, SERVER_PORT);
            if (client.state !== 'ESTABLISHED') {
                throw new Error(`unexpected state: ${client.state}`);
            }
            return `ISN=${client.initialSendSeqNum}`;
        });

        // 3. テキスト往復 + 部分読み取り (readExact)
        await runStep('3. 双方向データ送受信 & 部分読み取り (readExact)', async () => {
            const msg = 'Hello Real Browser WebRTC!';
            const readPromise = client.readExact(encoder.encode(msg).byteLength);
            await client.send(msg);
            const echoed = decoder.decode(await readPromise);
            if (echoed !== msg) {
                throw new Error(`mismatch: got "${echoed}"`);
            }
            return `${echoed.length} B`;
        });

        // 4. 96 KiB (> 60 KiB) 自動分割・再結合
        await runStep('4. 96 KiB (> 60 KiB) 自動分割・再結合 & 動的 RTO/cwnd', async () => {
            const size = 96 * 1024 + 77;
            const pattern = makePatternBytes(size);
            const readPromise = client.readExact(size);
            await client.send(pattern);
            const echoed = await readPromise;
            if (!bytesEqual(echoed, pattern)) {
                throw new Error('96 KiB バイト列が一致しませんでした');
            }
            const s = client.getStats();
            return `${size} B OK, RTO=${s.rtoMs}ms, cwnd=${Math.round(s.cwndBytes / 1024)}KiB`;
        });

        // 5. Half-Close（CLOSE_WAIT での応答受信 -> 双方 CLOSED）
        await runStep('5. Half-Close (end -> CLOSE_WAIT 応答受信 -> CLOSED)', async () => {
            const farewellPromise = client.readExact('HALF_CLOSE_OK'.length);
            const closedPromise = new Promise((resolve) => client.once('close', resolve));
            client.end();
            const farewell = decoder.decode(await farewellPromise);
            if (farewell !== 'HALF_CLOSE_OK') {
                throw new Error(`unexpected farewell: "${farewell}"`);
            }
            await closedPromise;
            if (!serverSawEnd || !serverStream) {
                throw new Error('server did not observe EOF');
            }
            return 'CLOSE_WAIT -> LAST_ACK -> CLOSED';
        });

        const totalMs = Date.now() - startedAt;
        setStatus(els.selftestStatus, `全 ${steps.length} 項目 PASS (${totalMs} ms)`, 'ok');
        document.documentElement.dataset.selftest = 'pass';
        window.__WEBTCP_SELFTEST__ = { ok: true, steps, durationMs: totalMs };
    } catch (error) {
        const totalMs = Date.now() - startedAt;
        setStatus(els.selftestStatus, `FAIL: ${error.message} (${totalMs} ms)`, 'err');
        document.documentElement.dataset.selftest = 'fail';
        window.__WEBTCP_SELFTEST__ = { ok: false, error: error.message, steps, durationMs: totalMs };
    } finally {
        netClient.close();
        netServer.close();
        sigClient.close();
        sigServer.close();
        els.selftestBtn.disabled = false;
    }
}

// =========================================================================
// 2 タブ自動検証モード（?role=server&autostart=1 / ?role=client&autostart=1）
// =========================================================================

async function runAutoTwoTabClient() {
    setStatus(els.clientStatus, '2 タブ自動検証を実行中...', 'warn');
    log(els.clientLog, '[auto-2tab] サーバータブを探索して接続します...');
    const startedAt = Date.now();
    try {
        const targetParam = params.get('target');
        const searcher = targetParam
            ? { search: async () => [targetParam] }
            : new EntranceSearcherAdapterHub({
                  url: location.origin,
                  exclude: network.localNodeId,
              });
        const boot = await network.bootstrap(searcher, {
            targetConnections: 1,
            maxRetries: 15,
            initialBackoffMs: 250,
            maxBackoffMs: 1000,
        });
        if (boot.connected.length === 0) {
            throw new Error('サーバータブが見つかりませんでした');
        }
        const serverId = boot.connected[0];
        log(els.clientLog, `[auto-2tab] サーバー検出・リンク確立: ${serverId}`);

        const stream = await network.connect(serverId, SERVER_PORT);
        log(els.clientLog, `[auto-2tab] 仮想 TCP 確立 (ISN=${stream.initialSendSeqNum})`);

        // 1. テキスト往復
        const textExpect = encoder.encode('echo:hello-2tab');
        const textPromise = stream.readExact(textExpect.byteLength);
        await stream.send('hello-2tab');
        const textActual = decoder.decode(await textPromise);
        if (textActual !== 'echo:hello-2tab') {
            throw new Error(`テキスト応答不一致: ${textActual}`);
        }
        log(els.clientLog, `[auto-2tab] テキスト往復 PASS: ${textActual}`);

        // 2. 80 KiB (> 60 KiB) 自動分割・再結合
        const pattern = makePatternBytes(LARGE_TEST_BYTES);
        const frame = new Uint8Array(8 + pattern.byteLength);
        frame.set(encoder.encode('BIG!'), 0);
        new DataView(frame.buffer).setUint32(4, pattern.byteLength, false);
        frame.set(pattern, 8);
        const largePromise = stream.readExact(pattern.byteLength);
        await stream.send(frame);
        const largeActual = await largePromise;
        if (!bytesEqual(largeActual, pattern)) {
            throw new Error('80 KiB 大容量データ不一致');
        }
        log(els.clientLog, `[auto-2tab] 80 KiB 大容量往復 PASS`);

        // 3. Half-Close & クローズ
        const closedPromise = new Promise((resolve) => stream.once('close', resolve));
        stream.end();
        await closedPromise;

        const durationMs = Date.now() - startedAt;
        setStatus(els.clientStatus, `2 タブ自動検証 PASS (${durationMs} ms)`, 'ok');
        log(els.clientLog, `[auto-2tab] 全項目 PASS (${durationMs} ms)`);
        document.documentElement.dataset.twotab = 'pass';
        window.__WEBTCP_TWOTAB__ = { ok: true, serverId, durationMs };
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        setStatus(els.clientStatus, `2 タブ自動検証 FAIL: ${error.message}`, 'err');
        log(els.clientLog, `[auto-2tab] FAIL: ${error.message}`);
        document.documentElement.dataset.twotab = 'fail';
        window.__WEBTCP_TWOTAB__ = { ok: false, error: error.message, durationMs };
    }
}

async function main() {
    if (params.get('stun') === '1') {
        els.icePresetSelect.value = 'stun';
    }

    els.icePresetSelect.addEventListener('change', () => {
        els.iceCustomWrap.style.display = els.icePresetSelect.value === 'custom' ? 'block' : 'none';
    });
    els.applyIceBtn.addEventListener('click', () => void initNetwork());
    els.logLevelSelect.addEventListener('change', () => {
        currentLogger.setLevel(els.logLevelSelect.value);
    });

    els.listenBtn.addEventListener('click', onListen);
    els.openClientTabBtn.addEventListener('click', () => {
        onListen();
        const target = network ? `&target=${encodeURIComponent(network.localNodeId)}` : '';
        window.open(`./?role=client&autostart=1${target}`, '_blank');
    });
    els.discoverBtn.addEventListener('click', onDiscover);
    els.bootstrapBtn.addEventListener('click', onBootstrap);
    els.connectBtn.addEventListener('click', onConnect);
    els.disconnectBtn.addEventListener('click', onDisconnect);
    els.sendBtn.addEventListener('click', onSend);
    els.sendLargeBtn.addEventListener('click', onSendLarge);
    els.selftestBtn.addEventListener('click', runSelfTest);
    els.messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void onSend();
    });

    const ok = await initNetwork();
    if (!ok) return;

    if (params.get('selftest') === '1') {
        await runSelfTest();
    } else if (params.get('role') === 'server' && params.get('autostart') === '1') {
        onListen();
    } else if (params.get('role') === 'client' && params.get('autostart') === '1') {
        await runAutoTwoTabClient();
    }
}

window.addEventListener('beforeunload', () => {
    stopStatsPolling();
    network?.close();
    signaling?.close();
});

void main();
