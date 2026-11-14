import { ISignalingAdapter } from '../../core/link/ISignalingAdapter.js';
import { WebRTCChannel, WebRTCChannelOptions } from './WebRTCChannel.js';

export interface NodeWebRTCChannelOptions extends WebRTCChannelOptions {
    /**
     * `RTCPeerConnection` を生成する関数。
     *
     * 依存パッケージを増やさないため、`wrtc` や `node-datachannel` などの
     * 実装は利用者が注入する。
     *
     * @example
     * ```ts
     * import wrtc from '@roamhq/wrtc';
     * const channel = new NodeWebRTCChannel(signaling, {
     *   createPeerConnection: () => new wrtc.RTCPeerConnection(),
     * });
     * ```
     */
    createPeerConnection: () => RTCPeerConnection;
}

/**
 * Node.js 用の WebRTC チャネル。
 *
 * WebRTC 実装を注入することで、コアにネイティブ依存を持ち込まない。
 */
export class NodeWebRTCChannel extends WebRTCChannel {
    private readonly factory: () => RTCPeerConnection;

    constructor(signaling: ISignalingAdapter, options: NodeWebRTCChannelOptions) {
        super(signaling, options);
        if (typeof options.createPeerConnection !== 'function') {
            throw new Error('NodeWebRTCChannel requires a createPeerConnection function');
        }
        this.factory = options.createPeerConnection;
    }

    protected createPeerConnection(): RTCPeerConnection {
        return this.factory();
    }
}
