# WebTCP 設計書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.8.1 |
| 対応仕様 | `specification.md` 0.8.1 / プロトコル v2（v1 後方互換） |
| 最終更新 | 2026-11-17 |

本書は `specification.md` を満たすための**実装構造と技術判断**を記述する。

---

## 1. 設計原則

1. **プラットフォーム非依存のコア**: `src/core` はブラウザにも Node.js にも依存しない。DOM API・Node 組み込みモジュールを直接使わない。また `src/core` は `src/adapters` に依存しない。
2. **依存は上から下への一方向**: アプリケーション → トランスポート → ルーティング → リンク → アダプタ。逆方向はイベントとインターフェースで解決する。
3. **アダプタで差し替え可能**: WebRTC・シグナリング・エントランス探索・鍵管理・ロガーはすべてインターフェースの実装として注入する。
4. **小さく検証可能**: 1 ファイル 1 責務。ユニット・統合テストは Node.js の `node:test` のみで実行できる。
5. **ブラウザで直接動く成果物**: バンドラを必須にしない。`tsc` の ESM 出力をそのまま `<script type="module">` から読める形にする。

## 2. モジュール構成

```
WebTCP/
├── specification.md      # プロトコル仕様書
├── design.md             # 本書（実装構造・設計判断）
├── plan.md               # マイルストーン・将来課題
├── examples/
│   ├── server.mjs        # 静的配信 + シグナリングハブ + エントランス探索 + ドメインレジストリ
│   ├── verify-browser.mjs # Playwright 実ブラウザ 2 タブ E2E 検証スクリプト
│   └── demo/             # 2 タブデモ + STUN 設定例 + 内蔵自己チェック
├── webtcp_website/       # Astro + Starlight 公式ドキュメントサイト
└── webtcp_jslib/
    ├── package.json      # ESM, exports, build/test/demo スクリプト
    ├── tsconfig.json     # ES2022 + DOM, strict
    ├── src/
    │   ├── index.ts      # 公開エントリポイント（全 export）
    │   ├── browser.ts    # createBrowserNetwork() ヘルパー
    │   ├── core/
    │   │   ├── types/
    │   │   │   ├── protocol.ts      # NodeId, VirtualPort, SequenceNumber, StreamState ...
    │   │   │   ├── packet.ts        # WebTCPPacket
    │   │   │   ├── serializer.ts    # BinaryPacketSerializer (v1/v2 バイナリ形式)
    │   │   │   └── index.ts
    │   │   ├── util/
    │   │   │   ├── EventEmitter.ts  # DOM/Node 非依存の最小実装
    │   │   │   ├── Logger.ts        # Logger / ConsoleLogger / noopLogger (#26)
    │   │   │   ├── id.ts            # generateNodeId() / allocateEphemeralPort()
    │   │   │   └── index.ts
    │   │   ├── link/
    │   │   │   ├── IChannel.ts          # データチャネル抽象
    │   │   │   ├── ISignalingAdapter.ts # シグナリング抽象
    │   │   │   ├── IEntranceSearcher.ts # エントランス探索抽象
    │   │   │   ├── LinkManager.ts       # 近隣管理 + パケット入出力
    │   │   │   └── index.ts
    │   │   ├── routing/
    │   │   │   ├── PacketVerifier.ts    # IPacketVerifier / Ed25519PacketVerifier / NullPacketVerifier
    │   │   │   ├── KeyDirectory.ts      # NodeId -> Ed25519 公開鍵（指紋照合つき）
    │   │   │   ├── keys.ts              # deriveNodeId / Base64url / Ed25519KeyManager
    │   │   │   ├── RoutingTable.ts
    │   │   │   ├── RoutingTableManager.ts
    │   │   │   ├── RoutingLayer.ts
    │   │   │   └── index.ts
    │   │   ├── transport/
    │   │   │   ├── seq.ts               # RFC 1982 mod 2^32 算術・ランダム ISN・SACK コーデック
    │   │   │   ├── RetransmitQueue.ts   # バイト範囲再送キュー + RFC 6298 RttEstimator
    │   │   │   ├── SessionManager.ts
    │   │   │   ├── VirtualStream.ts     # フル TCP セマンティクス（M2）
    │   │   │   ├── TransportLayer.ts
    │   │   │   └── index.ts
    │   │   ├── naming/                  # M4 / #25、M5 で domain 統合
    │   │   │   ├── url.ts               # parseWebTCPUrl / formatWebTCPUrl
    │   │   │   ├── NameServer.ts        # A/CNAME・キャッシュ・問い合わせ・所有権移譲
    │   │   │   └── index.ts
    │   │   ├── http/                    # M6 / #50（HTTP/1.1 サブセット）
    │   │   │   ├── message.ts           # HTTPHeaders / HTTPRequest / HTTPResponse / ステータス文言
    │   │   │   ├── parser.ts            # 行・ヘッダ・Content-Length / chunked の逐次パース（上限つき）
    │   │   │   ├── reader.ts            # VirtualStream -> メッセージ（分割耐性・EOF 処理）
    │   │   │   ├── writer.ts            # メッセージ -> バイト列（ヘッダ注入防止・chunked エンコード）
    │   │   │   ├── body.ts              # HTTPBodyReader（AsyncIterable / read / text / json / arrayBuffer）
    │   │   │   ├── server.ts            # HTTPServer（listen / keep-alive / リクエストループ）
    │   │   │   ├── client.ts            # HTTPClient（fetch 風 API / 接続プール / ストリーミング）
    │   │   │   ├── router.ts            # HTTPRouter（method + pattern、MAY）
    │   │   │   ├── errors.ts            # HTTPError 系
    │   │   │   └── index.ts
    │   │   ├── domain/                  # M5 / #25
    │   │   │   ├── names.ts             # domain.global ゾーンの正規化・検証（§14.1）
    │   │   │   ├── crypto.ts            # SHA-256 / Ed25519 検証の最小ラッパ（Web Crypto）
    │   │   │   ├── record.ts            # 所有権レコードの canonical 形式と厳格パース（§14.2）
    │   │   │   ├── merkle.ts            # 領域分離付き Merkle 木・包含証明（§14.3）
    │   │   │   ├── checkpoint.ts        # チェックポイント署名・prevHash 連鎖（§14.3）
    │   │   │   ├── ledger.ts            # 参照台帳（追記ストア + 証明発行）
    │   │   │   ├── verifier.ts          # IDomainOwnershipVerifier と既定実装（§14.4）
    │   │   │   ├── authority.ts         # DomainAuthority・解決フロー（§14.5）
    │   │   │   ├── errors.ts            # DomainRecordError / DomainOwnershipError / 衝突
    │   │   │   └── index.ts
    │   │   └── network/
    │   │       ├── WebTCPNetwork.ts     # listen / connect / connectURL / bootstrap / serveHTTP / fetchURL
    │   │       └── index.ts
    │   └── adapters/
    │       ├── webrtc/
    │       │   ├── WebRTCChannel.ts          # Offer/Answer/ICE・Glare解決・ICE再起動・動的TURNフック
    │       │   ├── BrowserWebRTCChannel.ts   # ブラウザ用（RTCPeerConnection）
    │       │   ├── NodeWebRTCChannel.ts      # Node 用（生成関数を注入）
    │       │   └── index.ts
    │       ├── keys/                          # #28 / M4 永続化
    │       │   ├── BrowserKeyManager.ts      # IndexedDB 復元 + 署名チャレンジ
    │       │   ├── NodeKeyManager.ts         # node:crypto + keyFile 永続化
    │       │   ├── NodeIdentityStorage.ts    # 0600 / 原子的 PEM 保存
    │       │   ├── nodeFs.ts                 # node:fs / path の遅延ロード
    │       │   ├── nodeCrypto.ts             # node:crypto の遅延ロード（ブラウザ非混入）
    │       │   ├── factory.ts                # createEd25519Verifier()
    │       │   └── index.ts
    │       ├── signaling/
    │       │   ├── SignalingAdapterHub.ts    # HTTP ポーリング型ハブクライアント
    │       │   └── index.ts
    │       ├── entrance-searcher/
    │       │   ├── IEntranceSearcher.ts      # core/link からの re-export
    │       │   ├── EntranceSearcherAdapterHub.ts
    │       │   └── index.ts
    │       └── domain/                       # M5 / #25
    │           ├── HttpDomainRegistryClient.ts  # §14.6 の HTTP レジストリクライアント
    │           └── index.ts
    └── tests/            # node:test（dist を import）
        ├── helpers/      # LoopbackChannel, FakeRTCPeerConnection, FakeIndexedDB, test hub
        ├── serializer.test.mjs
        ├── keys.test.mjs             # 鍵導出・署名・検証・ディレクトリ
        ├── signed-network.test.mjs   # v2 署名付きネットワーク統合
        ├── browser-keys.test.mjs     # BrowserKeyManager（IndexedDB シム）
        ├── naming-url.test.mjs       # webtcp:// URL パース・整形
        ├── nameserver.test.mjs       # A/CNAME・キャッシュ・問い合わせ・境界
        ├── nameserver-network.test.mjs # 実スタック名前解決 / マルチホップ
        ├── identity-persistence.test.mjs # Node keyFile / Browser 復元 / 衝突
        ├── lifecycle-regressions.test.mjs # 起動再試行 / end 状態 / ICE / cwnd (#38)
        ├── domain-record.test.mjs         # ゾーン規則・canonical 形式・厳格パース・署名（§14.1/§14.2）
        ├── domain-merkle.test.mjs         # Merkle ルート / 包含証明 / チェックポイント連鎖（§14.3）
        ├── domain-verify.test.mjs         # 検証器の成否・fail-closed・ログ鍵・衝突（§14.4）
        ├── domain-ledger.test.mjs         # 参照台帳の追記・serial・証明発行（§14.3/§14.6）
        ├── domain-resolution.test.mjs     # DomainAuthority と NameServer 統合（§14.5、#40 の回帰）
        ├── http-parse.test.mjs            # HTTP パーサ・ライタ（分割/合流・上限・chunked・インジェクション）
        ├── http-server.test.mjs           # HTTPServer（keep-alive / Half-Close / 413 / 500 / HEAD）
        ├── http-client.test.mjs           # HTTPClient（fetch 風 API・タイムアウト・上限・再利用）
        ├── e2e.test.mjs
        ├── tcp-semantics.test.mjs
        ├── routing.test.mjs
        ├── signaling.test.mjs
        ├── bootstrap.test.mjs
        ├── logger.test.mjs
        ├── webrtc.test.mjs
        └── demo-server.test.mjs
```

