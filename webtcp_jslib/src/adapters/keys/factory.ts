import { Ed25519PacketVerifier } from '../../core/routing/PacketVerifier.js';
import { KeyDirectory } from '../../core/routing/KeyDirectory.js';
import { Ed25519KeyManager, encodePublicKey } from '../../core/routing/keys.js';
import { IPacketSerializer } from '../../core/types/serializer.js';
import type { Logger } from '../../core/util/Logger.js';

export interface CreateEd25519VerifierOptions {
    /** 鍵管理（`BrowserKeyManager` / `NodeKeyManager`、または互換実装）。 */
    keyManager: Ed25519KeyManager;
    /**
     * 公開鍵ディレクトリ。
     * 省略時は新しい `KeyDirectory` を生成して戻り値に含める。
     */
    keyDirectory?: KeyDirectory;
    /** 署名対象バイト列の導出に使うシリアライザ（鍵管理と同一の設定にする）。 */
    serializer?: IPacketSerializer;
    /** 未知の公開鍵を待つ最大時間（ms）。既定 5000。 */
    keyWaitTimeoutMs?: number;
    /** ロガー（任意）。 */
    logger?: Logger;
}

/** `createEd25519Verifier()` の戻り値。 */
export interface Ed25519VerifierBundle {
    verifier: Ed25519PacketVerifier;
    keyDirectory: KeyDirectory;
    /** 自身の公開鍵（32 バイト）。シグナリングで配布する。 */
    publicKey: Uint8Array;
    /** 自身の公開鍵（Base64url）。 */
    publicKeyEncoded: string;
    nodeId: string;
}

/**
 * Ed25519 検証器と公開鍵ディレクトリをまとめて生成する。
 *
 * ```ts
 * const keys = await NodeKeyManager.create();
 * const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });
 * const network = new WebTCPNetwork({ channel, nodeId: keys.nodeId, verifier });
 * ```
 */
export function createEd25519Verifier(
    options: CreateEd25519VerifierOptions,
): Ed25519VerifierBundle {
    const keyDirectory = options.keyDirectory ?? new KeyDirectory({ logger: options.logger });
    const verifier = new Ed25519PacketVerifier({
        keyManager: options.keyManager,
        keyDirectory,
        ...(options.serializer ? { serializer: options.serializer } : {}),
        ...(options.keyWaitTimeoutMs !== undefined
            ? { keyWaitTimeoutMs: options.keyWaitTimeoutMs }
            : {}),
    });
    return {
        verifier,
        keyDirectory,
        publicKey: options.keyManager.publicKey,
        publicKeyEncoded: encodePublicKey(options.keyManager.publicKey),
        nodeId: options.keyManager.nodeId,
    };
}
