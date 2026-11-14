---
title: アーキテクチャ解説
description: design.md に基づく WebTCP のレイヤー構成、モジュール依存方向、主要な設計判断。
---

このページはリポジトリの `design.md` の要約です。

## 設計原則

1. **プラットフォーム非依存のコア**: `src/core` はブラウザにも Node.js にも依存しません（`Buffer` や `node:events` を使わない）。
2. **一方向の依存**: アプリケーション → トランスポート（L4）→ ルーティング（L3）→ リンク（L2）→ アダプタ。上位への通知はイベントまたは最小インターフェースで行います。
3. **差し替え可能なアダプタ**: WebRTC、シグナリング、エントランス探索、署名検証、ロガーはすべてインターフェース越しに注入します。
4. **バンドラ非必須**: `tsc` の出力（ESM + `.d.ts`）をそのままブラウザの `<script type="module">` から import できます。

## レイヤー構成

```
+-----------------------------------------------------------+
| L7  アプリケーション (任意のプロトコル / 将来の HTTP 層)     |
+-----------------------------------------------------------+
| L4  TransportLayer : 仮想ポート多重化 / SessionManager      |
|     VirtualStream  : 状態機械 / バイト Seq-Ack / 自動分割    |
|                      動的 RTO / 輻輳制御 / SACK / Half-Close |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF / 署名検証  |
|     RoutingTable(+Manager) : 距離ベクトル経路表と撤回伝播    |
+-----------------------------------------------------------+
| L2  LinkManager    : 隣接管理 / バイナリシリアライズ         |
|     IChannel       : WebRTC DataChannel の抽象化             |
|     ISignalingAdapter / IEntranceSearcher                   |
+-----------------------------------------------------------+
| L1  WebRTC (SCTP over DTLS over ICE) / ブラウザ API          |
+-----------------------------------------------------------+
```

## 主要な設計判断

### `Uint8Array` + `DataView` と独自 `EventEmitter`

`Buffer` と `events` を排除し、`Uint8Array` / `DataView` / `TextEncoder` と最小の独自 `EventEmitter` を採用しています。Node.js の `Buffer` は `Uint8Array` のサブクラスであるため、Node.js 利用者からもそのまま渡せます。

### シグナリング所有権の `IChannel` 集約

シグナリング（Offer / Answer / ICE 候補の運搬）は `WebRTCChannel` 内部で完結させ、`LinkManager` は隣接状態管理とパケットのシリアライズだけに責務を絞っています。`BrowserWebRTCChannel` と `NodeWebRTCChannel` は共通基底 `WebRTCChannel` を継承し、`createPeerConnection(iceServers)` のみ差し替えます。

### ルーティング更新の `RT_UPDATE` 統一と撤回リスト

ルーティングテーブルの交換は通常の WebTCP パケット（`RT_UPDATE` フラグ）として同一のシリアライズ経路を流れます。隣接切断やエイジングで失効した経路は `withdrawals` フィールドで全隣接へ伝播し、受信側はネクストホップが送信元と一致する場合に限り削除します。

### プロトコル v1 互換の SACK 拡張

24 バイト固定ヘッダーを変更せず、純粋な `ACK` パケットの空ペイロード領域に SACK オプション（種別 `0x05` + 最大 4 ブロック）を載せる設計としました。順序外データが無い通常時はペイロード 0 バイトのままオーバーヘッドゼロです。

### 差し替え可能な署名検証とロガー

- **署名検証（`IPacketVerifier`）**: M1–M2 の既定は `NullPacketVerifier`。ワイヤーフォーマット上に署名フィールドを予約済みで、M3（#28）で `Ed25519PacketVerifier` を導入予定です。
- **ロガー（`Logger`）**: コア・アダプタ全体から `console.*` の直書きを廃止し、`WebTCPNetwork` へ注入したロガーを全層へ伝播します（既定 `warn` 以上）。

## 接続・通信・切断シーケンス

```
Client (TransportLayer)                        Server (TransportLayer)
| SYN (seq=C_ISN, ack=0) -------------------->| stream=SYN_RCVD
|<------------------ SYN_ACK (S_ISN, C_ISN+1) |
| ESTABLISHED, emit connect                   |
| ACK (ack=S_ISN+1) ------------------------->| ESTABLISHED, emit connect -> listen handler
| DATA (seq=C_ISN+1, len=N) ----------------->| deliver / recvBuffer, send ACK (+SACK)
|<------------------------ ACK (ack=C_ISN+1+N)|
| end() -> FIN (FIN_WAIT_1) ----------------->| send ACK, emit 'end' (CLOSE_WAIT)
|<---------------------------------- ACK      | (FIN_WAIT_2; server can still send!)
|<------------------------ DATA / FIN         | server calls end() (LAST_ACK)
| send ACK (TIME_WAIT -> CLOSED) ------------>| CLOSED
```
