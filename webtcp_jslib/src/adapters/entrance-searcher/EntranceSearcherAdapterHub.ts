import { NodeId } from '../../core/types/protocol.js';
import { IEntranceSearcher } from '../../core/link/IEntranceSearcher.js';

export interface EntranceSearcherAdapterHubOptions {
    /** ハブのベースURL。 */
    url: string;
    /** パス。既定 `/entrances`。 */
    path?: string;
    /** 候補から除外するノードID（通常は自身の NodeId、specification.md §10.5）。 */
    exclude?: NodeId;
    /** fetch の実装（テスト用に差し替え可能）。 */
    fetchImpl?: typeof fetch;
}

/**
 * HTTP 経由でエントランス（接続候補ノード）を取得する（specification.md §10.5）。
 *
 * サーバーは次の形で応答する。
 * ```json
 * { "nodes": ["0123...cdef"] }
 * ```
 */
export class EntranceSearcherAdapterHub implements IEntranceSearcher {
    private readonly url: string;
    private readonly exclude: NodeId | undefined;
    private readonly fetchImpl: typeof fetch;

    constructor(options: EntranceSearcherAdapterHubOptions) {
        if (!options.url) {
            throw new Error('EntranceSearcherAdapterHub requires a hub URL');
        }
        const base = options.url.replace(/\/+$/, '') + (options.path ?? '/entrances');
        this.exclude = options.exclude;
        if (options.exclude) {
            const sep = base.includes('?') ? '&' : '?';
            this.url = `${base}${sep}exclude=${encodeURIComponent(options.exclude)}`;
        } else {
            this.url = base;
        }

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
            (node): node is NodeId =>
                typeof node === 'string' && node.length > 0 && node !== this.exclude,
        );
        return [...new Set(nodes)];
    }
}
