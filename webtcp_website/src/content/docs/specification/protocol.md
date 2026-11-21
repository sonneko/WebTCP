---
title: プロトコル仕様サマリー
description: specification.md（0.7.0 / プロトコル v2）のパケット形式、TCP セマンティクス、ルーティング、Ed25519 署名、名前解決、domain.global 所有権、HTTP トンネル、シグナリング契約の要約。
---

このページはリポジトリの `specification.md`（バージョン 0.8.1 / プロトコル v2、v1 は受信のみ後方互換）の要約です。規範的な定義（RFC 2119 キーワードを含む全文）はリポジトリルートの `specification.md` を参照してください。

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
| 6 | `RT_UPDATE` | 距離ベクトル経路更新（UTF-8 JSON）。直接隣接・sender 一致・自ノード宛・正 TTL・ポート 0 のみ受理し、中継しない |
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
- **公開鍵の配布**: シグナリング時の `public-key` 交換 + `RT_UPDATE` の `publicKey` / `entries[].publicKey` 同梱。どちらも指紋一致を必須とし、事前鍵共有なしのマルチホップ署名検証を可能にします。
- **永続 NodeId と衝突検出（M4）**: ブラウザ復元時は署名チャレンジで秘密鍵と公開鍵の対応を検証。Node.js は `NodeKeyManager.open({ keyFile })` で PKCS#8 PEM を `0600` 永続化。同一 NodeId に異なる鍵が対応する場合は `NodeIdCollisionError`。
- 詳細は [仕様書 §11](https://github.com/sonneko/WebTCP/blob/main/specification.md) を参照してください。

## シグナリング・エントランス HTTP 契約

| メソッド | パス | 用途 |
| :--- | :--- | :--- |
| `POST` | `/signal` | Offer / Answer / ICE 候補の送信（`{ fromId, toId, message }` → `202`） |
| `GET` | `/messages?nodeId=<id>&after=<cursor>` | 自ノード宛シグナリングメッセージのポーリング取得 |
| `GET` | `/entrances?exclude=<NodeId>` | 接続候補ノード ID 一覧の取得 |

DataChannel が開くと、双方が `public-key` メッセージ（`{ type: 'public-key', publicKey: <Base64url>, nodeId }`）を交換します（§10.2.1）。


## 名前解決と WebTCP URL（M4 / #25）

- `NameServer` はアプリケーション層サービスで、新しい L3/L4 フラグやワイヤーバージョンを追加しません。既存の署名付き `VirtualStream` 上で UTF-8 JSON の要求/応答を交換します（既定仮想ポート 5300）。
- レコードは A（`name -> NodeId`）と CNAME（`name -> canonical name`）。TTL 既定 60 秒、最大 86400 秒。
- 解決順序はローカル登録 → TTL キャッシュ → 既知ノード（明示 `resolvers` / 隣接 / 経路表）への反復問い合わせ。サーバーはローカル登録のみを返し、再帰問い合わせしません。
- `webtcp://<host>:<port><path>?<query>#<fragment>` はポート必須（1–65535）。host は NodeId リテラルまたは LDH 名。`parseWebTCPUrl()` / `formatWebTCPUrl()` / `network.connectURL()` を提供します。
- ゾーン外の名前解決はグローバルな所有権証明ではありません（応答ノードの自己申告）。所有権は次節の `domain.global` に限って検証可能です。

## HTTP トンネル（M6 / #50・仕様 §16）

HTTP/1.1 のサブセットを `VirtualStream` のバイト列として運びます。**パケット形式は変更しません**。

- 開始行は `method SP request-target SP "HTTP/1.1"`。request-target は origin-form（`/path?query`）のみ。
- ヘッダは CRLF 厳格、上限はリクエストライン 8 KiB / ヘッダ行 8 KiB / 100 個 / 合計 32 KiB（既定）。
- 本文は `Content-Length`・`Transfer-Encoding: chunked`・本文なしの 3 経路。両立は `400`。
- `keep-alive` は逐次（非パイプライン）。アイドル 30 秒。`Connection: close` では FIN 後にも応答を書けます（Half-Close の `CLOSE_WAIT` 送信）。
- エラー: `400` / `404` / `413` / `414` / `417` / `431` / `500` / `501` / `503` / `505`。
- ヘッダ書き込み時に CR/LF/NUL を拒否（インジェクション対策）、`remoteNodeId` は接続元のみ（エンドツーエンド認証ではない）。

## `domain.global` と所有権証明（M5 / #25・仕様 §14）

- **ゾーン**: `domain.global` 直下 1 ラベルのみ（LDH、1 ラベル 1–63 文字、完全名 253 文字まで）。ゾーン名そのものは登録不可。
- **レコード**: `DomainOwnershipRecord` は `body`（domain / nodeId / ownerPublicKey / serial / issuedAt / expiresAt / revoked / port / txt）+ `anchor` + Ed25519 `signature`。署名対象は canonical バイト列（固定長ヘッダ + 長さ接頭辞文字列）。サイズ上限 16 KiB、寿命は既定 30 日・上限 365 日。
- **commitment が真実**: 台帳が保持するのは `SHA-256(canonical body)` の 32 バイトのみで、レコード本体は carrier として運ばれます。
- **台帳とチェックポイント**: リーフは `H(0x00 || commitment)`、ルートは `H(0x02 || uint64BE(treeSize) || top)` でツリーサイズに束縛。チェックポイント（`treeSize` ごとにログ鍵が署名、`prevHash` で連結）は**追記専用**で、読み取りのたびに再署名してはなりません (MUST NOT)。
- **検証は fail-closed・順序固定**: 形式 → 指紋とゾーン → 所有者署名 → 有効期間（`clockSkewMs` 既定 300 秒）→ serial 単調増加と失効 → 同一 serial 衝突 → 台帳アンカー（包含証明 → チェックポイント署名 → ピン留め後退拒否 → 必要なら連結追跡）→ 収集元全滅は `resolution-unavailable`。
- **信頼の根拠はピン留めされたログ鍵**（`logKeys` / `resolveLogKey`）。未知の台帳のアンカーは `anchor-untrusted-log` で棄却され、HTTP で取得した文字列を信頼することはありません。
- **ワイヤー拡張**: 名前問い合わせ JSON に `wantOwnership`（要求）と `ownership`（応答）を追加した後方互換拡張です。L3/L4 フラグは増やしません。
- **HTTP レジストリ（オプショナル）**: `POST /domain/record`、`GET /domain/record?name=|?nodeId=`、`GET /domain/checkpoint`、`GET /domain/checkpoints?after=&to=`、`GET /domain/log`。改ざんは `400`、`serial` 衝突は `409`、0 件は `404`。
- **未実装**: 実ブロックチェーンへの裏付け（#42）、レジストリ運用ガバナンス（#43）。
