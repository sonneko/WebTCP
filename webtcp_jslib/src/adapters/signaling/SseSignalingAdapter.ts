import { ISignalingAdapter, SignalMessage } from '../../core/link/ISignalingAdapter.js';
import { NodeId } from '../../core/types/protocol.js';
import { LogLevel, Logger, createScopedLogger, resolveLogger } from '../../core/util/Logger.js';
import { generateNodeId } from '../../core/util/id.js';
import {
    SignalingBackoffOptions,
    StreamedSignal,
    backoffDelay,
    isNewerThanCursor,
    normalizeHubUrl,
    postSignal,
} from './common.js';

export interface SseSignalingAdapterOptions extends SignalingBackoffOptions {
    /** ハブのベース URL（例: `https://hub.example.com`）。 */
    url: string;
    /** ノード ID。省略時はランダム生成。 */
    nodeId?: NodeId;
    /** fetch の実装（テスト用に差し替え可能）。 */
    fetchImpl?: typeof fetch;
    /** ロガー（任意）。 */
    logger?: Logger;
    /** 既定コンソールロガーのログレベル（任意。既定 `'warn'`）。 */
    logLevel?: LogLevel;
}

/**
 * SSE（Server-Sent Events）によるシグナリング（specification.md §10.4.1）。
 *
 * 受信は `GET /events?nodeId=&after=` のストリーム、送信は `POST /signal`。
 * ストリームが切れたら指数バックオフで再接続し、カーソル以降を再生してもらう。
 * `EventSource` ではなく `fetch` のストリームを読むため、Node.js とブラウザで同じ実装になる。
 */
export class SseSignalingAdapter implements ISignalingAdapter {
    private readonly baseUrl: string;
    private readonly nodeId: NodeId;
    private readonly fetchImpl: typeof fetch;
    private readonly logger: Logger;
    private readonly backoff: SignalingBackoffOptions;

    private callback: ((fromId: NodeId, message: SignalMessage) => void) | null = null;
    private cursor = 0;
    private running = false;
    private attempt = 0;
    /** 一度でも接続に成功したか（再接続では `resume=1` を付ける）。 */
    private connectedBefore = false;
    private abort: AbortController | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: SseSignalingAdapterOptions) {
        this.baseUrl = normalizeHubUrl(options.url);
        this.nodeId = options.nodeId ?? generateNodeId();
        this.backoff = { initialMs: options.initialMs, maxMs: options.maxMs };
        this.logger = createScopedLogger(resolveLogger(options.logger, options.logLevel), 'SignalingSSE');
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
     * 受信ストリームを開始する。初回の接続に成功してから解決し、失敗すれば reject する。
     */
    public async listen(callback: (fromId: NodeId, message: SignalMessage) => void): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.callback = callback;
        await this.connect(true);
    }

    public async sendMessage(recipientId: NodeId, message: SignalMessage): Promise<void> {
        await postSignal(this.fetchImpl, this.baseUrl, this.nodeId, recipientId, message);
    }

    /** ストリームを閉じ、再接続を止める。 */
    public close(): void {
        this.running = false;
        this.callback = null;
        this.abort?.abort();
        this.abort = null;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private async connect(throwOnError: boolean): Promise<void> {
        if (!this.running) return;
        const controller = new AbortController();
        this.abort = controller;
        const resume = this.connectedBefore || this.cursor > 0 ? 1 : 0;
        const url =
            `${this.baseUrl}/events?nodeId=${encodeURIComponent(this.nodeId)}` +
            `&after=${this.cursor}&resume=${resume}`;
        const headers: Record<string, string> = { accept: 'text/event-stream' };
        if (this.cursor > 0) headers['last-event-id'] = String(this.cursor);
        try {
            const response = await this.fetchImpl(url, { headers, signal: controller.signal });
            if (!response.ok || !response.body) {
                throw new Error(`GET /events failed: HTTP ${response.status}`);
            }
            this.attempt = 0;
            this.connectedBefore = true;
            void this.consume(response.body, controller).finally(() => this.scheduleReconnect());
        } catch (error) {
            if (throwOnError) {
                this.running = false;
                throw error;
            }
            this.logger.warn('SSE connect failed (will retry):', error);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) return;
        if (this.timer !== null) return;
        const delay = backoffDelay(this.attempt, this.backoff);
        this.attempt += 1;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.connect(false);
        }, delay);
    }

    /** SSE のフレームを読み、`signal` イベントを配信する。 */
    private async consume(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const block = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    this.dispatchBlock(block);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) this.logger.warn('SSE stream error (will reconnect):', error);
        } finally {
            reader.releaseLock();
        }
    }

    private dispatchBlock(block: string): void {
        let eventName = 'message';
        let id: number | undefined;
        const data: string[] = [];
        for (const line of block.split('\n')) {
            if (line === '' || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') eventName = value;
            else if (field === 'id') id = Number(value);
            else if (field === 'data') data.push(value);
        }
        if (eventName !== 'signal' || data.length === 0) return;

        let payload: unknown;
        try {
            payload = JSON.parse(data.join('\n'));
        } catch {
            this.logger.warn('Malformed SSE signal payload; skipped');
            return;
        }
        const entry = { ...(payload as object), id } as Partial<StreamedSignal>;
        if (!isNewerThanCursor(entry, this.cursor)) return;
        this.cursor = entry.id;
        if (!this.callback) return;
        try {
            this.callback(entry.fromId, entry.message);
        } catch (error) {
            this.logger.error('listener threw:', error);
        }
    }
}
