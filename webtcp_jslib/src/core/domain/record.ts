/**
 * ドメイン所有権レコード（specification.md §14.2）。
 *
 * レコードは「`domain` ↔ `nodeId`」の対応を、`nodeId` を生む公開鍵の所有者が署名した
 * 自己証明型クレームである。誰もが発行できるが、他人の NodeId を束縛するレコードは
 * その鍵の所有者にしか作れない。台帳アンカー（§14.3）は「いつ台帳に入ったか」を
 * 後から検証できるようにするための別オブジェクトである。
 */

import {
    ED25519_PUBLIC_KEY_BYTES,
    Ed25519KeyManager,
    NodeId,
    bytesToHex,
    decodeBase64Url,
    decodePublicKey,
    deriveNodeId,
    encodeBase64Url,
    encodePublicKey,
    hexToBytes,
    isValidNodeId,
} from '../routing/keys.js';
import type { VirtualPort } from '../types/protocol.js';
import { defaultDomainHash, sha256Domain } from './crypto.js';
import { DomainRecordError } from './errors.js';
import { parseDomainAnchor, type DomainAnchor } from './checkpoint.js';
import { isDomainGlobalName, normalizeDomainName } from './names.js';

/** レコード形式のバージョン（プロトコルワイヤーバージョン §16 とは無関係）。 */
export const DOMAIN_RECORD_VERSION = 1;

/** レコード 1 件の JSON 最大バイト数。 */
export const MAX_DOMAIN_RECORD_BYTES = 16 * 1024;

/** 許容する最大レコード寿命（1 年）。 */
export const MAX_DOMAIN_RECORD_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** 既定のレコード寿命（30 日）。 */
export const DEFAULT_DOMAIN_RECORD_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** `txt` フィールドの最大文字数。 */
export const MAX_DOMAIN_TXT_CHARS = 255;

/** 署名対象になる本文（specification.md §14.2）。 */
export interface DomainRecordBody {
    version: 1;
    /** 正規化済みの完全名（`.domain.global` を含む）。 */
    domain: string;
    /** 所有者の NodeId（= `ownerPublicKey` の指紋）。 */
    nodeId: NodeId;
    /** 所有者の Ed25519 公開鍵（32 バイト、Base64url パディングなし）。 */
    ownerPublicKey: string;
    /** ドメインごとに単調増加する整数（1 以上）。 */
    serial: number;
    /** 発効時刻（epoch ms）。 */
    issuedAt: number;
    /** 失効時刻（epoch ms）。`issuedAt < expiresAt`。 */
    expiresAt: number;
    /** 自発的失効（焼却）。canonical 形式では常に書き出す。 */
    revoked: boolean;
    /** 推奨サービスポート。ヒントであり、`webtcp://` の必須ポートは置き換えない。 */
    port?: VirtualPort;
    /** 自由記述（1 行）。 */
    txt?: string;
}

/** 検証可能な所有権レコード。 */
export interface DomainOwnershipRecord {
    version: 1;
    body: DomainRecordBody;
    /** `canonicalDomainRecordBodyBytes(body)` に対する Ed25519 署名（Base64url、64 バイト）。 */
    signature: string;
    anchor?: DomainAnchor;
}

const encoder = new TextEncoder();

/**
 * 本文を canonical バイト列へ変換する（specification.md §14.2）。
 *
 * キー順は固定（`version, domain, nodeId, ownerPublicKey, serial, issuedAt, expiresAt,
 * revoked[, port][, txt]`）、空白なし JSON。`revoked` は `false` でも省略しない。
 * 受信時は必ず本関数で再正規化したバイト列に対して署名を検証する (MUST)。
 */
