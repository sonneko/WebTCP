/**
 * WebTCPプロトコル全体で使用される基本型定義。
 */

// ネットワーク内のノードを一意に識別するID
export type NodeId = string;

// トランスポート層で使用される仮想ポート番号
export type VirtualPort = number;

// TCPセッションを一意に識別するID
export type SessionId = string;

// 時間を表す型 (ミリ秒単位)
export type Milliseconds = number;

// 署名 (改ざん検証に使用される)
export type Signature = string;

// WebTCPパケットのフラグ
export type WebTCPFlags = 'SYN' | 'ACK' | 'SYN_ACK' | 'FIN' | 'RST' | 'DATA' | 'RT_UPDATE';

// 接続の状態
export type StreamState = 'CLOSED' | 'LISTEN' | 'SYN_SENT' | 'SYN_RCVD' | 'ESTABLISHED' | 'FIN_WAIT_1' | 'FIN_WAIT_2' | 'CLOSING' | 'TIME_WAIT' | 'LAST_ACK';
