/**
 * `domain.global` ゾーンの名前規則（specification.md §14.1）。
 *
 * このモジュールはプラットフォーム非依存の純粋関数だけを提供する。
 */

/** WebTCP が管理する唯一のグローバルゾーン。 */
export const DOMAIN_GLOBAL_ZONE = 'domain.global';

/** 1 ラベルの最大バイト数（DNS と同じ 63）。 */
export const MAX_DOMAIN_LABEL_BYTES = 63;

/** 完全名の最大長（DNS と同じ 253、ゾーン名を含む）。 */
export const MAX_DOMAIN_NAME_BYTES = 253;

const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 入力を小文字化・末尾ルートドット除去して返す（まだ検証は行わない）。
 */
export function prepareDomainName(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('domain name must be a string');
    }
    let name = value.trim().toLowerCase();
    if (name.endsWith('.')) name = name.slice(0, -1);
    return name;
}

/** `prepareDomainName` の結果が LDH 規則に沿った名前かどうか。 */
export function isValidDomainName(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const prepared = prepareDomainName(value);
    if (prepared.length === 0 || prepared.length > MAX_DOMAIN_NAME_BYTES) return false;
    return prepared.split('.').every((label) => LDH_LABEL.test(label));
}

/**
 * 名前が `domain.global` ゾーンに属するかを判定する。
 * 正規化は行わず、形式チェックのみ（予約語の検出に使う）。
 */
export function isDomainGlobalName(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const prepared = prepareDomainName(value);
    if (!prepared.endsWith(`.${DOMAIN_GLOBAL_ZONE}`)) return false;
    const labels = prepared.split('.');
    if (labels.length < 3) return false; // <label>.domain.global
    return labels.slice(0, labels.length - 2).every((label) => LDH_LABEL.test(label));
}

/** ラベル一覧を返す（ゾーン名を含む、右から `domain`, `global`）。 */
export function domainLabels(value: unknown): string[] {
    return validateDomainName(value).split('.');
}

/**
 * ゾーン内名前として妥当な形に正規化する。
 *
 * @throws 不正なラベル・長さ超過・ゾーン外の名前
 */
export function normalizeDomainName(value: unknown): string {
    const name = validateDomainName(value);
    if (!isDomainGlobalName(name)) {
        throw new Error(`domain name must live in the .${DOMAIN_GLOBAL_ZONE} zone (got "${name}")`);
    }
    return name;
}

function validateDomainName(value: unknown): string {
    const name = prepareDomainName(value);
    if (name.length === 0) throw new Error('domain name must not be empty');
    if (name.length > MAX_DOMAIN_NAME_BYTES) {
        throw new Error(`domain name must be at most ${MAX_DOMAIN_NAME_BYTES} characters (got ${name.length})`);
    }
    const labels = name.split('.');
    for (const label of labels) {
        if (!LDH_LABEL.test(label)) {
            throw new Error(`invalid domain label: ${label || '(empty)'}`);
        }
        if (label.length > MAX_DOMAIN_LABEL_BYTES) {
            throw new Error(`domain label must be at most ${MAX_DOMAIN_LABEL_BYTES} characters`);
        }
    }
    return name;
}

/** ゾーン名を除いた部分（`shop.domain.global` -> `shop`）。 */
export function domainLeadingLabels(value: unknown): string[] {
    const all = domainLabels(value);
    return all.slice(0, all.length - 2);
}

/** ゾーン名（最上位 2 ラベル）。`shop.domain.global` -> `domain.global`。 */
export function domainZone(value: unknown): string {
    return domainLabels(value).slice(-2).join('.');
}

/** ゾーン内名前（ゾーン名を除く左側ラベル）。`shop.domain.global` -> `shop`。 */
export function domainNameInZone(value: unknown): string {
    return domainLeadingLabels(value).join('.');
}
