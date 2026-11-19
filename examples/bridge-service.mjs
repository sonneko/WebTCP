#!/usr/bin/env node
/**
 * ブリッジの動作確認用サービス（#52）。Node 上で WebTCP の HTTP サービスを公開する。
 *
 * `examples/bridge.mjs` から curl で届くかを確かめるための最小サービス。
 *
 *   node examples/bridge-service.mjs --name demo-service --port 8080
 *   （ICE の候補収集を特定アドレスへ限定する場合は --rtc-bind 127.0.0.1）
 *
 * 名前は NameServer に A レコードとして登録し、`webtcp://demo-service:8080/` で引けるようにする。
 */
import os from 'node:os';
import path from 'node:path';
import {
    EntranceSearcherAdapterHub,
    NameServer,
    NodeKeyManager,
    SignalingAdapterHub,
    createNodeNetwork,
    createLogger,
} from '../webtcp_jslib/dist/index.js';

const argv = process.argv.slice(2);
const value = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const signal = value('--signal', 'http://127.0.0.1:8787');
const name = value('--name', 'demo-service');
const port = Number(value('--port', '8080'));
const keyFile = value('--key-file', path.join(os.homedir(), '.webtcp-bridge', 'service.pem'));
const rtcBind = value('--rtc-bind', null);
const logger = createLogger({ level: 'info' });

const keys = await NodeKeyManager.open({ keyFile });
const signaling = new SignalingAdapterHub({ url: signal, nodeId: keys.nodeId, logger });
const network = await createNodeNetwork({
    signaling,
    keyManager: keys,
    logger,
    ...(rtcBind ? { peerConnectionOptions: { bindAddress: rtcBind } } : {}),
});
await network.start();

const nameServer = new NameServer(network, { logger });
nameServer.registerA(name, keys.nodeId);
nameServer.listen();

network.serveHTTP(port, async (request, response) => {
    if (request.path === '/api/echo') {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        await response.end(
            JSON.stringify({ method: request.method, path: request.path, query: request.query, service: name }),
        );
        return;
    }
    if (request.path === '/big') {
        // 送信バッファ・フロー制御の確認用（?n= バイト、上限 1 MiB、既定 512 KiB）
        const n = Math.min(Number(new URLSearchParams(request.query.slice(1)).get('n') ?? 512 * 1024), 1 << 20);
        response.setHeader('content-type', 'application/octet-stream');
        await response.end('x'.repeat(n));
        return;
    }
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    await response.end(`hello from ${name} (${keys.nodeId})\n`);
});

const joined = await network.bootstrap(
    new EntranceSearcherAdapterHub({ url: signal, exclude: keys.nodeId }),
    { targetConnections: 1, maxRetries: 5, initialBackoffMs: 500 },
);
console.log(`service ${name} (${keys.nodeId}) on virtual port ${port}; bootstrap peers: ${joined.connected.length}`);
console.log(`bridge target: webtcp://${keys.nodeId}:${port}  or  webtcp://${name}:${port} (--resolve-name)`);

const stop = () => {
    network.close();
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
