/**
 * 参照レジストリ（HTTP）のクライアント（specification.md §13.6）。
 *
 * `IDomainRecordSource` と `DomainCheckpointSource` を同時に実装するため、
 * `DomainAuthority` に `sources: [new HttpDomainRegistryClient({ baseUrl })]` と渡すだけで
 * 台帳アンカーつきの解決が動く。レジストリは**信頼の根元ではない** (§13.7) — ここで得た
 * レコードは必ず所有者署名・台帳アンカーともに検証される。
 */

import {
    parseDomainAnchor,
    parseDomainCheckpoint,
    type DomainAnchor,
    type SignedDomainCheckpoint,
} from '../../core/domain/checkpoint.js';
import { DomainRegistryError } from '../../core/domain/errors.js';
import {
    domainRecordToJSON,
    parseDomainOwnershipRecord,
    type DomainOwnershipRecord,
} from '../../core/domain/record.js';
import type {
    DomainSourceContext,
    IDomainRecordSource,
} from '../../core/domain/authority.js';
import type { DomainCheckpointSource } from '../../core/domain/verifier.js';
import type { Logger } from '../../core/util/Logger.js';
import { createScopedLogger, defaultLogger } from '../../core/util/Logger.js';
import type { NodeId } from '../../core/routing/keys.js';

/** `fetch` の最小限の形（実行環境の差異を吸収する）。 */
export interface RegistryFetchResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

export type RegistryFetch = (
    input: string,
    init: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
        signal?: AbortSignal;
    },
) => Promise<RegistryFetchResponse>;

export interface HttpDomainRegistryClientOptions {
    /** レジストリの基点 URL（末尾スラッシュは不要）。 */
    baseUrl: string;
    /** `fetch` の差し替え（テスト・プロキシ用）。既定は `globalThis.fetch`。 */
    fetchImpl?: RegistryFetch;
    /** 1 請求のタイムアウト（既定 5 000 ms）。0 で無効。 */
    timeoutMs?: number;
    /** 404 を「候補 0 件」として扱う（既定 `true`）。`false` にすると例外。 */
    tolerateNotFound?: boolean;
    logger?: Logger;
}

/** `POST /domain/record` の応答。 */
export interface DomainRegistrySubmitResult {
    accepted: boolean;
    leafIndex?: number;
    treeSize?: number;
    checkpoint?: SignedDomainCheckpoint;
    anchor?: DomainAnchor;
    error?: string;
    code?: string;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * HTTP レジストリクライアント。
 *
 * 失敗（ネットワーク障害・非 2xx・不正 JSON）は `DomainRegistryError` を投げる。
 * 解決側はこれを「候補 0 件」として扱うため、レジストリが落ちても名前解決は壊れない。
 */
export class HttpDomainRegistryClient implements IDomainRecordSource, DomainCheckpointSource {
    readonly name = 'http-registry';
    private readonly baseUrl: string;
    private readonly fetchImpl: RegistryFetch;
    private readonly timeoutMs: number;
    private readonly tolerateNotFound: boolean;
    private readonly logger: Logger;

    constructor(options: HttpDomainRegistryClientOptions) {
        if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
            throw new DomainRegistryError('HttpDomainRegistryClient requires a baseUrl');
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        const injected =
            options.fetchImpl ??
            (typeof globalThis.fetch === 'function'
                ? (globalThis.fetch as unknown as RegistryFetch)
                : null);
        if (!injected) {
            throw new DomainRegistryError('no fetch implementation is available for the domain registry');
        }
        this.fetchImpl = injected;
        this.timeoutMs = Number.isFinite(options.timeoutMs ?? 5000) ? (options.timeoutMs ?? 5000) : 5000;
        this.tolerateNotFound = options.tolerateNotFound !== false;
        this.logger = createScopedLogger(options.logger ?? defaultLogger, 'DOMAIN-REGISTRY');
    }

    /** ドメインの現行レコード（検証は行わない。`DomainAuthority` が検証する）。 */
    async lookupByDomain(
        domain: string,
        context: DomainSourceContext = {},
    ): Promise<DomainOwnershipRecord[]> {
        const payload = await this.request('GET', `/domain/record?name=${encodeURIComponent(domain)}`, {
            signal: context.signal,
        });
        return this.readRecords(payload, domain);
    }

    /** ノード ID から逆引きしたレコード一覧。 */
    async lookupByNodeId(
        nodeId: NodeId,
        context: DomainSourceContext = {},
    ): Promise<DomainOwnershipRecord[]> {
        const payload = await this.request(
            'GET',
            `/domain/record?nodeId=${encodeURIComponent(nodeId)}`,
            { signal: context.signal },
        );
        return this.readRecords(payload, nodeId);
    }

    /** 生レコードを 1 件ずつ厳格パースする（不正レコードは警告して捨てる）。 */
    private async readRecords(payload: Record<string, unknown>, label: string): Promise<DomainOwnershipRecord[]> {
        const raw = payload.records;
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) {
            throw new DomainRegistryError('registry response field "records" must be an array', {
                domain: label,
            });
        }
        const out: DomainOwnershipRecord[] = [];
        for (const entry of raw) {
            try {
                out.push(await parseDomainOwnershipRecord(entry));
            } catch (error) {
                this.logger.warn(
                    `registry returned an invalid ownership record for ${label}: ${String(error)}`,
                );
            }
        }
        return out;
    }

