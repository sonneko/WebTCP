import { WebTCPPacket } from '../types/packet.js';
import { BinaryPacketSerializer, IPacketSerializer } from '../types/serializer.js';
import {
    ED25519_SIGNATURE_BYTES,
    decodePublicKey,
    isValidNodeId,
    nodeIdMatchesPublicKey,
} from './keys.js';

/**
 * パケットの署名付与・検証を行うインターフェース（specification.md §7.2 / §7.3 / §10）。
 *
 * - 既定実装は `Ed25519PacketVerifier`（プロトコル v2、署名必須）。
 * - `NullPacketVerifier` は署名なしのレガシー実装（v1 相互運用・テスト用）。
 */
export interface IPacketVerifier {
    /**
     * 送信前に署名を付与する。署名が不要な実装はパケットをそのまま返す。
     */
    signPacket(packet: WebTCPPacket): Promise<WebTCPPacket>;

    /**
     * 受信したパケットを検証する。
     * @returns 有効なら true。false の場合、呼び出し側はパケットを破棄しなければならない。
     */
    verifyPacket(packet: WebTCPPacket): Promise<boolean>;

    /**
     * 生の受信バイト列を受け取って検証する（任意）。
     *
     * 実装すると、再シリアライズせずに署名対象バイト列を直接使えるため、
     * `RoutingLayer` はより厳密かつ高速に検証できる。
     * 未実装の場合は `RoutingLayer` が `verifyPacket(packet)` にフォールバックする。
     */
    verifyBytes?(packet: WebTCPPacket, rawBytes: Uint8Array): Promise<boolean>;
}

/**
 * 署名を扱わない検証器（プロトコル v1 のレガシー動作）。
 *
 * セキュリティ保護は一切提供しない。v1 ノードとの相互運用や、
 * 署名なしでネットワーク層を試験する場合にのみ使うこと。
 */
export class NullPacketVerifier implements IPacketVerifier {
    public async signPacket(packet: WebTCPPacket): Promise<WebTCPPacket> {
        return packet;
    }

    public async verifyPacket(_packet: WebTCPPacket): Promise<boolean> {
        return true;
    }

    public async verifyBytes(
        _packet: WebTCPPacket,
        _rawBytes: Uint8Array,
    ): Promise<boolean> {
        return true;
    }
}

/**
 * ノード ID → Ed25519 公開鍵 の解決を行う抽象（specification.md §10.4）。
 *
 * 本ライブラリの `KeyDirectory` が既定実装であり、
 * 分散ストレージ（IPFS 等）から鍵を引く実装に差し替えることもできる。
 */
export interface IPublicKeyResolver {
    /** ノードIDに対応する公開鍵を取得する。未知なら null。 */
    getPublicKey(nodeId: string): Promise<Uint8Array | null>;
    /**
     * 公開鍵の到着を待つ（任意）。実装しない場合はポーリングで待つ。
     * タイムアウト時は `null` を返す。
     */
    waitForPublicKey?(nodeId: string, timeoutMs?: number): Promise<Uint8Array | null>;
}

/** 後方互換のための別名。公開鍵ディレクトリの契約を表す。 */
export type KeyManager = IPublicKeyResolver;

/** `Ed25519PacketVerifier` が要求する鍵管理の最小契約。 */
export interface Ed25519PacketVerifierKeySource {
    /** ローカル秘密鍵でデータに署名する（64 バイトの Ed25519 署名）。 */
    sign(data: Uint8Array): Promise<Uint8Array>;
    /** 公開鍵で署名を検証する。 */
    verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
    /** 公開鍵から NodeId を導出する。 */
    deriveNodeId(publicKey: Uint8Array): Promise<string>;
}