## 3. 主要な設計判断

### 3.1 `Buffer` を捨てて `Uint8Array` を使う

**課題**: 初期コードは `Buffer` と `NodeJS.Timeout`、`events` に依存しており、ブラウザでそのまま動かない。

**判断**: パケットのペイロードと署名を `Uint8Array` にする。Node.js の `Buffer` は `Uint8Array` の派生なので、Node 側からはそのまま渡せる。シリアライザは `DataView` と `TextEncoder`/`TextDecoder` のみを使う。

### 3.2 独自の `EventEmitter`

`src/core/util/EventEmitter.ts` に `on` / `once` / `off` / `emit` / `removeAllListeners` / `listenerCount` を自前実装する。リスナー例外の報告も注入された `Logger` 経由で行う。

### 3.3 IChannel の責務を「メッセージ輸送」に限定する

シグナリングは `IChannel` の実装（`WebRTCChannel`）が内部で利用する。`LinkManager` は隣接状態とパケットのシリアライズだけを扱う。

### 3.4 ルーティング情報を `RT_UPDATE` パケットに統一する

ルーティング更新は通常の `RT_UPDATE` パケットとして同一シリアライズ経路を通る。経路削除は `withdrawals`（撤回リスト）で伝播し、同一ネクストホップからの同一コスト更新でも `lastSeen` を更新して稼働中経路の誤失効を防ぐ（#30）。中継転送時の TTL は送信前に 1 減算し、0 以下になったら破棄する。

### 3.5 署名検証を差し替え可能にし、既定を Ed25519 にする（#28）

`IPacketVerifier` を境界とし、`Ed25519PacketVerifier`（v2・既定）と `NullPacketVerifier`（v1 レガシー）を差し替え可能にしている。
`WebTCPNetwork` は `keyManager` を受け取ると `Ed25519PacketVerifier` を自動で組み立てて署名必須化し、
`keyManager` が無ければ従来どおり `NullPacketVerifier` で v1 動作になる（後方互換）。
ワイヤーフォーマットは v1 とヘッダーが完全共通で、`signature` の有無だけが異なる。

### 3.6 RPF を「直接隣接なら許可」に緩和する

距離ベクトル収束前に最初のパケットが落ちないよう、経路未学習かつ直接隣接からの受信を許可している。本格的なマルチホップ強化（RPF 厳格化）は #46 で追跡しており、未実装。M4 では RT_UPDATE 自体を直接隣接・sender 一致・正 TTL に限定する。
なお署名検証（§11.2）は RPF より前に行うため、RPF の緩和がなりすましを許すことはない。

### 3.7 パケット種別は必ずフラグで判定する

`WebTCPFlags` をビットマスクとしてシリアライズし、`flags & 0x7f === 0` の不正パケットはデシリアライズ時に拒否する。`SYN_ACK` は `SYN|ACK` と正規化する。

### 3.8 WebRTC 実装を 1 つの基底クラスに集約する

`WebRTCChannel`（抽象）が Offer/Answer/ICE・Glare 解決・ICE 再起動・動的 TURN 資格情報解決・DataChannel 監視をすべて実装し、サブクラスは `createPeerConnection(iceServers)` だけを提供する。

### 3.9 シグナリングは HTTP ポーリングを既定にする

`SignalingAdapterHub` は `POST /signal` と `GET /messages` の HTTP ポーリングで実装し、依存なしの `examples/server.mjs` をリファレンス実装として同梱する。

### 3.10 `WebTCPNetwork` のコンストラクタをオプション形式にする

`channel` 必須、その他の `signaling` / `nodeId` / `verifier` / `logger` / `logLevel` 等はすべて任意オプションとする。ブラウザ向けには `createBrowserNetwork()` を提供する。

### 3.11 バイトストリーム・MSS 自動分割・部分読み取り（M2 / #23）

- **32 ビットシリアル番号算術（`seq.ts`）**: ランダム ISN を採用するため、`0xFFFFFFFF -> 0` のラップアラウンドを RFC 1982 の符号付き 32 ビット差分 `((a - b) | 0)` で安全に比較する。
- **送信バッファ + MSS 自動分割**: 既定 MSS を 16 KiB（WebRTC SCTP 実装間の相互運用性が高いサイズ、最大 60 KiB まで設定可能）とし、60 KiB 超のメッセージも `sendBuffer` から輻輳ウィンドウに従って自動分割送出する。
- **プッシュ/プル両立の受信バッファ**: `'data'` リスナーがあればフローイング配送し、無ければ（または `pause()` 中は）内部バッファへ蓄積して `read(maxBytes)` / `readExact(bytes)` / `'readable'` による部分読み取りを提供する。

### 3.12 プロトコル v1 互換の SACK・動的 RTO・輻輳制御（M2 / #23）

- **動的 RTO（`RttEstimator`）**: RFC 6298（`alpha = 1/8`, `beta = 1/4`, `G = 50 ms`）+ Karn のアルゴリズム（再送セグメントからは RTT を計測しない）+ タイムアウト時の指数バックオフ。
- **輻輳制御（RFC 5681）**: Slow Start / AIMD Congestion Avoidance / 3 重複 ACK による Fast Retransmit & NewReno Fast Recovery。
- **v1 互換 SACK**: 固定 24 バイトヘッダーを壊さず、純粋 `ACK` パケットの空ペイロード領域へ種別 `0x05` + 最大 4 ブロックの SACK 範囲をエンコードする。順序外が無い通常時はペイロード 0 バイトのまま。

### 3.13 Half-Close と `listen` ハンドラの呼び出し時期（M2 / #23, #31）

- `allowHalfOpen = true` を既定とし、`FIN` 受信時は `CLOSE_WAIT` へ遷移して `'end'` を発火する。アプリケーションは `CLOSE_WAIT` のまま `send()` を継続でき、完了後に `end()`/`close()` を呼ぶことで `LAST_ACK -> CLOSED` へ進む。
- 受動側の `listen(port, handler)` は、クライアントの最終 `ACK`（またはピギーバック ACK 付き `DATA`）で `ESTABLISHED` に到達した瞬間に `handler(stream)` を呼ぶ（#31）。これによりハンドラ内で即座に `stream.send()` を呼べる。

### 3.14 レベル付きロガー注入（M2 / #26）

`src/core/util/Logger.ts` に `Logger` / `ConsoleLogger` / `createScopedLogger` / `noopLogger` を定義し、`WebTCPNetwork` へ注入したロガー（既定は `warn` 以上）を `LinkManager`・`RoutingLayer`・`RoutingTableManager`・`TransportLayer`・`SessionManager`・`VirtualStream` へ一括伝播する。コア・アダプタ内に直接の `console.*` 呼び出しを残さない。

### 3.15 TURN 動的資格情報・ICE 再起動・Glare 解決（M2 / #24, #32）

- **`iceServersProvider`**: ピア生成時と ICE 再起動時に非同期で最新の `RTCIceServer[]` を取得し、再起動時は `RTCPeerConnection.setConfiguration({ iceServers })` で短期 TURN 資格情報を更新する。
- **インプレース ICE 再起動**: `iceConnectionState === 'failed'` または `'disconnected'` 継続時に `createOffer({ iceRestart: true })` を送信し、受信側も既存 `RTCPeerConnection` 上で `Answer` を返すことで DataChannel と `VirtualStream` を落とさずに復旧する。
- **Glare 解決**: 初期接続の同時 `offer` 衝突時は `localNodeId < remoteNodeId` を polite ピアとし、待機中の `connect()` Promise を引き継いだまま相手の `offer` を受け入れる。

### 3.16 `WebTCPNetwork.bootstrap(searcher)`（M2 / #27）

`IEntranceSearcher` を `src/core/link/` に配置してコアの依存方向を維持したうえで、`WebTCPNetwork.bootstrap(searcher, options)` が候補へ順次 `connectToPeer()` を試行し、未達成時は指数バックオフ付きでリトライする。

### 3.17 Ed25519 署名・鍵指紋・鍵管理（M3 / #28）

**NodeId = 公開鍵の指紋**。`deriveNodeId(publicKey)` は `SHA-256(rawPublicKey)` の先頭 16 バイトを hex 化する。
指紋は決定的であり、`senderId` と検証鍵の指紋を突き合わせれば「その NodeId の正当な所有者か」を判定できる。
これにより、`NodeId` は自己申告から**自己証明型の識別子**へ変わる。

**署名対象の正規化**。署名対象は「署名フィールドを除いた、シリアライズ済みパケット」である。
TTL は中継ごとに減算されるため **0 に正規化**して署名対象から外し、
「送信元が 1 度だけ署名し、中継ノードは再署名しない」モデルを成立させている（`specification.md` §11.3）。
実装は 2 経路を用意し、**両者がバイト単位で一致することをテストで固定**している。

