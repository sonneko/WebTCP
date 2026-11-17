import type { NameServer } from '../../core/naming/NameServer.js';
import type { WebTCPNetwork } from '../../core/network/WebTCPNetwork.js';
import type { NodeId } from '../../core/types/protocol.js';
import type { Logger } from '../../core/util/Logger.js';

/**
 * ブラウザのタブでサービス役を維持するための補助（#51 / specification.md §9.5）。
 *
 * - **Screen Wake Lock**: 画面のスリープでタブが止まるのを抑える（対応ブラウザのみ）。
 * - **無音オーディオ**: 再生中のタブはバックグラウンドで優先されやすい（既定では無効）。
 * - **visibilitychange**: 前面に戻ったら切れた隣接へ再接続する。
 * - **pagehide**: 離脱前に状態を保存し、`onPageHide` で利用者がストリームを `close()` する。
 *
 * これらは「止まらないこと」を保証しない。ブラウザが凍結・破棄したタブは
 * 再読み込み後に `restoreState()` で復元する。
 */
export interface BrowserKeepAliveOptions {
    /** Screen Wake Lock を取得する（既定 true）。非対応環境では何もしない。 */
    wakeLock?: boolean;
    /** 無音オーディオを再生する（既定 false。ユーザー操作の後でのみ再生が始まる）。 */
    silentAudio?: boolean;
    /** 前面復帰時に呼ばれる。省略時は切れた隣接へ `connectToPeer()` する。 */
    onResume?: () => void;
    /** `pagehide` で呼ばれる。ここで有効なストリームを `close()` する（破棄ではなく終了ハンドシェイク）。 */
    onPageHide?: () => void;
    /** `pagehide` 時に状態を保存する対象の NameServer（任意）。`stateStorage` が必要。 */
    nameServer?: NameServer;
    /** 監視対象のドキュメント（テスト用に差し替え可能）。既定 `globalThis.document`。 */
    document?: EventTarget & { visibilityState?: string };
    /** `pagehide` を受け取るウィンドウ（既定 `globalThis`）。 */
    windowTarget?: EventTarget;
    /** Navigator（既定 `globalThis.navigator`）。 */
    navigator?: { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };
    /** AudioContext のコンストラクタ（既定 `globalThis.AudioContext`）。 */
    audioContextFactory?: (() => AudioContextLike) | null;
    logger?: Logger;
}

export interface WakeLockLike {
    released?: boolean;
    release(): Promise<void>;
    addEventListener?(type: 'release', listener: () => void): void;
}

export interface AudioContextLike {
    state?: string;
    resume?(): Promise<void>;
    createOscillator(): { connect(node: unknown): unknown; start(): void; stop(): void };
    createGain(): { gain: { value: number }; connect(node: unknown): unknown };
    readonly destination: unknown;
    close?(): Promise<void>;
}

export interface KeepAliveHandle {
    readonly wakeLockActive: boolean;
    readonly audioActive: boolean;
    /** 監視を解除し、取得したリソースを解放する。 */
    stop(): void;
}

export function startBrowserKeepAlive(
    network: WebTCPNetwork,
    options: BrowserKeepAliveOptions = {},
): KeepAliveHandle {
    const doc = options.document ?? (globalThis as { document?: EventTarget & { visibilityState?: string } }).document;
    const win = options.windowTarget ?? (globalThis as unknown as EventTarget);
    const nav = options.navigator ?? (globalThis as { navigator?: BrowserKeepAliveOptions['navigator'] }).navigator;
    const lost = new Set<NodeId>();
    let stopped = false;
    let wakeLock: WakeLockLike | null = null;
    let audio: AudioContextLike | null = null;

    const onDisconnected = (peerId: NodeId): void => {
        lost.add(peerId);
    };
    const onConnected = (peerId: NodeId): void => {
        lost.delete(peerId);
    };

    const reconnect = (): void => {
        if (options.onResume) {
            options.onResume();
            return;
        }
        for (const peerId of [...lost]) {
            if (network.linkManager.isNeighbor(peerId)) {
                lost.delete(peerId);
                continue;
            }
            network.connectToPeer(peerId).then(
                () => lost.delete(peerId),
                (error) => network.logger.warn(`keep-alive reconnect to ${peerId} failed:`, error),
            );
        }
    };

    const acquireWakeLock = async (): Promise<void> => {
        if (options.wakeLock === false || !nav?.wakeLock || stopped) return;
        try {
            wakeLock = await nav.wakeLock.request('screen');
        } catch (error) {
            wakeLock = null;
            options.logger?.debug('Screen Wake Lock unavailable:', error);
        }
    };

    const startAudio = (): void => {
        if (!options.silentAudio || audio || stopped) return;
        const factory =
            options.audioContextFactory === undefined
                ? (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext
                    ? () => new ((globalThis as { AudioContext: new () => AudioContextLike }).AudioContext)()
                    : null
                : options.audioContextFactory;
        if (!factory) return;
        try {
            const ctx = factory();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            audio = ctx;
        } catch (error) {
            options.logger?.debug('silent audio keep-alive unavailable:', error);
        }
    };

    const onVisibility = (): void => {
        if (stopped || doc?.visibilityState !== 'visible') return;
        void acquireWakeLock();
        reconnect();
    };

    const onPageHide = (): void => {
        if (stopped) return;
        if (options.nameServer || options.onPageHide) {
            // 同期的な終了処理（close ハンドシェイク）を優先する
            options.onPageHide?.();
        }
        if (options.nameServer) {
            void network.persistState({ nameServer: options.nameServer }).catch((error) => {
                network.logger.warn('failed to persist service state on pagehide:', error);
            });
        }
    };

    network.on('neighbor-disconnected', onDisconnected);
    network.on('neighbor-connected', onConnected);
    doc?.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('pagehide', onPageHide);

    void acquireWakeLock();
    startAudio();

    return {
        get wakeLockActive() {
            return wakeLock !== null && !wakeLock.released;
        },
        get audioActive() {
            return audio !== null;
        },
        stop(): void {
            if (stopped) return;
            stopped = true;
            network.off('neighbor-disconnected', onDisconnected);
            network.off('neighbor-connected', onConnected);
            doc?.removeEventListener('visibilitychange', onVisibility);
            win.removeEventListener('pagehide', onPageHide);
            void wakeLock?.release().catch(() => undefined);
            wakeLock = null;
            void audio?.close?.().catch(() => undefined);
            audio = null;
        },
    };
}
