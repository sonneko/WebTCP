import { NodeId } from '../types/protocol';
import { WebTCPPacket } from '../types/packet'; // WebTCPPacketの型をインポート

/**
 * 秘密鍵と公開鍵のペアを管理する仮のインターフェース。
 * 実際のWebTCP実装では、KeyManagerが暗号ライブラリ（例: Web Crypto API, rust-crypto）をラップする。
 */
export interface KeyManager {
    /**
     * NodeIdに対応する公開鍵を取得する。
     * ネットワーク内の他のノードから取得するか、SharedKVなどの分散ストレージから取得する。
     * @param nodeId 検証したいノードID。
     * @returns 公開鍵のデータ（Uint8Arrayなど）、またはnull。
     */
    getPublicKey(nodeId: NodeId): Promise<Uint8Array | null>;

    /**
     * パケットの署名に必要なデータを生成する。
     * @param data 署名対象の生データ。
     * @returns 生成された署名。
     */
    sign(data: Uint8Array): Promise<Uint8Array>;
    
    /**
     * 署名の検証を行う。
     * @param publicKey 検証に使用する公開鍵。
     * @param data 署名対象の生データ。
     * @param signature 受信した署名データ。
     * @returns 署名が有効であればtrue、そうでなければfalse。
     */
    verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * WebTCPPacketの署名を検証し、データ改ざんの有無をチェックするクラス。
 * RoutingLayerの一部として機能し、不正なパケットを破棄する。
 */
export class PacketVerifier {
    private keyManager: KeyManager;

    constructor(keyManager: KeyManager) {
        this.keyManager = keyManager;
    }

    /**
     * パケットの内容（ヘッダーとペイロード）から、署名対象となる生データを抽出する。
     * 署名データ自体は署名対象から除外する必要がある。
     * @param packet 検証対象のパケット。
     * @returns 署名対象のUint8Arrayデータ。
     */
    private getSignatureTargetData(packet: WebTCPPacket): Uint8Array {
        // 【重要】署名対象からsignatureフィールドを除外したパケットのバイナリ表現を作成する。
        // ここでは実装を省略するが、実際には PacketSerializer を使用して、
        // 署名フィールドがゼロ埋めされたパケットバイナリを生成する必要がある。

        // 簡略化のため、ここではヘッダーとペイロードの結合データを返す（本来はシリアライザーに依存）
        const headerData = new TextEncoder().encode(`${packet.senderId}:${packet.destinationId}:${packet.ttl}:${packet.transportHeader}`);
        const fullData = new Uint8Array(headerData.length + packet.payload.length);
        fullData.set(headerData, 0);
        fullData.set(packet.payload, headerData.length);
        
        return fullData;
    }

    /**
     * 受信したパケットの署名を検証する。
     * @param packet 検証対象のWebTCPPacket。
     * @returns 署名が有効であればtrue、無効であればfalse。
     */
    public async verifyPacket(packet: WebTCPPacket): Promise<boolean> {
        // 1. 送信元の公開鍵を取得
        const publicKey = await this.keyManager.getPublicKey(packet.senderId);
        
        if (!publicKey) {
            console.warn(`[Verifier] Public key not found for sender: ${packet.senderId}. Dropping packet.`);
            return false;
        }

        // 2. 署名対象となるデータ本体を取得
        const targetData = this.getSignatureTargetData(packet);

        // 3. 署名検証を実行
        try {
            const signature = new Uint8Array(packet.signature); // パケットから署名を取り出す
            return await this.keyManager.verify(publicKey, targetData, signature);
        } catch (e) {
            console.error(`[Verifier] Signature verification failed unexpectedly: ${e}`);
            return false;
        }
    }

    /**
     * 送信前のパケットに対してデジタル署名を追加する。
     * @param packet 署名を追加したいWebTCPPacket。
     * @returns 署名が付与されたパケット。
     */
    public async signPacket(packet: WebTCPPacket): Promise<WebTCPPacket> {
        // 1. 署名対象データを作成
        // この時点でパケットのsignatureフィールドは空（またはプレースホルダ）である必要がある
        const targetData = this.getSignatureTargetData(packet);

        // 2. 秘密鍵を使用して署名
        const signature = await this.keyManager.sign(targetData);

        // 3. パケットに署名を付与し、返す
        return {
            ...packet,
            signature: signature
        };
    }
}
