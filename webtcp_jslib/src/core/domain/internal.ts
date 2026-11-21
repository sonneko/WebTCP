/**
 * ドメイン層内部の検証ヘルパー（公開 API ではない）。`core/domain/index.ts` からは再エクスポートしない。
 */
import { DomainRecordError } from './errors.js';

/** 許可されていないキーがあれば `DomainRecordError` を投げる（厳格な JSON スキーマ検査）。 */
export function rejectUnknownKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    where: string,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new DomainRecordError(`unknown field "${key}" in ${where}`, `${where}.${key}`);
        }
    }
}
