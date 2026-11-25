import { ISignalingAdapter } from '../../core/link/ISignalingAdapter.js';
import { WebRTCChannel, WebRTCChannelOptions } from './WebRTCChannel.js';

export interface NodeWebRTCChannelOptions extends WebRTCChannelOptions {
    /**
     * `RTCPeerConnection` を生成する関数。
     *
     * 依存パッケージを増やさないため、`wrtc` や `node-datachannel` などの
     * 実装は利用者が注入する。解決済みの `RTCConfiguration`（`iceServers`）が渡される。
     *
     * @example
     * ```ts
     * import wrtc from '@roamhq/wrtc';
     * const channel = new NodeWebRTCChannel(signaling, {
     *   iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
     *   createPeerConnection: (config) => new wrtc.RTCPeerConnection(config),
     * });
     * ```
     */
    createPeerConnection: (config?: RTCConfiguration) => RTCPeerConnection;
}

/**
 * Node.js 用の WebRTC チャネル。
 *
 * WebRTC 実装を注入することで、コアにネイティブ依存を持ち込まない。
 */
export class NodeWebRTCChannel extends WebRTCChannel {
    private readonly factory: (config?: RTCConfiguration) => RTCPeerConnection;

    constructor(signaling: ISignalingAdapter, options: NodeWebRTCChannelOptions) {
        super(signaling, options);
        if (typeof options.createPeerConnection !== 'function') {
            throw new Error(
                'NodeWebRTCChannel requires a createPeerConnection function (or use createNodeNetwork(), which resolves @roamhq/wrtc / node-datachannel)',
            );
        }
        this.factory = options.createPeerConnection;
    }

    protected createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
        return this.factory({ iceServers });
    }

    /**
     * 収集が完了しても ICE 候補が 1 件も無いとき、タイムアウトの原因として bind の設定を示す（#61）。
     * 候補の判定は収集完了後の SDP で行う（{@link watchIceGathering} と同じ基準）。
     */
    protected override describeConnectTimeout(connection: RTCPeerConnection): string {
        if (connection.iceGatheringState !== 'complete') return '';
        if (/^a=candidate:/m.test(connection.localDescription?.sdp ?? '')) return '';
        return (
            ' (ICE gathering finished with 0 local candidates. This happens with node-datachannel when the host has ' +
            'only link-local addresses; set peerConnectionOptions.bindAddress, e.g. 127.0.0.1 for same-host use. ' +
            'See https://github.com/sonneko/WebTCP/issues/61)'
        );
    }
}
