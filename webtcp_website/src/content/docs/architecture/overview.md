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
| L7  アプリケーション (NameServer / 任意のプロトコル)      |
+-----------------------------------------------------------+
| L4  TransportLayer : 仮想ポート多重化 / SessionManager      |
|     VirtualStream  : 状態機械 / バイト Seq-Ack / 自動分割    |
|                      動的 RTO / 輻輳制御 / SACK / Half-Close |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF             |
|     Ed25519 署名・検証 / KeyDirectory（公開鍵の指紋）          |
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

### Ed25519 署名と自己証明型 NodeId（M3 / #28）

`NodeId` は **Ed25519 公開鍵の指紋**（`SHA-256` の先頭 16 バイト）です。署名対象は「署名フィールドを除いたシリアライズ済みパケット」で、
TTL は 0 に正規化されるため、送信元が 1 度署名すれば中継ノードは再署名せずに転送できます。
公開鍵は (1) DataChannel open 時の `public-key` シグナリング交換、(2) `RT_UPDATE` への同梱、で配布され、
受信側は `KeyDirectory` に登録する前に必ず指紋一致を検証します。

鍵管理はプラットフォームごとに分離しています（`core` は暗号ライブラリに依存しない）。

- `BrowserKeyManager`: Web Crypto API + IndexedDB（秘密鍵は **非抽出 CryptoKey**）
- `NodeKeyManager`: `node:crypto`（Ed25519 `KeyObject` + `webcrypto.subtle`）

### NameServer と `webtcp://` URL（M4 / #25）

`core/naming` は L7 アプリケーション層サービスとして `WebTCPNetwork` の公開 API に依存します。L3/L4 へ名前を漏らさず、既存の署名付き `VirtualStream` 上で JSON 要求/応答を運びます。
ローカル登録を権威データとし、クライアント側で CNAME を反復解決します。サーバーは他ノードへ再帰問い合わせしないため、問い合わせループと増幅を抑えます。
`parseWebTCPUrl()` は非特殊スキームの環境依存を避けるため明示的な検証でパースし、`connectURL()` は名前なら NameServer、NodeId なら直接 `connect()` へ振り分けます。 `parseWebTCPUrl()` はゾーン名を `zone` として保持し、`.domain.global` を NameServer の権威側へ流します（M5）。

### 永続 NodeId と RT_UPDATE の信頼境界（M4 / #36, #37）

ブラウザ鍵復元時は公開鍵指紋だけでなく署名チャレンジで秘密鍵との対応を検証します。Node.js は `NodeKeyManager.open({ keyFile })` で PKCS#8 PEM を `0600` ・原子的に保存します。
`RT_UPDATE` は直接隣接・sender 一致・自ノード宛・正 TTL・制御ポート 0 のみ受理し、中継しません。`entries[].publicKey` で既知鍵を経路とともに伝播し、受信側は指紋検証して `KeyDirectory` へ登録します。

### domain.global 所有権レコードと台帳検証（M5 / #25）

`core/domain` は「名前をその NodeId に束縛できるのは誰か」を、**検証可能なレコード**として扱います。ブラウザにブロックチェーンクライアントは入れず、次の 3 点にスコープしました。

1. **所有者署名付きレコード** (`DomainOwnershipRecord`): canonical バイト列（固定長ヘッダ + 長さ接頭辞文字列）への Ed25519 署名。SHA-256 による 32 バイトの commitment が台帳に載り、レコード本体は carrier です。
2. **追記専用台帳とチェックポイント** (`DomainLedger` / `DomainCheckpoint`): リーフは `H(0x00 || commitment)`、ルートは `H(0x02 || uint64BE(treeSize) || top)` と**ツリーサイズに束縛**されるので、別のサイズの包含証明を通せません。チェックポイントはログ鍵が署名し、`prevHash` で連結されます。読取時に再署名しないため、`prevHash` の自己一致性が保たれます。
3. **差し替え可能な検証器** (`IDomainOwnershipVerifier` / `IChainAnchorVerifier`): 検証順序は fail-closed で固定（形式 → 指紋とゾーン → 所有者署名 → 有効期間 → serial と失効 → 衝突 → アンカー → 収集元全滅は `resolution-unavailable`）。信頼の根拠は**ピン留めされたログ鍵**であり、未知の台帳のアンカーは `anchor-untrusted-log` で棄却されます。

`DomainAuthority` が収集元（ローカル → HTTP レジストリ → 既知ノードの `wantOwnership` 応答）から候補をあつめ、検証を通ったものだけを残します。`core/domain` はストリーム I/O を知らず、NameServer 側の JSON プロトコルは後方互換拡張（`wantOwnership` / `ownership`）にとどめています。チェックポイントは**追記専用**なので、受理済みの `treeSize` より古いチェックポイントを見たら `anchor-rollback` で拒否します（読み取りのたびに作り直さない MUST があるのはこのためです）。

### HTTP トンネル（M6 / #50）

HTTP は `VirtualStream` の上の**純粋なバイトプロトコル**として実装します（`core/http`）。新しいパケット種別もポート予約も導入しないため、L4 までの実装・プロトコル v2 の署名検証・RPF・輻輳制御はそのまま効きます。

- **サーバー** (`HTTPServer`): 仮想ポートを `listen()` し、接続ごとに「リクエストを 1 つ読む → ハンドラ → 応答を書き切る → 継続判定」の逐次ループを回します。`keep-alive`（既定）と `Connection: close`（FIN 後も応答を書ける）、`HEAD` の本文抑止、同時接続上限、アイドルタイムアウトを持ちます。
- **クライアント** (`HTTPClient`): `fetch` 風 API。`webtcp://` URL の `path` + `query` を request-target に写像し、`(NodeId, 仮想ポート)` 単位で接続をプールします。パイプラインはせず、同時リクエストは別接続で並行します。
- **パーサ** (`HTTPHeadParser` / `HTTPChunkedDecoder`): ストリームの分割位置に依存しない逐次パーサ。CRLF 厳格、行長・ヘッダ数の上限つき。`Content-Length` と `Transfer-Encoding` の併用は `400`（スマグリング対策）。
- **ライタ** (`HTTPWriter`): ヘッダ名（`token`）と値（CR/LF/NUL 不在）を検証し、アプリがユーザー入力をそのまま流してもインジェクションが成立しません。
- **理由**: ブラウザ内ライブラリなので DOM API（`ReadableStream`）ではなく `AsyncIterable<Uint8Array>` を採用し、大きな本文はバックプレッシャー付きでストリーミングします。

詳細は [HTTP トンネル](/guides/http-tunnel/) と [仕様 §16](https://github.com/sonneko/WebTCP/blob/main/specification.md) を参照してください。

### 差し替え可能な署名検証とロガー

- **署名検証（`IPacketVerifier`）**: `keyManager`（または `Ed25519PacketVerifier`）を渡すとプロトコル v2 の署名必須になります。どちらも渡さない既定構成は `NullPacketVerifier` で、v1 パケットを無検証で通します（実験・相互運用モード、#28）。`Ed25519PacketVerifier` は署名対象のシリアライザを必須注入とし、無い場合は構築時に失敗します（#41 — 検証側が独自に近似すると、片側だけ通る署名になります）。
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
