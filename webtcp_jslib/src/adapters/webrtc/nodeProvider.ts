/**
 * Node.js 向け WebRTC 実装の既定プロバイダ解決（#52 / specification.md §19.8）。
 *
 * WebTCP 本体は WebRTC 実装を同梱しない。利用者が次のいずれかを `npm install` すれば、
 * 既定の解決順（`@roamhq/wrtc` → `node-datachannel/polyfill`）で自動的に使われる。
 * どちらも無ければ `WebRTCProviderUnavailableError` を投げる（黙って失敗しない）。
 */
import type { ISignalingAdapter } from '../../core/link/ISignalingAdapter.js';
import type { WebTCPNetwork, WebTCPNetworkOptions } from '../../core/network/WebTCPNetwork.js';
import { WebTCPNetwork as WebTCPNetworkClass } from '../../core/network/WebTCPNetwork.js';
import { KeyDirectory } from '../../core/routing/KeyDirectory.js';
import { Ed25519PacketVerifier } from '../../core/routing/PacketVerifier.js';
import type { Ed25519KeyManager } from '../../core/routing/keys.js';
import { resolveLogger, type Logger } from '../../core/util/Logger.js';
import { NodeWebRTCChannel } from './NodeWebRTCChannel.js';
import type { IceServersProvider } from './WebRTCChannel.js';

/** 既定の解決順（先に見つかったものを使う）。 */
export const DEFAULT_NODE_RTC_PACKAGES: readonly string[] = ['@roamhq/wrtc', 'node-datachannel/polyfill'];

export type PeerConnectionFactory = (config?: RTCConfiguration) => RTCPeerConnection;

export interface NodeRTCProvider {
    /** 解決に使ったモジュール名。 */
    readonly name: string;
    readonly createPeerConnection: PeerConnectionFactory;
}

export interface ResolveNodeRTCProviderOptions {
    /** 試すモジュール名の順序。既定 {@link DEFAULT_NODE_RTC_PACKAGES}。 */
    packages?: readonly string[];
    /** テスト用の動的 import の差し替え。 */
    importer?: (specifier: string) => Promise<unknown>;
}

/** 利用可能な WebRTC 実装が見つからないときのエラー（型付き）。 */
export class WebRTCProviderUnavailableError extends Error {
    public readonly tried: readonly string[];

    constructor(tried: readonly string[], reasons: readonly string[]) {
        super(
            `No Node.js WebRTC implementation is available (tried: ${tried.join(', ')}). ` +
                'Install one, for example `npm install @roamhq/wrtc` or `npm install node-datachannel`. ' +
                `Details: ${reasons.join('; ')}`,
        );
        this.name = 'WebRTCProviderUnavailableError';
        this.tried = [...tried];
    }
}

const defaultImporter = (specifier: string): Promise<unknown> => import(specifier);

function pickPeerConnection(mod: unknown): PeerConnectionFactory | null {
    const candidates = [
        (mod as { RTCPeerConnection?: unknown })?.RTCPeerConnection,
        (mod as { default?: { RTCPeerConnection?: unknown } })?.default?.RTCPeerConnection,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'function') {
            const ctor = candidate as new (config?: RTCConfiguration) => RTCPeerConnection;
            return (config) => new ctor(config);
        }
    }
    return null;
}

/**
 * 既定の順で `RTCPeerConnection` 実装を探す。
 *
 * `node-datachannel/polyfill` のようにグローバルへ差し込むタイプは、import 後に
 * `globalThis.RTCPeerConnection` を読む。
 */
