import { EventEmitter } from 'node:events';

/**
 * テスト用のインメモリ IChannel 実装。
 * WebRTC を介さずに、リンク層〜トランスポート層の end-to-end を検証できる。
 */
export class LoopbackChannel extends EventEmitter {
    constructor(network, nodeId) {
        super();
        this.network = network;
        this.nodeId = nodeId;
        this.connectedPeers = new Map();
        this.closed = false;
        this.setMaxListeners(0);
    }

    async start() {
        // シグナリングは不要
    }

    async connect(targetId) {
        if (this.closed) throw new Error('channel is closed');
        const target = this.network.channels.get(targetId);
        if (!target) throw new Error(`unknown node: ${targetId}`);
        if (this.connectedPeers.get(targetId) === true) return;

        this.connectedPeers.set(targetId, true);
        target.connectedPeers.set(this.nodeId, true);

        queueMicrotask(() => {
            this.emit('connection-status', targetId, true);
            target.emit('connection-status', this.nodeId, true);
        });

        // イベントの配送を待つ
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    async send(targetId, data) {
        const target = this.network.channels.get(targetId);
        if (!target) throw new Error(`no peer: ${targetId}`);
        if (this.connectedPeers.get(targetId) !== true) {
            throw new Error(`not connected to ${targetId}`);
        }

        // ネットワーク越しのコピーを模す
        const copy = new Uint8Array(data);
        await new Promise((resolve) => setTimeout(resolve, 0));
        target.emit('data', this.nodeId, copy);
    }

    disconnect(targetId) {
        const target = this.network.channels.get(targetId);
        if (!target) return;
        if (this.connectedPeers.get(targetId) === true) {
            this.connectedPeers.set(targetId, false);
            target.connectedPeers.set(this.nodeId, false);
            this.emit('connection-status', targetId, false);
            target.emit('connection-status', this.nodeId, false);
        }
    }

    close() {
        for (const peerId of [...this.connectedPeers.keys()]) {
            this.disconnect(peerId);
        }
        this.closed = true;
        this.removeAllListeners();
    }
}

export class LoopbackNetwork {
    constructor() {
        this.channels = new Map();
    }

    createChannel(nodeId) {
        if (this.channels.has(nodeId)) {
            throw new Error(`duplicate nodeId: ${nodeId}`);
        }
        const channel = new LoopbackChannel(this, nodeId);
        this.channels.set(nodeId, channel);
        return channel;
    }
}

/** 条件が満たされるまで待つ。 */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error('waitFor: condition was not met within the timeout');
}

export function decode(data) {
    return new TextDecoder().decode(data);
}
