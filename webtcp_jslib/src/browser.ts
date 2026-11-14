import { BrowserWebRTCChannel } from './adapters/webrtc/BrowserWebRTCChannel.js';
import { ISignalingAdapter } from './core/link/ISignalingAdapter.js';
import { WebTCPNetwork, WebTCPNetworkOptions } from './core/network/WebTCPNetwork.js';
import { NodeId } from './core/types/protocol.js';

export interface CreateBrowserNetworkOptions
    extends Omit<WebTCPNetworkOptions, 'channel' | 'signaling' | 'nodeId'> {
    /** シグナリングアダプタ（必須）。 */
    signaling: ISignalingAdapter;
    /** ノードID。省略時はシグナリングアダプタのIDを使う。 */
    nodeId?: NodeId;
    /** STUN/TURN サーバー。 */
    iceServers?: RTCIceServer[];
    /** データチャネルのラベル。 */
    dataChannelLabel?: string;
    /** WebRTC 接続確立のタイムアウト（ms）。 */
    connectTimeoutMs?: number;
}

/**
 * ブラウザ向けの `WebTCPNetwork` を組み立てるヘルパー。
 *
 * `BrowserWebRTCChannel` を生成して注入する。
 *
 * @example
 * ```ts
 * const signaling = new SignalingAdapterHub({ url: location.origin });
 * const network = createBrowserNetwork({ signaling });
 * await network.start();
 * ```
 */
export function createBrowserNetwork(options: CreateBrowserNetworkOptions): WebTCPNetwork {
    const channel = new BrowserWebRTCChannel(options.signaling, {
        ...(options.iceServers ? { iceServers: options.iceServers } : {}),
        ...(options.dataChannelLabel ? { dataChannelLabel: options.dataChannelLabel } : {}),
        ...(options.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: options.connectTimeoutMs }
            : {}),
    });

    return new WebTCPNetwork({
        ...options,
        channel,
        nodeId: options.nodeId ?? options.signaling.getLocalNodeId(),
    });
}
