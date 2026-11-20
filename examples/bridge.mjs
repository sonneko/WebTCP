#!/usr/bin/env node
/**
 * WebTCP ブリッジ（#52 / specification.md §19）: ローカル TCP → WebTCP トンネル。
 *
 * curl や既存アプリ（WebRTC を話さないクライアント）から、ブラウザ・Node 上の
 * WebTCP サービスへ入るための入口。ループバックでだけ待ち受け、署名付き（v2）の
 * ノードだけへ転送する（既定）。
 *
 * 前提:
 *   - 実 WebRTC 実装を `npm install` しておく（`@roamhq/wrtc` または `node-datachannel`）
 *     例: cd webtcp_jslib && npm install --no-save node-datachannel
 *   - シグナリングハブ（`node examples/server.mjs`）に到達できること
 *
 * 使い方:
 *   node examples/bridge.mjs webtcp://<nodeId>:8080 --listen 127.0.0.1:18080
 *   node examples/bridge.mjs webtcp://demo-service:8080 --listen 127.0.0.1:18080 --resolve-name
 *   curl http://127.0.0.1:18080/api/echo?x=1
 *
 * オプション:
 *   --listen HOST:PORT          待ち受け（既定 127.0.0.1:18080）
 *   --signal URL                シグナリングハブ（既定 http://127.0.0.1:8787）
 *   --key-file PATH             Ed25519 鍵の保存先（既定 ~/.webtcp-bridge/identity.pem）
 *   --resolve-name              webtcp://<名前>:port の名前を NameServer で解決する
 *   --allow-non-loopback        ループバック以外での待ち受けを許可する（危険・§19.4）
 *   --allow-unsigned-peers      公開鍵が不明な（v1）宛先への転送を許可する（危険・§19.4）
 */
import os from 'node:os';
import path from 'node:path';
import {
    EntranceSearcherAdapterHub,
    NameServer,
    NodeKeyManager,
    SignalingAdapterHub,
    createNodeNetwork,
    parseWebTCPUrl,
    createLogger,
} from '../webtcp_jslib/dist/index.js';
import { TcpBridge, isLoopbackHost } from '../webtcp_jslib/dist/adapters/bridge/TcpBridge.js';

function usage(exitCode) {
    const text = `usage: node examples/bridge.mjs webtcp://<nodeId|name>:<port> [options]

  --listen HOST:PORT      default 127.0.0.1:18080
  --signal URL            default http://127.0.0.1:8787
  --key-file PATH         default ~/.webtcp-bridge/identity.pem
  --resolve-name          resolve a name through NameServer (after bootstrap)
  --allow-non-loopback    allow a non-loopback listen address (dangerous)
  --allow-unsigned-peers  allow forwarding to v1 (unsigned) peers (dangerous)
  --rtc-bind ADDRESS      bind ICE to ADDRESS (node-datachannel bindAddress; for hosts
                          whose only interfaces are link-local or loopback)
`;
    (exitCode === 0 ? console.log : console.error)(text);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = {
        url: null,
        listen: '127.0.0.1:18080',
        signal: 'http://127.0.0.1:8787',
        keyFile: path.join(os.homedir(), '.webtcp-bridge', 'identity.pem'),
        resolveName: false,
        allowNonLoopback: false,
        allowUnsignedPeers: false,
        rtcBind: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined) usage(2);
            i += 1;
            return value;
        };
        if (arg === '--help' || arg === '-h') usage(0);
        else if (arg === '--listen') args.listen = next();
        else if (arg === '--signal') args.signal = next();
        else if (arg === '--key-file') args.keyFile = next();
        else if (arg === '--resolve-name') args.resolveName = true;
        else if (arg === '--allow-non-loopback') args.allowNonLoopback = true;
        else if (arg === '--allow-unsigned-peers') args.allowUnsignedPeers = true;
        else if (arg === '--rtc-bind') args.rtcBind = next();
        else if (arg.startsWith('--')) {
            console.error(`unknown option: ${arg}`);
            usage(2);
        } else if (args.url === null) args.url = arg;
        else usage(2);
    }
    if (!args.url) usage(2);
    return args;
}

function parseListen(value) {
    const match = /^(.*):(\d+)$/.exec(value);
    if (!match) throw new Error(`--listen must be HOST:PORT (got ${value})`);
    return { host: match[1].replace(/^\[(.*)\]$/, '$1'), port: Number(match[2]) };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const target = parseWebTCPUrl(args.url);
    if (target.port === undefined) throw new Error('the URL must include a port');
    if (!target.nodeId && !target.name) throw new Error('the URL host must be a NodeId or a name');
    const listen = parseListen(args.listen);
    // 安全条件は接続より前に確認する（§19.4）。違反なら何もネットワークへ参加しない。
    if (!isLoopbackHost(listen.host) && !args.allowNonLoopback) {
        throw new Error(`refusing to listen on ${listen.host}: pass --allow-non-loopback to bind beyond loopback`);
    }
    const logger = createLogger({ level: 'info' });

    const keys = await NodeKeyManager.open({ keyFile: args.keyFile });
    const signaling = new SignalingAdapterHub({ url: args.signal, nodeId: keys.nodeId, logger });
    const network = await createNodeNetwork({
        signaling,
        keyManager: keys,
        logger,
        ...(args.rtcBind ? { peerConnectionOptions: { bindAddress: args.rtcBind } } : {}),
    });
    await network.start();

    const result = await network.bootstrap(
        new EntranceSearcherAdapterHub({ url: args.signal, exclude: keys.nodeId }),
        { targetConnections: 1, maxRetries: 5, initialBackoffMs: 500 },
    );
    if (result.connected.length === 0) {
        throw new Error(`no peer could be reached via ${args.signal} (failed: ${result.failed.length})`);
    }

    let nodeId = target.nodeId;
    if (!nodeId) {
        if (!args.resolveName) throw new Error('a name needs --resolve-name');
        const nameServer = new NameServer(network, { logger });
        nodeId = (await nameServer.resolve(target.name)).nodeId;
        logger.info(`resolved ${target.name} -> ${nodeId}`);
    }

    const bridge = new TcpBridge({
        network,
        target: { nodeId, port: target.port },
        host: listen.host,
        port: listen.port,
        allowNonLoopbackBind: args.allowNonLoopback,
        allowUnsignedPeers: args.allowUnsignedPeers,
        logger,
    });
    const address = await bridge.start();
    console.log(`WebTCP bridge: http://${address.host}:${address.port}/ -> ${args.url}`);
    console.log('access log: one JSON line per connection (open / refused / close)');

    const stop = async () => {
        await bridge.close();
        network.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
}

main().catch((error) => {
    console.error(`bridge failed: ${error.message}`);
    process.exit(1);
});
