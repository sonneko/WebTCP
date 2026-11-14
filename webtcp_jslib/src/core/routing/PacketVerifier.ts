import { WebTCPPacket } from '../types/packet.js';
import { NodeId } from '../types/protocol.js';

/**
 * パケットの署名付与・検証を行うインターフェース。
 *
 * M1 の既定実装は `NullPacketVerifier`（署名なし）である。
 * Ed25519 を用いる実装は M3 で追加する（plan.md §4.2）。
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
}

/**
 * 署名を扱わない検証器。
 *
 * ブラウザ向けの鍵管理が未整備な M1 では、これが既定となる。
 * ワイヤーフォーマットには署名フィールド（長さ0）が予約済みのため、
 * 後から検証器を差し替えても互換性は壊れない。
 */
export class NullPacketVerifier implements IPacketVerifier {
    public async signPacket(packet: WebTCPPacket): Promise<WebTCPPacket> {
        return packet;
    }

    public async verifyPacket(_packet: WebTCPPacket): Promise<boolean> {
        return true;
    }
}

/**
 * 鍵管理の抽象。Ed25519 実装（M3）が利用する予定の契約。
 *
 * 実装時は `getPublicKey` が分散ストレージや既知のピアから公開鍵を解決し、
 * `sign` / `verify` が Web Crypto API などをラップする。
 */
export interface KeyManager {
    /** ノードIDに対応する公開鍵を取得する。未知なら null。 */
    getPublicKey(nodeId: NodeId): Promise<Uint8Array | null>;
    /** ローカル秘密鍵でデータに署名する。 */
    sign(data: Uint8Array): Promise<Uint8Array>;
    /** 署名を検証する。 */
    verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}