export async function resolveNodeRTCProvider(
    options: ResolveNodeRTCProviderOptions = {},
): Promise<NodeRTCProvider> {
    const packages = options.packages ?? DEFAULT_NODE_RTC_PACKAGES;
    const importer = options.importer ?? defaultImporter;
    const reasons: string[] = [];
    for (const name of packages) {
        try {
            const mod = await importer(name);
            const factory =
                pickPeerConnection(mod) ??
                (typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function'
                    ? pickPeerConnection({
                          RTCPeerConnection: (globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection,
                      })
                    : null);
            if (factory) return { name, createPeerConnection: factory };
            reasons.push(`${name}: loaded but exposes no RTCPeerConnection`);
        } catch (error) {
            reasons.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
    }
    throw new WebRTCProviderUnavailableError(packages, reasons);
}

export interface CreateNodeNetworkOptions
    extends Omit<WebTCPNetworkOptions, 'channel' | 'signaling' | 'nodeId'> {
    /** シグナリングアダプタ（必須）。 */
    signaling: ISignalingAdapter;
    /** Ed25519 鍵管理（推奨。指定すると v2・署名必須）。 */
    keyManager?: Ed25519KeyManager;
    /** ノードID。省略時は鍵管理の指紋、またはシグナリングのIDを使う。 */
    nodeId?: string;
    iceServers?: RTCIceServer[];
    iceServersProvider?: IceServersProvider;
    /** 注入する `RTCPeerConnection` 生成関数。省略時は {@link resolveNodeRTCProvider}。 */
    createPeerConnection?: PeerConnectionFactory;
    /**
     * 実装固有の設定を `RTCConfiguration` へ追加でマージする（例: `node-datachannel` の `bindAddress`）。
     * ICE の候補収集をホストの実インターフェース選択に任せられない環境（リンクローカルのみ、
     * 単一ホストのテスト等）で使う。
     */
    peerConnectionOptions?: Record<string, unknown>;
    /** 既定解決で試すモジュール名（省略時は {@link DEFAULT_NODE_RTC_PACKAGES}）。 */
    rtcPackages?: readonly string[];
    connectTimeoutMs?: number;
    maxIceRestarts?: number;
    iceRestartDelayMs?: number;
}

/**
 * Node.js 用の `WebTCPNetwork` を組み立てる（`createBrowserNetwork` の Node 版、#52）。
 *
 * WebRTC 実装は `createPeerConnection` で注入するか、既定の解決（`npm` で入れた
 * `@roamhq/wrtc` / `node-datachannel`）に任せる。どちらも無ければ型付きエラー。
 */
export async function createNodeNetwork(options: CreateNodeNetworkOptions): Promise<WebTCPNetwork> {
    const logger = resolveLogger(options.logger, options.logLevel);
    const factory =
        options.createPeerConnection ??
        (await resolveNodeRTCProvider({ ...(options.rtcPackages ? { packages: options.rtcPackages } : {}) }))
            .createPeerConnection;
    const createPeerConnection = wrapNodePeerConnection(factory, logger);

    const extra = options.peerConnectionOptions ?? {};
    const keyDirectory =
        options.keyDirectory ??
        (options.keyManager || options.verifier instanceof Ed25519PacketVerifier
            ? new KeyDirectory({ logger })
            : undefined);

    const channel = new NodeWebRTCChannel(options.signaling, {
        createPeerConnection: (config) =>
            createPeerConnection({ ...(config ?? {}), ...extra } as RTCConfiguration),
        logger,
        ...(options.iceServers ? { iceServers: options.iceServers } : {}),
        ...(options.iceServersProvider ? { iceServersProvider: options.iceServersProvider } : {}),
        ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
        ...(options.maxIceRestarts !== undefined ? { maxIceRestarts: options.maxIceRestarts } : {}),
        ...(options.iceRestartDelayMs !== undefined ? { iceRestartDelayMs: options.iceRestartDelayMs } : {}),
        ...(options.keyManager ? { keyManager: options.keyManager } : {}),
        ...(keyDirectory ? { keyDirectory } : {}),
    });

    return new WebTCPNetworkClass({
        ...options,
        logger,
        channel,
        nodeId: options.nodeId ?? options.keyManager?.nodeId ?? options.signaling.getLocalNodeId(),
        ...(keyDirectory ? { keyDirectory } : {}),
    });
}

/**
 * ICE 候補を 1 件も集めずに収集が完了したら警告する（#61）。
 *
 * `node-datachannel` は、バインド先が任意アドレス（既定）のとき、非ループバックのインターフェースが
 * リンクローカル（169.254.x.x）のみのホストで候補を 0 件にすることがある。その場合 DataChannel は開かず、
 * 接続は ICE のタイムアウトで失敗する。既定値は変えず（実ネットワークで候補が減るため）、原因を利用者に示す。
 * 判定は収集状態の遷移だけに依存するため、どの実装にも同じ規則で適用できる。
 */
export function watchIceGathering(pc: RTCPeerConnection, logger: Logger): RTCPeerConnection {
    let warned = false;
    const target = pc as unknown as EventTarget;
    if (typeof target.addEventListener !== 'function') return pc;
    target.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState !== 'complete' || warned) return;
        // 候補の数は SDP（収集完了後の localDescription）で数える。
        // `icecandidate` の配送は実装ごとに異なる。node-datachannel/polyfill は収集を createDataChannel()
        // の時点で始めて候補を再送しないため、生成直後に登録しないリスナーには候補が届かない（#67）。
        // イベントには依存しない。
        const sdp = pc.localDescription?.sdp ?? '';
        if (/^a=candidate:/m.test(sdp)) return;
        warned = true;
        logger.warn(
            '[webrtc] ICE gathering finished with 0 local candidates. ' +
                'Set peerConnectionOptions.bindAddress (e.g. the host address of a non-link-local interface, or 127.0.0.1 for same-host tests). ' +
                'See https://github.com/sonneko/WebTCP/issues/61',
        );
    });
    return pc;
}

