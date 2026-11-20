/**
 * 実 WebRTC（`@roamhq/wrtc` または `node-datachannel`）を使ったブリッジの統合テスト（#52）。
 *
 * 既定の CI には WebRTC 実装を入れないため、利用可能なプロバイダが無いときは skip する。
 * ローカルで実行するには `npm install --no-save node-datachannel` を行う（package.json は変更しない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    NodeKeyManager,
    createNodeNetwork,
    noopLogger,
    resolveNodeRTCProvider,
} from '../dist/index.js';
import { TcpBridge } from '../dist/adapters/bridge/TcpBridge.js';
import { createDemoServer } from '../../examples/server.mjs';
import { waitFor } from './helpers/loopback.mjs';

let providerName = null;
try {
    providerName = (await resolveNodeRTCProvider()).name;
} catch {
    providerName = null;
}
const skip = providerName ? false : 'no Node.js WebRTC package installed (npm install --no-save node-datachannel)';

test(`bridge-webrtc: curl-like TCP client reaches a browser-style service over real WebRTC${skip ? ' (skipped)' : ` via ${providerName}`}`, { skip, timeout: 120_000 }, async () => {
    const server = createDemoServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    // 単一ホストの ICE 候補は loopback に限定する（リンクローカルのみのホストで候補が 0 件になるのを避ける）
    const options = {
        iceServers: [],
        logger: noopLogger,
        connectTimeoutMs: 20_000,
        // 既定は 127.0.0.1（#61: node-datachannel の自動バインドは候補 0 件になることがある）。
        // WEBTCP_TEST_RTC_BIND= （空）で自動バインドのまま検証できる（@roamhq/wrtc など）。
        peerConnectionOptions: process.env.WEBTCP_TEST_RTC_BIND === ''
            ? {}
            : { bindAddress: process.env.WEBTCP_TEST_RTC_BIND ?? '127.0.0.1' },
    };
    const make = async () => {
        const keys = await NodeKeyManager.create();
        const signaling = new SignalingAdapterHub({ url, nodeId: keys.nodeId, pollIntervalMs: 120, logger: noopLogger });
        const network = await createNodeNetwork({ ...options, signaling, keyManager: keys });
        return { keys, network };
    };
    const service = await make();
    const client = await make();
    let bridge = null;
    try {
        service.network.serveHTTP(8080, async (request, response) => {
            await response.end(JSON.stringify({ path: request.path, query: request.query }));
        });
        await service.network.start();
        await client.network.start();

        const result = await client.network.bootstrap(
            new EntranceSearcherAdapterHub({ url, exclude: client.keys.nodeId }),
            { targetConnections: 1, maxRetries: 6, initialBackoffMs: 300 },
        );
        assert.ok(result.connected.includes(service.keys.nodeId), 'bootstrap must reach the service node');
        await waitFor(() => client.network.keyDirectory.get(service.keys.nodeId) !== undefined, { timeoutMs: 15_000 });

        bridge = new TcpBridge({
            network: client.network,
            target: { nodeId: service.keys.nodeId, port: 8080 },
            logger: noopLogger,
            onAccess: () => undefined,
        });
        const { port } = await bridge.start();
        const body = await new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write('GET /api/echo?x=1 HTTP/1.1\r\nHost: service\r\nConnection: close\r\n\r\n');
            });
            const chunks = [];
            socket.on('data', (chunk) => chunks.push(chunk));
            socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            socket.once('error', reject);
        });
        assert.match(body, /^HTTP\/1\.1 200 /);
        assert.match(body, /"path":"\/api\/echo"/);
        assert.match(body, /"query":"\?x=1"/);
    } finally {
        if (bridge) await bridge.close();
        client.network.close();
        service.network.close();
        await new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(resolve);
        });
    }
});