    /** 直近チェックポイント（`GET /domain/checkpoint`）。 */
    async checkpoint(context: DomainSourceContext = {}): Promise<SignedDomainCheckpoint | null> {
        const payload = await this.request('GET', '/domain/checkpoint', { signal: context.signal });
        if (payload.checkpoint === undefined || payload.checkpoint === null) return null;
        return parseDomainCheckpoint(payload.checkpoint);
    }

    /** チェックポイント連結の検証に使う区間（`GET /domain/checkpoints`）。 */
    async checkpointsBetween(params: {
        logId: string;
        afterTreeSize: number;
        toTreeSize: number;
        signal?: AbortSignal;
    }): Promise<SignedDomainCheckpoint[]> {
        const query = `after=${params.afterTreeSize}&to=${params.toTreeSize}`;
        const payload = await this.request('GET', `/domain/checkpoints?${query}`, {
            signal: params.signal,
        });
        void params.logId;
        const raw = payload.checkpoints;
        if (!Array.isArray(raw)) return [];
        return raw.map((entry) => parseDomainCheckpoint(entry));
    }

    /** レコードを台帳へ追加する（`POST /domain/record`）。 */
    async submit(
        record: DomainOwnershipRecord,
        context: DomainSourceContext = {},
    ): Promise<DomainRegistrySubmitResult> {
        const body = JSON.stringify({ record: domainRecordToJSON(record) });
        const payload = (await this.request('POST', '/domain/record', {
            body,
            signal: context.signal,
        })) as unknown as DomainRegistrySubmitResult;
        const result: DomainRegistrySubmitResult = { accepted: payload.accepted === true };
        if (typeof payload.leafIndex === 'number') result.leafIndex = payload.leafIndex;
        if (typeof payload.treeSize === 'number') result.treeSize = payload.treeSize;
        if (payload.checkpoint !== undefined) {
            try {
                result.checkpoint = parseDomainCheckpoint(payload.checkpoint);
            } catch (error) {
                throw new DomainRegistryError(
                    `registry returned an invalid checkpoint: ${String(error)}`,
                );
            }
        }
        if (payload.anchor !== undefined) {
            try {
                result.anchor = parseDomainAnchor(payload.anchor);
            } catch (error) {
                throw new DomainRegistryError(`registry returned an invalid anchor: ${String(error)}`);
            }
        }
        if (typeof payload.error === 'string') result.error = payload.error;
        if (typeof payload.code === 'string') result.code = payload.code;
        return result;
    }

    /** ログ鍵の素性（`GET /domain/log`）。TOFU ピン留めに使う。 */
    async logInfo(context: DomainSourceContext = {}): Promise<{ logId: string; publicKey: string }> {
        const payload = await this.request('GET', '/domain/log', { signal: context.signal });
        if (typeof payload.logId !== 'string' || typeof payload.publicKey !== 'string') {
            throw new DomainRegistryError('registry response for /domain/log is malformed');
        }
        return { logId: payload.logId, publicKey: payload.publicKey };
    }

    private async request(
        method: 'GET' | 'POST',
        path: string,
        init: { body?: string; signal?: AbortSignal } = {},
    ): Promise<Record<string, unknown>> {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const onOuterAbort = (): void => controller.abort();
        if (init.signal) {
            if (init.signal.aborted) controller.abort();
            else init.signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (this.timeoutMs > 0) {
            timer = setTimeout(() => controller.abort(), this.timeoutMs);
        }
        let response: RegistryFetchResponse;
        try {
            response = await this.fetchImpl(url, {
                method,
                ...(init.body !== undefined
                    ? { body: init.body, headers: { 'content-type': 'application/json' } }
                    : {}),
                signal: controller.signal,
            });
        } catch (error) {
            throw new DomainRegistryError(
                `domain registry request failed (${method} ${path}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            init.signal?.removeEventListener('abort', onOuterAbort);
        }
        if (!response.ok) {
            if (response.status === 404 && this.tolerateNotFound) {
                this.logger.debug(`registry answered 404 for ${method} ${path}`);
                return {};
            }
            const detail = await safeText(response);
            throw new DomainRegistryError(
                `domain registry returned ${response.status} for ${method} ${path}${detail ? `: ${detail}` : ''}`,
                { status: response.status },
            );
        }
        const text = await safeText(response);
        if (text.length > MAX_RESPONSE_BYTES) {
            throw new DomainRegistryError('domain registry response is too large', {
                status: response.status,
            });
        }
        if (text.length === 0) return {};
        try {
            const parsed = JSON.parse(text) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('response is not a JSON object');
            }
            return parsed as Record<string, unknown>;
        } catch (error) {
            throw new DomainRegistryError(
                `domain registry returned malformed JSON: ${String(error)}`,
                { status: response.status },
            );
        }
    }
}

async function safeText(response: RegistryFetchResponse): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

/** ファクトリ（ブラウザ側から `new` を隠す糖衣）。 */
export function createHttpDomainRegistryClient(
    options: HttpDomainRegistryClientOptions,
): HttpDomainRegistryClient {
    return new HttpDomainRegistryClient(options);
}
