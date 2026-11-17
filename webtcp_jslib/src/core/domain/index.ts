/**
 * `domain.global` とドメイン所有権証明の公開API（specification.md §14、§15.4）。
 *
 * `src/core` の制約どおりブラウザ / Node.js どちらにも依存しない。HTTP レジストリ
 * クライアントは `adapters/domain/` にある。
 */

export * from './names.js';
export * from './crypto.js';
export * from './errors.js';
export * from './record.js';
export * from './checkpoint.js';
export * from './merkle.js';
export * from './verifier.js';
export * from './ledger.js';
export * from './authority.js';
