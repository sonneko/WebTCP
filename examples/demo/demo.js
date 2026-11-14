/**
 * WebTCP 最小デモのクライアントサイド。
 *
 * `webtcp_jslib` をビルドした ESM をそのまま import している（バンドラ不要）。
 * 事前に `npm run build`（webtcp_jslib）を実行しておくこと。
 */
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '../../webtcp_jslib/dist/index.js';

const SERVER_PORT = 8080;
const decoder = new TextDecoder();

const els = {
    nodeId: document.getElementById('node-id'),
    listenBtn: document.getElementById('listen-btn'),
    listenStatus: document.getElementById('listen-status'),
    serverLog: document.getElementById('server-log'),
    discoverBtn: document.getElementById('discover-btn'),
    peerSelect: document.getElementById('peer-select'),
    connectBtn: document.getElementById('connect-btn'),
    clientStatus: document.getElementById('client-status'),
    clientLog: document.getElementById('client-log'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
};

let network = null;
let clientStream = null;
let listening = false;

function log(element, message) {
    const timestamp = new Date().toLocaleTimeString();
    element.textContent += `[${timestamp}] ${message}\n`;
    element.scrollTop = element.scrollHeight;
}

function setStatus(element, text, kind = '') {
    element.textContent = text;
    element.className = `status ${kind}`.trim();
}

async function main() {
    const signaling = new SignalingAdapterHub({
        url: location.origin,
        pollIntervalMs: 400,
    });

    network = createBrowserNetwork({
        signaling,
        // 同一ホスト・同一LANのデモなので STUN/TURN は不要。
        // インターネット越しに試す場合は iceServers を指定する。
        iceServers: [],
    });

    try {
        await network.start();
    } catch (error) {
        console.error(error);
        setStatus(els.listenStatus, 'シグナリングに接続できません', 'err');
        log(els.serverLog, `起動失敗: ${error.message}`);
        return;
    }

    els.nodeId.textContent = network.localNodeId;

    els.listenBtn.addEventListener('click', onListen);
    els.discoverBtn.addEventListener('click', onDiscover);
    els.connectBtn.addEventListener('click', onConnect);
    els.sendBtn.addEventListener('click', onSend);
    els.messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') onSend();
    });
}

function onListen() {
    if (listening) return;

    try {
        network.listen(SERVER_PORT, (stream) => {
            log(els.serverLog, `接続を受け付けました (remote=${stream.remoteNodeId.slice(0, 8)}…)`);

            stream.on('data', (data) => {
                const text = decoder.decode(data);
                log(els.serverLog, `受信: ${text}`);
                void stream
                    .send(`echo:${text}`)
                    .catch((error) => log(els.serverLog, `送信失敗: ${error.message}`));
            });

            stream.on('close', () => log(els.serverLog, '接続が閉じられました'));
            stream.on('error', (error) => log(els.serverLog, `エラー: ${error.message}`));
        });

        listening = true;
        els.listenBtn.disabled = true;
        setStatus(els.listenStatus, `待ち受け中 (port ${SERVER_PORT})`, 'ok');
    } catch (error) {
        log(els.serverLog, `待ち受け開始に失敗: ${error.message}`);
    }
}

async function onDiscover() {
    setStatus(els.clientStatus, '接続先を検索中...');
    try {
        const searcher = new EntranceSearcherAdapterHub({
            url: location.origin,
            path: `/entrances?exclude=${encodeURIComponent(network.localNodeId)}`,
        });
        const nodes = await searcher.search();

        els.peerSelect.innerHTML = '';
        if (nodes.length === 0) {
            const option = document.createElement('option');
            option.textContent = '（他のタブが見つかりません）';
            option.value = '';
            els.peerSelect.append(option);
            setStatus(els.clientStatus, '接続先が見つかりません');
            return;
        }

        for (const nodeId of nodes) {
            const option = document.createElement('option');
            option.value = nodeId;
            option.textContent = `${nodeId.slice(0, 10)}…`;
            els.peerSelect.append(option);
        }
        setStatus(els.clientStatus, `${nodes.length} 件見つかりました`, 'ok');
    } catch (error) {
        setStatus(els.clientStatus, '検索に失敗しました', 'err');
        log(els.clientLog, `検索失敗: ${error.message}`);
    }
}

async function onConnect() {
    const targetId = els.peerSelect.value;
    if (!targetId) {
        log(els.clientLog, '接続先を選択してください');
        return;
    }

    els.connectBtn.disabled = true;
    setStatus(els.clientStatus, '接続中...');

    try {
        clientStream = await network.connect(targetId, SERVER_PORT);
        setStatus(els.clientStatus, '接続済み (ESTABLISHED)', 'ok');
        log(els.clientLog, `仮想TCPセッションを確立しました (remote=${targetId.slice(0, 8)}…)`);

        clientStream.on('data', (data) => {
            log(els.clientLog, `受信: ${decoder.decode(data)}`);
        });
        clientStream.on('close', () => {
            setStatus(els.clientStatus, '切断されました');
            setConnectedUi(false);
        });
        clientStream.on('error', (error) => {
            log(els.clientLog, `エラー: ${error.message}`);
        });

        setConnectedUi(true);
    } catch (error) {
        setStatus(els.clientStatus, '接続に失敗しました', 'err');
        log(els.clientLog, `接続失敗: ${error.message}`);
    } finally {
        els.connectBtn.disabled = false;
    }
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

function setConnectedUi(connected) {
    els.messageInput.disabled = !connected;
    els.sendBtn.disabled = !connected;
    els.connectBtn.disabled = connected;
    els.messageInput.focus();
}

window.addEventListener('beforeunload', () => {
    network?.close();
});

main();
