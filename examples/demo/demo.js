/**
 * WebTCP M4 デモのクライアントサイド。
 *
 * `webtcp_jslib` をビルドした ESM をそのまま import している（バンドラ不要）。
 * 事前に `npm run build`（webtcp_jslib）を実行しておくこと。
 *
 * 既定で Ed25519 署名（プロトコル v2 / #28）が有効になる。
 * M4 では NameServer（A/CNAME）と webtcp:// URL 接続のデモを含む。
 * 秘密鍵は IndexedDB に非抽出 CryptoKey として保存され、NodeId は公開鍵の指紋になる。
 * Web Crypto の Ed25519 が使えないブラウザでは自動的に v1（署名なし）へフォールバックする。
 *
 * クエリパラメータ:
 * - `?stun=1`: パブリック STUN サーバー例（EXAMPLE_STUN_ICE_SERVERS）を有効化
 * - `?insecure=1`: Ed25519 署名を無効化して v1 で動作（比較・デバッグ用）
 * - `?e2e=1`: テスト用の一時データベース名を使う（Playwright のタブ間で同一鍵を共有しない）
 * - `?selftest=1`: 起動時に同一タブ内の実 WebRTC 2 ピア自己チェックを自動実行
 * - `?role=server&autostart=1`: サーバーとしてポート 8080 で自動待ち受け
 * - `?role=client&autostart=1`: クライアントとして自動探索・接続・検証を実行
 * - `?static=1`: デモサーバーが無い環境（GitHub Pages など）の動作を強制する（検証用）
 *
 * デモサーバー（`examples/server.mjs`）が無ければ静的モードで動く。静的モードでは
 * シグナリングを同一ページ内のメモリ（自己チェック）か BroadcastChannel（タブ間）で行い、
 * `/domain/*` に依存する検査は省略する。詳細は `design.md` §3.33。
 */
import {
    EXAMPLE_STUN_ICE_SERVERS,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    SseSignalingAdapter,
    WebSocketSignalingAdapter,
    BrowserKeyManager,
    KeyDirectory,
    createBrowserNetwork,
    commitDomainRecord,
    createDomainAuthority,
    createDomainOwnershipRecord,
    createHttpDomainRegistryClient,
    createLogger,
    deriveNodeId,
    NameServer,
    parseWebTCPUrl,
    IndexedDBServiceStateStorage,
} from '../../webtcp_jslib/dist/index.js';
import {
    createBroadcastEntranceSearcher,
    createBroadcastSignaling,
    createMemorySignalingBus,
    randomNodeId,
} from './local-signaling.js';

/** 静的モードで 2 タブが使う BroadcastChannel の名前。 */
const TWO_TAB_CHANNEL = 'webtcp-demo-2tab';

/** 自己チェックのうち、デモサーバーが必要で省略された項目（失敗ではない）。 */
class SkipError extends Error {}

const SERVER_PORT = 8080;
/** M6 の HTTP サービスポート（`serveHTTP`）。生 TCP の 8080 とは別ポートにしている。 */
const DEMO_HTTP_PORT = 8081;
const DEMO_SERVICE_NAME = 'demo-service';
const DEMO_ALIAS_NAME = 'demo-alias';
/** M5 のデモドメイン（`<prefix>-<nodeId 先頭 8 桁>.domain.global`）。 */
const DEMO_DOMAIN_PREFIX = 'webtcp-demo';
const LARGE_TEST_BYTES = 80 * 1024 + 123; // > 60 KiB
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const params = new URLSearchParams(location.search);

const els = {
    nodeId: document.getElementById('node-id'),
    identity: document.getElementById('identity-status'),
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
    urlInput: document.getElementById('url-input'),
    connectUrlBtn: document.getElementById('connect-url-btn'),
    resolveNameBtn: document.getElementById('resolve-name-btn'),
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
    domainInput: document.getElementById('domain-input'),
    domainRegisterBtn: document.getElementById('domain-register-btn'),
    domainResolveBtn: document.getElementById('domain-resolve-btn'),
    domainStatus: document.getElementById('domain-status'),
    domainLog: document.getElementById('domain-log'),
};

let network = null;
let nameServer = null;
/** M5: 参照レジストリ（`examples/server.mjs` の `/domain/*`）へのクライアントと権威。 */
let domainAuthority = null;
let domainRegistryClient = null;
let domainRegistryPinned = false;
let signaling = null;
let clientStream = null;
let listening = false;
let statsTimer = null;
let currentLogger = createLogger({ level: 'warn' });
/** 保存済みの Ed25519 鍵管理（タブ内で使い回す）。 */
let identity = null;
/** Ed25519 の利用可否（初回判定後にキャッシュ）。 */
let identityLoadPromise = null;

const SIGNED = params.get('insecure') !== '1';
/** デモサーバーが応答するか（`main()` で判定）。false なら静的モード。 */
let serverMode = true;

/**
 * Ed25519 鍵管理を読み込む（IndexedDB から復元、無ければ生成）。
 * 利用できないブラウザでは null を返し、v1 へフォールバックする。
 */