export function canonicalDomainRecordBodyBytes(body: DomainRecordBody): Uint8Array {
    const parts: string[] = [
        `{"version":${DOMAIN_RECORD_VERSION}`,
        `,"domain":${JSON.stringify(body.domain)}`,
        `,"nodeId":${JSON.stringify(body.nodeId)}`,
        `,"ownerPublicKey":${JSON.stringify(body.ownerPublicKey)}`,
        `,"serial":${body.serial}`,
        `,"issuedAt":${body.issuedAt}`,
        `,"expiresAt":${body.expiresAt}`,
        `,"revoked":${body.revoked ? 'true' : 'false'}`,
    ];
    if (body.port !== undefined) parts.push(`,"port":${body.port}`);
    if (body.txt !== undefined) parts.push(`,"txt":${JSON.stringify(body.txt)}`);
    parts.push('}');
    return encoder.encode(parts.join(''));
}

/**
 * commitment: 台帳の葉の入力となる `hex(SHA-256(canonical バイト列))`（§14.2）。
 */
export async function commitDomainRecord(
    body: DomainRecordBody,
    hashFn: (data: Uint8Array) => Promise<Uint8Array> = defaultDomainHash,
): Promise<string> {
    return bytesToHex(await hashFn(canonicalDomainRecordBodyBytes(body)));
}

/** 任意バイト列の SHA-256 を hex で返す（チェックポイントハッシュ等の共通ヘルパ）。 */
export async function sha256Hex(
    data: Uint8Array,
    hashFn: (data: Uint8Array) => Promise<Uint8Array> = sha256Domain,
): Promise<string> {
    return bytesToHex(await hashFn(data));
}

/** commitment（hex）を葉ハッシュへ変換する前の原料バイト列へ戻す。 */
export function domainCommitmentBytes(commitment: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/.test(commitment)) {
        throw new DomainRecordError('commitment must be 32 bytes of lowercase hex', 'commitment');
    }
    return hexToBytes(commitment);
}

/** レコード全体を JSON 可能オブジェクトへ（転送・保存用）。 */
export function domainRecordToJSON(record: DomainOwnershipRecord): Record<string, unknown> {
    const body: Record<string, unknown> = {
        version: DOMAIN_RECORD_VERSION,
        domain: record.body.domain,
        nodeId: record.body.nodeId,
        ownerPublicKey: record.body.ownerPublicKey,
        serial: record.body.serial,
        issuedAt: record.body.issuedAt,
        expiresAt: record.body.expiresAt,
        revoked: record.body.revoked,
    };
    if (record.body.port !== undefined) body.port = record.body.port;
    if (record.body.txt !== undefined) body.txt = record.body.txt;
    const out: Record<string, unknown> = {
        version: DOMAIN_RECORD_VERSION,
        body,
        signature: record.signature,
    };
    if (record.anchor) out.anchor = record.anchor;
    return out;
}

/** レコード全体を UTF-8 JSON バイト列へ変換する。 */
export function serializeDomainRecord(record: DomainOwnershipRecord): Uint8Array {
    return encoder.encode(JSON.stringify(domainRecordToJSON(record)));
}

function rejectUnknownKeys(
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

function asRecord(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DomainRecordError(`${where} must be an object`, where);
    }
    return value as Record<string, unknown>;
}

function isSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * 本文の構造検証（specification.md §14.2）。未知キーは拒否する。
 *
 * @throws DomainRecordError
 */
