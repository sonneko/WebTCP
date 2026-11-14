/**
 * Ed25519 鍵管理アダプタ（#28）。
 *
 * - `BrowserKeyManager`: Web Crypto + IndexedDB（秘密鍵は非抽出 CryptoKey）
 * - `NodeKeyManager`: `node:crypto`
 * - `createEd25519Verifier()` / `createKeyedNetwork()`: 鍵管理と検証器の組み立てヘルパー
 */
export * from './BrowserKeyManager.js';
export * from './NodeKeyManager.js';
export * from './nodeCrypto.js';
export * from './factory.js';
export * from './NodeIdentityStorage.js';
