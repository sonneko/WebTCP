/**
 * WebTCPプロトコル全体で使用される基本型定義。
 *
 * このモジュールはブラウザ・Node.jsのどちらにも依存してはならない。
 * ペイロードや署名は `Buffer` ではなく `Uint8Array` を用いる（design.md §3.1）。
 */

/** ネットワーク内のノードを一意に識別するID（M1–M2では32文字のhex）。 */
export type NodeId = string;

/** トランスポート層で使用される仮想ポート番号（1–65535、0は制御用予約）。 */
export type VirtualPort = number;

/** TCPセッションを一意に識別するID。 */
export type SessionId = string;

/** 時間を表す型（ミリ秒単位）。 */
export type Milliseconds = number;

/** バイト単位のシーケンス番号・ACK番号（mod 2^32）。 */
export type SequenceNumber = number;

/** 署名（改ざん検証に使用される）。M1–M2では空配列。 */
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

/** WebTCPのプロトコルバージョン（ワイヤーフォーマット）。 */
export const WEBTCP_PROTOCOL_VERSION = 1;

/** パケットのマジックバイト（'W'）。 */
export const WEBTCP_MAGIC = 0x57;

/** パケットの固定ヘッダー長（バイト）。 */
export const WEBTCP_HEADER_SIZE = 24;