export interface Ed25519PacketVerifierOptions {
    /** 署名・検証を行う鍵管理実装（必須。`BrowserKeyManager` / `NodeKeyManager`）。 */
    keyManager: Ed25519PacketVerifierKeySource;
    /**
     * 公開鍵ディレクトリ（任意）。
     * 未指定の場合はパケット同梱の公開鍵のみで検証する。
     */
    keyDirectory?: IPublicKeyResolver;
    /** 署名対象バイト列の導出に使うシリアライザ。既定 `BinaryPacketSerializer`。 */
    serializer?: IPacketSerializer;
    /**
     * 未知の公開鍵の到着を待つ最大時間（ms）。既定 5000。
     * 0 を指定すると待たずに即座に検証失敗とする。
     *
     * 隣接確立直後は RT_UPDATE（公開鍵つき）や署名交換がまだ届いていないことがあるため、
     * 有限時間だけ待つことで初回パケットの取りこぼしを防ぐ。
     */
    keyWaitTimeoutMs?: number;
}

/**
 * Ed25519 署名の検証器（プロトコル v2、#28）。
 *
 * - **送信時**: 署名フィールドを除くシリアライズ済みパケット（TTL は 0 に正規化）へ
 *   ローカル秘密鍵で署名し、`packet.signature` に 64 バイトの署名を設定する。
 * - **受信時**: `senderId` が「署名を検証できる公開鍵の指紋」と一致することを確認し、
 *   さらに署名そのものを検証する。どちらかが失敗すれば `false` を返し、
 *   `RoutingLayer` はパケットを破棄する（specification.md §10.2）。
 *
 * 公開鍵の解決順序（specification.md §10.4）:
 * 1. 公開鍵ディレクトリ（シグナリング時の交換・RT_UPDATE による学習・手動登録）
 * 2. パケット自体に同梱された公開鍵（RT_UPDATE の `publicKey`。指紋一致を必須とする）
 */
export class Ed25519PacketVerifier implements IPacketVerifier {
    private readonly keys: Ed25519PacketVerifierKeySource;
    private readonly serializer: IPacketSerializer;
    private readonly directory: IPublicKeyResolver | null;
    private readonly keyWaitTimeoutMs: number;

    /** 未知の鍵を待つための待機中プロミス（ノードごとに共有）。 */
    private readonly pendingKeyWaiters = new Map<string, Promise<Uint8Array | null>>();

    constructor(options: Ed25519PacketVerifierOptions) {
        if (!options.keyManager) {
            throw new Error('Ed25519PacketVerifier requires a keyManager');
        }
        this.keys = options.keyManager;
        this.serializer = options.serializer ?? new BinaryPacketSerializer();
        this.directory = options.keyDirectory ?? null;
        this.keyWaitTimeoutMs = Math.max(0, options.keyWaitTimeoutMs ?? 5000);
    }

