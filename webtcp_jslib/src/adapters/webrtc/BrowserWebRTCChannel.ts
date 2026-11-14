import { ISignalingAdapter } from '../../core/link/ISignalingAdapter.js';
import { WebRTCChannel, WebRTCChannelOptions } from './WebRTCChannel.js';

/**
 * ブラウザ用の WebRTC チャネル。
 *
 * グローバルの `RTCPeerConnection` を利用する。ブラウザ以外では
 * `NodeWebRTCChannel` を使うか、`createPeerConnection()` を実装した
 * サブクラスを用意する。
 */
export class BrowserWebRTCChannel extends WebRTCChannel {
    constructor(signaling: ISignalingAdapter, options: WebRTCChannelOptions = {}) {
        super(signaling, options);
    }

    protected createPeerConnection(): RTCPeerConnection {
        const PeerConnectionCtor = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection })
            .RTCPeerConnection;

        if (!PeerConnectionCtor) {
            throw new Error(
                'RTCPeerConnection is not available. Use BrowserWebRTCChannel in a browser, ' +
                    'or NodeWebRTCChannel with a WebRTC implementation such as `wrtc`.',
            );
        }

        return new PeerConnectionCtor({
            iceServers: this.options.iceServers ?? [],
        });
    }
}