function loadIdentity() {
    if (!identityLoadPromise) {
        identityLoadPromise = (async () => {
            if (!SIGNED) return null;
            // Playwright の全タブが同一オリジン（同一 IndexedDB）を共有するため、
            // E2E モードではタブごとに別の DB 名を使い、独立した鍵指紋を持たせる
            const databaseName =
                params.get('e2e') === '1'
                    ? `webtcp-keys-e2e-${Math.random().toString(16).slice(2)}`
                    : 'webtcp-keys';
            try {
                identity = await BrowserKeyManager.open({
                    databaseName,
                    logger: currentLogger,
                });
                return identity;
            } catch (error) {
                currentLogger.warn('Ed25519 unavailable; falling back to unsigned v1:', error);
                return null;
            }
        })();
    }
    return identityLoadPromise;
}

/** 同一オリジンのデモサーバーの有無を調べる。無ければ静的モード（GitHub Pages など）。 */
async function probeDemoServer() {
    if (params.get('static') === '1') return false;
    try {
        const response = await fetch(`${location.origin}/domain/log`, { cache: 'no-store' });
        if (!response.ok) return false;
        const info = await response.json();
        return typeof info?.logId === 'string';
    } catch {
        return false;
    }
}

/** 静的モードの表示（ヘッダーのバナー）。 */
function renderModeBanner() {
    const banner = document.getElementById('mode-banner');
    if (!banner) return;
    banner.textContent = serverMode
        ? 'ローカルデモサーバーに接続中：シグナリング・台帳・すべての自己チェックが使えます。'
        : '公開版（静的）：サーバー不要の機能だけが動きます。シグナリングサーバーと台帳はローカル（node examples/server.mjs）で使えます。';
    if (serverMode) {
        banner.textContent += `（シグナリング: ${SIGNALING_TRANSPORT}）`;
    }
    banner.className = `status ${serverMode ? 'ok' : 'warn'}`;
}

/** シグナリングアダプタ。サーバーモードは HTTP ハブ、静的モードは BroadcastChannel。 */
/**
 * デモサーバーのシグナリング経路（`?signaling=poll|sse|ws`、既定 poll）。
 * 既定はポーリング（`SignalingAdapterHub`）。SSE / WebSocket は仕様 §10.4.1 の押し込み型。
 */
const SIGNALING_TRANSPORT = ['poll', 'sse', 'ws'].includes(params.get('signaling') ?? '')
    ? params.get('signaling')
    : 'poll';

function createHubSignaling({ keys, logger, pollIntervalMs }) {
    const nodeOptions = keys ? { nodeId: keys.nodeId } : {};
    if (SIGNALING_TRANSPORT === 'sse') {
        return new SseSignalingAdapter({ url: location.origin, logger, ...nodeOptions });
    }
    if (SIGNALING_TRANSPORT === 'ws') {
        return new WebSocketSignalingAdapter({ url: location.origin, logger, ...nodeOptions });
    }
    return new SignalingAdapterHub({ url: location.origin, pollIntervalMs, logger, ...nodeOptions });
}

function createSignaling({ keys, logger, pollIntervalMs = 250 }) {
    if (serverMode) {
        return createHubSignaling({ keys, logger, pollIntervalMs });
    }
    return createBroadcastSignaling({
        nodeId: keys?.nodeId ?? randomNodeId(),
        channelName: TWO_TAB_CHANNEL,
        logger,
    });
}

/** ピア探索。サーバーモードは `/entrances`、静的モードは BroadcastChannel の問い合わせ。 */
function createEntranceSearcher(exclude) {
    if (serverMode) {
        return new EntranceSearcherAdapterHub({ url: location.origin, exclude });
    }
    return createBroadcastEntranceSearcher({ channelName: TWO_TAB_CHANNEL, exclude });
}

/** 静的モードでデモサーバーが必要な操作を止め、理由を表示する。 */
function requireDemoServer(element) {
    if (serverMode) return true;
    setStatus(element, 'ローカルデモサーバーが必要です（node examples/server.mjs）', 'warn');
    return false;
}

/**
 * ICE 候補の事前診断（#73）。ブラウザが候補を 1 つも出せないと、同一ページ内の接続も確立しない。
 * 既定の `iceServers` で `RTCPeerConnection` を 1 つ作り、候補の型（host は mDNS か IP か）を数える。
 */
