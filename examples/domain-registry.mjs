/**
 * `domain.global` 参照レジストリ（specification.md §14.6）。
 *
 * デモサーバーに組み込む小さなラッパーで、実装はビルド済み `webtcp_jslib` を
 * そのまま使う。canonical バイト列・Ed25519 署名・Merkle 木・チェックポイント署名を
 * サーバー側で**再実装しない**ことが重要だ（実装が分岐すると検証が嘘になる）。
 *
 * 依存: `webtcp_jslib/dist/index.js`（`npm run build` で生成）。読み込めない場合は
 * `unavailable` を返し、サーバーは 503 を返す（デモ自体は落ちない）。
 *
 * 注意: ログ鍵は**起動のたびに作り直す**。恒久化すると、その鍵を PIN したクライアントに
 * 対して台帳を書換える能力を持つことになる（§14.7 の信頼境界）。本来の透明性ログは #42。
 */

/** ビルド済みライブラリの場所（`npm run build` で生成される）。 */
const LIBRARY_URL = new URL('../webtcp_jslib/dist/index.js', import.meta.url);

/** 1 レコードの JSON 上限（specification.md §14.2 / §14.6）。 */
export const MAX_RECORD_JSON_BYTES = 16 * 1024;

/** 1 応答に載せるレコード数の上限（specification.md §14.6）。 */
export const MAX_RECORDS_PER_RESPONSE = 8;

let cachedLibrary = null;

/** ESM のまま動的 import する（`require(esm)` は Node のバージョン依存になるため避ける）。 */
async function loadLibrary() {
    if (cachedLibrary) return cachedLibrary;
    cachedLibrary = await import(LIBRARY_URL.href);
    return cachedLibrary;
}

/**
 * 参照レジストリを作る。`state()` は初期化を待って台帳の状態を返す。
 */
