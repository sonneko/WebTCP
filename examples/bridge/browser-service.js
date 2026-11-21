/**
 * ブラウザ上で動く HTTP サービス（M8 の残検証: curl → ブリッジ → 実ブラウザ）。
 *
 * `examples/verify-bridge-browser.mjs` から開かれる。ポート 8080 で HTTP を公開し、
 * 準備ができたら `body[data-ready]` に NodeId を入れる。
 *
 *   /api/echo?x=1  JSON（method / path / query / runtime）
 *   /big?n=N       N バイトの本文（既定 512 KiB、上限 1 MiB）
 */
import { BrowserKeyManager, SignalingAdapterHub, createBrowserNetwork, createLogger } from '../../webtcp_jslib/dist/index.js';

const SERVICE_PORT = 8080;
const logger = createLogger({ level: 'warn' });
const status = document.getElementById('status');

try {
    // 署名付き（v2）の身元。ブリッジは v1 の宛先を既定で拒否するため必須（仕様 §19.4 の 3）。
    const keys = await BrowserKeyManager.open({ databaseName: `webtcp-bridge-service-${Date.now()}` });
    const signaling = new SignalingAdapterHub({ url: location.origin, pollIntervalMs: 120, logger, nodeId: keys.nodeId });
    const network = createBrowserNetwork({ signaling, iceServers: [], logger, keyManager: keys });
    await network.start();
    network.serveHTTP(SERVICE_PORT, async (request, response) => {
        if (request.path === '/api/echo') {
            response.setHeader('content-type', 'application/json; charset=utf-8');
            await response.end(
                JSON.stringify({
                    method: request.method,
                    path: request.path,
                    query: request.query,
                    runtime: 'browser',
                    nodeIdPrefix: network.localNodeId.slice(0, 8),
                }),
            );
            return;
        }
        if (request.path === '/big') {
            const requested = Number(new URLSearchParams(request.query.slice(1)).get('n') ?? 512 * 1024);
            const n = Math.min(Math.max(0, requested), 1 << 20);
            response.setHeader('content-type', 'application/octet-stream');
            await response.end('x'.repeat(n));
            return;
        }
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        await response.end('hello from a browser service\n');
    });
    document.getElementById('node-id').textContent = network.localNodeId;
    status.textContent = 'listening';
    document.body.dataset.ready = network.localNodeId;
} catch (error) {
    status.textContent = `failed: ${error.message}`;
    document.body.dataset.error = error.message;
}
