/**
 * WebTCP — WebRTC データチャネル上の仮想 TCP/HTTP トンネル。
 *
 * 公開 API はこのファイルから re-export される。
 */

// コア（ブラウザ・Node.js 非依存）
export * from './core/types/index.js';
export * from './core/util/index.js';
export * from './core/link/index.js';
export * from './core/routing/index.js';
export * from './core/transport/index.js';
export * from './core/network/index.js';
export * from './core/naming/index.js';

// アダプタ
export * from './adapters/webrtc/index.js';
export * from './adapters/signaling/index.js';
export * from './adapters/entrance-searcher/index.js';
export * from './adapters/keys/index.js';

// ブラウザ向けヘルパー
export * from './browser.js';
