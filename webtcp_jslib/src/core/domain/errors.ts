/**
 * ドメイン所有権関連のエラー（specification.md §13.2 / §13.4 / §11.2）。
 *
 * `DomainProofCode` は解決・検証の**失敗理由**を表す安定した識別子である。
 * 転送時は §13.5 の名前一貫性エラー文字列（`domain zone mismatch: ...` /
 * `domain proof unavailable: ...`）へ写像される。
 */

/** 所有権・解決の検証結果コード（specification.md §13.4.1）。 */
export type DomainProofCode =
    | 'ok'
    | 'invalid-record'
    | 'zone-mismatch'
    | 'fingerprint-mismatch'
    | 'bad-signature'
    | 'expired'
    | 'not-yet-valid'
    | 'stale-serial'
    | 'revoked'
    | 'conflict'
    | 'anchor-missing'
    | 'anchor-bad-proof'
    | 'anchor-untrusted-log'
    | 'anchor-bad-checkpoint'
    | 'anchor-rollback'
    | 'chain-unverified'
    | 'resolution-unavailable';

/** `DomainProofCode` を転送用の説明文字列へ写像する（specification.md §13.5）。 */
export function domainProofCodeToReason(code: DomainProofCode): string {
    switch (code) {
        case 'ok':
            return 'ok';
        case 'zone-mismatch':
            return 'domain zone mismatch: record zone does not match the requested name';
        case 'resolution-unavailable':
            return 'domain proof unavailable: no ownership record found';
        case 'invalid-record':
            return 'invalid domain ownership record';
        case 'anchor-missing':
            return 'domain ownership record has no ledger anchor';
        case 'anchor-untrusted-log':
            return 'domain ownership record is anchored to an untrusted log';
        case 'anchor-rollback':
            return 'domain ownership record is anchored to a rolled-back checkpoint';
        case 'chain-unverified':
            return 'domain ownership record anchor chain data is unverified';
        default:
            return `domain ownership verification failed: ${code}`;
    }
}

/** 衝突解決に必要な最小情報（specification.md §13.4.3）。 */
export interface DomainConflictCandidate {
    serial: number;
    commitment: string;
    /** 台帳アンカーがあればその葉番号。 */
    anchorLeafIndex?: number;
}

/**
 * 同一ドメインに有効なレコードが複数あるときの勝者を選ぶ（specification.md §13.4.3）。
 *
 * 比較順序は `serial` -> `anchor.leafIndex`。どちらも及ばず内容も違う場合は
 * 勝者無し（`'conflict'`）を返す。**勝者が決められない競合を黙って解決してはならない (MUST NOT)**。
 * `identical` は同一内容（幂等な再送）を意味する。
 */
export function conflictVerdict(
    current: DomainConflictCandidate,
    candidate: DomainConflictCandidate,
): 'identical' | 'candidate' | 'current' | 'conflict' {
    if (candidate.serial > current.serial) return 'candidate';
    if (candidate.serial < current.serial) return 'current';
    if (candidate.commitment === current.commitment) return 'identical';
    if (candidate.anchorLeafIndex !== undefined && current.anchorLeafIndex !== undefined) {
        // 先に台帳へ入った（葉番号が小さい）ほうを決定的な勝者とする (§13.4.3)
        if (candidate.anchorLeafIndex < current.anchorLeafIndex) return 'candidate';
        if (candidate.anchorLeafIndex > current.anchorLeafIndex) return 'current';
    }
    return 'conflict';
}

/**
 * 所有権レコードの検証に失敗した（候補はあるが信頼できない）。
 *
 * `NameServer` はこれを `webtcp://` 解決失敗へ写像する（specification.md §13.5）。
 */
export class DomainOwnershipError extends Error {
    /** 失敗理由（specification.md §13.4.1）。 */
    readonly code: DomainProofCode;
    readonly domain: string;

    constructor(domain: string, code: DomainProofCode, message?: string) {
        super(message ?? `domain ownership verification failed (${code}): ${domain}`);
        this.name = 'DomainOwnershipError';
        this.domain = domain;
        this.code = code;
    }
}

/**
 * ゾーン内名前を解決するための権威・収集元が無い（§12.2 / §13.5）。
 * 名前が「存在しない」ことと「検証できない」ことを区別するための型である。
 */
export class DomainResolutionUnavailableError extends Error {
    readonly domain: string;

    constructor(domain: string, message?: string) {
        super(message ?? `domain resolution unavailable for ${domain}`);
        this.name = 'DomainResolutionUnavailableError';
        this.domain = domain;
    }
}

/**
 * 所有権レコードの構造・canonical 化に失敗したことを示す基底エラー。
 *
 * `DomainProofCode` は持たない（検証結果は例外ではなく {@link DomainVerifyResult} で
 * 返される）。例外として投げるのは「入力を解釈できない」ケースに限る。
 */
export class DomainRecordError extends Error {
    /** 問題のあるフィールド名（指定された場合）。 */
    readonly field?: string;

    constructor(message: string, field?: string) {
        super(message);
        this.name = 'DomainRecordError';
        if (field !== undefined) this.field = field;
    }
}

/** 台帳・レジストリへの追加が拒否された。 */
export class DomainLedgerAppendError extends Error {
    readonly domain?: string;

    constructor(message: string, domain?: string) {
        super(message);
        this.name = 'DomainLedgerAppendError';
        if (domain !== undefined) this.domain = domain;
    }
}

/** 同一ドメインに解消不能な競合がある。 */
export class DomainConflictError extends Error {
    readonly domain: string;
    readonly current?: unknown;
    readonly candidate?: unknown;

    constructor(message: string, domain: string, current?: unknown, candidate?: unknown) {
        super(message);
        this.name = 'DomainConflictError';
        this.domain = domain;
        if (current !== undefined) this.current = current;
        if (candidate !== undefined) this.candidate = candidate;
    }
}

/** 台帳・HTTP レジストリへの問い合わせが失敗した。 */
export class DomainRegistryError extends Error {
    readonly status?: number;
    readonly domain?: string;

    constructor(message: string, options: { status?: number; domain?: string } = {}) {
        super(message);
        this.name = 'DomainRegistryError';
        if (options.status !== undefined) this.status = options.status;
        if (options.domain !== undefined) this.domain = options.domain;
    }
}