| 経路 | API | 用途 |
| :--- | :--- | :--- |
| 送信 | `BinaryPacketSerializer.serializeForSigning(packet)` | 署名対象バイト列の生成 |
| 受信 | `BinaryPacketSerializer.signatureInputFromBytes(rawBytes)` + `ttl = 0` 上書き | 再シリアライズせず受信バイト列から導出 |

**プラットフォーム別の鍵管理**（`core` は暗号ライブラリに依存しない）:

| 実装 | 配置 | 秘密鍵 | プリミティブ |
| :--- | :--- | :--- | :--- |
| `NodeKeyManager` | `adapters/keys` | メモリ上の `KeyObject`（PKCS#8 / シード hex で入出力） | `node:crypto`（`generateKeyPairSync` + `webcrypto.subtle`） |
| `BrowserKeyManager` | `adapters/keys` | **IndexedDB に非抽出 CryptoKey**（`extractable: false`） | Web Crypto API（`crypto.subtle`） |

`node:crypto` は**動的 import**（`loadNodeCrypto()`）で読み込み、ブラウザ向けバンドルへ Node 組み込みが混入しないようにしている
（`tsconfig` の `types: []` を維持するため、戻り値は最小限の構造的型で宣言する）。

`BrowserKeyManager` は `CryptoKey` を構造化複製して IndexedDB に保存する。秘密鍵は非抽出なので、
ストレージが読まれても生バイトへエクスポートできない。公開鍵・NodeId は同一レコードに保存し、
起動時に指紋を再検証してから再利用する（不一致なら再生成）。

**公開鍵の配布**は 2 経路の併用とした（`specification.md` §11.4）。

1. **シグナリング時の交換**: `WebRTCChannel` が DataChannel open 直後に `public-key` メッセージを送る。
   直接の隣接とは `RT_UPDATE` を待たずに検証を始められる。
2. **`RT_UPDATE` への同梱**: `RoutingTableManager.createRoutingInfoPacket()` に `publicKey` を加え、
   マルチホップの中継ノードへも伝播させる。

受信側は `KeyDirectory` に登録する前に **必ず指紋一致を検証**する。配布経路（ハブ・中継ノード）が
信頼できなくても、指紋が一致しない鍵は登録しない。このため「分散ストレージに置く」方式も
`IPublicKeyResolver` の差し替えだけで同じ安全性で導入できる（将来課題）。

**初回パケットの取りこぼし対策**。隣接確立直後は公開鍵がまだ届いていないことがあるため、
`Ed25519PacketVerifier` は未知の署名者について `keyWaitTimeoutMs`（既定 5000 ms）だけ
`KeyDirectory.waitForPublicKey()` で待機してから検証する。`RT_UPDATE` は同梱鍵で自己証明できるため、
典型的なケースでは待機は発生しない。

**バージョンの決め方**。シリアライザは「`signature` が 64 バイトなら v2、空なら v1」で送信バージョンを決める。
`WebTCPNetwork` に `keyManager`（または `Ed25519PacketVerifier`）を渡すと署名必須（`requireSignatures: true`）になり、
渡さなければ v1 後方互換モードで動く。受信側は v1 / v2 の両方をデシリアライズできる。

### 3.18 NameServer と `webtcp://` URL（M4 / #25）

**配置**: `core/naming` は L7 アプリケーション層サービスとして `WebTCPNetwork` の公開 API のみに依存する（M5 で `core/domain` を追加してもこの不変条件は変えない）。L3/L4 へ名前を漏らさない。新しいワイヤーフラグは追加せず、既存の署名付き `VirtualStream` 上で JSON 要求/応答を運ぶ。これにより v2 のセキュリティ境界をそのまま利用する。

**解決モデル**: ローカル登録を権威データとし、クライアント側で反復解決する。サーバーはローカル登録のみを返し、他ノードへ再帰問い合わせしない。問い合わせ先は明示リゾルバ、隣接、経路表宛先から重複除外で選ぶ。CNAME はクライアントが最大 8 段辿り、訪問済み名前で拒否する。ノード間再帰を使わないため問い合わせ増幅とループを抑える。

**キャッシュ**: 名前ごとの A/CNAME レコードを TTL 付きで保持し、最大 1024 件。ローカル登録が常に優先。リモートの名前応答は所有権証明ではないため、ゾーン内名前は §3.21 の所有権検証を経る（M5）。ゾーン外名のグローバル衝突解決は対象外のままとし、`plan.md` §4.3 に記録する。

**URL**: `URL` コンストラクタは非特殊スキームのホスト/ポート解釈が環境依存になるため、`webtcp://` は明示的な正規表現と検証でパースする。ポートは必須、パス省略時は `/`。`connectURL()` は名前なら NameServer、NodeId なら直接 `connect()` へ振り分ける。パス/クエリ/フラグメントは接続先ルーティングには使わずアプリケーションへ返す。

**並行性と終了**: 問い合わせは全体デッドラインとノード単位タイムアウトを持ち、AbortSignal で中断できる。ストリームはタイムアウト・中断・不正応答時に `destroy()` する。NameServer.close() は自身の listen ハンドラと問い合わせを停止し、ネットワークは閉じない。

### 3.19 永続 NodeId と衝突検出（M4 / #36）

- ブラウザ: IndexedDB 復元時に公開鍵指紋だけでなく、秘密鍵で署名したチャレンジを公開鍵で検証する。壊れた身元は黙って使わず再生成。`expectedNodeId` 不一致は `NodeIdCollisionError`。
- Node.js: `NodeKeyManager.open({ keyFile })` は既存 PEM を復元、無ければ生成して `0600` で原子的に保存する。競合作成時は既存ファイルを読み直す。秘密鍵をネットワークやログへ出さない。
- `KeyDirectory.setPublicKey()` は後方互換の同期 API だが、既存鍵と異なる場合は `NodeIdCollisionError` で拒否する。非同期経路は従来どおり `false`。
- `WebTCPNetwork` はローカル鍵とディレクトリ内の既存鍵の衝突を起動前に検出する。

### 3.20 RT_UPDATE の信頼境界と鍵伝播（M4 / #37）

`RT_UPDATE` は直接隣接からのみ、外側 sender・payload sender・受信元が一致し、外側 destination が自ノードで、正の TTL・制御ポート 0 の場合のみ受理する。中継しない。`entries[].publicKey` に既知鍵を同梱して経路と一緒に伝播し、受信側は各鍵の指紋を検証して `KeyDirectory` へ登録する。これにより事前鍵共有なしのマルチホップ v2 通信を可能にする。送信側は `entries` / `withdrawals` を各 256 件以内的 `RT_UPDATE` に分割する。

### 3.21 `domain.global` の所有権証明を「検証可能な設計」に縮小する（M5 / #25）

**課題**: ブロックチェーンによるドメイン所有権を、依存ゼロ・バンドラ不要のブラウザライブラリで実現する。フルクライアント（ヘッダー同期、状態ツリー、コンセンサス）を載せるのは現実的でない。

**判断**: 信頼の根元を「チェーンそのもの」ではなく **検証可能な 3 点セット** に置き換える。

1. **自己署名クレーム**: レコードは所有者の Ed25519 鍵で署名され、`nodeId = 指紋(ownerPublicKey)` を要求する。したがって第三者は「他人の NodeId にドメインを紐づけるレコード」を**作れない**（M3 の鍵指紋化がそのまま効く）。誰もが発行できる代わりに、誰もが始末できない。
2. **追記型台帳の包含証明**: 台帳はレコードの commitment を Merkle 木へ積上げ、`{ treeSize, root, prevHash, timestamp }` をログ鍵で署名する。クライアントは (a) 包含証明、(b) チェックポイント署名（**設定済みログ鍵でのみ**信任）、(c) `treeSize` 単調性、(d) 必要なら `prevHash` 連鎖の追跡を行う。これだけで「ログが過去を書換えた」ことを PIN 以降に検出できる。SHA-256 は Web Crypto が提供するため**依存ゼロで検証できる**。
3. **プラガブルな実チェーン検証**: `IChainAnchorVerifier` が `anchor.chain`（txId・blockHeight・network）を実データへ突き合わせる。未設定なら `chainVerified: null`（＝オフライン検証範囲）として**正直に区別**し、`requireChainAnchor: true` で fail-closed にできる。Namecoin / EVM 証明の実装は #42 に切り出した（keccak-256 依存をコアへ入れたくない）。

**canonical バイト列の方式**: JSON のキー順に頼ると環境差で署名が壊れるため、**固定キー順で再シリアライズした結果のみ**を署名対象とする。受信時は生バイトではなく必ず再正規化したバイト列で検証する（未知キー混入の oracle を防ぐ）。厳格パース（未知キー拒否）とセットで仕様に明記した（§14.2）。

**なぜハッシュチェーンで十分か**: 本ライブラリの脅威モデルでは「レジストリ運用者を信頼しない」ことが重要で、「チェーンが正しい」ことは要求しない。ログ鍵が嘘をつけば**そのログの信頼は失われる**が、誤った所有者情報を受け入れる代わりに検証失敗となる（fail-closed）。複数ログの M-of-N 合意に拡張する余地を残す（#43）。

### 3.22 NameServer からの分離と統合（M5）

