/**
 * WebTCPプロトコル全体で使用される基本型定義。
 *
 * このモジュールはブラウザ・Node.jsのどちらにも依存してはならない。
 * ペイロードや署名は `Buffer` ではなく `Uint8Array` を用いる（design.md §3.1）。
 */

/**
 * ネットワーク内のノードを一意に識別するID（プロトコル v2 では Ed25519 公開鍵の指紋）。
 *
 * 形式は `^[0-9a-f]{32}$`。SHA-256(公開鍵) の先頭 16 バイトを hex 化したもの
 * （specification.md §5.1、`deriveNodeId()` を参照）。
 */
export type NodeId = string;

/** トランスポート層で使用される仮想ポート番号（1–65535、0は制御用予約）。 */
export type VirtualPort = number;

/** TCPセッションを一意に識別するID。 */
export type SessionId = string;

/** 時間を表す型（ミリ秒単位）。 */
export type Milliseconds = number;

/** バイト単位のシーケンス番号・ACK番号（mod 2^32）。 */
export type SequenceNumber = number;

/**
 * 署名（改ざん検証に使用される）。
 * プロトコル v2 では Ed25519 署名（64 バイト）。v1 では常に空配列。
 */
export type Signature = Uint8Array;

/**
 * WebTCPパケットのフラグ。
 * `SYN_ACK` は `SYN | ACK` と等価に扱う（specification.md §6.3）。
 */
export type WebTCPFlags =
    | 'SYN'
    | 'ACK'
    | 'SYN_ACK'
    | 'FIN'
    | 'RST'
    | 'DATA'
    | 'RT_UPDATE';

/** 仮想ストリーム（TCP相当）の状態（specification.md §8.2）。 */
export type StreamState =
    | 'CLOSED'
    | 'SYN_SENT'
    | 'SYN_RCVD'
    | 'ESTABLISHED'
    | 'FIN_WAIT_1'
    | 'FIN_WAIT_2'
    | 'CLOSE_WAIT'
    | 'CLOSING'
    | 'LAST_ACK'
    | 'TIME_WAIT';

/**
 * 現在の WebTCP プロトコルバージョン（ワイヤーフォーマット）。
 *
 * v2 では Ed25519 署名が必須であり、NodeId は公開鍵の指紋でなければならない（#28）。
 * v1（署名なし・ランダム NodeId）は後方互換のため受信のみ受理する（§13）。
 */
export const WEBTCP_PROTOCOL_VERSION = 2;

/** 署名なしの旧プロトコルバージョン（受信のみ受理。specification.md §13）。 */
export const WEBTCP_PROTOCOL_VERSION_V1 = 1;

/** 受信側が受理するプロトコルバージョン。 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [
    WEBTCP_PROTOCOL_VERSION_V1,
    WEBTCP_PROTOCOL_VERSION,
];

/** パケットのマジックバイト（'W'）。 */
export const WEBTCP_MAGIC = 0x57;

/** パケットの固定ヘッダー長（バイト）。v1 / v2 で共通。 */
export const WEBTCP_HEADER_SIZE = 24;

/** Ed25519 署名のバイト長（プロトコル v2）。 */
export const WEBTCP_SIGNATURE_BYTES = 64;