/**
 * `createNodeNetwork()` が生成するすべての PC に適用する共通の包み（#61 の収集完了の警告、#67 の橋渡し）。
 * 注入された factory も同じ経路を通る。
 */
export function wrapNodePeerConnection(factory: PeerConnectionFactory, logger: Logger): PeerConnectionFactory {
    return (config) => watchIceGathering(bridgeIceCandidateEvents(factory(config)), logger);
}

/** `icecandidate` の終了マーカー（`candidate === null`）を待つ上限（1 ms 刻みの確認回数）。 */
const MAX_END_MARKER_CHECKS = 200;

const countCandidateLines = (sdp: string): number => (sdp.match(/^a=candidate:/gm) ?? []).length;

/**
 * `icecandidate` の候補と終了マーカーを、リスナーの登録タイミングに関係なく届ける（#67 / 設計 §3.38）。
 *
 * `node-datachannel/polyfill` は候補イベントを再送せず、終了時の `candidate === null` も送らない（上流）。
 * 生成直後に記録を始め、後から登録された `addEventListener` のリスナーと `onicecandidate` へ、
 * 既に発行された候補を順に渡す。収集完了後は SDP の候補数に達してから `null` を 1 回発行する。
 * ネイティブが自前で `null` を発行する場合はそれを使い、二重に出さない。
 * 生の PC（`createNodeNetwork()` を通さないもの）には適用しない。
 */