- `core/domain` は `core/naming` に依存しない（逆方向のみ）。`NameServer` は `DomainAuthority` を**注入される側**で、権威側はネットワークを知らない。既知ノードへの問い合わせは **`NameServer` が候補として集めて `DomainAuthority.settleCandidates()` に渡す**（関数型の `DomainQueryTransport` は実装せず、候補配列を渡す形へ簡約した）。これにより core の依存方向（アプリケーション → トランスポート）を保つ。
- ワイヤー変更はしない。`protocol: 1` の JSON に `wantOwnership` / `ownership` を**追加フィールドとして**足すだけ（旧実装は未知フィールドを無視）。権威が裏へ回っても既存の A/CNAME 解决は不変。
- ゾーン内名前は `registerA()` / `registerCNAME()` を**構造的に禁止**し、`registerDomain()`（検証必須）のみを通す。これで「ローカル登録が常に優先」する現行モデルでも `.domain.global` の squat が起きない。
- 解決の勝敗は `serial` → `anchor.leafIndex` → commitment の決定的順序で決め、同 serial 異内容なら **勝者を決めずに失敗**する（§14.4.3）。「早く返った方を信じる」を禁止すると仕様に書いた（§13.1 との違いは失敗側へ厳しくした）。
- 失敗キャッシュ（`negativeTtlMs`）を持つが、成功より長くしてはならない。DoS の足掛かり（解決不能な名前の増殖）を防ぐため、収集元数・1 名あたりレコード数・全体タイムアウト・キャッシュ件数に上限を設ける。

### 3.23 停滞ノードに強い解決と、署名対象のシリアライザ同一性（#40 / #41）

- **#40**: `NameServer` の問い合わせは「`connect()` 待機」「応答待機」を区別せず、**同じ AbortController でまとめる**。`queryKnownNodes()` は `Promise.all` をやめ、*最初の成功* または *デッドライン* で返す（残りのワーカーは abort してストリームを `destroy()`）。`resolve()` は各 `await` 後に中断・超過を再評価し、`NameResolutionTimeoutError` を返す。宙吊り `connect()` を殺せない TransportLayer の制約（#44）は、**待たずに返す**ことでユーザー体感として解決する（内部的に残りが解決しても無視する）。
- **#72**: 解決デッドラインと問い合わせタイマーは同じ時刻に満了しうる。どちらが先に処理されるかで、期限切れの打ち切りが `NameNotFoundError`（空応答）として `resolve()` を決着させる競合があった（ループ試行で約 10%、単発の CI 実行でも稀に発生）。対策: `queryNode()` は解決デッドラインで打ち切られた場合 `NameResolutionTimeoutError` を投げ、`queryKnownNodes()` は期限到達を記録して空応答のまま終わった場合にタイムアウトとして返す。`NameNotFoundError` は期限内に候補が尽きた場合だけ生じる。
- **#41**: `Ed25519PacketVerifier` は署名対象を `serializer.serializeForSigning()` からのみ得る。`WebTCPNetwork` は注入された `serializer` を検証器へも渡す。`serializeForSigning` 欠落時に v1 ヘッダーで近似していた黙ったフォールバックは削除し、構築時エラーへ置き換える（誤った署名対象で署名し続ける状態を作らない）。

### 3.24 HTTP を「ストリームの上の純粋なバイトプロトコル」として実装する（M6 / #50）

**課題**: README の構想は「仮想 TCP/HTTP トンネル」だが、M5 までは L4 のバイトストリームのみで、HTTP のリクエスト/レスポンスは存在しなかった。ブラウザ上のサービスを HTTP で公開するには、`VirtualStream` の上にフレーミングを載せる必要がある。

**判断**:

- **新しいパケット種別・ポート予約を導入しない。** HTTP は `VirtualStream` のバイト列としてだけ存在する。したがって v1 ノードとも同じストリームで会話でき、署名検証（§11）・RPF・TTL・輻輳制御はすべてそのまま効く。HTTP 層の追加は `core/http/` に閉じ、`LinkManager` / `RoutingLayer` / `TransportLayer` には一切手を入れない。
- **`ReadableStream` / `WritableStream` を使わず、`AsyncIterable<Uint8Array>` を採用する。** 理由は 3 つ。(1) `core` は DOM API に依存しない方針（§1）で、`ReadableStream` は Web Streams の実装差（Node 18 未満・一部バンドル）を持ち込む。(2) `VirtualStream` の `read()` / `readExact()` はプル型であり、`AsyncIterable` とは自然に対応する。(3) テストは `node:test` で `for await` をそのまま使える。
- **本文はバッファせずにストリーミングする。** `HTTPBodyReader` は内部に最大 `highWaterMark`（既定 64 KiB）だけ保持し、超えたら `VirtualStream.pause()` で受信を止め、読み進められたら `resume()` する。これで 8 MiB の応答も一定メモリで扱える。「バッファする API」（`text()` / `json()` / `arrayBuffer()`）はその上に `maxResponseBytes` を被せるだけである。
- **`fetch()` をエミュレートしない。** グローバルの `fetch` を差し替える（monkey-patch）と、`webtcp://` を解釈しない既存コードが壊れる。`HTTPClient` は明示的なクラスで、`network.fetchURL()` という薄いヘルパーだけを提供する。
- **パイプラインを実装しない。** `VirtualStream` は順序保証つきのバイトストリームであり、HTTP/1.1 のパイプラインを載せる技術的障害は無いが、(a) サーバー側で応答順序を守るキューが必要になり、(b) 実運用のブラウザ・curl もパイプラインを使わず、(c) 失敗時の再送とストリームの状態機械が複雑化する。`keep-alive`（逐次再利用）だけを実装する。

### 3.25 HTTP パーサを「上限つきの逐次パーサ」にする

**課題**: ストリームは任意の境界で分割される。16 KiB MSS の途中でヘッダが切れることも、`\r` と `\n` が別セグメントに来ることもある。また、悪意あるピアは無限にヘッダを送れる。

**判断**:

- **パーサは状態機械（`HEADERS` → `BODY_FIXED` / `BODY_CHUNKED` → `DONE`）で書き、入力を「与えられたバイト列を消費する」形にする。** 行末は CRLF のみを受理し、`\n` 単独は `HTTPParseError`。`\r` 単独で終わる行も拒否する。
- **上限はパースの入口で強制する**（§16.2.1）。行長・ヘッダ数・ヘッダ合計は累積カウンタで判定し、超えた瞬間に `HTTPError(414|431)` を返す。`Content-Length` は `Number` へ変換する前に 10 進数字のみを検証し、`Number.MAX_SAFE_INTEGER` を超える値は `400`。
- **`chunked` は `size` 行（16 進 + 任意の `;ext`）→ データ → CRLF の繰り返し**として実装し、`0` チャンクで終端（トレーラは読み捨て）。`size` 行が 1 KiB を超えたら `400`。負値・非 16 進は `400`。
- **ヘッダ値の正規化はしない**（前後の OWS だけ落とす）。`Content-Type` の charset 解釈や `Accept-Encoding` の交渉はアプリケーションの責務（§16.9）。
- **ライタ側でインジェクションを防ぐ**。`HTTPWriter.setHeader()` は名前が RFC 9110 の `token`、値に `CR` / `LF` / `NUL` を含まないことを検証し、違反は `HTTPHeaderInjectionError`。これで「アプリがユーザー入力をそのままヘッダに入れる」実装でもスマグリングが成立しない。

### 3.26 HTTP サーバーと Half-Close の調停

**課題**: HTTP/1.1 の `keep-alive` と、`VirtualStream` の Half-Close は素直に組み合わせると衝突する。クライアントが `Connection: close` で 1 リクエスト送って `end()`（FIN）すると、サーバーは `CLOSE_WAIT` で応答を書く必要がある。逆に `keep-alive` では FIN を送らずに複数リクエストを流す。

**判断**:

- **サーバーのループは「リクエストを 1 つ読む → ハンドラ → 応答を書き切る → 接続継続判定」の逐次ループ**にする。`end`（EOF）を受けたらループを抜け、未応答のリクエストがあれば応答を書いてから `end()` する（§16.5 の 3）。`VirtualStream` が `CLOSE_WAIT` で `send()` を許す（§8.2）ため、追加の L4 変更は不要。
- **`HTTPServer` は `network.listen()` のハンドラを 1 つ占有する**。同じポートに別のハンドラを登録できないのは `TransportLayer` の既存契約であり、これは意図的（1 ポート 1 ハンドラ = HTTP サーバー）。HTTP と生 TCP を同じポートで混在させたい場合は仮想ポートを分ける。
- **接続ごとに `AbortController` を持ち**、`server.close()` で全接続を中断する。ハンドラの Promise が後から解決しても、応答は破棄する（`HTTPResponseWriter` が `closed` フラグを見る）。
- **アイドルタイムアウト**はサーバー側で `idleTimeoutMs`（既定 30 000 ms）のタイマーとして実装し、リクエスト受信のたびにリセットする。発火したら `end()`。クライアント側は接続プールのエントリに `lastUsed` を持ち、`HTTPClient.fetch()` の前に期限切れを捨てる。
- **`HTTPClient` の接続プールはキー `(nodeId, port)` で 1 本**（サイクル17 / §3.36 で上限・LRU・アイドル回収を追加。詳細は §3.36）。同時 `fetch()` が重なった場合は新しい接続を作って並行実行し、終了後にプールへ戻す（戻すのは 1 本だけ）。これは HTTP/1.1 の「1 接続 1 リクエスト」原則と一致する。

### 3.27 `serveHTTP` / `fetchURL` を `WebTCPNetwork` に生やす理由

**課題**: HTTP 層を別パッケージ・別クラスにするか、`WebTCPNetwork` のメソッドにするか。

**判断**: メソッドにする。`serveHTTP(port, handler)` と `fetchURL(url, options)` は「ネットワークに 1 つの機能を足す」操作であり、利用者から見ると `listen` / `connect` と同じ粒度である。内部実装は `core/http/` のクラスへ委譲するので、`WebTCPNetwork` の肥大化は最小限（各 10 行未満）に留まる。`HTTPServer` / `HTTPClient` は独立にエクスポートし、`nameServer` を注入して再利用できる。

