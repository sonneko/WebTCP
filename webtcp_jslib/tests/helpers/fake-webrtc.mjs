/**
 * テスト用の最小 RTCPeerConnection / RTCDataChannel。
 *
 * 実際の WebRTC スタック（SDP / ICE / SCTP）は使わず、Offer/Answer の受け渡し、
 * ICE 再起動の再ネゴシエーション、`setConfiguration`、およびデータチャネルの開設・
 * メッセージ配送を模倣する。
 */

const offers = new Map();
let nextId = 1;

class FakeDataChannel {
    constructor(label) {
        this.label = label;
        this.readyState = 'connecting';
        this.binaryType = 'blob';
        this.remote = null;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
    }

    send(data) {
        if (this.readyState !== 'open') {
            throw new Error('DataChannel is not open');
        }

        const buffer =
            data instanceof ArrayBuffer
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        setTimeout(() => {
            this.remote?.onmessage?.({ data: buffer });
        }, 0);
    }

    close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        setTimeout(() => {
            this.onclose?.({});
            this.remote?.handleRemoteClose?.();
        }, 0);
    }

    handleRemoteClose() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.onclose?.({});
    }

    open() {
        if (this.readyState === 'open') return;
        this.readyState = 'open';
        this.onopen?.({});
    }
}

export class FakeRTCPeerConnection {
    constructor(config = {}) {
        this.configuration = config;
        this.configurations = [config];
        this.localDescription = null;
        this.remoteDescription = null;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.oniceconnectionstatechange = null;
        this.ondatachannel = null;
        this.localChannel = null;
        this.remotePeer = null;
        this.remoteOfferId = null;
        this.restartIceCalls = 0;
        this.iceRestartOffersCreated = 0;
        /** ICE 再起動が成功するか（テストで失敗シナリオを再現したい場合に false）。 */
        this.failIceRestarts = false;
    }

    setConfiguration(config) {
        this.configuration = config;
        this.configurations.push(config);
    }

    restartIce() {
        this.restartIceCalls += 1;
    }

    createDataChannel(label) {
        this.localChannel = new FakeDataChannel(label);
        return this.localChannel;
    }

    async createOffer(options = {}) {
        const offerId = `offer-${nextId++}`;
        this.offerId = offerId;
        const iceRestart = Boolean(options?.iceRestart);
        if (iceRestart) {
            this.iceRestartOffersCreated += 1;
        }
        return { type: 'offer', sdp: JSON.stringify({ offerId, iceRestart }) };
    }

    async createAnswer() {
        return { type: 'answer', sdp: JSON.stringify({ answerFor: this.remoteOfferId }) };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
    }

    async setRemoteDescription(description) {
        const parsed = JSON.parse(description.sdp);

        if (description.type === 'offer') {
            this.remoteOfferId = parsed.offerId;
            this.remoteDescription = description;

            const entry = offers.get(parsed.offerId) ?? {};
            entry.answerer = this;
            entry.iceRestart = Boolean(parsed.iceRestart);
            offers.set(parsed.offerId, entry);
            return;
        }

        this.remoteDescription = description;
        const entry = offers.get(parsed.answerFor);
        if (!entry?.answerer) {
            throw new Error('no answerer registered for this offer');
        }

        if (entry.iceRestart) {
            this.completeIceRestart(entry.answerer);
            return;
        }

        this.connectTo(entry.answerer);
    }

    async addIceCandidate() {
        // ICE candidate 配送は省略
    }

    connectTo(answerer) {
        this.remotePeer = answerer;
        answerer.remotePeer = this;
        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        answerer.connectionState = 'connected';
        answerer.iceConnectionState = 'connected';

        const offererChannel = this.localChannel;
        const answererChannel = new FakeDataChannel(offererChannel?.label ?? 'webtcp');
        if (offererChannel) {
            offererChannel.remote = answererChannel;
            answererChannel.remote = offererChannel;
        }

        setTimeout(() => {
            this.oniceconnectionstatechange?.({});
            answerer.oniceconnectionstatechange?.({});
            this.onconnectionstatechange?.({});
            answerer.onconnectionstatechange?.({});

            if (answererChannel && answerer.ondatachannel) {
                answerer.ondatachannel({ channel: answererChannel });
            }

            offererChannel?.open();
            answererChannel?.open();
        }, 0);
    }

    completeIceRestart(answerer) {
        if (this.failIceRestarts) {
            setTimeout(() => {
                this.iceConnectionState = 'failed';
                this.oniceconnectionstatechange?.({});
            }, 0);
            return;
        }

        this.connectionState = 'connected';
        this.iceConnectionState = 'connected';
        answerer.connectionState = 'connected';
        answerer.iceConnectionState = 'connected';

        setTimeout(() => {
            this.oniceconnectionstatechange?.({});
            answerer.oniceconnectionstatechange?.({});
            this.onconnectionstatechange?.({});
            answerer.onconnectionstatechange?.({});
        }, 0);
    }

    /** テスト用: ICE 障害を発生させる。 */
    simulateIceState(iceState) {
        this.iceConnectionState = iceState;
        this.oniceconnectionstatechange?.({});
    }

    close() {
        const wasConnected = this.connectionState !== 'new' && this.connectionState !== 'closed';
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.localChannel?.close();
        if (wasConnected) {
            setTimeout(() => this.onconnectionstatechange?.({}), 0);
        }
    }
}

/** テスト間で状態を共有しないようリセットする。 */
export function resetFakeWebRTC() {
    offers.clear();
    nextId = 1;
}
