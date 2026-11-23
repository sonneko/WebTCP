import { BinaryPacketSerializer, IPacketSerializer } from '../types/serializer.js';
import { WebTCPPacket } from '../types/packet.js';
import { NodeId } from '../types/protocol.js';
import { EventEmitter } from '../util/EventEmitter.js';
import { Logger, createScopedLogger, defaultLogger } from '../util/Logger.js';
import { ChannelConnectOptions, IChannel } from './IChannel.js';
import { throwIfAborted } from '../util/abort.js';

/**
 * リンク層のメインコントローラー。
 *
 * 責務は次の2つだけである。
 * 1. `IChannel` の接続状態を監視し、隣接ノード集合を維持する。
 * 2. `WebTCPPacket` とバイト列の相互変換を行い、`IChannel` へ送る / から受け取る。
 *
 * シグナリングは `IChannel` の実装が内部で扱う。ルーティング情報も
 * `RT_UPDATE` パケットとしてこの層を通るため、シリアライズ経路は1本になる。
 *
 * イベント:
 * - `packet` (packet: WebTCPPacket, fromId: NodeId, rawBytes: Uint8Array)
 * - `neighbor-connected` (peerId: NodeId)
 * - `neighbor-disconnected` (peerId: NodeId)
 */
export class LinkManager extends EventEmitter {
    public readonly localNodeId: NodeId;

    private readonly channel: IChannel;
    private readonly serializer: IPacketSerializer;
    private readonly logger: Logger;

    private started = false;
    private closed = false;
    private listenersAttached = false;

    constructor(
        localNodeId: NodeId,
        channel: IChannel,
        serializer: IPacketSerializer = new BinaryPacketSerializer(),
        logger: Logger = defaultLogger,
    ) {
        super(logger);
        this.localNodeId = localNodeId;
        this.channel = channel;
        this.serializer = serializer;
        this.logger = createScopedLogger(logger, 'LM');
    }

    /**
     * チャネルを開始し、受信イベントを購読する。
     * 二重呼び出しは無視される（冪等）。
     */
    public async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        if (!this.listenersAttached) {
            this.channel.on('data', (fromId, data) => this.handleChannelData(fromId, data));
            this.channel.on('connection-status', (peerId, isConnected) =>
                this.handleConnectionStatus(peerId, isConnected),
            );
            this.listenersAttached = true;
        }

        try {
            await this.channel.start();
        } catch (error) {
            this.started = false;
            throw error;
        }
        this.logger.info(`LinkManager started (nodeId=${this.localNodeId})`);
    }

    /** 現在接続済みの隣接ノードIDを返す。 */
    public getActiveNeighbors(): NodeId[] {
        const neighbors: NodeId[] = [];
        this.channel.connectedPeers.forEach((isConnected, peerId) => {
            if (isConnected) neighbors.push(peerId);
        });
        return neighbors;
    }

    /** 指定ノードが直接接続された隣接ノードかどうか。 */
    public isNeighbor(peerId: NodeId): boolean {
        return this.channel.connectedPeers.get(peerId) === true;
    }

    /**
     * 隣接ノードへのリンク確立を要求する。
     * すでに接続済みの場合は何もしない。
     */
    public async connectToNeighbor(peerId: NodeId, options: ChannelConnectOptions = {}): Promise<void> {
        if (this.closed) {
            throw new Error('LinkManager is closed');
        }
        if (peerId === this.localNodeId) {
            throw new Error('Cannot connect to self');
        }
        if (this.isNeighbor(peerId)) return;
        throwIfAborted(options.signal, `Connection to neighbor ${peerId} aborted`);
        this.logger.debug(`Connecting to neighbor ${peerId}`);
        await this.channel.connect(peerId, options);
    }

    /**
     * パケットを隣接ノードへ送信する。
     * @returns 送信キューへ投入できたら true
     */
    public async sendPacketToNeighbor(neighborId: NodeId, packet: WebTCPPacket): Promise<boolean> {
        if (this.closed) return false;

        let data: Uint8Array;
        try {
            data = this.serializer.serialize(packet);
        } catch (error) {
            this.logger.error(`Failed to serialize packet for ${neighborId}:`, error);
            return false;
        }

        try {
            await this.channel.send(neighborId, data);
            return true;
        } catch (error) {
            this.logger.error(`Failed to send packet to ${neighborId}:`, error);
            return false;
        }
    }

    /** チャネルを閉じる。 */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.channel.close();
        this.removeAllListeners();
    }

    private handleConnectionStatus(peerId: NodeId, isConnected: boolean): void {
        if (this.closed || !this.started) return;
        if (isConnected) {
            this.logger.info(`Neighbor connected: ${peerId}`);
            this.emit('neighbor-connected', peerId);
        } else {
            this.logger.info(`Neighbor disconnected: ${peerId}`);
            this.emit('neighbor-disconnected', peerId);
        }
    }

    private handleChannelData(fromId: NodeId, data: Uint8Array): void {
        if (this.closed || !this.started) return;

        let packet: WebTCPPacket;
        try {
            packet = this.serializer.deserialize(data);
        } catch (error) {
            this.logger.warn(`Dropping malformed packet from ${fromId}:`, error);
            return;
        }

        // 署名検証はシリアライズ済みバイト列（署名フィールドを除く）に対して行うため、
        // 受信した生バイト列も一緒に上位へ渡す（#28, specification.md §11.3）。
        this.emit('packet', packet, fromId, data);
    }
}