### 3.28 サービス状態は「名前層の登録の再生」として保存する（M7 / #51）

- **保存するのは名前層の登録だけ**: 待ち受けポート・A/CNAME・所有権レコード。接続・ストリーム・ハンドラ関数・鍵は含めない。鍵は既存の `BrowserKeyManager`（IndexedDB）が持つ。
- **所有権レコードは JSON 往復で保存し、復元時に再検証する**。`domainRecordToJSON` / `parseDomainOwnershipRecord` は既に可逆なので、別のアンカーストアは作らない。保存時の検証結果は信用せず、`registerDomain()` の検証を通す（改ざんされた保存内容を拒否する、テストで確認済み）。
- **再広告は pull のまま**: 名前を隣接へ push すると「応答は自分のローカル登録だけ」（§13.2）の不変条件が崩れるうえ、所有権の主張を未要求で配ることになる。経路は既存の RT_UPDATE（`neighbor-connected` 時）が再広告するので、新しい制御パケットは導入しない。
- **再発行は `WebTCPNetwork` で行う**: `LinkManager` の隣接イベントを転送し、利用者（keep-alive の再接続、UI）が `LinkManager` の内部に触れずに済むようにする。
- **keep-alive はアダプタ層に置く**: Wake Lock・AudioContext・`visibilitychange`・`pagehide` はブラウザ依存なので `core/` には入れない（§3.2 の依存方針）。ブラウザ API はすべて注入可能にし、Node のテストで検証する。
- **離脱は `close()`（FIN）**: `pagehide` の処理では `destroy()` を使わない。`destroy()` は中断（RST）であり、送信中のデータを相手に届けずに相手側を失敗させるため、終了ハンドシェイクを優先する。

### 3.29 ブリッジは TCP 中継に徹し、署名・ループバック・ログを起動条件にする（M8 / #52）

- **中継は `network.connect()` だけに依存する**: `adapters/bridge/TcpBridge` は `node:net` と `VirtualStream` の橋渡しだけを行う。HTTP の解釈は持たない（§16 の `HTTPClient` とは独立に使える）。`core/` は変更しない。
- **安全条件はコンストラクタで検査する**（`assertBridgeSecurity`）。`requireSignatures` が偽、または鍵管理が無いノードでは起動しない。非ループバックの待ち受けは `allowNonLoopbackBind` が無ければ拒否する。起動後に条件を緩める経路は設けない。仕様 §19.4 の 1・2 に対応する。
- **v1 宛先の拒否は鍵ディレクトリで判定する**。宛先の公開鍵が既知であることを v2 の証拠とみなす。公開鍵は RT_UPDATE で届くため、未知なら一定時間（5 秒）待ってから拒否する。`allowUnsignedPeers` を明示した場合だけ転送する（§19.4 の 3）。
- **`allowHalfOpen: true` で待ち受ける**（#62）。Node の既定の `false` は、クライアントの FIN で応答の書き込み側を閉じてしまい、半クローズ後の応答が届かない。双方向の FIN を仕様どおり写すため、`end()` を両方向で独立に呼ぶ。
- **背圧は 2 方向で扱う**。上りは `VirtualStream.send()` の `Send buffer full` を `drain` 待ちの再送で吸収する（受信ウィンドウ #56 が無いため、送信側だけで止める）。下りはソケットの `write` が偽を返したら仮想側の読み取りを一時停止し、`drain` で再開する。
- **ログは `onAccess` 関数に一本化する**。既定の出力先は `Logger`（`console` を直接使わない）。1 接続につき `open` と、`close` / `refused` / `error` のいずれか 1 件を記録する。`refused` の後に来る `close` は無視する（二重記録を防ぐ）。
- **既定の RTC プロバイダ解決は `createNodeNetwork()` に置く**（`adapters/webrtc/nodeProvider.ts`）。順序は `@roamhq/wrtc`、`node-datachannel` の順で、`import()` の失敗は無視して次を試す。どれも無ければ `WebRTCProviderUnavailableError`（試した名前の一覧を含む）を投げる。`peerConnectionOptions` は RTC 設定へ浅くマージし、ICE の `bindAddress` などを利用者が上書きできるようにする（#61 の回避）。
- **パッケージは分割しない（M8）**: `webtcp-bridge` の `bin` と `@sonneko/webtcp-bridge` の分割は、npm 公開の方針（#49）が決まるまで保留する。現時点でブリッジは `webtcp_jslib` 内の `adapters/bridge` に置き、CLI は `examples/bridge.mjs` とする。ブラウザ向けの `index.ts` からは再エクスポートせず、Node 専用の入口から使う（`dist/adapters/bridge/TcpBridge.js`）。

### 3.30 `destroy()` は RST で相手に中断を伝える（#54 / 0.8.1）

- **根拠**: 旧実装は `destroy()` が `finalize()` だけを呼び、相手のストリームが `ESTABLISHED` のまま残った（L4 のセッションタイムアウトまで資源を保持）。HTTP 層は `end()` だけで回避していた。
- **決定**: `destroy()` は相手へ `RST` を送ってから `finalize()` する（RFC 793 の abort 相当）。名前は `abort()` を増やさず `destroy()` に意味を与えた。既存の呼び出し元（NameServer のタイムアウト、SessionManager の停止、`AbortSignal` の中断）は、いずれも中断の意図であり、相手に知らせる方が正しい。
- **安全性の 2 つの前提**:
  1. 受信した `RST` で `error` を発火するのは、リスナーがあるときだけ。EventEmitter は `error` にリスナーが無いと例外を投げ、受信経路を壊すため。
  2. `TransportLayer` は、対応するセッションが無い `RST` へ `RST` を返さない。両端が同時に `destroy()` すると、無いセッションへの応答として `RST` を往復させ続けてしまうため（`destroy-abort.test.mjs` の「ping-pong」で検証）。
- **正常終了との分離**: 正常終了は引き続き `end()`（FIN）。`close()` は `end()` の別名。

### 3.31 ICE 候補 0 件は収集完了後の SDP で検出する（#61 / 0.8.1）

- `node-datachannel` は、既定の自動バインドでリンクローカルのみのホストに ICE 候補を 0 件にすることがある（#61）。既定値は変えず、`createNodeNetwork()` が `icegatheringstatechange` で収集完了を検出し、候補 0 件なら警告ログを出す。
- **候補の数はイベントではなく SDP（`localDescription.sdp` の `a=candidate:` 行）で数える。** `icecandidate` の配送は実装ごとに異なり（`node-datachannel/polyfill` では `addEventListener` のリスナーに届かなかった）、イベントに頼ると正常な接続まで誤って警告するため。
- 検証: 自動バインドでは警告、`127.0.0.1` では警告なし（実 `node-datachannel` で確認）。

---

### 3.32 公開デモは静的ホスティングで動く範囲だけを提供し、サーバー依存部はローカルに残す（サイクル11 / GitHub Pages）

- **公開先**: `https://sonneko.github.io/WebTCP/`（GitHub Pages のプロジェクトサイト）。Astro の `site` は `https://sonneko.github.io`、`base` は `/WebTCP`。リンクは `/WebTCP` を前置する rehype プラグイン（`webtcp_website/src/plugins/base-links.mjs`）で補う。
- **デプロイ**: `.github/workflows/deploy-pages.yml` が `main` への push と手動実行で、`webtcp_jslib` と `webtcp_website` をビルドして `actions/upload-pages-artifact` + `actions/deploy-pages` で配信する。Pages の Source は `build_type: workflow`（確認済み）。PR の検証は既存の `build-website` ジョブが担い、デプロイ用ワークフローは `main` のみ。
- **デモの配置**: サイトの `public/` に `examples/demo/*`（HTML と JS）と `webtcp_jslib/dist/` をローカルサーバーと同じ相対配置（`/examples/demo/`、`/webtcp_jslib/dist/`）で複製する（`webtcp_website/scripts/sync-demo.mjs`、生成物は Git 管理外）。デモの `import` パスと `examples/server.mjs` の静的配信は変更しない。
- **モード判定**: 起動時に `/domain/log` を取得し、応答すればローカルサーバーモード（従来どおり `SignalingAdapterHub` と `EntranceSearcherAdapterHub`、`/domain/*` の検査）。応答しなければ静的モード。`?static=1` で静的モードを強制できる（検証用）。
- **静的モードのシグナリング**: (a) 自己チェック（`?selftest=1`）は同一ページ内の `ISignalingAdapter` の対（メモリ内バス、`examples/demo/local-signaling.js`）で 2 つの実 `RTCPeerConnection` を直接つなぐ。他タブへは漏れない。(b) 2 タブデモは `BroadcastChannel`（同一ブラウザ内）で SDP / ICE / public-key を交換し、探索は `discover` / `here` メッセージで行う。別ブラウザ・別デバイスの接続は静的版では成立しない（交換経路がない）。これは受け入れた制約。
- **省略する検査**: 静的モードでは `/domain/*` に依存する自己チェック項目（1d: domain.global の台帳アンカーと偽造拒否）を「スキップ」として表示し、失敗にしない（`SkipError`）。ドメインパネルの登録・解決は「ローカルサーバーが必要」と表示して止める。
- **シグナリングを増やさない理由**: シグナリングサーバーを置くと運用対象が増え、静的ホスティングの範囲を超える。クロスデバイスのデモが必要になった時点で、シグナリングだけの小さなエンドポイントを別途検討する（今回はスコープ外）。
- **検証**: `examples/verify-static-demo.mjs` が Playwright で、(1) サイト表示、(2) デモ読み込み（静的モード表示）、(3) `?selftest=1` の全項目（スキップ以外）PASS を確認する。CI の `browser-e2e` ジョブに組み込み、ビルド済み `webtcp_website/dist` を一時 HTTP サーバーで配信して検査する。
- **既存の CI の役割**: `build-website` は PR の検証として残す。`build-website` は `webtcp_jslib` のビルド成果物を必要とするため、ジョブ内で先に `npm ci && npm run build`（jslib）を実行する。

