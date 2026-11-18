/**
 * ドメイン台帳・レジストリアダプタ（specification.md §14.6）。
 *
 * `src/core` 側は HTTP を知らない。ネットワーク I/O はこの層に閉じ込める。
 */

export * from './HttpDomainRegistryClient.js';