export function parseDomainRecordBody(value: unknown): DomainRecordBody {
    const raw = asRecord(value, 'record.body');
    rejectUnknownKeys(
        raw,
        [
            'version',
            'domain',
            'nodeId',
            'ownerPublicKey',
            'serial',
            'issuedAt',
            'expiresAt',
            'revoked',
            'port',
            'txt',
        ],
        'record.body',
    );
    if (raw.version !== DOMAIN_RECORD_VERSION) {
        throw new DomainRecordError(`record.body.version must be ${DOMAIN_RECORD_VERSION}`, 'version');
    }
    if (typeof raw.domain !== 'string') {
        throw new DomainRecordError('record.body.domain must be a string', 'domain');
    }
    let domain: string;
    try {
        domain = normalizeDomainName(raw.domain);
    } catch (error) {
        throw new DomainRecordError(
            error instanceof Error ? error.message : 'invalid domain name',
            'domain',
        );
    }
    if (!isDomainGlobalName(domain)) {
        throw new DomainRecordError('record.body.domain must live in the domain.global zone', 'domain');
    }
    if (typeof raw.nodeId !== 'string' || !isValidNodeId(raw.nodeId)) {
        throw new DomainRecordError('record.body.nodeId must be a 32-character hex NodeId', 'nodeId');
    }
    if (typeof raw.ownerPublicKey !== 'string' || !decodePublicKey(raw.ownerPublicKey)) {
        throw new DomainRecordError(
            `record.body.ownerPublicKey must be Base64url of a ${ED25519_PUBLIC_KEY_BYTES}-byte Ed25519 public key`,
            'ownerPublicKey',
        );
    }
    if (!isSafeInteger(raw.serial) || raw.serial < 1) {
        throw new DomainRecordError('record.body.serial must be an integer >= 1', 'serial');
    }
    if (!isSafeInteger(raw.issuedAt) || !isSafeInteger(raw.expiresAt)) {
        throw new DomainRecordError('record.body.issuedAt / expiresAt must be integers', 'issuedAt');
    }
    if (raw.issuedAt < 0 || raw.expiresAt <= raw.issuedAt) {
        throw new DomainRecordError(
            'record.body.expiresAt must be greater than a non-negative issuedAt',
            'expiresAt',
        );
    }
    if (raw.expiresAt - raw.issuedAt > MAX_DOMAIN_RECORD_LIFETIME_MS) {
        throw new DomainRecordError(
            `record lifetime must be at most ${MAX_DOMAIN_RECORD_LIFETIME_MS} ms`,
            'expiresAt',
        );
    }
    if (raw.revoked !== undefined && raw.revoked !== false && raw.revoked !== true) {
        throw new DomainRecordError('record.body.revoked must be a boolean when present', 'revoked');
    }
    const body: DomainRecordBody = {
        version: DOMAIN_RECORD_VERSION,
        domain,
        nodeId: raw.nodeId as NodeId,
        ownerPublicKey: raw.ownerPublicKey as string,
        serial: raw.serial,
        issuedAt: raw.issuedAt,
        expiresAt: raw.expiresAt,
        revoked: raw.revoked === true,
    };
    if (raw.port !== undefined) {
        const port = raw.port;
        if (!isSafeInteger(port) || port < 1 || port > 65535) {
            throw new DomainRecordError('record.body.port must be an integer in 1..65535', 'port');
        }
        body.port = port;
    }
    if (raw.txt !== undefined) {
        if (
            typeof raw.txt !== 'string' ||
            raw.txt.length > MAX_DOMAIN_TXT_CHARS ||
            /[\r\n]/.test(raw.txt)
        ) {
            throw new DomainRecordError(
                `record.body.txt must be a single line of at most ${MAX_DOMAIN_TXT_CHARS} characters`,
                'txt',
            );
        }
        body.txt = raw.txt;
    }
    if (canonicalDomainRecordBodyBytes(body).byteLength > MAX_DOMAIN_RECORD_BYTES) {
        throw new DomainRecordError(`record body exceeds ${MAX_DOMAIN_RECORD_BYTES} bytes`, 'body');
    }
    return body;
}

export interface ParseDomainOwnershipRecordOptions {
    /**
     * `body.nodeId` と `ownerPublicKey` の指紋一致を確認する（既定 `true`）。
     * 署名そのものの検証は §14.4 の検証器が担当する。
     */
    verifyFingerprint?: boolean;
}

/**
 * 受信した JSON / バイト列を厳格にパースする（specification.md §14.2）。
 * ネットワーク経由の入力は必ず本関数を通さなければならない (MUST)。
 *
 * @throws DomainRecordError
 */