### 3.33 公開デモは ICE 候補の事前診断を行い、候補ゼロなら早く止めて理由を示す（サイクル13 / #73）

- **事象**: 公開デモの自己チェック step 1 が、ICE 候補を 1 つも得られない訪問者の環境で約 45 秒かけて失敗し、原因が表示されなかった。`bootstrap()` の既定リトライ（3 回 × 15 秒）が続くため。
- **決定**: 自己チェックの先頭（step 0）で、デモ側が `RTCPeerConnection` を 1 つ作って候補を収集する（ライブラリの変更はしない）。候補が 0 件、または gathering が完了しない場合は step 0 を FAIL にし、残りを実行しない。理由（UDP 遮断・VPN・企業ネットワーク）と対処（ローカルサーバー、別のネットワーク）を表示する。
- **内訳の表示**: step 0 の詳細に `host(mdns)` / `host(ip)` / `srflx` / `relay` の件数を出す。step 1 が失敗した場合も同じ内訳を詳細に含める。
- **STUN について**: 既定の `iceServers` は空のまま（同一ホスト向け）。STUN / TURN で改善するかは環境次第で、UDP 自体が遮断されていれば効かない。公開版では保証しない。
- **対象外**: 2 タブ（BroadcastChannel）の経路は WebRTC を使うが、今回の事前診断は自己チェックだけに付ける。プロトコルは変更しない（仕様書は更新なし）。

### 3.34 シグナリングのトランスポートは「配送の仕方」だけを変え、契約と既定は変えない（M9 / #45 / サイクル14）

- **問題**: ポーリングの平均遅延は約 500 ms（1000 ms 間隔）で、ICE 候補の逐次到着が遅い。
- **決定**: `ISignalingAdapter` の契約は変えず、SSE と WebSocket の実装を追加する。既定は `SignalingAdapterHub`（ポーリング）のまま（依存なし・プロキシ耐性）。
- **押し込み型の再生**: ポーリングはメッセージを配信時に削除するが、押し込み型では接続が切れても届け直せるよう、サーバーは保持期間（60 秒）まで削除しない。再接続（`resume=1`）は `id > after` をすべて再生し、初回接続は未配信のものだけを再生する（以前の受信者が受け取った古いメッセージを新しいリスナーへ流さないため。ポーリングと同じ「一度だけ配る」）。重複はクライアントがカーソルで捨てる。
- **SSE は `fetch` で読む**: `EventSource` は Node.js に標準で無く、ヘッダーとバックオフを制御しにくい。`fetch` のストリームなら両方で同じ実装になり、`fetchImpl` の差し替えでテストできる。
- **WebSocket の送信は Socket 経由、未接続時は `POST /signal`**: 送信の遅延を下げつつ、切断中の送信を失わない。
- **参照サーバー**: `examples/server.mjs` に `/events` と `/ws` を追加する。WebSocket は依存を増やさないため、RFC 6455 のサーバー側（ハンドシェイク・マスク解除・ping/pong・断片化）を `examples/lib/ws-server.mjs` に実装する。
- **検証**: CI の `browser-e2e` で、同じ 2 タブの自動検証を 3 つのトランスポートで実行し、結果（成功・ステップ名・接続）が一致することを確認する。加えて Node.js の検証で、同じメッセージ列が 3 つで同順・同内容に届くことと、遅延の差を測る。
- **対象外**: 双方向の認証（トークン）、ハブの水平分散、TURN の変更。

### 3.35 API の中断は「待機者単位」で外し、RST と資源解放を契約にする（M9 / #44 / サイクル15）

- **問題**: `connect()` は中断を受け取れず、リンク確立（WebRTC 既定 15 秒）や仮想接続（10 秒）をアプリから打ち切れなかった。UI のキャンセルやタイムアウト設計ができない（#40 の恒久対策）。
- **決定**: `connect()` 系 API に `AbortSignal` を伝播する。中断は `name === 'AbortError'` の `Error` で表す（DOM 互換。`HTTPAbortError` と同じ名前）。共通ヘルパーは `core/util/abort.ts`（`raceAbort` / `throwIfAborted` / `createAbortError` / `isAbortError`）。
- **仮想接続は RST で取り消す**: `TransportLayer.connect()` の中断は `VirtualStream.destroy()`（§8.2、#54）を使い、既に送った SYN を `RST` で取り消す。相手側に半開きのセッションを残さない。（`close()` でも SYN_SENT では RST が送られるため振る舞いは同じだが、中断の意図を明示するため `destroy()` を選んだ。）
- **共有ネゴシエーションの待機者を個別に外す**: `WebRTCChannel` は同じピアの待機者（`openResolvers` / `openRejecters`）を共有する。中断は、その呼び出しの resolve / reject の組だけを配列から取り除く（同一参照で探す）。
- **破棄は「発信側かつ待機者ゼロ」のときだけ**: 他の待機者が残っていれば接続を継続する。受信側から始まったネゴシエーション（`isInitiator === false`）は、待機者を外しても破棄しない。相手からの接続を壊さないため。
- **中断済みのネゴシエーションの後始末**: 発信処理（`createDataChannel` / `createOffer` / `sendSignal`）は `raceAbort` で競争させる。中断後に残った非同期結果は捨てる（未処理の拒否にしない）。
- **非中断の失敗は従来どおり破棄する**: 中断でない失敗では、これまでどおりネゴシエーションを破棄して元のエラーを投げる。
- **`bootstrap()` は中断を失敗扱いにしない**: 候補ごとの失敗（warn）と区別し、中断は `debug` だけで伝播させる。
- **NameServer / HTTPClient も signal を渡す**: `NameServer` の問い合わせは `controller.signal` を `connect()` へ渡すようになった（#40 の回帰テストは変わらず通る。宙吊りの打ち切りは念のため残した）。`HTTPClient` は `signal` を `network.connect()` へ渡す。
- **制限**: 送信済みの offer / SYN は取り消せない（相手側は自身のタイムアウトで破棄する）。`ISignalingAdapter.sendMessage()` は `signal` を受け取らないため、シグナリング HTTP の送信そのものは打ち切らない。将来 `ISignalingAdapter` の契約へ `signal` を足す余地はあるが、本サイクルの範囲外とした。
- **検証**: `tests/abort-propagation.test.mjs`（9 件）は、接続試行中（SYN 送信済み・RTCPeerConnection 生成済み）に中断し、タイマー・リスナー・セッション・RTCPeerConnection が残らないこと、後続接続が成功することを確かめる。変異（WebRTC の破棄を外す）で失敗することも確認した。`examples/verify-abort-browser.mjs` は実 Chromium の RTCPeerConnection で同じ検証を行い、CI の `browser-e2e` で実行する。

### 3.36 HTTPClient の接続プールに上限・LRU・アイドル回収を入れる（#58 / サイクル17）

- **問題**: プールは `Map<key, PooledConnection>` で、`close()` まで無制限に `VirtualStream` を保持した。アイドル期限は次のリクエストのときにしか判定されず、多数の `(nodeId, port)` を巡回すると接続とタイマーが残り、サーバーの `maxConnections`（既定 64）に当たって `503` を受けうる。
- **同時に見つかった既存の不具合**: 同じキーで並行リクエストが重なると、後から作った接続が `pool.set(key, …)` で前の接続を上書きした。上書きされた接続は `close()` の対象から外れ、閉じられずに残っていた。
- **決定**:
  - プールは **接続の集合（`Set<PooledConnection>`、挿入順 = LRU 順）** にする。各エントリが `key` を持ち、キーでの検索は線形（上限が小さいため十分）。使用時・返却時に末尾へ移して最近使用順を保つ。
  - `maxPooledConnections`（既定 32、1 以上の整数。不正値は構築時に例外）。返却（`release(keep=true)`）のたびに超過分を **アイドルの LRU から** `end()` する。**使用中の接続は追い出さない**（使用中が上限を超える間は一時的に超えてよい。仕様 §16.5 の 9）。
  - **アイドル回収はエントリごとのタイマー**（`idleTimeoutMs`、`unref` 可能なら付ける）。アイドルになった時点で張り、取得・終了時に消す。発火したら `end()` してプールから外す。
  - **相手からの切断はアイドル中に検知する**: アイドルのエントリに `end` / `close` リスナーを付け、使用に入るときに外す。リスナーは `busy` を見て、使用中のエントリを誤って外さない。
  - **同キーの余分な接続は戻さない**: 返却時にアイドルの同キー接続が既にあれば、今回の接続を `end()` する（仕様 §16.5 の 10）。
  - `getPoolStats()` は `total / busy / idle / max` と累計 `evictedLru / expiredIdle / closedByPeer` を返す。`pooledConnectionCount` は `total` と同じ値を返す（互換のため残す）。
- **互換**: 既定値（keep-alive 既定、30 000 ms、`fetchURL()` の 1 リクエストごとの切断）は変えない。`pool` は非公開フィールドであり、テストは内部構造に依存しない形にする（既存テストは `[...client.pool][0]` を使っていたため、`pool` の走査方法だけを更新）。
- **制限**: LRU は接続数の上限であり、メモリ使用量の上限ではない。`VirtualStream` の受信バッファは接続ごとに上限があるが、総量は見ていない（#56 の範囲）。
- **検証**: `tests/http-client-pool.test.mjs`（上限超過時の LRU 追い出し・使用中を追い出さないこと・アイドルタイマーでの回収・相手切断の即時除去・同キー並行の上書き不具合の修正・`getPoolStats()` の内訳）を、実際のループバック接続で実行する。