export function bridgeIceCandidateEvents(pc: RTCPeerConnection): RTCPeerConnection {
    const target = pc as unknown as EventTarget & {
        iceGatheringState: RTCIceGatheringState;
        localDescription: RTCSessionDescription | null;
        connectionState?: string;
        onicecandidate: ((event: Event) => void) | null;
    };
    if (typeof target.addEventListener !== 'function' || typeof target.dispatchEvent !== 'function') return pc;

    const nativeAdd = target.addEventListener;
    const nativeRemove = target.removeEventListener;
    const nativeDispatch = target.dispatchEvent;

    let events: Event[] = [];
    let ended = false;
    let endScheduled = false;
    /** ハンドラごとに、既に渡した件数（`onicecandidate` の再代入で重複させないため）。 */
    let handlerCounts = new WeakMap<object, number>();
    const registered = new Set<unknown>();
    /** `once` で登録したリスナーの、ネイティブ登録用のラッパー（発火時に `registered` から外すため）。 */
    const onceWrappers = new Map<unknown, EventListener>();
    /**
     * リスナーごとの受信済みの位置（記録された候補の件数）。登録・再登録のたびに、ここから先の未受信の候補を配送する（#83）。
     * 記録は PC 単位で共有されるため、位置はリスナー側に持つ。
     */
    let cursors = new WeakMap<object, number>();
    let currentHandler: ((event: Event) => void) | null = target.onicecandidate ?? null;

    const deliver = (listener: unknown, event: Event): void => {
        if (typeof listener === 'function') {
            (listener as (this: EventTarget, e: Event) => void).call(target, event);
        } else if (listener && typeof (listener as EventListenerObject).handleEvent === 'function') {
            (listener as EventListenerObject).handleEvent(event);
        }
    };
    const candidateCount = (): number => events.filter((e) => (e as Event & { candidate: unknown }).candidate !== null).length;
    const startRound = (): void => {
        events = [];
        ended = false;
        endScheduled = false;
        handlerCounts = new WeakMap<object, number>();
        cursors = new WeakMap<object, number>();
    };

    // 記録: 発行の時点で記録し、その後にネイティブの配送（登録済みリスナーと onicecandidate）を行う。
    target.dispatchEvent = function (this: EventTarget, event: Event): boolean {
        if (event.type === 'icecandidate' && !ended) {
            events.push(event);
            if ((event as Event & { candidate: unknown }).candidate === null) ended = true;
            if (currentHandler) handlerCounts.set(currentHandler, events.length);
        }
        return nativeDispatch.call(this, event);
    };

    // 後から代入された onicecandidate へ、未受信の分を渡す。
    Object.defineProperty(target, 'onicecandidate', {
        configurable: true,
        enumerable: true,
        get: () => currentHandler,
        set: (handler: unknown) => {
            currentHandler = typeof handler === 'function' ? (handler as (event: Event) => void) : null;
            if (!currentHandler) return;
            const start = handlerCounts.get(currentHandler) ?? 0;
            const pending = events.slice(start);
            handlerCounts.set(currentHandler, events.length);
            for (const event of pending) deliver(currentHandler, event);
        },
    });

    // 後から登録されたリスナーへ、既に発行された候補を順に渡す（同じリスナーの二重登録では渡さない）。
    target.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown): void {
        if (type !== 'icecandidate' || !listener) {
            nativeAdd.call(this, type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions);
            return;
        }
        if (registered.has(listener)) return;
        const key = listener as object;
        const once = typeof options === 'object' && options !== null && (options as { once?: boolean }).once === true;
        const from = cursors.get(key) ?? 0;
        if (once && from < events.length) {
            // 未受信の先頭 1 件だけを渡す。ネイティブには登録しない（次の候補は、再登録されるまで渡さない）。
            cursors.set(key, from + 1);
            const pending = events[from];
            if (pending) deliver(listener, pending);
            return;
        }
        registered.add(listener);
        if (once) {
            // DOM と同じく、発火時（コールバックの直前）に除去する。こうすると、コールバック内での再登録も受け付けられる。
            const wrapper = function (this: EventTarget, event: Event): void {
                registered.delete(listener);
                onceWrappers.delete(listener);
                cursors.set(key, events.length);
                if (typeof listener === 'function') {
                    (listener as (this: EventTarget, e: Event) => void).call(this, event);
                } else if (listener && typeof (listener as EventListenerObject).handleEvent === 'function') {
                    (listener as EventListenerObject).handleEvent(event);
                }
            };
            onceWrappers.set(listener, wrapper);
            nativeAdd.call(this, type, wrapper, options as AddEventListenerOptions);
            return;
        }
        nativeAdd.call(this, type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions);
        // 通常のリスナーは、未受信の分（初回は全部、再登録後は取りこぼした分）を渡してから、以後はネイティブで受け取る。
        const pendingAll = events.slice(from);
        cursors.set(key, events.length);
        for (const event of pendingAll) deliver(listener, event);
    };
    target.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown): void {
        if (type === 'icecandidate') {
            // 登録されていたリスナーは、ここまでの候補をすべて受け取っている。再登録時はこの続きから渡す。
            if (registered.has(listener)) cursors.set(listener as object, events.length);
            registered.delete(listener);
            const wrapper = onceWrappers.get(listener);
            onceWrappers.delete(listener);
            nativeRemove.call(this, type, (wrapper ?? listener) as EventListenerOrEventListenerObject, options as EventListenerOptions);
            return;
        }
        nativeRemove.call(this, type, listener as EventListenerOrEventListenerObject, options as EventListenerOptions);
    };

    // 終了マーカー: SDP の候補数に達してから 1 回だけ発行する。
    const emitEnd = (): void => {
        if (ended) return;
        ended = true;
        const end = new Event('icecandidate');
        Object.defineProperty(end, 'candidate', { value: null });
        events.push(end);
        if (currentHandler) handlerCounts.set(currentHandler, events.length);
        nativeDispatch.call(target, end);
    };
    const scheduleEnd = (attempt: number): void => {
        if (ended || target.connectionState === 'closed') return;
        const sdp = target.localDescription?.sdp;
        const expected = typeof sdp === 'string' ? countCandidateLines(sdp) : null;
        if ((expected !== null && candidateCount() >= expected) || attempt >= MAX_END_MARKER_CHECKS) {
            emitEnd();
            return;
        }
        setTimeout(() => scheduleEnd(attempt + 1), 1);
    };
    nativeAdd.call(target, 'icegatheringstatechange', () => {
        if (target.iceGatheringState === 'gathering' && ended) {
            startRound();
            return;
        }
        if (target.iceGatheringState === 'complete' && !endScheduled) {
            endScheduled = true;
            scheduleEnd(0);
        }
    });
    return pc;
}
