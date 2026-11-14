/**
 * テスト用の最小 RTCPeerConnection / RTCDataChannel。
 *
 * 実際の WebRTC スタック（SDP / ICE / SCTP）は使わず、Offer/Answer の受け渡しと
 * データチャネルの開設・メッセージ配送だけを模倣する。
 * `WebRTCChannel` のシグナリング手順とデータ経路を Node.js 上で検証するために使う。
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
    constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.connectionState = 'new';
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.ondatachannel = null;
        this.localChannel = null;
        this.remoteOfferId = null;
    }

    createDataChannel(label) {
        this.localChannel = new FakeDataChannel(label);
        return this.localChannel;
    }

    async createOffer() {
        const offerId = `offer-${nextId++}`;
        this.offerId = offerId;
        return { type: 'offer', sdp: JSON.stringify({ offerId }) };
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
            offers.set(parsed.offerId, entry);
            return;
        }

        this.remoteDescription = description;
        const entry = offers.get(parsed.answerFor);
        if (!entry?.answerer) {
            throw new Error('no answerer registered for this offer');
        }
        this.connectTo(entry.answerer);
    }

    async addIceCandidate() {
        // ICE は模倣しない
    }

    connectTo(answerer) {
        this.connectionState = 'connected';
        answerer.connectionState = 'connected';

        const offererChannel = this.localChannel;
        const answererChannel = new FakeDataChannel(offererChannel?.label ?? 'webtcp');
        if (offererChannel) {
            offererChannel.remote = answererChannel;
            answererChannel.remote = offererChannel;
        }

        setTimeout(() => {
            this.onconnectionstatechange?.({});
            answerer.onconnectionstatechange?.({});

            if (answererChannel && answerer.ondatachannel) {
                answerer.ondatachannel({ channel: answererChannel });
            }

            offererChannel?.open();
            answererChannel?.open();
        }, 0);
    }

    close() {
        const wasConnected = this.connectionState !== 'new' && this.connectionState !== 'closed';
        this.connectionState = 'closed';
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