export async function parseDomainOwnershipRecord(
    value: unknown,
    options: ParseDomainOwnershipRecordOptions = {},
): Promise<DomainOwnershipRecord> {
    let source: unknown = value;
    if (source instanceof Uint8Array) {
        try {
            source = JSON.parse(new TextDecoder().decode(source));
        } catch {
            throw new DomainRecordError('domain record is not valid JSON');
        }
    }
    const raw = asRecord(source, 'record');
    rejectUnknownKeys(raw, ['version', 'body', 'signature', 'anchor'], 'record');
    if (raw.version !== DOMAIN_RECORD_VERSION) {
        throw new DomainRecordError(`record.version must be ${DOMAIN_RECORD_VERSION}`, 'version');
    }
    const body = parseDomainRecordBody(raw.body);
    if (typeof raw.signature !== 'string') {
        throw new DomainRecordError('record.signature must be a Base64url string', 'signature');
    }
    const signatureBytes = decodeBase64Url(raw.signature);
    if (!signatureBytes || signatureBytes.byteLength !== 64) {
        throw new DomainRecordError(
            'record.signature must decode to a 64-byte Ed25519 signature',
            'signature',
        );
    }
    if (options.verifyFingerprint !== false) {
        const publicKey = decodePublicKey(body.ownerPublicKey) as Uint8Array;
        if ((await deriveNodeId(publicKey)) !== body.nodeId) {
            throw new DomainRecordError(
                'record.body.nodeId does not match the fingerprint of ownerPublicKey',
                'nodeId',
            );
        }
    }
    const record: DomainOwnershipRecord = {
        version: DOMAIN_RECORD_VERSION,
        body,
        signature: raw.signature,
    };
    if (raw.anchor !== undefined) {
        record.anchor = parseDomainAnchor(raw.anchor);
    }
    return record;
}

export interface CreateDomainOwnershipRecordParams {
    /** 完全名（`.domain.global` を含む）。正規化される。 */
    domain: string;
    /** 所有者の鍵管理（`keyManager.nodeId` がレコードの主体になる）。 */
    keyManager: Ed25519KeyManager;
    /** ドメイン内の連番（1 以上）。 */
    serial: number;
    /** 発効時刻（既定は現在）。 */
    issuedAt?: number;
    /** 有効期間（ms）。既定 30 日。 */
    lifetimeMs?: number;
    /** 失効時刻（指定時は `lifetimeMs` より優先）。 */
    expiresAt?: number;
    /** 自発的失効レコードを発行する。 */
    revoked?: boolean;
    /** 推奨サービスポート。 */
    port?: VirtualPort;
    /** 自由記述。 */
    txt?: string;
    /** レジストリ発行の台帳アンカーを添える。 */
    anchor?: DomainAnchor;
}

/**
 * 所有者署名付きの所有権レコードを生成する（specification.md §14.2）。
 *
 * canonical バイト列へ Ed25519 署名を付与する。台帳アンカーは付けない
 * （`DomainLedger.append()` が付与したレコードを返す）。
 */
export async function createDomainOwnershipRecord(
    params: CreateDomainOwnershipRecordParams,
): Promise<DomainOwnershipRecord> {
    if (!params.keyManager || !isValidNodeId(params.keyManager.nodeId)) {
        throw new DomainRecordError('createDomainOwnershipRecord requires a keyManager with a valid nodeId');
    }
    const issuedAt = params.issuedAt ?? Date.now();
    const expiresAt = params.expiresAt ?? issuedAt + (params.lifetimeMs ?? DEFAULT_DOMAIN_RECORD_LIFETIME_MS);
    const body: DomainRecordBody = {
        version: DOMAIN_RECORD_VERSION,
        domain: normalizeDomainName(params.domain),
        nodeId: params.keyManager.nodeId,
        ownerPublicKey: encodePublicKey(params.keyManager.publicKey),
        serial: params.serial,
        issuedAt,
        expiresAt,
        revoked: params.revoked === true,
    };
    if (params.port !== undefined) body.port = params.port;
    if (params.txt !== undefined) body.txt = params.txt;

    const validated = parseDomainRecordBody(body);
    const signatureBytes = await params.keyManager.sign(canonicalDomainRecordBodyBytes(validated));
    if (signatureBytes.byteLength !== 64) {
        throw new DomainRecordError('keyManager.sign() must return a 64-byte Ed25519 signature', 'signature');
    }
    const record: DomainOwnershipRecord = {
        version: DOMAIN_RECORD_VERSION,
        body: validated,
        signature: encodeBase64Url(signatureBytes),
    };
    if (params.anchor) record.anchor = params.anchor;
    return record;
}