export function createDomainRegistry(options = {}) {
    /** @type {{ lib: unknown, ledger: unknown, keyManager: unknown } | null} */
    let runtime = null;
    let failure = null;

    const init = async () => {
        if (runtime) return runtime;
        if (failure) throw failure;
        try {
            const lib = await loadLibrary();
            const keyManager = await lib.NodeKeyManager.create();
            runtime = {
                lib,
                keyManager,
                ledger: lib.createDomainLedger({
                    keyManager,
                    logId: keyManager.nodeId,
                    logger: lib.noopLogger,
                }),
            };
            return runtime;
        } catch (error) {
            failure = error;
            throw error;
        }
    };

    const unavailable = (res) => ({
        status: 503,
        body: {
            error: 'the domain registry needs the built library; run `npm run build` in webtcp_jslib',
            detail: String(failure?.message ?? failure ?? 'library not built'),
        },
    });

    return {
        /** レジストリが使えるか（初期化済みなら `true`）。 */
        get ready() {
            return runtime !== null;
        },
        get error() {
            return failure ? String(failure.message ?? failure) : null;
        },

        /**
         * `POST /domain/record`。検証（§14.4 の 1〜6）を通ったものだけを受け付ける。
         * @param {unknown} payload
         */
        async submit(payload) {
            let context;
            try {
                context = await init();
            } catch {
                return unavailable();
            }
            const { lib } = context;
            const candidate = payload && typeof payload === 'object' ? payload.record ?? payload : null;
            if (!candidate) {
                return { status: 400, body: { error: 'body must be { "record": DomainOwnershipRecord }' } };
            }
            const json = JSON.stringify(candidate);
            if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_JSON_BYTES) {
                return {
                    status: 413,
                    body: { error: `record exceeds ${MAX_RECORD_JSON_BYTES} bytes` },
                };
            }
            let record;
            try {
                record = await lib.parseDomainOwnershipRecord(JSON.parse(json));
            } catch (error) {
                return { status: 400, body: { error: 'invalid ownership record', detail: String(error.message ?? error) } };
            }
            const proof = await lib
                .createDomainOwnershipVerifier({ logger: lib.noopLogger })
                .verify(record);
            if (!proof.ok) {
                return {
                    status: 400,
                    body: { accepted: false, code: proof.code, error: proof.message ?? 'ownership proof failed' },
                };
            }
            try {
                const appended = await context.ledger.append(record);
                return {
                    status: 200,
                    body: {
                        accepted: true,
                        domain: appended.record.body.domain,
                        commitment: appended.commitment,
                        leafIndex: appended.anchor.leafIndex,
                        treeSize: appended.anchor.checkpoint.treeSize,
                        checkpoint: appended.anchor.checkpoint,
                        anchor: appended.anchor,
                        record: JSON.parse(JSON.stringify(appended.record)),
                    },
                };
            } catch (error) {
                if (error instanceof lib.DomainConflictError) {
                    // `conflictVerdict()` の裁定語をそのまま HTTP の code に写像する (§14.4.3)
                    const verdict = /verdict "([a-z-]+)"/.exec(error.message)?.[1] ?? 'conflict';
                    return {
                        status: 409,
                        body: {
                            accepted: false,
                            code: verdict === 'conflict' ? 'conflict' : 'stale-serial',
                            verdict,
                            error: error.message,
                        },
                    };
                }
                if (error instanceof lib.DomainLedgerAppendError) {
                    return { status: 409, body: { accepted: false, code: 'ledger-rejected', error: error.message } };
                }
                return { status: 400, body: { accepted: false, code: 'invalid-record', error: String(error.message ?? error) } };
            }
        },

        /**
         * `GET /domain/record?name=` / `?nodeId=`。
         * @param {URLSearchParams} params
         */
        async lookup(params) {
            let context;
            try {
                context = await init();
            } catch {
                return unavailable();
            }
            const { lib } = context;
            const name = params.get('name');
            const nodeId = params.get('nodeId');
            if (!name && !nodeId) {
                return { status: 400, body: { error: 'name or nodeId is required' } };
            }
            const snapshot = await context.ledger.snapshot();
            let records = [];
            if (name) {
                let canonical;
                try {
                    canonical = lib.normalizeDomainName(name);
                } catch (error) {
                    return { status: 400, body: { error: String(error.message ?? error) } };
                }
                const found = snapshot.current[canonical];
                if (!found) return { status: 404, body: { error: 'no ownership record', name: canonical } };
                records = [found];
            } else {
                for (const record of Object.values(snapshot.current)) {
                    if (record.body.nodeId === nodeId) records.push(record);
                }
                records.sort((a, b) => (a.body.domain < b.body.domain ? -1 : 1));
            }
            const truncated = records.length > MAX_RECORDS_PER_RESPONSE;
            return {
                status: 200,
                body: {
                    records: records.slice(0, MAX_RECORDS_PER_RESPONSE).map((record) => JSON.parse(JSON.stringify(record))),
                    checkpoint: snapshot.checkpoint,
                    truncated,
                },
            };
        },

        /** `GET /domain/checkpoint`。 */
        async checkpoint() {
            let context;
            try {
                context = await init();
            } catch {
                return unavailable();
            }
            const snapshot = await context.ledger.snapshot();
            return {
                status: 200,
                body: {
                    logId: snapshot.logId,
                    treeSize: snapshot.treeSize,
                    root: snapshot.root,
                    checkpoint: snapshot.checkpoint,
                },
            };
        },

        /**
         * `GET /domain/checkpoints?after=&to=`（`between` 区間。両端は含めない）。
         * @param {URLSearchParams} params
         */
        async checkpoints(params) {
            let context;
            try {
                context = await init();
            } catch {
                return unavailable();
            }
            const after = Number(params.get('after') ?? '0');
            const to = Number(params.get('to') ?? '0');
            if (!Number.isInteger(after) || !Number.isInteger(to) || after < 0 || to <= after) {
                return { status: 400, body: { error: 'after and to must be integers with to > after >= 0' } };
            }
            const checkpoints = await context.ledger.checkpointsBetween({ afterTreeSize: after, toTreeSize: to });
            return { status: 200, body: { checkpoints } };
        },

        /** `GET /domain/log`（ログ鍵の TOFU ピン留め用）。 */
        async log() {
            let context;
            try {
                context = await init();
            } catch (error) {
                return {
                    status: 503,
                    body: { error: 'the domain registry needs the built library', detail: String(error.message ?? error) },
                };
            }
            const snapshot = await context.ledger.snapshot();
            return {
                status: 200,
                body: {
                    logId: snapshot.logId,
                    publicKey: context.ledger.publicKeyEncoded,
                    ephemeral: true,
                    note: 'デモのログ鍵は起動のたびに作り直す（恒久化しない）',
                },
            };
        },
    };
}