async function probeIceCandidates(iceServers, timeoutMs = 5000) {
    const started = performance.now();
    const pc = new RTCPeerConnection({ iceServers });
    const candidates = [];
    try {
        pc.createDataChannel('webtcp-ice-probe');
        const gathered = new Promise((resolve) => {
            pc.onicecandidate = (event) => {
                if (event.candidate) candidates.push(event.candidate.candidate);
                else resolve(true);
            };
        });
        await pc.setLocalDescription(await pc.createOffer());
        const completed = await Promise.race([gathered, new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
        return summarizeIceCandidates(candidates, {
            gatheringState: pc.iceGatheringState,
            gatheringCompleted: completed,
            ms: Math.round(performance.now() - started),
        });
    } finally {
        pc.close();
    }
}

/** 候補の文字列から型の内訳を作る。 */
function summarizeIceCandidates(lines, extra = {}) {
    const counts = { hostMdns: 0, hostIp: 0, srflx: 0, relay: 0, other: 0 };
    for (const line of lines) {
        const type = /typ (\w+)/.exec(line)?.[1] ?? 'other';
        if (type === 'host') {
            const address = line.split(/\s+/)[4] ?? '';
            if (address.endsWith('.local')) counts.hostMdns += 1;
            else counts.hostIp += 1;
        } else if (type === 'srflx') counts.srflx += 1;
        else if (type === 'relay') counts.relay += 1;
        else counts.other += 1;
    }
    return { total: lines.length, ...counts, ...extra };
}

/** 診断の 1 行表示。 */
function describeIceProbe(probe) {
    return `host(mdns)=${probe.hostMdns} host(ip)=${probe.hostIp} srflx=${probe.srflx} relay=${probe.relay} 状態=${probe.gatheringState}（${probe.ms} ms）`;
}

/** 候補ゼロのときの利用者向けの説明。 */
const ICE_BLOCKED_MESSAGE =
    'WebRTC の ICE 候補を 1 つも得られませんでした。ブラウザの WebRTC 設定（IP 処理の制限）、VPN、企業ネットワーク・ファイアウォールが UDP を遮断している可能性があります。対処: 別のネットワークやブラウザで試す、またはローカルで `node examples/server.mjs` を起動して http://localhost:8787/examples/demo/?selftest=1 を開く。';

function describeIdentity(keys) {
    if (!keys) {
        return 'Ed25519: 無効（v1 署名なしモード）';
    }
    return `Ed25519: 有効（プロトコル v2・署名必須 / 公開鍵 ${keys.nodeId.slice(0, 8)}…）`;
}

/** M5: ノードごとに一意なデモドメイン名（LDH ラベル + `domain.global`）。 */
function demoDomainName(nodeId, label) {
    const cleaned = String(label ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    const base = cleaned.length > 0 ? cleaned : DEMO_DOMAIN_PREFIX;
    return cleaned.includes('.') ? cleaned : `${base}-${nodeId.slice(0, 8)}.domain.global`;
}

/**
 * 参照レジストリへ接続し、`domain.global` 権威を作る（specification.md §14.5 / §14.6）。
 *
 * ログ鍵は起動のたびに `GET /domain/log` から得る（TOFU ピン留め）。取得できない場合は
 * アンカー検証なしの権威にする（その場合でも所有者署名と有効期間は必ず検証される）。
 */
async function createDomainRegistryAuthority(logger) {
    if (!serverMode) {
        // 静的モード: 台帳は無いので、所有者署名の検証だけで解決する（ネットワークへ問い合わせない）
        domainRegistryClient = null;
        domainRegistryPinned = false;
        return createDomainAuthority({ sources: [], verifierOptions: { requireAnchor: false, logger }, logger });
    }
    const client = createHttpDomainRegistryClient({ baseUrl: location.origin, logger, timeoutMs: 6000 });
    const options = { sources: [client], logger };
    try {
        const response = await fetch(`${location.origin}/domain/log`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const info = await response.json();
        if (typeof info?.logId !== 'string' || typeof info.publicKey !== 'string') {
            throw new Error('the registry did not publish a log key');
        }
        options.verifierOptions = {
            requireAnchor: true,
            logKeys: { [info.logId]: info.publicKey },
            logger,
        };
        options.checkpointChain = client;
        domainRegistryPinned = true;
        logDomain(`台帳に接続しました（logId ${info.logId.slice(0, 8)}… / チェックポイント検証は必須）`);
    } catch (error) {
        domainRegistryPinned = false;
        options.verifierOptions = { requireAnchor: false, logger };
        logger.warn('domain registry unavailable; resolving without ledger anchors:', error);
        logDomain(`台帳に接続できません（${error.message}）。所有者署名の検証だけで進めます`);
    }
    domainRegistryClient = client;
    return createDomainAuthority(options);
}

/** `domain.global` パネルのログ（パネルが無いときはサーバーログへ流す）。 */
function logDomain(message) {
    const target = els.domainLog ?? els.serverLog;
    if (target) log(target, message);
}

/** 入力欄から解決対象の完全名を作る（`.` を含めばそのまま、無ければノード固有名）。 */
function requestedDomain(nodeId) {
    const raw = (els.domainInput?.value ?? '').trim().toLowerCase();
    return raw.includes('.') ? raw : demoDomainName(nodeId, raw);
}

async function onDomainRegister() {
    if (!requireDemoServer(els.domainStatus)) return;
    if (!network || !nameServer) {
        setStatus(els.domainStatus, '先にネットワークを起動してください', 'err');
        return;
    }
    await loadIdentity();
    if (!identity) {
        setStatus(els.domainStatus, 'Ed25519 鍵が無いため所有権レコードを署名できません', 'err');
        return;
    }
    els.domainRegisterBtn.disabled = true;
    setStatus(els.domainStatus, '登録中...', 'warn');
    try {
        const domain = requestedDomain(network.localNodeId);
        const existing = domainRegistryClient
            ? await domainRegistryClient.lookupByDomain(domain).catch(() => [])
            : [];
        const serial = existing.reduce((max, entry) => Math.max(max, entry.body.serial), 0) + 1;
        const record = await createDomainOwnershipRecord({
            domain,
            keyManager: identity,
            serial,
            port: SERVER_PORT,
            txt: 'webtcp browser demo',
            lifetimeMs: 24 * 60 * 60 * 1000,
        });
        logDomain(`${domain} のレコードを署名しました（serial ${serial}）`);
        let anchored = record;
        if (domainRegistryClient) {
            const submitted = await domainRegistryClient.submit(record);
            if (!submitted.accepted) {
                throw new Error(`台帳が拒否しました: ${submitted.error ?? 'unknown'}`);
            }
            if (submitted.anchor) anchored = { ...record, anchor: submitted.anchor };
            logDomain(`台帳leaf=${submitted.leafIndex} / treeSize=${submitted.treeSize}`);
        }
        const resolution = await nameServer.registerDomain(anchored);
        if (!resolution.ok) throw new Error(`検証に失敗しました: ${resolution.code} ${resolution.message ?? ''}`);
        const commitment = await commitDomainRecord(anchored.body);
        logDomain(`commitment ${commitment.slice(0, 16)}… / 所有権付きで ${domain} を提供中`);
        setStatus(els.domainStatus, `${domain} を登録しました`, 'ok');
    } catch (error) {
        logDomain(`登録失敗: ${error.message}`);
        setStatus(els.domainStatus, '登録に失敗しました', 'err');
    } finally {
        els.domainRegisterBtn.disabled = false;
    }
}

async function onDomainResolve() {
    if (!requireDemoServer(els.domainStatus)) return;
    if (!network || !nameServer) {
        setStatus(els.domainStatus, '先にネットワークを起動してください', 'err');
        return;
    }
    els.domainResolveBtn.disabled = true;
    setStatus(els.domainStatus, '解決中...', 'warn');
    try {
        const domain = requestedDomain(network.localNodeId);
        const resolution = await nameServer.resolve(domain);
        const proof = resolution.proof ?? {};
        logDomain(
            `解決: ${domain} -> ${resolution.nodeId.slice(0, 8)}… (source=${resolution.source}, serial=${
                resolution.record?.body.serial
            }, anchor=${proof.anchorVerified ? 'verified' : 'none'}, chain=${
                proof.chainVerified === true ? 'verified' : proof.chainVerified === false ? 'failed' : 'unchecked'
            })`,
        );
        els.urlInput.value = `webtcp://${domain}:${SERVER_PORT}/`;
        setStatus(els.domainStatus, `${domain} を検証付きで解決しました`, 'ok');
    } catch (error) {
        logDomain(`解決失敗: ${error.name}: ${error.message}`);
        setStatus(els.domainStatus, '解決に失敗しました（fail-closed）', 'err');
    } finally {
        els.domainResolveBtn.disabled = false;
    }
}

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
    if (nameServer) {
        nameServer.close();
        nameServer = null;
    }
    if (domainAuthority) {
        domainAuthority.close();
        domainAuthority = null;
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
        const keys = await loadIdentity();

        signaling = createSignaling({ keys, logger: currentLogger });

        network = createBrowserNetwork({
            signaling,
            iceServers,
            logger: currentLogger,
            ...(keys ? { keyManager: keys } : {}),
        });

        await network.start();
        domainAuthority = await createDomainRegistryAuthority(currentLogger);
        nameServer = new NameServer(network, { logger: currentLogger, domains: domainAuthority });
        nameServer.listen();
        els.nodeId.textContent = network.localNodeId;
        if (els.identity) {
            els.identity.textContent = describeIdentity(keys);
            els.identity.className = `status ${keys ? 'ok' : 'warn'}`;
        }
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

        if (nameServer) {
            nameServer.registerA(DEMO_SERVICE_NAME, network.localNodeId);
            nameServer.registerCNAME(DEMO_ALIAS_NAME, DEMO_SERVICE_NAME);
            log(els.serverLog, `NameServer 登録: ${DEMO_SERVICE_NAME} A -> ${network.localNodeId.slice(0, 8)}… / ${DEMO_ALIAS_NAME} CNAME -> ${DEMO_SERVICE_NAME}`);
        }
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
        const searcher = createEntranceSearcher(network.localNodeId);
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
        const searcher = createEntranceSearcher(network.localNodeId);
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
        attachClientStream(clientStream, `remote=${targetId.slice(0, 8)}…`);
    } catch (error) {
        setStatus(els.clientStatus, '接続に失敗しました', 'err');
        log(els.clientLog, `接続失敗: ${error.message}`);
    } finally {
        if (!connected) {
            els.connectBtn.disabled = false;
        }
    }
}

function attachClientStream(stream, label) {
    setStatus(els.clientStatus, '接続済み (ESTABLISHED)', 'ok');
    log(els.clientLog, `仮想TCPセッション確立 (${label}, ISN=${stream.initialSendSeqNum})`);
    stream.on('data', (data) => {
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

    stream.on('end', () => {
        log(els.clientLog, '相手から EOF (FIN) を受信しました');
    });

    stream.on('close', () => {
        setStatus(els.clientStatus, '切断されました');
        setConnectedUi(false);
        stopStatsPolling();
        clientStream = null;
    });

    stream.on('error', (error) => {
        log(els.clientLog, `エラー: ${error.message}`);
    });

    setConnectedUi(true);
    startStatsPolling();
}

async function onConnectURL() {
    if (!network || !nameServer) return;
    const url = els.urlInput.value.trim();
    try {
        const parsed = parseWebTCPUrl(url);
        if (clientStream) {
            clientStream.destroy();
            clientStream = null;
        }
        els.connectUrlBtn.disabled = true;
        setStatus(els.clientStatus, `URL 接続中: ${parsed.host}:${parsed.port}`);
        const stream = await network.connectURL(url, { nameServer });
        clientStream = stream;
        attachClientStream(stream, `url=${parsed.host}:${parsed.port}${parsed.path}`);
        log(els.clientLog, `webtcp:// 接続成功 (path=${parsed.path}, search=${parsed.search || '-'}, hash=${parsed.hash || '-'})`);
    } catch (error) {
        setStatus(els.clientStatus, 'URL 接続に失敗しました', 'err');
        log(els.clientLog, `URL 接続失敗: ${error.message}`);
    } finally {
        els.connectUrlBtn.disabled = false;
    }
}

async function onResolveName() {
    if (!nameServer) return;
    const url = els.urlInput.value.trim();
    try {
        const parsed = parseWebTCPUrl(url);
        const name = parsed.name ?? parsed.host;
        const result = await nameServer.resolve(name);
        log(els.clientLog, `名前解決: ${name} -> ${result.nodeId} (source=${result.source}, ttl=${result.ttlMs}ms, chain=${result.chain.join(' -> ')})`);
        setStatus(els.clientStatus, `解決済み: ${name} -> ${result.nodeId.slice(0, 8)}…`, 'ok');
    } catch (error) {
        setStatus(els.clientStatus, '名前解決に失敗しました', 'err');
        log(els.clientLog, `名前解決失敗: ${error.message}`);
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

async function waitForCondition(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition not met within the timeout');
}

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

    // 同一タブ内で 2 つの独立した Ed25519 識別子を作る（#28）
    const makeIdentity = async () => {
        if (!SIGNED) return null;
        try {
            return await BrowserKeyManager.open({
                databaseName: `webtcp-keys-selftest-${Math.random().toString(16).slice(2)}`,
                logger,
            });
        } catch (error) {
            logger.warn('Ed25519 unavailable; self-test falls back to v1:', error);
            return null;
        }
    };
    const keysServer = await makeIdentity();
    const keysClient = await makeIdentity();
    const keyDirectory = keysServer || keysClient ? new KeyDirectory({ logger }) : null;

    const buildNetwork = (signaling, keys, extra = {}) => {
        const options = { signaling, iceServers, logger, ...extra };
        if (keys && keyDirectory) {
            return createBrowserNetwork({
                ...options,
                keyManager: keys,
                keyDirectory,
            });
        }
        return createBrowserNetwork(options);
    };

    // 静的モードは同一ページ内のメモリ上のバスで交換する（他タブへ漏れない / サーバー不要）
    const selftestBus = serverMode ? null : createMemorySignalingBus();
    const makeSignaling = (keys) =>
        selftestBus
            ? selftestBus.adapter(keys?.nodeId ?? randomNodeId())
            : createHubSignaling({ keys, logger, pollIntervalMs: 120 });
    const sigServer = makeSignaling(keysServer);
    const sigClient = makeSignaling(keysClient);
    // サービス役の状態は一時的な IndexedDB ストアへ保存する（#51 / 1f）
    const serviceStateStorage = new IndexedDBServiceStateStorage({
        databaseName: `webtcp-service-selftest-${Math.random().toString(16).slice(2)}`,
    });
    const netServer = buildNetwork(sigServer, keysServer, { stateStorage: serviceStateStorage });
    const netClient = buildNetwork(sigClient, keysClient);

    const runStep = async (name, fn) => {
        const li = addSelfTestRow(name, 'run');
        const t0 = Date.now();
        try {
            const detail = (await fn()) ?? '';
            const ms = Date.now() - t0;
            updateSelfTestRow(li, name, 'pass', `${detail}${detail ? ' ' : ''}(${ms}ms)`);
            steps.push({ name, ok: true, detail, ms });
        } catch (error) {
            if (error instanceof SkipError) {
                updateSelfTestRow(li, name, 'skip', error.message);
                steps.push({ name, ok: true, skipped: true, detail: error.message });
                return;
            }
            const ms = Date.now() - t0;
            updateSelfTestRow(li, name, 'fail', `${error.message} (${ms}ms)`);
            steps.push({ name, ok: false, error: error.message, ms });
            throw error;
        }
    };

    // `finally` からも参照するため、`try` の外で宣言する（ブロックスコープ）
    const httpServers = [];
    // 後始末（finally）から参照するため try の外で宣言する（#70）
    let nsServer = null;
    let nsClient = null;

    try {
        // 0. ICE 候補の事前診断（#73）。候補が無ければ以降の接続は確立しないため、ここで止めて理由を示す
        let iceProbe = null;
        await runStep('0. WebRTC ICE 候補の収集（事前診断）', async () => {
            iceProbe = await probeIceCandidates(iceServers);
            if (iceProbe.total === 0) {
                throw new Error(`${ICE_BLOCKED_MESSAGE}（${describeIceProbe(iceProbe)}）`);
            }
            return describeIceProbe(iceProbe);
        });
        await netServer.start();
        await netClient.start();

        let serverStream = null;
        let serverSawEnd = false;
        // M5: 参照レジストリ（`/domain/*`）へ接続した `domain.global` 権威を作る。
        // サーバー側 NameServer は自分の所有権レコードをこの権威で検証してから登録し、
        // ピアからの wantOwnership 問い合わせに同じ検証付きで答える (§14.5)。
        const domainRegistry = serverMode ? createHttpDomainRegistryClient({ baseUrl: location.origin, logger }) : null;
        let domainLogInfo = null;
        let domainVerifierOptions = { requireAnchor: false, logger };
        if (serverMode) {
            try {
                const response = await fetch(`${location.origin}/domain/log`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const info = await response.json();
                if (typeof info?.logId !== 'string' || typeof info.publicKey !== 'string') {
                    throw new Error('the registry did not publish a log key');
                }
                domainLogInfo = info;
                domainVerifierOptions = { requireAnchor: true, logKeys: { [info.logId]: info.publicKey }, logger };
            } catch (error) {
                logger.warn('domain registry unavailable; the self-test will run without ledger anchors:', error);
            }
        }
        nsServer = new NameServer(netServer, {
            logger,
            ...(serverMode
                ? {
                      domains: createDomainAuthority({
                          sources: [domainRegistry],
                          verifierOptions: domainVerifierOptions,
                          logger,
                      }),
                  }
                : {}),
        });
        nsClient = new NameServer(netClient, { logger, queryTimeoutMs: 1500, resolveTimeoutMs: 4000 });
        nsServer.registerA(DEMO_SERVICE_NAME, netServer.localNodeId);
        nsServer.registerCNAME(DEMO_ALIAS_NAME, DEMO_SERVICE_NAME);
        nsServer.listen();

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
                const detail = iceProbe ? `（ICE 候補: ${describeIceProbe(iceProbe)}）` : '';
                throw new Error(`bootstrap がサーバーノードへ接続できませんでした${detail}`);
            }
            return `peer=${netServer.localNodeId.slice(0, 8)}…`;
        });

        // 1.5 Ed25519 署名と鍵指紋（#28）
        await runStep('1b. Ed25519 署名検証 & NodeId の鍵指紋一致（プロトコル v2）', async () => {
            if (!keysServer || !keysClient) {
                return 'Ed25519 非対応のためスキップ（v1）';
            }
            const derived = await deriveNodeId(keysServer.publicKey);
            if (derived !== keysServer.nodeId) {
                throw new Error('NodeId が公開鍵の指紋と一致しません');
            }
            await waitForCondition(
                () =>
                    keyDirectory.get(keysClient.nodeId) !== undefined &&
                    keyDirectory.get(keysServer.nodeId) !== undefined,
                3000,
            );
            return `fingerprint=${keysServer.nodeId.slice(0, 8)}…`;
        });

        // 1c. NameServer 名前解決（M4 / #25）
        await runStep('1c. NameServer 名前解決 (A/CNAME) と webtcp:// URL パース', async () => {
            const resolved = await nsClient.resolve(DEMO_ALIAS_NAME);
            if (resolved.nodeId !== netServer.localNodeId) {
                throw new Error(`名前解決が不一致: ${resolved.nodeId}`);
            }
            const parsed = parseWebTCPUrl(`webtcp://${DEMO_SERVICE_NAME}:${SERVER_PORT}/hello?x=1#frag`);
            if (parsed.name !== DEMO_SERVICE_NAME || parsed.port !== SERVER_PORT || parsed.path !== '/hello') {
                throw new Error('webtcp:// URL パースが不正です');
            }
            return `${DEMO_ALIAS_NAME} -> ${resolved.nodeId.slice(0, 8)}… (${resolved.source})`;
        });

        // 1d. domain.global 所有権レコード + 台帳アンカー検証（M5 / #25）
        await runStep('1d. domain.global 所有権レコードと台帳アンカー検証 (M5)', async () => {
            if (!serverMode) {
                throw new SkipError('ローカルデモサーバーが必要（台帳アンカーと偽造拒否は省略）');
            }
            if (!keysServer) {
                return 'Ed25519 非対応のためスキップ（所有権レコードは署名必須）';
            }
            const domain = `m5-${netServer.localNodeId.slice(0, 8)}-${Date.now().toString(36)}.domain.global`;
            if (!domainLogInfo) {
                throw new Error('参照レジストリがログ鍵を公開していません（`npm run build` 後にデモサーバーを起動してください）');
            }
            const registry = domainRegistry;
            const verifierOptions = domainVerifierOptions;
            const record = await createDomainOwnershipRecord({
                domain,
                keyManager: keysServer,
                serial: 1,
                port: SERVER_PORT,
                txt: 'self-test',
                lifetimeMs: 3_600_000,
            });
            // 改ざんは台帳が 400 で拒否する (§14.4 の 1〜6 をレジストリも実施)
            const forged = { ...record, body: { ...record.body, txt: 'tampered' } };
            const forgedResponse = await fetch(`${location.origin}/domain/record`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ record: forged }),
            });
            if (forgedResponse.status !== 400) {
                throw new Error(`改ざんレコードが拒否されませんでした (HTTP ${forgedResponse.status})`);
            }
            const submitted = await registry.submit(record);
            if (!submitted.accepted || !submitted.anchor) {
                throw new Error(`台帳が受理しませんでした: ${submitted.error ?? 'no anchor'}`);
            }
            const anchored = { ...record, anchor: submitted.anchor };
            const registered = await nsServer.registerDomain(anchored);
            if (!registered.ok) {
                throw new Error(`自分のレコードを登録できません: ${registered.code} ${registered.message}`);
            }

            // (a) レジストリ（台帳）を引いて解決する
            const ledgerNameServer = new NameServer(netClient, {
                logger,
                queryTimeoutMs: 1500,
                resolveTimeoutMs: 4000,
                domains: createDomainAuthority({ sources: [registry], verifierOptions, logger }),
            });
            const viaLedger = await ledgerNameServer.resolve(domain);
            ledgerNameServer.close();

            // (b) 台帳を引かず、既知ノードの wantOwnership 応答だけで解決する (§13.2 / §14.5 の (3))
            const peerNameServer = new NameServer(netClient, {
                logger,
                queryTimeoutMs: 1500,
                resolveTimeoutMs: 4000,
                domains: createDomainAuthority({ verifierOptions, logger }),
            });
            const viaPeers = await peerNameServer.resolve(domain);
            peerNameServer.close();

            for (const [label, resolved] of [['ledger', viaLedger], ['peers', viaPeers]]) {
                if (resolved.nodeId !== netServer.localNodeId) {
                    throw new Error(`${label} 経由の解決先が不一致: ${resolved.nodeId}`);
                }
                if (resolved.source !== 'domain') {
                    throw new Error(`${label} 経由の解決ソースが 'domain' ではありません: ${resolved.source}`);
                }
                if (resolved.proof?.anchorVerified !== true) {
                    throw new Error(`${label} 経由で台帳アンカーの検証が通りませんでした`);
                }
            }

            // (c) 台帳にも既知ノードにも無い名前は fail-closed で失敗する
            const missingNameServer = new NameServer(netClient, {
                logger,
                queryTimeoutMs: 1000,
                resolveTimeoutMs: 2000,
                domains: createDomainAuthority({ sources: [registry], verifierOptions, logger }),
            });
            let failure = null;
            try {
                await missingNameServer.resolve('not-in-the-ledger.domain.global');
            } catch (error) {
                failure = error;
            }
            missingNameServer.close();
            if (!failure) {
                throw new Error('未登録のドメインが解決できてしまいました（fail-closed でありません）');
            }
            // 台帳も既知ノードもその名前を知らない → 「検証できない」ではなく単なる not-found として
            // 区別できる (§14.5 の書き分け)。裏付け不足は DomainOwnershipError で返る。
            if (failure.name !== 'NameNotFoundError') {
                throw new Error(`未登録名前は NameNotFoundError で失敗すべきでした: ${failure.name}: ${failure.message}`);
            }
            const commitment = await commitDomainRecord(anchored.body);
            return `leaf=${submitted.leafIndex} treeSize=${submitted.treeSize} commitment=${commitment.slice(0, 8)}… / 台帳・既知ノードの両方で anchor=verified / 改ざんは 400 / 未登録は ${failure.name}`;
        });

        // 1e. HTTP トンネル（M6 / #50）: サーバータブが HTTP を公開し、クライアントタブが fetchURL で叩く
        await runStep('1e. HTTP トンネル: serveHTTP + fetchURL のリクエスト/レスポンス (M6)', async () => {
            const httpServer = netServer.serveHTTP(DEMO_HTTP_PORT, async (request, response) => {
                response.setHeader('content-type', 'application/json; charset=utf-8');
                await response.end(
                    JSON.stringify({
                        method: request.method,
                        path: request.path,
                        query: request.query,
                        remoteNodeIdPrefix: (request.remoteNodeId ?? '').slice(0, 8),
                    }),
                );
            });
            httpServers.push(httpServer);
            const response = await netClient.fetchURL(
                `webtcp://${DEMO_SERVICE_NAME}:${DEMO_HTTP_PORT}/api/echo?x=1#ignored`,
                { nameServer: nsClient, timeoutMs: 5000 },
            );
            const body = await response.json();
            if (response.status !== 200) {
                throw new Error(`unexpected status: ${response.status}`);
            }
            if (body.path !== '/api/echo' || body.query !== '?x=1' || body.method !== 'GET') {
                throw new Error(`request-target が往復しませんでした: ${JSON.stringify(body)}`);
            }
            if (body.remoteNodeIdPrefix !== netClient.localNodeId.slice(0, 8)) {
                throw new Error(`remoteNodeId が一致しません: ${body.remoteNodeIdPrefix}`);
            }
            return `${response.status} ${body.path}${body.query} (remote=${body.remoteNodeIdPrefix}…)`;
        });

        await runStep('1f. サービス状態の永続化 (IndexedDB) & 復元 — 再読み込み後も名前を提供 (#51)', async () => {
            await netServer.persistState({ nameServer: nsServer });
            const saved = await serviceStateStorage.load();
            if (!saved) throw new Error('保存された状態が読み込めません');
            const expectedDomains = nsServer.servedDomainRecords().length;
            if (saved.names.length < 2 || saved.domainRecords.length !== expectedDomains) {
                throw new Error(`保存内容が不足: names=${saved.names.length} domains=${saved.domainRecords.length}`);
            }
            // 再読み込み後を模擬: 新しい NameServer へ復元し、名前と所有権レコードが引けることを確認する。
            // 台帳アンカー付きのレコードは信頼するログ鍵を持つ権威でのみ検証できる（fail-closed）ため、
            // 同じ権威を渡す。権威が無いと anchor-untrusted-log で拒否される。
            const probe = new NameServer(netServer, {
                logger,
                ...(nsServer.domainAuthority ? { domains: nsServer.domainAuthority } : {}),
            });
            try {
                const restored = await probe.restoreState(saved);
                if (restored.rejected !== 0 || restored.domainRecords !== expectedDomains) {
                    throw new Error(`復元結果が不一致: ${JSON.stringify(restored)}`);
                }
                const alias = await probe.resolve(DEMO_ALIAS_NAME);
                if (alias.nodeId !== netServer.localNodeId) {
                    throw new Error(`復元後の解決先が一致しません: ${alias.nodeId}`);
                }
                return `names=${restored.names} domains=${restored.domainRecords} rejected=${restored.rejected}`;
            } finally {
                probe.close();
                await serviceStateStorage.clear();
            }
        });

        // 2. 仮想 TCP 接続（ランダム ISN & ESTABLISHED）を webtcp:// URL で確立
        let client = null;
        await runStep('2. webtcp:// URL 接続 & 仮想 TCP 3 ウェイハンドシェイク', async () => {
            client = await netClient.connectURL(`webtcp://${DEMO_SERVICE_NAME}:${SERVER_PORT}/`, { nameServer: nsClient });
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
        const skipped = steps.filter((step) => step.skipped).length;
        const passed = steps.length - skipped;
        setStatus(
            els.selftestStatus,
            `${passed} 項目 PASS${skipped ? `・${skipped} 項目は省略（デモサーバーが必要）` : ''} (${totalMs} ms)`,
            'ok',
        );
        document.documentElement.dataset.selftest = 'pass';
        window.__WEBTCP_SELFTEST__ = { ok: true, steps, durationMs: totalMs };
    } catch (error) {
        const totalMs = Date.now() - startedAt;
        setStatus(els.selftestStatus, `FAIL: ${error.message} (${totalMs} ms)`, 'err');
        document.documentElement.dataset.selftest = 'fail';
        window.__WEBTCP_SELFTEST__ = { ok: false, error: error.message, steps, durationMs: totalMs };
    } finally {
        for (const httpServer of httpServers) httpServer.close();
        nsClient?.close();
        nsServer?.close();
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
            : createEntranceSearcher(network.localNodeId);
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

        const resolved = await nameServer.resolve(DEMO_ALIAS_NAME);
        if (resolved.nodeId !== serverId) {
            throw new Error(`名前解決がサーバータブと一致しません: ${resolved.nodeId}`);
        }
        log(els.clientLog, `[auto-2tab] 名前解決 PASS: ${DEMO_ALIAS_NAME} -> ${resolved.nodeId} (${resolved.source})`);
        const stream = await network.connectURL(`webtcp://${DEMO_SERVICE_NAME}:${SERVER_PORT}/`, { nameServer });
        log(els.clientLog, `[auto-2tab] webtcp:// URL 接続確立 (ISN=${stream.initialSendSeqNum})`);

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
        window.__WEBTCP_TWOTAB__ = { ok: true, serverId, resolvedName: DEMO_ALIAS_NAME, durationMs };
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
    els.connectUrlBtn.addEventListener('click', onConnectURL);
    els.resolveNameBtn.addEventListener('click', onResolveName);
    els.disconnectBtn.addEventListener('click', onDisconnect);
    els.sendBtn.addEventListener('click', onSend);
    els.sendLargeBtn.addEventListener('click', onSendLarge);
    els.selftestBtn.addEventListener('click', runSelfTest);
    els.domainRegisterBtn?.addEventListener('click', () => void onDomainRegister());
    els.domainResolveBtn?.addEventListener('click', () => void onDomainResolve());
    els.messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void onSend();
    });

    serverMode = await probeDemoServer();
    renderModeBanner();

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
    domainAuthority?.close();
    nameServer?.close();
    network?.close();
    signaling?.close();
});

void main();
