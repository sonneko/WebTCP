import { NodeId } from '../types/protocol.js';

/** `IChannel.connect()` のオプション（#44）。 */
export interface ChannelConnectOptions {
    /**
     * 中断用シグナル。中断されたら待機中の接続を打ち切り、`AbortError` で reject する。
     * 中断済みのネゴシエーションは破棄する（他の待機者が残っている場合は共有を保つ）。
     */
    signal?: AbortSignal;
}

/**
 * P2Pリンク層の抽象化インターフェース（specification.md §10.1）。
 *
 * WebRTC DataChannel（またはその他のメッセージ指向のP2P通信手段）を抽象化する。
 * この層は「メッセージの輸送」のみを責務とし、順序保証・再送・多重化は行わない。
 * それらは RoutingLayer / TransportLayer が担う。
 */
export interface IChannel {
    /**
     * 接続済みのピアIDをキーとするマップ。
     * true: 接続完了（DataChannel Open）
     * false: 接続処理中または切断
     */
    readonly connectedPeers: ReadonlyMap<NodeId, boolean>;

    /**
     * シグナリングの受信を開始する。
     * 接続確立に必要なリスナー登録をここで行う。
     */
    start(): Promise<void>;

    /**
     * 指定ノードとのデータチャネルを確立する。
     * @param targetId 接続先ノードID
     * @param options 中断用シグナルなど（#44）
     * @throws タイムアウトまたはシグナリング失敗時。中断時は `AbortError`
     */
    connect(targetId: NodeId, options?: ChannelConnectOptions): Promise<void>;

    /**
     * 確立済みチャネルへ1メッセージを送信する。
     * @param targetId 宛先（直接接続された隣接ノード）
     * @param data シリアライズ済みパケット
     */
    send(targetId: NodeId, data: Uint8Array): Promise<void>;

    /**
     * 指定ノードとのチャネルを閉じる。
     */
    disconnect(targetId: NodeId): void;

    /**
     * すべてのチャネルを閉じる。
     */
    close(): void;

    /** 隣接ノードからデータを受信した。 */
    on(eventName: 'data', listener: (fromId: NodeId, data: Uint8Array) => void): this;
    /** 隣接ノードの接続状態が変化した。 */
    on(
        eventName: 'connection-status',
        listener: (peerId: NodeId, isConnected: boolean) => void,
    ): this;
}
