import { NodeId } from '../../core/types/protocol.js';

/**
 * ネットワークへの入口（エントランス）を探索する抽象。
 *
 * WebTCP は P2P であり、最初に接続する相手を何らかの手段で知る必要がある。
 * その手段を差し替え可能にする。
 */
export interface IEntranceSearcher {
    /**
     * 接続候補となるノードIDの一覧を返す。
     * 候補が無い場合は空配列を返す。
     */
    search(): Promise<NodeId[]>;
}
