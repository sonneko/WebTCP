import { ISignalingAdapter, SignalMessage } from '../../core/link/ISignalingAdapter.js';
import { NodeId } from '../../core/types/protocol.js';
import { LogLevel, Logger, createScopedLogger, resolveLogger } from '../../core/util/Logger.js';
import { generateNodeId } from '../../core/util/id.js';

export interface SignalingAdapterHubOptions {
    /** ハブのベースURL（例: `https://hub.example.com`）。 */
    url: string;
    /** ノードID。省略時はランダム生成。 */
    nodeId?: NodeId;
    /** ポーリング間隔（ms）。既定 1000。 */
    pollIntervalMs?: number;
    /** fetch の実装（テスト用に差し替え可能）。 */
    fetchImpl?: typeof fetch;
    /** ロガー（任意）。 */
    logger?: Logger;
    /** 既定コンソールロガーのログレベル（任意。既定 `'warn'`）。 */
    logLevel?: LogLevel;
}

interface HubMessage {
    id: number;
    fromId: NodeId;
    message: SignalMessage;
}

/**
 * HTTP ポーリング型のシグナリングハブクライアント（specification.md §9.4）。
 *
 * サーバーに必要なエンドポイントは 2 つだけである。
 * - `POST /signal`
 * - `GET /messages?nodeId=...&after=...`
 *
 * SSE や WebSocket に比べて遅延は大きいが、静的ホスティングと小さな
 * 関数サーバーだけで運用できる。
 */
export class SignalingAdapterHub implements ISignalingAdapter {
    private readonly baseUrl: string;
    private readonly nodeId: NodeId;
    private readonly pollIntervalMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly logger: Logger;

    private callback: ((fromId: NodeId, message: SignalMessage) => void) | null = null;
    private cursor = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private polling = false;
    private running = false;

    constructor(options: SignalingAdapterHubOptions) {
        if (!options.url) {
            throw new Error('SignalingAdapterHub requires a hub URL');
        }
        this.baseUrl = options.url.replace(/\/+$/, '');
        this.nodeId = options.nodeId ?? generateNodeId();
        this.pollIntervalMs = options.pollIntervalMs ?? 1000;
        this.logger = createScopedLogger(
            resolveLogger(options.logger, options.logLevel),
            'SignalingHub',
        );

        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new Error('No fetch implementation available');
        }
        this.fetchImpl = fetchImpl.bind(globalThis);
    }

    public getLocalNodeId(): NodeId {
        return this.nodeId;
    }

    /**
     * 受信ポーリングを開始する。
     * 初回のポーリングは待機し、サーバーに到達できなければ reject する。
     */
    public async listen(
        callback: (fromId: NodeId, message: SignalMessage) => void,
    ): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.callback = callback;

        await this.pollOnce(true);
        this.schedule();
    }

    public async sendMessage(recipientId: NodeId, message: SignalMessage): Promise<void> {
        const response = await this.fetchImpl(`${this.baseUrl}/signal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                fromId: this.nodeId,
                toId: recipientId,
                message: { ...message, fromId: this.nodeId },
            }),
        });

        if (!response.ok) {
            throw new Error(
                `Failed to send signaling message to ${recipientId}: HTTP ${response.status}`,
            );
        }
    }

    /** ポーリングを停止する。 */
    public close(): void {
        this.running = false;
        this.callback = null;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule(): void {
        if (!this.running || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.pollOnce(false);
        }, this.pollIntervalMs);
    }

    private async pollOnce(throwOnError: boolean): Promise<void> {
        if (!this.running || this.polling) return;
        this.polling = true;

        try {
            const url =
                `${this.baseUrl}/messages?nodeId=${encodeURIComponent(this.nodeId)}` +
                `&after=${this.cursor}`;
            const response = await this.fetchImpl(url, {
                headers: { accept: 'application/json' },
            });

            if (!response.ok) {
                throw new Error(`GET /messages failed: HTTP ${response.status}`);
            }

            const body = (await response.json()) as { messages?: HubMessage[] };
            const messages = Array.isArray(body.messages) ? body.messages : [];

            for (const entry of messages) {
                if (typeof entry.id === 'number' && entry.id > this.cursor) {
                    this.cursor = entry.id;
                }
                if (!this.callback) continue;
                try {
                    this.callback(entry.fromId, entry.message);
                } catch (error) {
                    this.logger.error('listener threw:', error);
                }
            }
        } catch (error) {
            if (throwOnError) {
                this.running = false;
                throw error;
            }
            this.logger.warn('Polling failed (will retry):', error);
        } finally {
            this.polling = false;
            this.schedule();
        }
    }
}
