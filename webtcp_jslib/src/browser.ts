import { BrowserWebRTCChannel } from './adapters/webrtc/BrowserWebRTCChannel.js';
import { IceServersProvider } from './adapters/webrtc/WebRTCChannel.js';
import { ISignalingAdapter } from './core/link/ISignalingAdapter.js';
import { WebTCPNetwork, WebTCPNetworkOptions } from './core/network/WebTCPNetwork.js';
import { KeyDirectory } from './core/routing/KeyDirectory.js';
import { Ed25519PacketVerifier } from './core/routing/PacketVerifier.js';
import { Ed25519KeyManager } from './core/routing/keys.js';
import { NodeId } from './core/types/protocol.js';
import { resolveLogger } from './core/util/Logger.js';

export interface CreateBrowserNetworkOptions
    extends Omit<WebTCPNetworkOptions, 'channel' | 'signaling' | 'nodeId'> {
    /** シグナリングアダプタ（必須）。 */
    signaling: ISignalingAdapter;
    /** ノードID。省略時は鍵管理の指紋、またはシグナリングアダプタのIDを使う。 */
    nodeId?: NodeId;
    /** STUN/TURN サーバーの静的リスト。 */
    iceServers?: RTCIceServer[];
    /** ピア接続生成時・ICE 再起動時に `RTCIceServer[]` を動的に取得するフック（#24）。 */
    iceServersProvider?: IceServersProvider;
    /** データチャネルのラベル。 */
    dataChannelLabel?: string;
    /** WebRTC 接続確立のタイムアウト（ms）。 */
    connectTimeoutMs?: number;
    /** ICE 失敗時の自動再起動上限（既定 2、0 で無効）。 */
    maxIceRestarts?: number;
    /** ICE 切断状態から再起動を試みるまでの猶予時間（ms、既定 3000）。 */
    iceRestartDelayMs?: number;
    /**
     * ブラウザ用 Ed25519 鍵管理（任意、#28）。
     *
     * `BrowserKeyManager.open()` で得たインスタンスを渡すと、
     * ・NodeId が公開鍵の指紋になる
     * ・パケットがプロトコル v2（署名必須）になる
     * ・ピアと公開鍵をシグナリング経由で自動交換する
     *
     * 省略した場合は v1（署名なし）で動作する。
     */
    keyManager?: Ed25519KeyManager;
    /** 公開鍵ディレクトリ（任意。省略時は鍵管理から自動生成）。 */
    keyDirectory?: KeyDirectory;
}

/**
 * ブラウザ向けの `WebTCPNetwork` を組み立てるヘルパー。
 *
 * `BrowserWebRTCChannel` を生成して注入する。
 *
 * @example
 * ```ts
 * const keys = await BrowserKeyManager.open();
 * const signaling = new SignalingAdapterHub({ url: location.origin, nodeId: keys.nodeId });
 * const network = createBrowserNetwork({ signaling, keyManager: keys });
 * await network.start();
 * ```
 */
export function createBrowserNetwork(options: CreateBrowserNetworkOptions): WebTCPNetwork {
    const logger = resolveLogger(options.logger, options.logLevel);

    const keyDirectory =
        options.keyDirectory ??
        (options.keyManager || options.verifier instanceof Ed25519PacketVerifier
            ? new KeyDirectory({ logger })
            : undefined);

    const channel = new BrowserWebRTCChannel(options.signaling, {
        logger,
        ...(options.iceServers ? { iceServers: options.iceServers } : {}),
        ...(options.iceServersProvider ? { iceServersProvider: options.iceServersProvider } : {}),
        ...(options.dataChannelLabel ? { dataChannelLabel: options.dataChannelLabel } : {}),
        ...(options.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: options.connectTimeoutMs }
            : {}),
        ...(options.maxIceRestarts !== undefined
            ? { maxIceRestarts: options.maxIceRestarts }
            : {}),
        ...(options.iceRestartDelayMs !== undefined
            ? { iceRestartDelayMs: options.iceRestartDelayMs }
            : {}),
        ...(options.keyManager ? { keyManager: options.keyManager } : {}),
        ...(keyDirectory ? { keyDirectory } : {}),
    });

    return new WebTCPNetwork({
        ...options,
        logger,
        channel,
        nodeId: options.nodeId ?? options.keyManager?.nodeId ?? options.signaling.getLocalNodeId(),
        ...(keyDirectory ? { keyDirectory } : {}),
    });
}