    /** 送信パケットへ Ed25519 署名を付与する。 */
    public async signPacket(packet: WebTCPPacket): Promise<WebTCPPacket> {
        const signingInput = this.signatureInputFor(packet);
        const signature = await this.keys.sign(signingInput);
        if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
            throw new Error(
                `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes (got ${signature.byteLength})`,
            );
        }
        return { ...packet, signature };
    }

    public async verifyPacket(packet: WebTCPPacket): Promise<boolean> {
        return this.verify(packet, null);
    }

    public async verifyBytes(packet: WebTCPPacket, rawBytes: Uint8Array): Promise<boolean> {
        return this.verify(packet, rawBytes);
    }

    /**
     * 署名対象バイト列（署名フィールドを除き、TTL を 0 に正規化したもの）。
     * specification.md §10.3。
     */
    public signatureInputFor(packet: WebTCPPacket): Uint8Array {
        if (this.serializer.serializeForSigning) {
            return this.serializer.serializeForSigning({ ...packet, ttl: 0 });
        }
        return this.serializer.serialize({
            ...packet,
            version: undefined,
            ttl: 0,
            signature: new Uint8Array(0),
        });
    }

    // =================================================================
    // 内部実装
    // =================================================================

    private async verify(packet: WebTCPPacket, rawBytes: Uint8Array | null): Promise<boolean> {
        if (!isValidNodeId(packet.senderId)) return false;
        if (packet.signature.byteLength !== ED25519_SIGNATURE_BYTES) return false;

        let signingInput: Uint8Array;
        try {
            signingInput = rawBytes
                ? this.signatureInputFromRaw(rawBytes)
                : this.signatureInputFor(packet);
        } catch {
            return false;
        }

        const publicKey = await this.resolvePublicKey(packet);
        if (!publicKey) return false;

        try {
            return await this.keys.verify(publicKey, signingInput, packet.signature);
        } catch {
            return false;
        }
    }

    /**
     * 受信した生バイト列から署名対象バイト列を作る。
     * TTL を 0 に正規化する（中継で減算されるため署名対象外、§10.3）。
     */
    private signatureInputFromRaw(rawBytes: Uint8Array): Uint8Array {
        if (!this.serializer.signatureInputFromBytes) {
            return this.signatureInputFor(this.serializer.deserialize(rawBytes));
        }
        const input = this.serializer.signatureInputFromBytes(rawBytes);
        if (!input) throw new Error('invalid packet bytes');
        input[2] = 0;
        return input;
    }

    private async resolvePublicKey(packet: WebTCPPacket): Promise<Uint8Array | null> {
        const known = await this.lookup(packet.senderId);
        if (known) return known;

        // RT_UPDATE は公開鍵を同梱して自己証明できる（§10.4.2）。
        // 同梱鍵は「senderId の指紋と一致する」ことを必ず確認する。
        const embedded = extractEmbeddedPublicKey(packet);
        if (embedded) {
            return (await nodeIdMatchesPublicKey(packet.senderId, embedded)) ? embedded : null;
        }

        // 隣接確立直後の競合を吸収するため、有限時間だけ鍵の到着を待つ
        return this.waitForPublicKey(packet.senderId);
    }

    private async lookup(nodeId: string): Promise<Uint8Array | null> {
        if (this.directory) {
            const key = await this.directory.getPublicKey(nodeId);
            if (key) return key;
        }
        return null;
    }

    private async waitForPublicKey(nodeId: string): Promise<Uint8Array | null> {
        if (this.keyWaitTimeoutMs <= 0 || !this.directory) return null;
        const existing = this.pendingKeyWaiters.get(nodeId);
        if (existing) return existing;

        const waiter = this.createKeyWaiter(nodeId);
        this.pendingKeyWaiters.set(nodeId, waiter);
        try {
            return await waiter;
        } finally {
            this.pendingKeyWaiters.delete(nodeId);
        }
    }

    private createKeyWaiter(nodeId: string): Promise<Uint8Array | null> {
        if (this.directory?.waitForPublicKey) {
            return this.directory.waitForPublicKey(nodeId, this.keyWaitTimeoutMs);
        }

        const deadline = Date.now() + this.keyWaitTimeoutMs;
        return new Promise<Uint8Array | null>((resolve) => {
            const poll = async (): Promise<void> => {
                const key = await this.lookup(nodeId);
                if (key) {
                    resolve(key);
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve(null);
                    return;
                }
                setTimeout(() => {
                    void poll();
                }, 25);
            };
            void poll();
        });
    }
}

/**
 * パケットのペイロード（`RT_UPDATE` の JSON）に同梱された公開鍵を取り出す。
 *
 * 指紋（`senderId`）との一致確認は呼び出し側の責任である。
 * `Ed25519PacketVerifier` は `nodeIdMatchesPublicKey()` で必ず照合する。
 */
export function extractEmbeddedPublicKey(packet: WebTCPPacket): Uint8Array | null {
    if (packet.flags !== 'RT_UPDATE' || packet.payload.byteLength === 0) return null;

    let decoded: { publicKey?: unknown };
    try {
        decoded = JSON.parse(new TextDecoder().decode(packet.payload)) as { publicKey?: unknown };
    } catch {
        return null;
    }

    return decodePublicKey(decoded.publicKey);
}

/**
 * 同梱公開鍵が `senderId` の指紋と一致するか確認する非同期版ヘルパー。
 */
export async function isEmbeddedPublicKeyValid(packet: WebTCPPacket): Promise<boolean> {
    const key = extractEmbeddedPublicKey(packet);
    if (!key) return false;
    return nodeIdMatchesPublicKey(packet.senderId, key);
}
