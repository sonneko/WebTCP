/**
 * ローカル TCP → WebTCP トンネルのブリッジ（#52 / specification.md §19）。
 *
 * ローカルの TCP ソケット（curl・既存アプリ・ブラウザ）を、仮想ポート経由で
 * リモートノードのサービスへ双方向に中継する。WebRTC を話せない外部クライアントの入口になる。
 *
 * ## 安全上の前提（§19.4、MUST）
 * - ブリッジは**認証なし**でトンネルを開く。したがって次を強制する。
 *   1. `network.signaturesRequired` と鍵管理が必要（プロトコル v2）。満たさなければ起動しない。
 *   2. 既定はループバック（`127.0.0.1` / `::1`）のみ待ち受ける。他のアドレスは明示的な許可が必要。
 *   3. 宛先の公開鍵が公開鍵ディレクトリに無い（= v1 ノード）場合は転送しない。明示的な許可が必要。
 *   4. すべての接続（開始・拒否・終了）を `onAccess` へ記録する。
 * - 本クラスは Node.js 専用（`node:net` を使う）。ブラウザ向けの `index` からは再公開しない。
 *
 * ## 転送（§19.2）
 * - 上り: ソケット → `VirtualStream.send()`。送信バッファ満杯（`Send buffer full`）は `drain` を待って再試行する。
 * - 下り: `VirtualStream` の `data` → `socket.write()`。書き込みが詰まったら `resume` を止める。
 * - Half-Close: クライアントの FIN は `stream.end()`、リモートの FIN は `socket.end()` へ伝える。
 */
import type { NodeId, VirtualPort } from '../../core/types/protocol.js';
import type { WebTCPNetwork } from '../../core/network/WebTCPNetwork.js';
import type { VirtualStream } from '../../core/transport/VirtualStream.js';
import { Logger, defaultLogger } from '../../core/util/Logger.js';

/** 1 回の `send()` に渡す最大チャンク。 */
export const BRIDGE_CHUNK_BYTES = 16 * 1024;
/** 上り方向の未送信バイトがこれを超えたらソケットを一時停止する。 */
export const BRIDGE_MAX_QUEUED_BYTES = 1024 * 1024;
/** 宛先の公開鍵が届くのを待つ時間（既定）。RT_UPDATE の伝播を待つため。 */
export const BRIDGE_KEY_WAIT_MS = 5000;

export type BridgeSecurityCode = 'signatures-required' | 'non-loopback-bind';

export class BridgeSecurityError extends Error {
    public readonly code: BridgeSecurityCode;

    constructor(code: BridgeSecurityCode, message: string) {
        super(message);
        this.name = 'BridgeSecurityError';
        this.code = code;
    }
}

export interface BridgeTarget {
    nodeId: NodeId;
    port: VirtualPort;
}

export interface BridgeAccessEntry {
    /** ISO 8601 時刻。 */
    at: string;
    event: 'open' | 'refused' | 'error' | 'close';
    /** 接続番号（ブリッジ内で単調増加）。 */
    id: number;
    /** ローカルの接続元（`address:port`）。 */
    client: string;
    /** 宛先（`nodeId:port`）。 */
    target: string;
    bytesUp: number;
    bytesDown: number;
    durationMs?: number;
    reason?: string;
}

export interface TcpBridgeOptions {
    network: WebTCPNetwork;
    target: BridgeTarget;
    /** 待ち受けホスト。既定 `127.0.0.1`。 */
    host?: string;
    /** 待ち受けポート。既定 0（OS 割り当て）。 */
    port?: number;
    /** ループバック以外のホストで待ち受けることを許可する（既定 false、§19.4）。 */
    allowNonLoopbackBind?: boolean;
    /** 公開鍵が不明な（v1 の）宛先への転送を許可する（既定 false、§19.4）。 */
    allowUnsignedPeers?: boolean;
    /** 宛先の公開鍵を待つ時間（ms）。既定 {@link BRIDGE_KEY_WAIT_MS}。 */
    keyWaitMs?: number;
    /** 仮想接続の確立タイムアウト（ms）。既定 10000。 */
    connectTimeoutMs?: number;
    /** アクセスログの出力先。既定はロガーへ JSON 1 行で出す。 */
    onAccess?: (entry: BridgeAccessEntry) => void;
    logger?: Logger;
}

export interface BridgeAddress {
    host: string;
    port: number;
}

