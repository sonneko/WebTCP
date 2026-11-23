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

/** WebSocket の最小限の型（ブラウザ / Node.js 22 以降の組み込み実装）。 */
export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
}

export interface WebSocketSignalingAdapterOptions extends SignalingBackoffOptions {
    /** ハブのベース URL（`http(s)://` でも `ws(s)://` でもよい）。 */
    url: string;
    /** ノード ID。省略時はランダム生成。 */
    nodeId?: NodeId;
    /** WebSocket の実装（テスト用に差し替え可能）。既定は組み込みの `WebSocket`。 */
    webSocketImpl?: new (url: string) => WebSocketLike;
    /** 送信の代替（`POST /signal`）に使う fetch（テスト用に差し替え可能）。 */
    fetchImpl?: typeof fetch;
    /** ロガー（任意）。 */
    logger?: Logger;
    /** 既定コンソールロガーのログレベル（任意。既定 `'warn'`）。 */
    logLevel?: LogLevel;
}

const WS_OPEN = 1;

/**
 * WebSocket によるシグナリング（specification.md §10.4.1）。
 *
 * 受信は `GET /ws?nodeId=&after=` の Upgrade。送信は Socket へ `{"type":"send"}` を流し、
 * Socket が開いていないときは `POST /signal` へ切り替える（切断中の送信を失わないため）。
 * 切断時は指数バックオフで再接続し、カーソル以降を再生してもらう。
 */
export class WebSocketSignalingAdapter implements ISignalingAdapter {
    private readonly baseUrl: string;
    private readonly wsBaseUrl: string;
    private readonly nodeId: NodeId;
    private readonly WebSocketImpl: new (url: string) => WebSocketLike;
    private readonly fetchImpl: typeof fetch;
    private readonly logger: Logger;
    private readonly backoff: SignalingBackoffOptions;

    private callback: ((fromId: NodeId, message: SignalMessage) => void) | null = null;
    private cursor = 0;
    private running = false;
    private attempt = 0;
    /** 一度でも接続に成功したか（再接続では `resume=1` を付ける）。 */
    private connectedBefore = false;
    private socket: WebSocketLike | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: WebSocketSignalingAdapterOptions) {
        this.baseUrl = normalizeHubUrl(options.url);
        this.wsBaseUrl = this.baseUrl.replace(/^http/, 'ws');
        this.nodeId = options.nodeId ?? generateNodeId();
        this.backoff = { initialMs: options.initialMs, maxMs: options.maxMs };
        this.logger = createScopedLogger(resolveLogger(options.logger, options.logLevel), 'SignalingWS');

        const WebSocketImpl = options.webSocketImpl ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
        if (typeof WebSocketImpl !== 'function') {
            throw new Error('No WebSocket implementation available');
        }
        this.WebSocketImpl = WebSocketImpl;

        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new Error('No fetch implementation available');
        }
        this.fetchImpl = fetchImpl.bind(globalThis);
    }

    public getLocalNodeId(): NodeId {
        return this.nodeId;
    }

    /** 受信を開始する。初回の接続に成功してから解決し、失敗すれば reject する。 */
    public async listen(callback: (fromId: NodeId, message: SignalMessage) => void): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.callback = callback;
        await this.connect(true);
    }

    public async sendMessage(recipientId: NodeId, message: SignalMessage): Promise<void> {
        const socket = this.socket;
        if (socket && socket.readyState === WS_OPEN) {
            socket.send(
                JSON.stringify({
                    type: 'send',
                    toId: recipientId,
                    message: { ...message, fromId: this.nodeId },
                }),
            );
            return;
        }
        // 切断中は POST /signal で届ける（サーバーは保持期間内の再生で配る）
        await postSignal(this.fetchImpl, this.baseUrl, this.nodeId, recipientId, message);
    }

    /** Socket を閉じ、再接続を止める。 */
    public close(): void {
        this.running = false;
        this.callback = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onclose = null;
            socket.close();
        }
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private connect(throwOnError: boolean): Promise<void> {
        if (!this.running) return Promise.resolve();
        const resume = this.connectedBefore || this.cursor > 0 ? 1 : 0;
        const url =
            `${this.wsBaseUrl}/ws?nodeId=${encodeURIComponent(this.nodeId)}` +
            `&after=${this.cursor}&resume=${resume}`;

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let socket: WebSocketLike;
            try {
                socket = new this.WebSocketImpl(url);
            } catch (error) {
                this.handleFailure(error, throwOnError, settled, reject);
                return;
            }
            this.socket = socket;

            socket.onopen = () => {
                settled = true;
                this.attempt = 0;
                this.connectedBefore = true;
                resolve();
            };
            socket.onmessage = (event) => this.dispatch(event.data);
            socket.onerror = (event) => {
                if (!settled) this.handleFailure(event, throwOnError, settled, reject);
            };
            socket.onclose = () => {
                if (this.socket === socket) this.socket = null;
                if (!settled) {
                    this.handleFailure(new Error('WebSocket closed before open'), throwOnError, settled, reject);
                    return;
                }
                this.scheduleReconnect();
            };
        });
    }

    private handleFailure(
        error: unknown,
        throwOnError: boolean,
        settled: boolean,
        reject: (reason: unknown) => void,
    ): void {
        if (settled) return;
        if (throwOnError) {
            this.running = false;
            reject(error);
            return;
        }
        this.logger.warn('WebSocket connect failed (will retry):', error);
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (!this.running || this.timer !== null) return;
        const delay = backoffDelay(this.attempt, this.backoff);
        this.attempt += 1;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.connect(false).catch(() => this.scheduleReconnect());
        }, delay);
    }

    private dispatch(data: unknown): void {
        if (typeof data !== 'string') return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            this.logger.warn('Malformed WebSocket signal payload; skipped');
            return;
        }
        if (!isNewerThanCursor(parsed as Partial<StreamedSignal>, this.cursor)) return;
        const entry = parsed as StreamedSignal;
        this.cursor = entry.id;
        if (!this.callback) return;
        try {
            this.callback(entry.fromId, entry.message);
        } catch (error) {
            this.logger.error('listener threw:', error);
        }
    }
}
