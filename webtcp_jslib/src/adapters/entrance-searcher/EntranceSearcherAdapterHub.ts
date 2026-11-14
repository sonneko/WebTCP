import { NodeId } from '../../core/types/protocol.js';
import { IEntranceSearcher } from './IEntranceSearcher.js';

export interface EntranceSearcherAdapterHubOptions {
    /** ハブのベースURL。 */
    url: string;
    /** パス。既定 `/entrances`。 */
    path?: string;
    /** fetch の実装（テスト用に差し替え可能）。 */
    fetchImpl?: typeof fetch;
}

/**
 * HTTP 経由でエントランス（接続候補ノード）を取得する（specification.md §9.5）。
 *
 * サーバーは次の形で応答する。
 * ```json
 * { "nodes": ["0123...cdef"] }
 * ```
 */
export class EntranceSearcherAdapterHub implements IEntranceSearcher {
    private readonly url: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: EntranceSearcherAdapterHubOptions) {
        if (!options.url) {
            throw new Error('EntranceSearcherAdapterHub requires a hub URL');
        }
        this.url = options.url.replace(/\/+$/, '') + (options.path ?? '/entrances');

        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            throw new Error('No fetch implementation available');
        }
        this.fetchImpl = fetchImpl.bind(globalThis);
    }

    public async search(): Promise<NodeId[]> {
        const response = await this.fetchImpl(this.url, {
            headers: { accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`GET ${this.url} failed: HTTP ${response.status}`);
        }

        const body = (await response.json()) as { nodes?: unknown };
        if (!Array.isArray(body.nodes)) {
            throw new Error('Invalid /entrances response: "nodes" must be an array');
        }

        const nodes = body.nodes.filter(
            (node): node is NodeId => typeof node === 'string' && node.length > 0,
        );
        return [...new Set(nodes)];
    }
}