/** `node:net` の必要最小限の型（`@types/node` に依存しない）。 */
interface NetSocket {
    readonly remoteAddress?: string;
    readonly remotePort?: number;
    readonly destroyed: boolean;
    write(data: Uint8Array): boolean;
    end(): void;
    destroy(error?: Error): void;
    pause(): this;
    resume(): this;
    setNoDelay?(enable?: boolean): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
}
interface NetServer {
    listen(port: number, host: string, listener?: () => void): this;
    close(callback?: (error?: Error) => void): this;
    address(): { address: string; port: number } | string | null;
    once(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
}
interface NodeNetModule {
    createServer(
        options: { allowHalfOpen: boolean },
        listener: (socket: NetSocket) => void,
    ): NetServer;
}

async function loadNodeNet(): Promise<NodeNetModule> {
    const name = 'node:net';
    const mod = (await import(name)) as unknown as NodeNetModule & { default?: NodeNetModule };
    return typeof mod.createServer === 'function' ? mod : (mod.default as NodeNetModule);
}

/** ループバックアドレスか（`localhost` は解決先が 127.0.0.1 / ::1 とみなす）。 */
export function isLoopbackHost(host: string): boolean {
    const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** 起動前の安全条件を検査する（§19.4）。違反なら {@link BridgeSecurityError}。 */
export function assertBridgeSecurity(
    network: WebTCPNetwork,
    options: { host: string; allowNonLoopbackBind?: boolean },
): void {
    if (!network.signaturesRequired || network.keyManager === null) {
        throw new BridgeSecurityError(
            'signatures-required',
            'the bridge requires signed packets (protocol v2): create the network with a keyManager and requireSignatures',
        );
    }
    if (!isLoopbackHost(options.host) && options.allowNonLoopbackBind !== true) {
        throw new BridgeSecurityError(
            'non-loopback-bind',
            `refusing to listen on ${options.host}: the bridge is loopback-only unless allowNonLoopbackBind is set`,
        );
    }
}

class BridgeRefusedError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'BridgeRefusedError';
    }
}

export class TcpBridge {
    private readonly network: WebTCPNetwork;
    private readonly target: BridgeTarget;
    private readonly host: string;
    private readonly port: number;
    private readonly allowUnsignedPeers: boolean;
    private readonly keyWaitMs: number;
    private readonly connectTimeoutMs: number;
    private readonly onAccess: (entry: BridgeAccessEntry) => void;
    private readonly logger: Logger;
    private server: NetServer | null = null;
    private readonly sockets = new Set<NetSocket>();
    private seq = 0;
    private closed = false;

    constructor(options: TcpBridgeOptions) {
        this.network = options.network;
        this.target = options.target;
        this.host = options.host ?? '127.0.0.1';
        this.port = options.port ?? 0;
        this.allowUnsignedPeers = options.allowUnsignedPeers === true;
        this.keyWaitMs = options.keyWaitMs ?? BRIDGE_KEY_WAIT_MS;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
        this.logger = options.logger ?? defaultLogger;
        this.onAccess =
            options.onAccess ??
            ((entry) => this.logger.info(`[bridge] ${JSON.stringify(entry)}`));
        assertBridgeSecurity(this.network, {
            host: this.host,
            ...(options.allowNonLoopbackBind !== undefined
                ? { allowNonLoopbackBind: options.allowNonLoopbackBind }
                : {}),
        });
    }