## 4. クラス責務

| クラス | 責務 | 依存 |
| :--- | :--- | :--- |
| `WebTCPNetwork` | 層の組み立て、公開 API（`listen`/`connect`/`connectURL`/`bootstrap`）、ロガー伝播 | 全層 |
| `NameServer` | A/CNAME ローカル登録、TTL キャッシュ、既知ノードへの反復問い合わせ | `WebTCPNetwork`, `Logger` |
| `parseWebTCPUrl` / `formatWebTCPUrl` | `webtcp://` の厳格パースと正規整形 | `NodeId` 検証 |
| `persistState` / `restoreState`（`core/persistence`） | サービス役の状態（JSON）の保存と復元（M7） | `ServiceStateStorage`, `NameServer.exportState/restoreState` |
| `startBrowserKeepAlive`（`adapters/keepalive`） | Wake Lock・無音オーディオ・前面復帰の再接続・pagehide の終了処理（M7） | `WebTCPNetwork`, DOM API（注入可能） |
| `NodeIdentityStorage` | Node.js 秘密鍵 PEM の 0600 永続化・原子的作成 | `node:fs/promises` |
| `DomainAuthority` | ゾーン内名の収集・検証・勝敗決定・キャッシュ（候補は `NameServer` が `settleCandidates()` で渡す） | `IDomainRecordSource`, `IDomainOwnershipVerifier`, `Logger` |
| `createDomainOwnershipVerifier` | レコード構造・指紋・署名・有効期間・台帳アンカーの検証（fail-closed） | `Ed25519` 検証, `IChainAnchorVerifier` |
| `DomainLedger` | commitment の追記、Merkle ルート/証明発行、チェックポイント署名、serial 単調性 | `Ed25519KeyManager`（ログ鍵）, `merkle.ts` |
| `HttpDomainRegistryClient` | §14.6 の HTTP 契約でレコード送受・証明取得 | `fetch`, `parseDomainOwnershipRecord` |
| `LinkManager` | 近隣集合の維持、`WebTCPPacket` ⇄ バイト列、IChannel への送信 | `IChannel`, `IPacketSerializer`, `Logger` |
| `RoutingLayer` | 宛先判定、転送、TTL、RPF、RT_UPDATE の振り分け、署名の付与と検証 | `LinkManager`, `RoutingTable`, `IPacketVerifier`, `KeyDirectory`, `Logger` |
| `Ed25519PacketVerifier` | 署名の付与、署名対象バイト列の導出、指紋照合つき検証 | `Ed25519KeyManager`, `KeyDirectory`, `IPacketSerializer` |
| `KeyDirectory` | `NodeId -> 公開鍵` の保持、指紋照合つき登録、到着待機 | `deriveNodeId`, `Logger` |
| `NodeKeyManager` / `BrowserKeyManager` | Ed25519 鍵の生成・保存・署名・検証 | `node:crypto` / Web Crypto + IndexedDB |
| `RoutingTableManager` | 距離ベクトル更新、`lastSeen` 維持、エイジング、撤回伝播 | `RoutingTable`, 送信コールバック, `Logger` |
| `TransportLayer` | ポート多重化、`ESTABLISHED` 時のハンドラ呼出、RST | `IRoutingLayer`, `SessionManager`, `Logger` |
| `VirtualStream` | 状態機械、バイト単位 Seq/Ack、MSS 分割、部分読み取り、輻輳制御、SACK、Half-Close | `TransportContext`, `RetransmitQueue`, `Logger` |
| `RetransmitQueue` / `RttEstimator` | バイト範囲再送管理、SACK スコアボード、RFC 6298 動的 RTO | `seq.ts` |
| `SessionManager` | セッション表、アイドル回収 | `Logger` |
| `WebRTCChannel` | Offer/Answer/ICE、Glare 解決、ICE 再起動、動的 TURN フック、DataChannel | `ISignalingAdapter`, `Logger` |
| `SignalingAdapterHub` | HTTP によるシグナリングメッセージの送受信 | `fetch`, `Logger` |
| `EntranceSearcherAdapterHub` | HTTP による参加ノードの発見（`exclude` 対応） | `fetch` |
| `HTTPServer` | 仮想ポートの待ち受け、接続ごとのリクエストループ、`keep-alive`、ハンドラ呼び出し、上限の強制 | `WebTCPNetwork`（`listen`）, `HTTPReader` / `HTTPWriter`, `Logger` |
| `HTTPClient` | `webtcp://` URL / NodeId + ポートへのリクエスト送信、接続プール、ストリーミング応答 | `WebTCPNetwork`（`connect` / `connectURL`）, `NameServer`（任意）, `HTTPReader` / `HTTPWriter` |
| `HTTPReader` / `HTTPWriter` | バイト列 ⇄ HTTP メッセージ（分割耐性・CRLF 厳格・上限・chunked・インジェクション防止） | `VirtualStream`, `Logger` |
| `HTTPParser` | リクエストライン / ステータスライン / ヘッダ / 本文長の逐次決定 | `HTTPHeaders`, 上限設定 |
| `HTTPRouter` | `method + path` パターンのディスパッチ（`/users/:id`） | `HTTPHandler` |

## 5. シーケンス

### 5.1 リンク確立（2 ノード、HTTP ハブ）

```
A                           hub                           B
|-- POST /signal (offer) -->|                             |
|                           |<-- GET /messages (poll) -----|
|                           |--- offer ------------------>|
|                           |<-- POST /signal (answer) ----|
|<-- GET /messages ---------|                             |
|-- POST /signal (candidate)-->|                          |
|                           |--- candidate -------------->|
|============ DTLS/SCTP データチャネル ====================|
|   connection-status(true)                              |
```

### 5.2 仮想接続の確立（ランダム ISN）

```
Client (TransportLayer)                     Server (TransportLayer)
| stream=SYN_SENT, send SYN(seq=C, ack=0)    |
|------------------------------------------->| no session + listener
|                                            | stream=SYN_RCVD
|                                            | send SYN_ACK(seq=S, ack=C+1)
|<-------------------------------------------|
| ackNum==C+1 -> ESTABLISHED                 |
| emit connect                               |
| send ACK(seq=C+1, ack=S+1)                 |
|------------------------------------------->| ackNum>=S+1 -> ESTABLISHED
|                                            | emit connect -> handler(stream)
```

### 5.3 バイトストリーム送信・SACK

```
Client                                        Server
| send(80 KiB) -> split into 16 KiB segments |
| DATA(seq=C+1, len=16384) ----------------->| rcvNxt=C+16385, emit data / recvBuffer
| DATA(seq=C+16385, len=16384) --X (lost)    |
| DATA(seq=C+32769, len=16384) ------------->| out-of-order -> ACK(ack=C+16385, SACK=[C+32769..C+49153))
|<------------------ 3x dup ACK + SACK ------|
| Fast Retransmit ONLY missing segment       |
| DATA(seq=C+16385, len=16384) ------------->| reassemble contiguous bytes -> ACK(ack=C+49153)
```

### 5.4 Half-Close 切断

```
Client (ESTABLISHED)                          Server (ESTABLISHED)
| end() -> FIN (FIN_WAIT_1) ----------------->| send ACK, emit 'end' (CLOSE_WAIT)
|<------------------------------------- ACK   |
| (FIN_WAIT_2: 引き続き受信可能)               | send("farewell") (送信継続可能)
|<---------------------------- DATA("farewell")|
| send ACK ---------------------------------->|
|                                             | end() -> FIN (LAST_ACK)
|<------------------------------------- FIN   |
| send ACK (TIME_WAIT -> CLOSED, emit close) >| CLOSED, emit close
```

### 5.5 HTTP の 1 往復（`Connection: close` と Half-Close）

```
HTTPClient                                   HTTPServer
| (keepAlive=false) connect() -> ESTABLISHED  | listen(8080) 済み
| GET /hello?x=1 HTTP/1.1 CRLF               |
| Host: demo-service:8080 CRLF               |
| CRLF                                       |
| end() -> FIN (FIN_WAIT_1) ----------------->| send ACK, emit 'end' (CLOSE_WAIT)
|                                            | handler(request, response)
|                                            | response.end('hi')
|<--------------- HTTP/1.1 200 OK CRLF …DATA | CLOSE_WAIT でも send() 可能（§8.2）
|<--------------------------------------- FIN | end() -> LAST_ACK
| send ACK (TIME_WAIT -> CLOSED) ----------->| CLOSED
```

`keepAlive=true` の場合、`end()` は呼ばずに同一ストリーム上で次のリクエストを送る（逐次・非パイプライン）。接続は `HTTPClient.close()` かアイドルタイムアウト（既定 30 000 ms）で `end()` する。

## 6. 状態と並行性

- すべての処理は単一スレッドのイベントループ上で動く。共有状態のロックは不要。
- タイマー（再送・`TIME_WAIT`・ICE 切断猶予・経路メンテナンス・セッション回収・シグナリングポーリング）は `close()` / `destroy()` で必ず解除する。
- `WebTCPNetwork.start()` は冪等（二重呼び出しで多重タイマーを作らない）。

## 7. エラー処理方針

