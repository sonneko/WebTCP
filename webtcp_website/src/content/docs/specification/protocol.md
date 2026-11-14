---
title: プロトコル仕様サマリー
description: specification.md（0.3.0 / プロトコル v2）のパケット形式、TCP セマンティクス、ルーティング、Ed25519 署名、シグナリング契約の要約。
---

このページはリポジトリの `specification.md`（バージョン 0.3.0 / プロトコル v2、v1 は受信のみ後方互換）の要約です。規範的な定義（RFC 2119 キーワードを含む全文）はリポジトリルートの `specification.md` を参照してください。

## バイナリパケット形式（固定 24 バイトヘッダー）

すべてのマルチバイト整数は**ビッグエンディアン**です。

| Offset | Size | Field | 型 | 説明 |
| ---: | ---: | :--- | :--- | :--- |
| 0 | 1 | `magic` | uint8 | 固定値 `0x57`（`'W'`） |
| 1 | 1 | `version` | uint8 | `2`（既定・署名必須）/ `1`（レガシー・署名なし） |
| 2 | 1 | `ttl` | uint8 | 残ホップ数（初期値 64） |
| 3 | 1 | `flags` | uint8 | ビットマスク（下表） |
| 4 | 2 | `sourcePort` | uint16 | 送信元仮想ポート（1–65535） |
| 6 | 2 | `destinationPort` | uint16 | 宛先仮想ポート（1–65535） |
| 8 | 4 | `seqNum` | uint32 | バイト単位シーケンス番号（mod 2^32） |
| 12 | 4 | `ackNum` | uint32 | 次に期待する受信バイト番号（mod 2^32） |
| 16 | 1 | `senderIdLen` | uint8 | `senderId` UTF-8 長（1–255） |
| 17 | 1 | `destIdLen` | uint8 | `destinationId` UTF-8 長（1–255） |
| 18 | 2 | `signatureLen` | uint16 | 署名長（v2 は 64、v1 は 0） |
| 20 | 4 | `payloadLen` | uint32 | ペイロード長（上限 60 KiB） |
| 24 | var | 可変長部 | bytes | `senderId` / `destinationId` / `signature`（Ed25519, 64 B） / `payload` |

### フラグビット（Offset 3）

| ビット | 名称 | 意味 |
| ---: | :--- | :--- |
| 0 | `DATA` | アプリケーションデータ |
| 1 | `SYN` | 接続要求（シーケンス 1 消費、`ackNum = 0`） |
| 2 | `ACK` | 確認応答（順序外データ時はペイロードに SACK オプション格納可） |
| 3 | `FIN` | 片方向送信終了（シーケンス 1 消費） |
| 4 | `RST` | 強制切断 |
| 5 | `SYN_ACK` | `SYN | ACK` の同時表現（シーケンス 1 消費） |
| 6 | `RT_UPDATE` | 距離ベクトル経路更新（UTF-8 JSON） |
| 7 | 予約 | 送信時 0、受信時無視 |

## トランスポート層（M2 TCP セマンティクス）

### バイトストリーム・ランダム ISN・自動分割

- `seqNum` / `ackNum` はバイト単位（RFC 1982 シリアル番号算術で 32 ビットラップアラウンドに対応）。
- 接続ごとに暗号学的乱数で 32 ビット ISN を生成。
- 60 KiB 超のメッセージは MSS（既定 16 KiB、上限 60 KiB）以下へ透過的に自動分割し、送信バッファ（上限 4 MiB）と輻輳ウィンドウで流量制御します。
- 受信側は重複・オーバーラップ・順序外をバイト単位で再結合し、プッシュ（`data` イベント）とプル（`read(maxBytes)` / `readExact(bytes)` / `readable` イベント）の両方を提供します。

### 動的 RTO・輻輳制御・Fast Retransmit / SACK

- **動的 RTO（RFC 6298）**: `alpha = 1/8`, `beta = 1/4`, `G = 50 ms`, `RTO = clamp(SRTT + max(G, 4 * RTTVAR), 200ms, 60000ms)`。Karn のアルゴリズムにより再送セグメントからは RTT を計測せず、タイムアウト時は指数バックオフ（×2）します。
- **輻輳制御（RFC 5681）**: 初期 `cwnd = 4 * MSS`（64 KiB）、`ssthresh = maxWindowBytes`（1 MiB）。Slow Start と AIMD Congestion Avoidance を実装し、RTO タイムアウト時は `ssthresh = max(2 * MSS, inFlight / 2)`, `cwnd = MSS` へ縮小します。
- **Fast Retransmit / SACK**: 3 重複 ACK で RTO を待たずに最古の未 SACK セグメントを再送し Fast Recovery に入ります。SACK オプションは純粋 `ACK` ペイロードへ `0x05 | count | [leftEdge:u32, rightEdge:u32]...`（最大 4 ブロック）で格納します。

### Half-Close 状態機械

状態: `CLOSED`, `SYN_SENT`, `SYN_RCVD`, `ESTABLISHED`, `FIN_WAIT_1`, `FIN_WAIT_2`, `CLOSE_WAIT`, `CLOSING`, `LAST_ACK`, `TIME_WAIT`。
既定では `allowHalfOpen = true` であり、相手の `FIN` を受けても `CLOSE_WAIT` に留まってローカルからの送信を継続できます。

## セキュリティ（プロトコル v2 / Ed25519）

- **NodeId = Ed25519 公開鍵の指紋**: `hex(SHA-256(rawPublicKey)[0..16])`（32 文字）。指紋は決定的で、自己証明型の識別子になります。
- **署名対象**: 署名フィールドを除いたシリアライズ済みパケット。**TTL は 0 に正規化**するため、中継ノードは再署名しません。
- **検証**: `senderId` の指紋と検証鍵の指紋を照合し、署名を検証します。失敗したパケットは破棄されます。
- **鍵管理**: ブラウザは Web Crypto + IndexedDB（**非抽出 CryptoKey**）、Node.js は `node:crypto`。
- **公開鍵の配布**: シグナリング時の `public-key` 交換 + `RT_UPDATE` への `publicKey` 同梱。どちらも指紋一致を必須とします。
- 詳細は [仕様書 §10](https://github.com/sonneko/WebTCP/blob/main/specification.md) を参照してください。

## シグナリング・エントランス HTTP 契約

| メソッド | パス | 用途 |
| :--- | :--- | :--- |
| `POST` | `/signal` | Offer / Answer / ICE 候補の送信（`{ fromId, toId, message }` → `202`） |
| `GET` | `/messages?nodeId=<id>&after=<cursor>` | 自ノード宛シグナリングメッセージのポーリング取得 |
| `GET` | `/entrances?exclude=<NodeId>` | 接続候補ノード ID 一覧の取得 |

DataChannel が開くと、双方が `public-key` メッセージ（`{ type: 'public-key', publicKey: <Base64url>, nodeId }`）を交換します（§9.2.1）。