    /** 待ち受けを開始する。 */
    public async start(): Promise<BridgeAddress> {
        if (this.closed) throw new Error('TcpBridge is closed');
        if (this.server) throw new Error('TcpBridge is already started');
        const net = await loadNodeNet();
        // allowHalfOpen: クライアントの FIN 後もリモートからの応答を書き込むため（§19.2 Half-Close）。
        // 既定の false だと、読み取り側の終了で書き込み側も自動的に閉じられてしまう。
        const server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleSocket(socket));
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once('error', onError);
            server.listen(this.port, this.host, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        this.server = server;
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('TcpBridge: unexpected listen address');
        }
        this.logger.info(
            `[bridge] listening on ${address.address}:${address.port} -> ${this.target.nodeId}:${this.target.port}`,
        );
        return { host: address.address, port: address.port };
    }

    /** 待ち受けを止め、既存の接続を閉じる。ネットワーク自体は閉じない。 */
    public async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const socket of [...this.sockets]) socket.destroy();
        this.sockets.clear();
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    /** 接続中のローカルソケット数。 */
    public get activeConnections(): number {
        return this.sockets.size;
    }

    private access(entry: Omit<BridgeAccessEntry, 'at'>): void {
        try {
            this.onAccess({ at: new Date().toISOString(), ...entry });
        } catch (error) {
            this.logger.warn('[bridge] onAccess threw:', error);
        }
    }

    private handleSocket(socket: NetSocket): void {
        if (this.closed) {
            socket.destroy();
            return;
        }
        const id = ++this.seq;
        const client = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
        const target = `${this.target.nodeId}:${this.target.port}`;
        const startedAt = Date.now();
        this.sockets.add(socket);
        socket.setNoDelay?.(true);
        // 仮想接続が確立するまでソケットからの読み取りを止める
        socket.pause();

        let stream: VirtualStream | null = null;
        let bytesUp = 0;
        let bytesDown = 0;
        let finished = false;
        const finish = (event: 'close' | 'error', reason?: string) => {
            if (finished) return;
            finished = true;
            this.sockets.delete(socket);
            this.access({
                event,
                id,
                client,
                target,
                bytesUp,
                bytesDown,
                durationMs: Date.now() - startedAt,
                ...(reason ? { reason } : {}),
            });
        };

        // 上り（ソケット → ストリーム）の状態
        const queue: Uint8Array[] = [];
        let queued = 0;
        let clientEnded = false;
        let pumping = false;
        let socketPaused = false;

        const pump = async (): Promise<void> => {
            if (pumping || !stream) return;
            pumping = true;
            try {
                while (queue.length > 0) {
                    const head = queue[0]!;
                    const part = head.subarray(0, BRIDGE_CHUNK_BYTES);
                    await sendChunk(stream, part);
                    bytesUp += part.byteLength;
                    queued -= part.byteLength;
                    if (part.byteLength === head.byteLength) queue.shift();
                    else queue[0] = head.subarray(part.byteLength);
                    if (socketPaused && queued < BRIDGE_MAX_QUEUED_BYTES / 2) {
                        socketPaused = false;
                        socket.resume();
                    }
                }
                if (clientEnded && !finished) stream.end();
            } catch (error) {
                finish('error', error instanceof Error ? error.message : String(error));
                socket.destroy();
                stream?.destroy();
            } finally {
                pumping = false;
            }
        };

        socket.on('data', (chunk: Uint8Array) => {
            queue.push(new Uint8Array(chunk));
            queued += chunk.byteLength;
            if (!socketPaused && queued > BRIDGE_MAX_QUEUED_BYTES) {
                socketPaused = true;
                socket.pause();
            }
            void pump();
        });
        socket.on('end', () => {
            clientEnded = true;
            void pump();
        });
        socket.on('error', (error: Error) => {
            finish('error', error.message);
            stream?.destroy();
        });
        socket.on('close', () => {
            // クライアントが閉じた: 未送信分を送ってから FIN（既に終わっていれば何もしない）
            if (stream && stream.state !== 'CLOSED' && !clientEnded) stream.end();
            finish('close');
        });

        void (async () => {
            try {
                await this.ensureAuthorizedPeer();
                stream = await this.openStream();
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                // 拒否は `refused` の 1 件だけ記録する（後続の close は無視される）
                finished = true;
                this.sockets.delete(socket);
                this.access({
                    event: 'refused',
                    id,
                    client,
                    target,
                    bytesUp: 0,
                    bytesDown: 0,
                    reason,
                });
                socket.destroy();
                return;
            }
            if (finished || socket.destroyed) {
                stream.destroy();
                return;
            }
            this.access({ event: 'open', id, client, target, bytesUp: 0, bytesDown: 0 });

            // 下り（ストリーム → ソケット）
            stream.on('data', (chunk: Uint8Array) => {
                bytesDown += chunk.byteLength;
                if (!socket.write(chunk)) {
                    stream?.pause();
                    socket.once('drain', () => stream?.resume());
                }
            });
            stream.on('end', () => socket.end());
            stream.on('close', () => {
                if (!socket.destroyed) socket.end();
            });
            stream.on('error', (error: Error) => {
                finish('error', error.message);
                socket.destroy();
            });

            socket.resume();
            void pump();
        })();
    }

    /** 宛先が署名付き（v2）で公開鍵が既知であることを確認する。無ければ待ち、それでも無ければ拒否。 */
    private async ensureAuthorizedPeer(): Promise<void> {
        if (this.allowUnsignedPeers) return;
        const directory = this.network.keyDirectory;
        if (!directory) {
            throw new BridgeRefusedError('unsigned-peer: no key directory on this network');
        }
        if (directory.get(this.target.nodeId)) return;
        // 近隣からの RT_UPDATE で公開鍵が届くまで待つ。経路の学習もここで進む。
        if (!this.network.getRoutingTable().getEntry(this.target.nodeId)) {
            await this.network.connectToPeer(this.target.nodeId).catch(() => undefined);
        }
        const deadline = Date.now() + this.keyWaitMs;
        while (Date.now() < deadline) {
            if (directory.get(this.target.nodeId)) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new BridgeRefusedError(
            'unsigned-peer: the target public key is unknown (v1 node); pass allowUnsignedPeers to forward anyway',
        );
    }

    private async openStream(): Promise<VirtualStream> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pending = this.network.connect(this.target.nodeId, this.target.port);
        try {
            return await Promise.race([
                pending,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`connect to ${this.target.nodeId}:${this.target.port} timed out`)),
                        this.connectTimeoutMs,
                    );
                }),
            ]);
        } catch (error) {
            // タイムアウト後に遅れて成立した仮想接続は破棄する
            pending.then((late) => late.destroy(), () => undefined);
            throw error;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

/** 送信バッファ満杯のときは `drain` を待って同じチャンクを再送する。 */
async function sendChunk(stream: VirtualStream, data: Uint8Array): Promise<void> {
    for (;;) {
        try {
            await stream.send(data);
            return;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Send buffer full')) throw error;
            await new Promise<void>((resolve) => {
                const done = () => {
                    stream.removeListener('drain', done);
                    stream.removeListener('close', done);
                    resolve();
                };
                stream.on('drain', done);
                stream.on('close', done);
            });
            if (stream.state === 'CLOSED') throw new Error('stream closed while waiting to send');
        }
    }
}