| 層 | 方針 |
| :--- | :--- |
| シリアライザ | 不正入力は `Error` を投げる。呼び出し側（LinkManager）が捕捉して `warn` ログ後に破棄。 |
| リンク | 送信失敗は `error` ログ + `false` を返す。プロセスを落とさない。 |
| ルーティング | 経路なし・TTL 切れ・検証失敗は `warn` ログ + 破棄。 |
| 署名（送信） | 署名に失敗したら `warn` ログのうえ v1 として送信（縮退）。 |
| 署名（受信） | 鍵未解決は `keyWaitTimeoutMs` 待機後に破棄。`Ed25519PacketVerifier` は例外を投げず `false` を返す。 |
| トランスポート | アプリ向け API は Promise を reject。異常終了は `error` + `close` イベントで通知。 |
| アダプタ | ネットワークエラーは `warn` ログ + 再試行。ICE 失敗時は `maxIceRestarts` まで自動再起動。 |
| HTTP（サーバー） | パース失敗・上限超過は対応する 4xx を返して接続を閉じる。ハンドラの reject は未応答なら `500`、応答開始済みなら切断。例外をプロセスへ伝播させない。 |
| HTTP（クライアント） | 接続・パース・時間切れ・上限は型付きエラーで reject する。`AbortSignal` はストリームの `destroy()` まで伝播させる（中断は相手に伝わらない点に注意、§16.5 / #54）。 |

## 8. テスト戦略

- **生存期間（M7 / #51）**: `service-persistence.test.mjs`（IndexedDB 往復・再検証による改ざん拒否・不正な版/ポートの拒否・NodeId 不一致・neighbor イベント再発行・keep-alive の Wake Lock / 前面復帰 / pagehide）。実ブラウザの 1f 項目は `verify-browser.mjs` が CI で検証する。
- **ユニット**: シリアライザ（不正フラグ・v1/v2 の長さ制約を含む）、NodeId 指紋導出、Base64url コーデック、
  Ed25519 署名/検証（改ざん・なりすまし・TTL 正規化）、`KeyDirectory` の指紋照合、RFC 1982 算術、SACK コーデック、
  RFC 6298 `RttEstimator`、ロガーレベル制御。
- **統合（LoopbackChannel）**: 2 ノード E2E、ランダム ISN & 32 ビットラップアラウンド、160 KiB 自動分割・再結合、部分読み取り（`read` / `readExact`）、損失チャネルでの 3 重複 ACK Fast Retransmit + SACK、RTO タイムアウトと `cwnd` 縮小、Half-Close（`CLOSE_WAIT` 中の送信継続 / `allowHalfOpen: false` / 順序外 `FIN`）、3 ノードマルチホップ転送、経路撤回、`RT_UPDATE` の `lastSeen` 更新、TTL=1 境界、`bootstrap()` リトライと指数バックオフ。
- **署名付きネットワーク（#28）**: 2 ノード v2 E2E、署名欠落パケットの拒否、リンク上での改ざん注入の破棄、
  3 ノードマルチホップでの各ホップ検証、`RT_UPDATE` による公開鍵配布。
- **鍵管理アダプタ（#28 / M4）**: `NodeKeyManager`（PEM / シード復元・指紋照合・keyFile 永続化・衝突）、`BrowserKeyManager`
  （IndexedDB への非抽出 CryptoKey 保存・復元・署名チャレンジ・再生成・IndexedDB 無しのセッション限定動作。テストは `FakeIndexedDB` シムを使用）。
- **名前解決（M4 / #25）**: URL 正常/異常、A/CNAME、ループ・深度上限、TTL キャッシュ、ローカル優先、問い合わせタイムアウト/中断、実スタック 2 ノード解決、事前鍵共有なし 3 ノードの名前解決と URL 接続。
- **ドメイン所有権（M5 / #25）**: canonical バイト列の決定性と未知キー拒否、署名・指紋・有効期間・serial ルール、
  台帳の包含証明（木サイズ 1〜8、奇数 promote）、チェックポイント署名と `treeSize` 後退拒否、`prevHash` 連鎖追跡、
  ログ鍵未設定時の fail-closed、`requireChainAnchor` の切り替え、同 serial 異内容の衝突、
  `NameServer` 統合（ゾーン名の `registerA` 拒否・`registerDomain`・`source: 'domain'`・所有権なし応答の拒否）、
  停滞ノードを含む解決が `resolveTimeoutMs` に収まること（#40 の回帰）。
- **アダプタ**: `SignalingAdapterHub`、`EntranceSearcherAdapterHub`（`exclude` 対応）、`examples/server.mjs` の配信・API 検証（`/domain/*` を含む）。
- **WebRTC 経路（FakeRTCPeerConnection）**: Offer/Answer/DataChannel、動的 TURN 資格情報（`iceServersProvider`）、ICE 障害時の自動 ICE 再起動と資格情報更新、再起動上限超過時の切断、同時接続 Glare 解決。
- **HTTP 層（M6 / #50）**: パーサの分割耐性（1 バイトずつ／`\r` と `\n` の分離／ヘッダ途中の MSS 境界）、CRLF 厳格性、`Content-Length` / `chunked` の往復、上限（行長・ヘッダ数・本文）、ヘッダインジェクション拒否、`HTTPReader` の EOF 処理。
  LoopbackChannel 上の `HTTPServer` × `HTTPClient` による E2E（`keep-alive` での複数リクエスト再利用、`Connection: close` での FIN 後応答、`HEAD`、404/500、`413`、同時接続、`HTTPRouter`）。
  `HTTPClient` のタイムアウト・`AbortSignal`・`maxResponseBytes`・`text()` の二重読み取り拒否、サーバー idle timeout 後のプール再利用。
  `HTTPServer.close()` が `FIN` を送ること（`destroy()` は `RST` で中断するため、正常な終了には使わない。#54）。
  実ブラウザ自己チェック（`?selftest=1`）に `serveHTTP` + `fetchURL` の 1 往復を追加（`examples/verify-browser.mjs` も検証）。
- **実ブラウザ検証**:
  - ブラウザ内蔵の自己チェックモード（`/examples/demo/?selftest=1` および `?role=server/client&autostart=1`）。
  - Playwright によるヘッドレス Chromium 2 タブ E2E（`examples/verify-browser.mjs`、GitHub Actions CI の `browser-e2e` ジョブで自動実行）。

## 9. 既存コードからの移行（M1 で完了）

| 旧 | 新 | 理由 |
| :--- | :--- | :--- |
| `core/routing/PacketVarifier.ts` | `core/routing/PacketVerifier.ts` | ファイル名 typo と未完成実装の書き直し。 |
| `core/transport/RetrainsmitQueue.ts` | `core/transport/RetransmitQueue.ts` | ファイル名 typo 修正。 |
| `core/transport/PortMultiplexer.ts` | 削除 | `TransportLayer.ts` の重複コピー。 |
| `core/types/serializer.ts` の Buffer 実装 | `Uint8Array` + DataView 実装 | ブラウザ互換とフラグ復元バグ修正。 |
| `LinkManager` のダミー `IChannel` | `IChannel` 実装の注入 | 実通信不可だったため。 |
| `WebTCPNetwork(adapter, keyManager)` | `WebTCPNetwork(options)` | オプション形式への統一。 |

## 10. 既知の制約（0.8.1 時点）

- **鍵管理を渡さない場合は v1（署名なし）で動く**: 既定の `WebTCPNetwork(options)` は後方互換のため `NullPacketVerifier`。
  署名必須にするには `keyManager` または `Ed25519PacketVerifier` を注入する（`createBrowserNetwork({ keyManager })` など）。
- **Ed25519 非対応ブラウザ**: Web Crypto の Ed25519 は Chrome 137+ / Firefox 129+ / Safari 17+。デモは v1 へ自動フォールバックする。
- **鍵ローテーション・E2E 暗号化・リプレイ検知の強化は未実装**: `specification.md` §11.7 を参照。
- **RPF は緩和版**: 経路未学習の直接隣接からの受信を許可している。本格的なマルチホップ強化（RPF 厳格化）は #46 で追跡しており、未実装。
- **`domain.global` は「検証可能」まで（M5）**: 所有権レコードの署名・指紋・有効期間・追記台帳の包含証明までは検証する。実チェーン（SPV / EVM 証明 / Namecoin RPC）との突き合わせは未同梱で、`IChainAnchorVerifier` の実装は #42。単一ログの信頼モデルであり、複数ログ合意・紛争裁定・IDNA は #43。
- **ゾーン外の名前は依然としてローカル信頼**: `my-service` のような NameServer ローカル名に所有権はない（§13.1）。
- **Node.js 鍵ファイルは平文 PEM**: `0600` で保存するが、ディスク暗号化やバックアップは利用者の責任。
- **Node.js 向け WebRTC 実装は非同梱**: `NodeWebRTCChannel` へ利用者が注入する設計。
- **HTTP は HTTP/1.1 のサブセット**: HTTP/2・HTTP/3、`Upgrade` / WebSocket、`CONNECT`、パイプライン、圧縮、Cookie ジャー、認証、リダイレクト追従は実装しない（`specification.md` §16.9）。`webtcp://` URL の `fragment` は送らない。
- **HTTP 層に認証・認可は無い**: トンネルの外側（署名・RPF）だけで守られる。`request.remoteNodeId` を使った許可リストはアプリケーションの責務（§16.7）。
- **受信フロー制御（ウィンドウ広告）は無い**: 送信側の制限は輻輳ウィンドウと `maxWindowBytes` のみ。遅い受信側で大量の HTTP 応答を受けるとメモリを消費する（`specification.md` §8.3.1）。
- **`NodeWebRTCChannel` を実接続に使う構成は CI 対象外**: 実ブラウザ検証（Playwright）と LoopbackChannel が検証範囲。
- **サービス役は凍結中のタブでは応答しない**: 状態の永続化・復元と keep-alive 補助で停止からの回復は速くなるが、非可視タブの凍結は防げない（`specification.md` §9.6）。HTTP ハンドラと `onPageHide` は復元時に利用者が付け直す。
