/**
 * サーバーを使わないデモ用のシグナリングとピア探索（GitHub Pages などの静的ホスティング向け）。
 *
 * - `createMemorySignalingBus()`: 同一ページ内の `ISignalingAdapter` の対。`?selftest=1` が使う。
 *   他のタブへは漏れない。
 * - `createBroadcastSignaling()` / `createBroadcastEntranceSearcher()`: `BroadcastChannel` による
 *   同一ブラウザ内のタブ間シグナリングと探索。別ブラウザ・別デバイスとは交換できない（仕様の制約）。
 *
 * どちらも SDP / ICE / public-key を JSON の往復で運ぶ。`examples/server.mjs` のシグナリングハブと
 * 同じ条件（構造化クローンできない値を含まない）にそろえるため。
 */

const CHANNEL_KIND = Object.freeze({ SIGNAL: 'signal', DISCOVER: 'discover', HERE: 'here' });

/** 16 バイトの乱数を 32 桁の hex にする（NodeId と同じ長さ）。 */
export function randomNodeId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function roundTrip(message) {
    return JSON.parse(JSON.stringify(message));
}

/**
 * 同一ページ内のメモリ上のシグナリングバス。宛先が未接続の間は届くまでキューに保持する
 * （`SignalingAdapterHub` がポーリングで未配送メッセージを受け取るのと同じ扱い）。
 */
export function createMemorySignalingBus() {
    const nodes = new Map(); // nodeId -> { callback: fn | null, pending: [] }

    const flush = (nodeId) => {
        const node = nodes.get(nodeId);
        if (!node?.callback) return;
        while (node.pending.length > 0) {
            const { fromId, message } = node.pending.shift();
            queueMicrotask(() => node.callback?.(fromId, message));
        }
    };

    return {
        /** 指定の NodeId でアダプタを作る。 */
        adapter(nodeId) {
            if (!nodes.has(nodeId)) nodes.set(nodeId, { callback: null, pending: [] });
            return {
                getLocalNodeId: () => nodeId,
                async sendMessage(recipientId, message) {
                    const target = nodes.get(recipientId) ?? { callback: null, pending: [] };
                    nodes.set(recipientId, target);
                    target.pending.push({ fromId: nodeId, message: roundTrip(message) });
                    flush(recipientId);
                },
                async listen(callback) {
                    nodes.get(nodeId).callback = callback;
                    flush(nodeId);
                },
                close() {
                    const node = nodes.get(nodeId);
                    if (node) node.callback = null;
                },
            };
        },
    };
}

/**
 * `BroadcastChannel` 上のシグナリングアダプタ。`listen()` の前に届いたメッセージは捨てられるが、
 * デモでは各タブが起動時にネットワークを開始してから相手を探すため問題にならない。
 */
export function createBroadcastSignaling({ nodeId, channelName, logger, isDiscoverable = () => true } = {}) {
    if (typeof BroadcastChannel !== 'function') {
        throw new Error('BroadcastChannel が使えないため、タブ間シグナリングを作れません');
    }
    const localId = nodeId ?? randomNodeId();
    const channel = new BroadcastChannel(channelName);
    let callback = null;

    channel.onmessage = (event) => {
        const data = typeof event.data === 'string' ? safeParse(event.data) : null;
        if (!data || typeof data !== 'object') return;
        if (data.kind === CHANNEL_KIND.DISCOVER) {
            // 探索に応じられるのは待ち受けを開始したノードだけ（`isDiscoverable` が true のとき）
            if (callback && typeof data.from === 'string' && isDiscoverable()) {
                channel.postMessage(JSON.stringify({ kind: CHANNEL_KIND.HERE, to: data.from, nodeId: localId }));
            }
            return;
        }
        if (data.kind === CHANNEL_KIND.SIGNAL && data.to === localId && callback) {
            callback(data.from, data.message);
        }
    };

    logger?.debug?.(`broadcast signaling ${localId.slice(0, 8)}… on ${channelName}`);

    return {
        getLocalNodeId: () => localId,
        async sendMessage(recipientId, message) {
            channel.postMessage(
                JSON.stringify({ kind: CHANNEL_KIND.SIGNAL, to: recipientId, from: localId, message: roundTrip(message) }),
            );
        },
        async listen(cb) {
            callback = cb;
        },
        close() {
            callback = null;
            channel.close();
        },
    };
}

/**
 * `BroadcastChannel` で待ち受け中のノードを集める（`EntranceSearcherAdapterHub.search()` の代わり）。
 * `timeoutMs` 以内に応答したノードの NodeId を返す。`exclude` 自身は含めない。
 */
export function createBroadcastEntranceSearcher({ channelName, exclude, timeoutMs = 400 } = {}) {
    return {
        async search() {
            const probeId = randomNodeId();
            const channel = new BroadcastChannel(channelName);
            const found = new Set();
            channel.onmessage = (event) => {
                const data = typeof event.data === 'string' ? safeParse(event.data) : null;
                if (!data || data.kind !== CHANNEL_KIND.HERE || data.to !== probeId) return;
                if (typeof data.nodeId !== 'string' || data.nodeId.length === 0) return;
                if (data.nodeId !== exclude) found.add(data.nodeId);
            };
            channel.postMessage(JSON.stringify({ kind: CHANNEL_KIND.DISCOVER, from: probeId }));
            await new Promise((resolve) => setTimeout(resolve, timeoutMs));
            channel.close();
            return [...found];
        },
    };
}

function safeParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
