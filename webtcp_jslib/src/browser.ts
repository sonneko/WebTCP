import { BrowserWebRTCChannel } from './adapters/webrtc/BrowserWebRTCChannel.js';
import { IceServersProvider } from './adapters/webrtc/WebRTCChannel.js';
import { ISignalingAdapter } from './core/link/ISignalingAdapter.js';
import { WebTCPNetwork, WebTCPNetworkOptions } from './core/network/WebTCPNetwork.js';
import { NodeId } from './core/types/protocol.js';
import { resolveLogger } from './core/util/Logger.js';

export interface CreateBrowserNetworkOptions
    extends Omit<WebTCPNetworkOptions, 'channel' | 'signaling' | 'nodeId'> {
    /** シグナリングアダプタ（必須）。 */
    signaling: ISignalingAdapter;
    /** ノードID。省略時はシグナリングアダプタのIDを使う。 */
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
}

/**
 * ブラウザ向けの `WebTCPNetwork` を組み立てるヘルパー。
 *
 * `BrowserWebRTCChannel` を生成して注入する。
 *
 * @example
 * ```ts
 * const signaling = new SignalingAdapterHub({ url: location.origin });
 * const network = createBrowserNetwork({
 *   signaling,
 *   iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
 * });
 * await network.start();
 * ```
 */
export function createBrowserNetwork(options: CreateBrowserNetworkOptions): WebTCPNetwork {
    const logger = resolveLogger(options.logger, options.logLevel);

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
    });

    return new WebTCPNetwork({
        ...options,
        logger,
        channel,
        nodeId: options.nodeId ?? options.signaling.getLocalNodeId(),
    });
}
