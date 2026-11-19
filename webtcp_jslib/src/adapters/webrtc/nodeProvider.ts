/**
 * Node.js 向け WebRTC 実装の既定プロバイダ解決（#52 / specification.md §17.5）。
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
import { resolveLogger } from '../../core/util/Logger.js';
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
    const createPeerConnection =
        options.createPeerConnection ??
        (await resolveNodeRTCProvider({ ...(options.rtcPackages ? { packages: options.rtcPackages } : {}) }))
            .createPeerConnection;

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
