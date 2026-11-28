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
- **`HTTPClient` の接続プールはキー `(nodeId, port)` で 1 本**（サイクル17 / §3.37 で上限・LRU・アイドル回収を追加。詳細は §3.37）。同時 `fetch()` が重なった場合は新しい接続を作って並行実行し、終了後にプールへ戻す（戻すのは 1 本だけ）。これは HTTP/1.1 の「1 接続 1 リクエスト」原則と一致する。

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
- **背圧は 2 方向で扱う**。上りは `VirtualStream.send()` の `Send buffer full` を `drain` 待ちの再送で吸収する（受信ウィンドウ（#56）は §3.39 で交渉し、受信側は上限を強制する。送信側だけで止める）。下りはソケットの `write` が偽を返したら仮想側の読み取りを一時停止し、`drain` で再開する。
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
- **候補の数はイベントではなく SDP（`localDescription.sdp` の `a=candidate:` 行）で数える。** `icecandidate` の配送は実装ごとに異なり、イベントに頼ると正常な接続まで誤って警告するため。`node-datachannel/polyfill` では、生成直後に登録しなかったリスナーには候補が届かない（#67、下記）。
- **#67 の原因（上流の挙動。node-datachannel 0.33.6 で再現）**: polyfill は `createDataChannel()` の時点で ICE 収集を始め、`setLocalDescription()` の完了より前に `complete` にする（サイクル26 の計測、20 回・`createDataChannel()` からの中央値: `complete` 0.59 ms、`setLocalDescription()` の完了 0.65 ms、最初の候補イベント 0.75 ms。20/20 回で `complete` が完了より先）。候補イベントは完了の直後（中央値で約 0.2 ms 後）に `dispatchEvent` され、再送されない（`dist/esm/polyfill/RTCPeerConnection.mjs` の `onLocalCandidate`）。そのため、生成直後に同期登録したリスナーは候補を受け取るが、数百 ms 後に登録したリスナーは `addEventListener` でも `onicecandidate` でも 0 回になる（SDP には候補が残っている。遅延登録 3/3・5/5 で再現）。`candidate === null` の終了イベントも発行されない。
- **設計上の扱い（#67）**: サイクル20 で `createNodeNetwork()` 経由の PC に橋渡しを入れた（§3.38）。上流の挙動は変わらず、`tests/node-datachannel-polyfill.characterization.test.mjs` で固定する。`watchIceGathering` の SDP カウントは変えない（収集完了時に `localDescription` は暗黙の offer として既に存在し、`127.0.0.1` で候補 1 件・自動バインドで 0 件を確認）。
- 検証: 自動バインドでは警告、`127.0.0.1` では警告なし（実 `node-datachannel` で確認）。

### 3.32 候補 0 件の接続は、タイムアウトの原因を示して失敗させる（#61 / 0.8.1）

- **問題**: 自動バインドで候補 0 件のホストでは、接続は成立せず `connectTimeoutMs` まで待ってから失敗する。警告は収集完了時に 1 回出るが、接続の失敗（`connect()` の拒否、`bootstrap()` の `warn`）は「timed out」だけで、原因が分からない。
- **検討した方針**:
  - (a) 候補 0 件なら `127.0.0.1` へ自動で再バインドする。却下。同一ホストでしか成立しない接続を黙って作り、リモートの相手では依然失敗する。候補収集の後でオファーを作り直す必要があり、#67 と同じタイミングの問題を抱える。
  - (b) 警告のみ（現状）。不十分。原因はログの 1 行にしか現れず、接続の失敗理由には含まれない。
  - (c) 既定の `bindAddress` を固定する。却下。実ネットワークで候補が減る（#61 の既存の懸念）。
  - **採用**: (b) を強化する。接続のタイムアウトのエラーに原因を含める。既定値は変えず、待ち時間も変えない。
- **判定**: タイムアウトの時点で、`iceGatheringState === 'complete'` かつ `localDescription.sdp` に `a=candidate:` 行が無いときだけ、原因（候補 0 件、`peerConnectionOptions.bindAddress`、#61 の Issue）を付ける。収集中・候補ありのときは付けない（誤って原因を断定しない）。
- **早期に失敗させない理由**: 収集完了の時点で即座に拒否する案は、`complete` が `setLocalDescription()` より前に起きる実装（#67 の polyfill）で `localDescription` が無いまま判定する競合を抱える。タイムアウト時点の判定は収集が確実に終わっているため、この競合が無い。
- **構成**: 基底の `WebRTCChannel` に既定が空の protected フック `describeConnectTimeout(connection)` を置き、`NodeWebRTCChannel` だけが上記の判定を実装する（ブラウザ経路は変えない）。
- **#67 / `watchIceGathering` との関係**: 判定基準（SDP の `a=candidate:` 行）は `watchIceGathering` と同じ。`watchIceGathering` の収集完了時の警告はそのまま残す。`icecandidate` イベントには依存しないため、#67 の配送タイミングの影響は受けない。
- **検証**: `tests/webrtc-connect-timeout.test.mjs`（fake PC で 0 件・候補あり・収集中の 3 件、実 `node-datachannel` で自動バインドの 1 件。実 `node-datachannel` のテストは子プロセスで実行する）。修正前は 2 件失敗、修正後は 4 件合格。

---

### 3.33 公開デモは静的ホスティングで動く範囲だけを提供し、サーバー依存部はローカルに残す（サイクル11 / GitHub Pages）

- **公開先**: `https://sonneko.github.io/WebTCP/`（GitHub Pages のプロジェクトサイト）。Astro の `site` は `https://sonneko.github.io`、`base` は `/WebTCP`。リンクは `/WebTCP` を前置する rehype プラグイン（`webtcp_website/src/plugins/base-links.mjs`）で補う。
- **デプロイ**: `.github/workflows/deploy-pages.yml` が `main` への push と手動実行で、`webtcp_jslib` と `webtcp_website` をビルドして `actions/upload-pages-artifact` + `actions/deploy-pages` で配信する。Pages の Source は `build_type: workflow`（確認済み）。PR の検証は既存の `build-website` ジョブが担い、デプロイ用ワークフローは `main` のみ。
- **デモの配置**: サイトの `public/` に `examples/demo/*`（HTML と JS）と `webtcp_jslib/dist/` をローカルサーバーと同じ相対配置（`/examples/demo/`、`/webtcp_jslib/dist/`）で複製する（`webtcp_website/scripts/sync-demo.mjs`、生成物は Git 管理外）。デモの `import` パスと `examples/server.mjs` の静的配信は変更しない。
- **モード判定**: 起動時に `/domain/log` を取得し、応答すればローカルサーバーモード（従来どおり `SignalingAdapterHub` と `EntranceSearcherAdapterHub`、`/domain/*` の検査）。応答しなければ静的モード。`?static=1` で静的モードを強制できる（検証用）。
- **静的モードのシグナリング**: (a) 自己チェック（`?selftest=1`）は同一ページ内の `ISignalingAdapter` の対（メモリ内バス、`examples/demo/local-signaling.js`）で 2 つの実 `RTCPeerConnection` を直接つなぐ。他タブへは漏れない。(b) 2 タブデモは `BroadcastChannel`（同一ブラウザ内）で SDP / ICE / public-key を交換し、探索は `discover` / `here` メッセージで行う。別ブラウザ・別デバイスの接続は静的版では成立しない（交換経路がない）。これは受け入れた制約。
- **省略する検査**: 静的モードでは `/domain/*` に依存する自己チェック項目（1d: domain.global の台帳アンカーと偽造拒否）を「スキップ」として表示し、失敗にしない（`SkipError`）。ドメインパネルの登録・解決は「ローカルサーバーが必要」と表示して止める。
- **シグナリングを増やさない理由**: シグナリングサーバーを置くと運用対象が増え、静的ホスティングの範囲を超える。クロスデバイスのデモが必要になった時点で、シグナリングだけの小さなエンドポイントを別途検討する（今回はスコープ外）。
- **検証**: `examples/verify-static-demo.mjs` が Playwright で、(1) サイト表示、(2) デモ読み込み（静的モード表示）、(3) `?selftest=1` の全項目（スキップ以外）PASS を確認する。CI の `browser-e2e` ジョブに組み込み、ビルド済み `webtcp_website/dist` を一時 HTTP サーバーで配信して検査する。
- **既存の CI の役割**: `build-website` は PR の検証として残す。`build-website` は `webtcp_jslib` のビルド成果物を必要とするため、ジョブ内で先に `npm ci && npm run build`（jslib）を実行する。

### 3.34 公開デモは ICE 候補の事前診断を行い、候補ゼロなら早く止めて理由を示す（サイクル13 / #73）

- **事象**: 公開デモの自己チェック step 1 が、ICE 候補を 1 つも得られない訪問者の環境で約 45 秒かけて失敗し、原因が表示されなかった。`bootstrap()` の既定リトライ（3 回 × 15 秒）が続くため。
- **決定**: 自己チェックの先頭（step 0）で、デモ側が `RTCPeerConnection` を 1 つ作って候補を収集する（ライブラリの変更はしない）。候補が 0 件、または gathering が完了しない場合は step 0 を FAIL にし、残りを実行しない。理由（UDP 遮断・VPN・企業ネットワーク）と対処（ローカルサーバー、別のネットワーク）を表示する。
- **内訳の表示**: step 0 の詳細に `host(mdns)` / `host(ip)` / `srflx` / `relay` の件数を出す。step 1 が失敗した場合も同じ内訳を詳細に含める。
- **STUN について**: 既定の `iceServers` は空のまま（同一ホスト向け）。STUN / TURN で改善するかは環境次第で、UDP 自体が遮断されていれば効かない。公開版では保証しない。
- **対象外**: 2 タブ（BroadcastChannel）の経路は WebRTC を使うが、今回の事前診断は自己チェックだけに付ける。プロトコルは変更しない（仕様書は更新なし）。

### 3.35 シグナリングのトランスポートは「配送の仕方」だけを変え、契約と既定は変えない（M9 / #45 / サイクル14）

- **問題**: ポーリングの平均遅延は約 500 ms（1000 ms 間隔）で、ICE 候補の逐次到着が遅い。
- **決定**: `ISignalingAdapter` の契約は変えず、SSE と WebSocket の実装を追加する。既定は `SignalingAdapterHub`（ポーリング）のまま（依存なし・プロキシ耐性）。
- **押し込み型の再生**: ポーリングはメッセージを配信時に削除するが、押し込み型では接続が切れても届け直せるよう、サーバーは保持期間（60 秒）まで削除しない。再接続（`resume=1`）は `id > after` をすべて再生し、初回接続は未配信のものだけを再生する（以前の受信者が受け取った古いメッセージを新しいリスナーへ流さないため。ポーリングと同じ「一度だけ配る」）。重複はクライアントがカーソルで捨てる。
- **SSE は `fetch` で読む**: `EventSource` は Node.js に標準で無く、ヘッダーとバックオフを制御しにくい。`fetch` のストリームなら両方で同じ実装になり、`fetchImpl` の差し替えでテストできる。
- **WebSocket の送信は Socket 経由、未接続時は `POST /signal`**: 送信の遅延を下げつつ、切断中の送信を失わない。
- **参照サーバー**: `examples/server.mjs` に `/events` と `/ws` を追加する。WebSocket は依存を増やさないため、RFC 6455 のサーバー側（ハンドシェイク・マスク解除・ping/pong・断片化）を `examples/lib/ws-server.mjs` に実装する。
- **検証**: CI の `browser-e2e` で、同じ 2 タブの自動検証を 3 つのトランスポートで実行し、結果（成功・ステップ名・接続）が一致することを確認する。加えて Node.js の検証で、同じメッセージ列が 3 つで同順・同内容に届くことと、遅延の差を測る。
- **対象外**: 双方向の認証（トークン）、ハブの水平分散、TURN の変更。

### 3.36 API の中断は「待機者単位」で外し、RST と資源解放を契約にする（M9 / #44 / サイクル15）

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

### 3.37 HTTPClient の接続プールに上限・LRU・アイドル回収を入れる（#58 / サイクル17）

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
- **制限**: LRU は接続数の上限であり、メモリ使用量の上限ではない。`VirtualStream` の受信バッファは接続ごとに `maxRecvBufferBytes` で有界（§3.39）。接続数を掛けた総量は見ていない。
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
- **受信ウィンドウは交渉した接続だけで送信側を制限する**: 旧実装の相手とは窓が無く、受信側の上限を超えた分は破棄→再送になる。読み手が長く止まると切断されうる。上限は `maxRecvBufferBytes` で調整する（`specification.md` §8.3.4、§3.39）。
- **`NodeWebRTCChannel` を実接続に使う構成は CI 対象外**: 実ブラウザ検証（Playwright）と LoopbackChannel が検証範囲。
- **サービス役は凍結中のタブでは応答しない**: 状態の永続化・復元と keep-alive 補助で停止からの回復は速くなるが、非可視タブの凍結は防げない（`specification.md` §9.6）。HTTP ハンドラと `onPageHide` は復元時に利用者が付け直す。

### 3.38 `node-datachannel/polyfill` の ICE 候補と終了マーカーを、アダプタ層で後から登録しても届くようにする（#67 / サイクル20）

- **問題**: 上流の polyfill は候補イベントを再送せず、終了時の `candidate === null` も送らない（characterization で固定）。`addEventListener` のリスナーは生成直後に登録しないと候補を 1 件も受け取れない。`onicecandidate` も後から代入すると同じく届かない。上流の `complete` は候補イベントより先に発火する（30 回の実測で `complete > complete > candidate` の順）。
- **検討した方針**:
  - (a) 上流を直す。却下。上流のリポジトリへの報告は、この sandbox から Issue を作れない（#67 の option 3 と同じ）。
  - (b) 利用者に SDP で数えさせる。不十分。利用者がイベントで候補を数える前提を守れない。
  - (c) 候補を数える利用者向けに、イベントの代わりに SDP を見るよう文書化する。却下。終了の合図が無いまま待つことになる。
  - **採用**: 橋渡しをアダプタ層（`createNodeNetwork()` の factory の直後）に置く。生成直後に記録用の処理を入れ、後から登録されたリスナーへ記録を再送する。
- **仕組み**（`src/adapters/webrtc/nodeProvider.ts` の `bridgeIceCandidateEvents`）:
  - `dispatchEvent` を差し替え、`icecandidate` を発行の時点で記録する。上流の内部リスナー（`onicecandidate` への配送）も同じ経路を通るため、`onicecandidate` の既存の動作は変わらない。
  - `addEventListener('icecandidate', l)` は、`l` ごとの受信済みの位置（`cursor`、初期値 0）から、記録済みの候補を登録時に同期的に順に渡す。通常のリスナーは未受信の分をすべて渡してからネイティブに登録する。`once` は未受信の先頭 1 件だけを渡し、ネイティブには登録しない。ただし未受信の候補が無いとき（`cursor` が記録の末尾）は、次の候補を待つためネイティブに登録する。同じリスナーの二重登録（未発火）は無視する。
  - **`once` の意味論と位置（サイクル21 / 23、PR #81・Issue #83）**: DOM の `once` と同じく、発火した `once` リスナーは除去され、同じリスナーを再登録できる。ネイティブに登録した `once` は、発火時（コールバックの直前）に除去し、`cursor` を記録の末尾まで進める。こうすると、コールバック内での再登録も受け付けられる。`removeEventListener` は登録を外し、登録されていたリスナーの `cursor` を記録の末尾まで進める。再登録は `cursor` 以降の未受信の候補から再開するため、受信済みの候補を再配送しない。修正前は再登録が常に先頭の候補から配送され、`once` で 1 件ずつ読むリスナーは候補を重複して受け取り、後続を取りこぼした（#83）。
  - **リスナーごとの位置を採用した理由（#83）**: 候補の記録は PC 単位で共有されるため、リスナーの位置を記録側に持たせると、他のリスナーの配送が壊れる。検討した案: (a) 再登録のたびに先頭から渡す（修正前。重複する）、(b) 発火済みの `once` の再登録を無視する（取りこぼす）、(c) 発火時に記録の先頭を削る（他のリスナーの位置が壊れる）、(d) リスナーごとの `cursor` を持つ（採用）。(d) は他のリスナーに影響せず、DOM の「発火ごとに除去」と両立する。`cursor` は収集の新しいラウンドで 0 から数え直す（記録も新しくなるため）。
  - `onicecandidate` の代入（アクセサ）は、代入されたハンドラが未受信の分だけを渡す。同じハンドラの再代入では重複しない。
  - 終了マーカー: 収集が `complete` になったら、`localDescription.sdp` の `a=candidate:` 行の数に記録済みの候補数が達するまで 1 ms ごとに確認し、達した時点で `candidate === null` を 1 回発行する（上限 200 回で打ち切り）。`complete` の時点で候補は届いていないことがあるため、即座には出さない。`localDescription` が無い場合（#67 の順序）は SDP の件数が分からないため、同じ上限（200 回）まで待ってから出す。
  - ネイティブ実装が `null` を自前で発行した場合は、それを記録して二重に出さない。
  - 収集が再開された（`gathering` に戻った）場合は、記録と終了の状態を次の収集の分として初期化する。
- **#61 / `watchIceGathering` との関係**: `watchIceGathering` は SDP で候補を数える（変更なし）。#61 の `describeConnectTimeout`（§3.32）も SDP で判定する（変更なし）。#67 の橋渡しは候補 0 件の判定を変えない。#61 は自動バインドの host 設定の問題で、この変更では解決しないため open のまま。
- **適用範囲**: `createNodeNetwork()` が生成する PC（注入された factory を含む）。生の `RTCPeerConnection` は変えない（characterization テストは上流の挙動をそのまま固定する）。
- **検証**: `tests/icecandidate-bridge.test.mjs`（fake PC で、後からの登録・代入・二重登録・`once`・終了マーカーの順序・ネイティブの `null`・SDP 件数の待ち）と、実 `node-datachannel`（子プロセス）で、修正前（生の PC）と修正後（橋渡し）の候補数・終了数を比較する。

### 3.39 受信ウィンドウは v2 のまま `WIN` ビットで交渉し、受信側は交渉の有無によらず上限を強制する（#56 / サイクル22）

- **問題**: 受信側の空きを送信側へ伝える手段が無い。`VirtualStream` の受信バッファ（`recvChunks` と順序外保持）は読み手が止まっても伸び続け、悪意ある相手に送らせれば受信側のメモリを使い切れる。
- **検討した方式**:
  1. **プロトコル v3 でウィンドウを広告する**（ヘッダーまたは SYN オプションに載せる）。ヘッダーに項目を足すと §6.2 の長さ検証とバージョン判定（v2 は署名必須）が変わり、全ノードの更新が前提になる。SYN オプションだけなら変更は小さいが、窓の更新（ACK）には結局 ACK 側の拡張が要る。旧ノードとの共存は、バージョンのネゴシエーションまたは再接続を必要とする。実装とテストの範囲が最も大きい。
  2. **v2 のまま `maxWindowBytes` を受信側の空きで動的に縮める**。送信側は受信側の空きを知らないため、受信側が ACK を遅らせるか落とすしかない。落とした分は RTO の再送になり、指数バックオフで `maxRetransmissions` を超えて切断される。フロー制御ではなく障害になるため採らない。
  3. **HTTP 層の `highWaterMark` を受信バッファの残量で縮める**（`getStats()` に受信バッファ量を追加）。`HTTPBodyStream` の購読を止めても、`VirtualStream` の受信チャネルは ACK を返し続けるため、L4 の `recvChunks` は伸びる。HTTP 以外のストリームは守れない。単独では #56 を解決しないため、既存の `highWaterMark` と併用する補助に留める。
  4. **採用: v2 のまま `WIN` ビット（フラグ bit 7）で交渉し、ACK のペイロード先頭 4 バイトに受信ウィンドウを載せる**。
- **採用理由（後方互換・実装コスト・効果）**:
  - 後方互換: 旧実装はフラグ bit 7 を無視する（`maskToFlags` は既知のフラグだけを見る）。`WIN` は SYN / SYN_ACK で交渉し、旧実装の相手が `SYN_ACK` で `WIN` を返さなければ、その接続は従来どおりウィンドウ無しで続く。パケット形式・バージョン・署名の対象（ヘッダー全体）は変わらない。
  - 実装コスト: シリアライザ（ビットの読み書き 1 箇所ずつ）、`VirtualStream`（交渉・広告・右端・破棄・窓更新・問い合わせ）に限られる。
  - 効果: 交渉した相手には送信側が右端で止まり、受信バッファは `maxRecvBufferBytes` に収まる。交渉しない相手にも受信側の上限を適用するため、悪意ある相手でもメモリは有界になる。
- **バージョンとフォールバック（§8.3.4 / §6.3）**:
  - プロトコルは v2 のまま。`WIN` は `SYN` で申し出、受動側は対応する場合だけ `SYN_ACK` で受諾する。両方が `WIN` を立てた接続だけがウィンドウ付き ACK を使う。
  - 旧実装の相手とは、ウィンドウ無しで通信する。受信側の上限は、交渉の有無によらず適用する（破棄→再送）。旧実装の相手が読み手の止まった接続を長く続けると、再送の上限で切断されうる。これは #56 の受け入れ条件（上限で有界）を優先した結果で、利用者は `maxRecvBufferBytes` で調整する。
  - 窓更新を失っても止まらないよう、送信側は右端で止まっている間、RTO 間隔で `WIN` 付きの問い合わせ ACK を送る。受信側はこれに必ず現在のウィンドウで答える。応答には `WIN` を立てないため、問い合わせの往復が無限に続くことはない。
- **実装の要点（`VirtualStream`）**:
  - 受信側: 格納前に、セグメントの新規バイト（`segEnd - max(segSeq, rcvNxt)`）を比べる。順序外のセグメントは空き（`maxRecvBufferBytes - 連続未読 - 順序外保持`）に収まる場合だけ格納する。先頭の欠損を埋めるセグメントは、連続未読の空きに収まれば格納し、必要なら順序外保持のバイトを押し出す（破棄して再送に任せる）。押し出さないと、順序外バイトが空きを埋めたまま先頭の欠損が埋まらず、送信が永久に止まる。これは実装後の相互運用試験（旧実装の送信側・新実装の受信側・読み手が遅い・損失あり）で見つかった欠陥で、修正した。順序外保持の重複も全バイトを数えるため、実際のメモリ量を超えない。
  - 既知の限界（実測）: 旧実装の送信側は、押し出されたセグメントを自分の再送タイムアウトの指数バックオフでしか再送しない。相互運用試験（1 MiB、読み手は 1.5 秒後に開始）は約 120 秒で完了した（停止はしない）。受信側で回避できる手段は無いため、仕様 §8.3.4 に記載する。
  - 送信側: 右端 `peerWindowEdge` は `ackNum + window` の最大値（`seqGt` で比較）として保持し、`flushSendBuffer` で `min(cwnd, maxWindowBytes, 右端 - nextSendSeqNum)` を超えて送らない。右端が後退しても無視する（送信側は既に送った分を取り消さない）。
  - 窓更新: 読み取りで空きが `min(MSS, maxRecvBufferBytes / 2)` 以上増えたら、ウィンドウ付き ACK を送る。
  - 問い合わせ: `retransmissionLoop` の既存タイマーで、右端で止まっている間だけ RTO 間隔に送る。
- **#61 / #67 との関係**: 変更は L4 のストリームだけ。ICE 候補・SDP の件数の扱い（§3.31・§3.32・§3.38）には触れない。
- **検証**: `tests/flow-control.test.mjs`。修正前は、遅い読み手のもとで受信バッファが送信量（2 MiB）まで伸びることを示す。修正後は上限以内に収まり、読み手が読み終えると全データが一致することを示す。加えて、窓更新が失われても進むこと、旧実装相手とのフォールバック、不正な相手（上限超過の DATA）の破棄を実行で確かめる。

### 3.40 リンクローカルのみのホストでは、node-datachannel の既定バインドをそのリンクローカルのアドレスに置き換える（#61 / サイクル24）

- **問題（実行で確認、サイクル24）**: この sandbox は `eth0` が `169.254.0.21/30` と `fe80::/64` のみ（非ループバックはすべてリンクローカル）。実 `node-datachannel` の 2 ノードを 1 プロセスで接続した結果（`/tmp/cy24/ndc_pair.mjs`）:

  | バインド | 候補（A / B） | DataChannel |
  | :--- | :--- | :--- |
  | 未指定（自動） | 0 / 0 | 開かない |
  | `0.0.0.0` | 0 / 0 | 開かない |
  | `127.0.0.1` | 1 / 1 | 開く（約 19 ms） |
  | `169.254.0.21` | 1 / 1 | 開く（約 21 ms） |

- **観測した原因（ライブラリのログ、`initLogger` の Verbose）**: 自動バインドでは libjuice が IPv6 ソケットを `any` に開き、`No local host candidates gathered` で候補 0 件になる。`0.0.0.0` では IPv4 ソケットを `any` に開き、同じく 0 件になる。明示バインドでは、開いたアドレス（`169.254.0.21`）がそのまま `Gathered host candidate` として出る。したがって、任意アドレスへのバインド時のインターフェース列挙が、リンクローカルのみのホストで候補を集めない。これは **ログからの推定**である。ネイティブのソース（libdatachannel / libjuice）は同梱されず、列挙がリンクローカルを除外する箇所は確認していない。上流への報告は、この観測を根拠に行う。
- **検討した方針**:
  - (a) 候補 0 件なら `127.0.0.1` へ再バインドする。却下。同一ホストでしか成立せず、リモートの相手では依然として失敗する。また収集後にオファーを作り直す必要があり、#67 と同じタイミングの問題を抱える（§3.32 の (a) と同じ理由）。
  - (b) 候補 0 件なら次のプロバイダへ切り替える。却下。既定の順序は `@roamhq/wrtc` → `node-datachannel` で、`node-datachannel` は最後である。`node-datachannel` が使われるのは `@roamhq/wrtc` が無いときだけで、その場合に次は無い。
  - (c) 警告と原因の表示のみ（0.8.1 の状態）。接続は成立しない。原因は示せても、利用者は設定を書き換えるまで使えない。
  - (d) **採用**: 非ループバックのアドレスがすべてリンクローカル IPv4 のホストに限り、`node-datachannel` の既定バインドをそのリンクローカル IPv4 アドレスへ置き換える。実行で、この候補が 1 件出て DataChannel が開くことを確認した（上表）。ルーティング可能なアドレスがあるホストは変えないため、#61 の懸念（既定の bind を変えると候補が減る実ネットワーク）を避けられる。`127.0.0.1` への固定は #61 で却下済み（既定のまま）。
- **判定規則**: 純関数 `chooseNodeDatachannelDefaultBindAddress(networkInterfaces)`（`nodeProvider.ts`）。入力は `os.networkInterfaces()` と同じ形。`internal` でないアドレスを集め、その中に 1 つでもリンクローカル以外（IPv4 は 169.254.0.0/16 以外、IPv6 は fe80::/10 以外）があれば `undefined`。すべてリンクローカルで、かつ IPv4 があれば最初の IPv4 を返す。IPv6 のリンクローカルだけのホストは対象外（`undefined`、従来の警告のまま）。
- **適用**: `createNodeNetwork()` で、解決されたプロバイダの名前が `node-datachannel` のときだけ。注入された factory（名前が無い）には適用しない。利用者が `peerConnectionOptions.bindAddress` を指定したときは、その値が常に優先される（`peerConnectionOptions` は既定の後にマージする）。適用したときは `info` ログに適用先を出す。
- **限界と未検証**:
  - ルーティング可能なアドレスがあるホストの挙動は、この変更では実行していない（この sandbox はリンクローカルのみ）。規則は「そのホストでは既定を変えない」であり、既定のままである。
  - IPv6 のリンクローカルのみのホストは対象外。
  - 上流（libjuice の列挙）の挙動そのものは直していない。Issue #61 は `Refs` とし、上流への報告文案を Issue に残す（Muse が確認してから外部へ起票する）。
- **検証**: 純関数の表形式テスト（偽の列挙）。実 `node-datachannel` の 2 ノードを `createNodeNetwork()` の既定（`peerConnectionOptions` なし）で接続するプローブ（子プロセス）で、修正前は接続が失敗し、修正後は接続が成功することを確認する。既存の `bridge-webrtc` は従来どおり `127.0.0.1` を指定する。

### 3.41 タブ停止・リロードへの耐性（M9 / #51）: 実行による調査と方式の選択（サイクル27）

- **依頼と前提の訂正**: 依頼では M8 を #51 とした。しかし M8 は #52（ブリッジ）で完了済みであり、#51 のうち永続化・稼働維持の補助は M7 で実装済みである（計画 §3.7）。このため本節は **M9** とし、#51 に残っている課題を扱う。M8 の行は変更しない。
- **調査環境**: Chromium 158（ヘッドレス）。Playwright の配布元（`cdn.playwright.dev`）へはこの sandbox から接続できないため、npm の `@sparticuz/chromium` に同梱されたバイナリを使った（ライブラリを足して起動）。実機のデスクトップ・モバイルのブラウザではない。WebTCP の実ブラウザ WebRTC（同一ブラウザ内の 2 タブ、`SignalingAdapterHub`）で測定した。

**測定（すべて実行。スクリプトは sandbox の `/tmp/cy27/`）**

| 項目 | 方法 | 結果 |
| :--- | :--- | :--- |
| 可視時のデータプレーン | サーバー・クライアントを別ウィンドウで接続し、1 秒ごとにエコー | 60 秒で 60 件、3 秒を超える欠落 0 件 |
| 非表示（最小化）7 分 | サーバー側のウィンドウだけを最小化。3 variant（keep-alive なし / Wake Lock / Wake Lock + 無音オーディオ）を同時に測定 | 3 variant とも 60 件/分、欠落 0 件。サーバー側のタイマーは 1 Hz のまま（420 tick / 420 秒） |
| 凍結（CDP `Page.setWebLifecycleState: frozen`）60 秒 | サーバー側を凍結 | 凍結中はエコーが止まる（526 のまま）。送信は続き（586）、解凍後 20 秒で 606 件 = 送信 606 件。ストリームは閉じない |
| Wake Lock（既定） | `navigator.wakeLock.request('screen')` | ヘッドレスの既定では `NotAllowedError`（権限が `denied`） |
| Wake Lock（権限付与後） | CDP `Browser.setPermission({ name: 'screen-wake-lock' })` で `granted` | 取得成功。最小化で UA が `released-by-ua`。前面復帰後、`startBrowserKeepAlive` が `acquired` を記録し `wakeLockActive` が真に戻る |
| 無音オーディオ | `AudioContext` をクリック内で作成 | `running`。非表示 7 分の間も `running` のまま（効果は測定できなかった：下記） |
| 無音オーディオ（ジェスチャー無し） | ページ読み込み直後に作成 / `--autoplay-policy=user-gesture-required` | どちらも `running`。このビルドでは自動再生ポリシーが効かず、**判定できなかった**（未検証） |
| Service Worker と Worker の RTC | `typeof RTCPeerConnection`（Service Worker / Dedicated Worker） | 両方とも `undefined`。`RTCDataChannel` と `WebSocket` は存在する |
| Service Worker の WebSocket | SW が hub へ WebSocket を開く。全ページを閉じて 150 秒待つ | 開いた直後は `readyState` 1。150 秒後、SW は再起動（`startedAt` が変わり `ticks` が 0）、WebSocket は失われていた |
| Service Worker から窓を開く | ページからのメッセージを受けた SW が `clients.openWindow()` | `Not allowed to open a window.` |
| 保存と復元（実 IndexedDB） | 名前とポートを保存 → リロード → 復元 → 別クライアントが接続 | 保存: `listenPorts [7002]`、名前 `persist.test`。リロード後の復元: 名前は `local` で解決、隣接 0。リロード後の 7002 への接続は `RST`（ハンドラ未付与） |

**読み取り**: 可視・非表示・凍結の 3 条件のうち、この環境で実際に止まったのは凍結だけだった。非表示で止まらなかったのは、ヘッドレス（最小化）では一般のデスクトップのタブで起きる長時間の間引き（intensive throttling）や破棄が再現されないためで、Keep-alive の効果の有無はこの環境では判定できない。この限界は仕様 §9.7 に書いた。

**方式の比較**

| 方式 | 判定 | 理由（測定） |
| :--- | :--- | :--- |
| データプレーンを Service Worker に置く | 却下 | `RTCPeerConnection` が無い（測定） |
| データプレーンを Dedicated Worker に置く | 却下 | 同上（測定） |
| Service Worker を常駐の監視役にする（WebSocket を保持） | 却下 | 150 秒の無操作で再起動し、WebSocket も失われた（測定）。再登録の起点としても信頼できない |
| Service Worker からウィンドウを開いて復帰させる | 却下 | ユーザー操作が無いと開けない（測定） |
| Wake Lock を、非表示のタブを稼働させる手段にする | 却下（補助に限る） | 非表示で UA が解放する（測定）。取得には権限が要る |
| 無音オーディオを保証された手段にする | 却下（任意・未検証） | 効果を測定できなかった。実機での検証が要る |
| **状態の永続化と復元（採用）** | 採用 | 名前・待ち受け・所有権は保存でき、リロード後も解決できた（測定）。接続は戻らないので、復元と再接続を分けて扱う |
| 前面復帰時の再接続（既存、§9.5） | 採用 | 既存の補助。実機での効果は未測定 |

**採用する設計（M9 の中心）**

1. **データプレーンは前面のページに置く。** 現在のまま変えない。Service Worker と Worker には RTC を置かない。
2. **状態は保存し、リロード後に復元する。** 保存対象は既存の `PersistedServiceState`（名前・待ち受けポート・所有権レコード）。接続と隣接は保存しない（既存の仕様どおり）。M9 で次を足す。
   - (a) **自動保存**: 名前・待ち受けを変えた後、`persistState()` を約 1 秒のデバウンスで呼ぶ（既存は `pagehide` と利用者の明示呼び出しのみ）。
   - (b) **ハンドラの再付与**: 復元と同時にポートへハンドラを付けられる形を候補とする（例: `restoreState({ nameServer, handlers })`）。測定のとおり、ハンドラの無いポートへの接続は RST になるため、再付与の手段が無いと復元の効果が半減する。API は項目 29 で確定した（§3.43）。
   - (c) **隣接の再確立**: 既知の隣接先 NodeId を別に保存し、復元後に `connectToPeer()` を試みる候補とする。**未測定**（2 ノード以上の実験が要る）。
3. **前面復帰時の再接続**（既存 §9.5）と **Wake Lock の取り直し**（既存）は続ける。Wake Lock は画面スリープの抑制に限った補助と位置づけ、非表示の稼働の根拠にしない。
4. **無音オーディオ**: 既定は無効のまま。M9 の後続で、AudioContext の生成をユーザー操作の中に限り、`resume()` を呼ぶ変更を候補とする。有効化の判断は、実機の自動再生ポリシー下の状態を測ってから行う。
5. **Service Worker**: 静的資産の配信に限る（任意）。常駐・RTC・窓を開く役は持たせない。

**未解決（M9 の後続で測る）**

- 実機のデスクトップ・モバイルでの長時間の非表示（intensive throttling、凍結、破棄）。
- 無音オーディオの自動再生ポリシー下での状態（この環境では判定できなかった）。
- リロード後に、リモートのノードから名前が解決されるか（2 ノード以上）。
- 隣接の再確立（(c)）の有効性。

### 3.42 自動保存（M9 項目 28）: 既定の時間、呼び出し順、検証（サイクル28）

- **方式**: 変更の検知は既存の `EventEmitter` の仕組みに載せた。`TransportLayer` は `listening-changed`（`listen` / `unlisten` の後）を出し、`NameServer` は `onChange(listener)`（ローカル登録の成功時のみ。`restoreState()` は通知しない）を持つ。`WebTCPNetwork.enableAutoPersist()` が両方を購読し、スケジューラ（`core/persistence/AutoPersist.ts`）へ `notify()` を渡す。スケジューラは保存関数 `persistState()` を直列に呼ぶ。
- **既定値の根拠**（実測: Chromium 158、IndexedDB、200 回ずつ、p50 / p95 ms）:

| 名前の数 | p50 | p95 | 最大 |
| ---: | ---: | ---: | ---: |
| 1 | 0.30 | 0.40 | 4.4 |
| 10 | 0.40 | 0.50 | 2.3 |
| 100 | 0.40 | 0.50 | 2.3 |
| 500 | 0.50 | 0.70 | 3.5 |
| 1000 | 0.80 | 1.00 | 3.6 |

  - `debounceMs = 500`: 名前 1000 件の保存の p95 は 1 ms なので、変更が 1 秒に 1 回の最悪の場合でも保存の占有は約 0.2% に収まる。一方、ポートや名前の登録の連続（例: 11 件の登録と `listen` が 1 件）は 1 回の保存にまとまる（検証で 1 回を確認）。
  - `maxWaitMs = 5000`: 変更が途切れない場合でも、強制終了で失われる変更の上限を 5 秒にする。
  - 100 ms にすると、100 ms ごとに変更が続く場合（例: 連続した登録）、保存が毎回走る。最悪の占有は 1 ms / 100 ms ≈ 1% になる。500 ms なら約 0.2%。デバウンスの目的は保存回数と占有を抑えることにあるため、500 ms を選んだ。
- **退けた案**: (a) 変更のたびに保存（デバウンスなし）: 保存回数が増え、失敗の扱いが複雑になる。(b) `pagehide` だけで保存: 強制終了・クラッシュでは発火しない（§3.41 の測定と同じ理由で不十分）。(c) Service Worker のタイマーで保存: Service Worker は無操作で再起動し、ページの状態を持たないため不可（§3.41）。
- **呼び出し順（テストで見つけた不具合の修正）**: 当初は `enableAutoPersist()` の時点で 1 回保存していた。その結果、復元より前に有効化すると、空の状態が保存済みの状態を上書きした（再現: `restoreState()` の後に名前が 0 件）。修正として、有効化だけでは保存しないようにし、仕様 §9.8 で「`restoreState()` の後に `enableAutoPersist()`」を定めた。回帰テスト「enabling before restoreState would clobber」と「auto-persist: listen/unlisten and NameServer changes…」で確認する。
- **`close()` の保存**: `scheduler.stop()` は、トランスポートを閉じる前に保存を同期的に開始する。`persistState()` は `listenPorts` と名前の出力を最初の `await` より前に取り込むため、閉じた後の状態は含まない。テスト「close() saves pending changes before transports close」で、60 秒のデバウンス中でも `close()` の後に保存されることを確認する。
- **失敗**: 保存の失敗は変更を未保存に戻し、`debounceMs` 後に再試行する。失敗を `listen()` へ伝えない（テスト「a save failure is logged」）。
- **実ブラウザの検証**（`examples/verify-persistence-browser.mjs`、ページ `examples/verify-persistence/index.html`）: 書き込みページで `restoreState` → `enableAutoPersist` → 登録と `listen`（`persistState` も `close` も呼ばない）。IndexedDB に保存されたことを確認したうえで、ページを遷移させて読み込みページで復元する。結果: 9/9 合格。`enableAutoPersist` を外した版では 7 件が不合格になる（before / after）。
- **保存される内容の制限**: 復元されるのは名前・所有権レコード・待ち受けポートの一覧のみ。アプリのポートの再待ち受けは行わない（ハンドラの再付与は項目 29）。
- **公開 API の追加**: `enableAutoPersist`、`NameServer.onChange`、`createAutoPersistScheduler`、`AUTO_PERSIST_DEBOUNCE_MS` / `AUTO_PERSIST_MAX_WAIT_MS`。既存の公開 API は変えない。
- **残る課題**: 保存のタイミングは、実機の省電力下での挙動は未測定。項目 30 の隣接の保存は未着手。

### 3.43 ハンドラの再付与（M9 項目 29）: API の選択と実行による検証（サイクル29）

- **問題**: リロード後、`restoreState()` は保存された待ち受けポートを戻すが、ハンドラは戻さない。ハンドラの無いポートへの SYN は RST で拒否される（`TransportLayer.handleSynRequest`）。付け直すのが利用者のコードであるため、利用者が `restoreState()` の後で `listen()` するまでの間、そのポートへの接続は失敗する。
- **選択した API**: `restoreState({ nameServer?, handlers? })`。`handlers` は保存済みのポート番号をキーにした `Map` または `{ 7002: handler }`。`handlers` のあるポートは、`restoreState()` の中で `listen()` する。戻り値は `listeningPorts`（付けたポート）と `unhandledPorts`（付けなかったポート）を返す。
- **選んだ理由**: 復元とハンドラの付与を 1 つの呼び出しにまとめると、利用者のコードが戻り値を受け取るまでの間に生じる窓が無くなる。既存の `listen()` は残すので、後から付ける場合はそのまま使える（後方互換）。
- **退けた案**:
  - (a) 復元後に `attachRestoredHandler(port, handler)` を別に呼ぶ: 呼び忘れと呼ぶ順序の問題が残る。
  - (b) `onRestoredPort(port) => handler` のコールバック: 戻り値の `unhandledPorts` で十分に表せるため、間接化の利点が無い。
  - (c) 復元時にハンドラを自動で生成する（既定のエコー等）: アプリの振る舞いを勝手に決めるため不可。
- **検証の設計**: 実ブラウザで 2 ノード（別々のブラウザコンテキスト、別の鍵・別の IndexedDB）。接続は実 WebRTC で、シグナリングはデモサーバーのハブ（`SignalingAdapterHub`）。サーバーのページは同じページを遷移（＝再読み込み）させ、旧ページの JS と接続は破棄される。クライアントは毎回新しいページで接続を繰り返し、最初に成功するまで（最長 30〜40 秒）待つ。すべての失敗を記録し、RST の件数を数える。
  - 基準: リロード前に 7002 のエコーが届く。
  - 対照（修正前の使い方）: ハンドラ無しで復元し、15 秒後に `listen()` する。
  - 修正: `restoreState({ handlers })`。
- **結果**（`examples/verify-reconnect-browser.mjs`、3 回実行。すべて合格）:

| 手順 | 3 回の結果 |
| :--- | :--- |
| 基準（リロード前） | 最初の成功 70 ms〜130 ms（1 回だけ 15.4 秒。ICE とシグナリングの待ち） |
| 対照（ハンドラを 15 秒後に付ける） | 試行 50 回（うち RST 49 回）。最初の成功は 14.9〜15.0 秒（`listen()` の後）。`restoreState()` の戻り値では 7002 は `unhandledPorts` |
| 修正（`handlers` を渡す） | 戻り値の時点で 7002 が待ち受け中。試行 1 回で成功（71〜128 ms）、RST 0 回 |

- **Node の検証**（`tests/restore-handlers.test.mjs`、5 件合格）: 戻り値の時点で待ち受けていて、ピアがすぐにエコーを受け取る（RST 無し）。ハンドラ無しは `unhandledPorts` に入り、接続は `Connection reset by remote peer (RST)` で拒否される。`Map` 形式、保存されていないポートのハンドラは無視される。既に待ち受け中のポートは、何も待ち受けずに失敗する。不正なハンドラは、何も待ち受けずに失敗する。
- **限界（検証していないこと）**:
  - クライアントは各試行でページを新しくしている。生き続けているクライアントが、サーバーのリロード後に古い経路を持ったままになる場合（隣接の切断の検出に依存する）は検証していない。項目 30（隣接の再確立）で扱う。
  - 復元より前（ページの起動直後）に届く接続は、ページが動いていないため対象外である。
  - 試験は headless Chromium。実機の省電力下での挙動は未測定（項目 31）。

### 3.44 保存済み隣接の再接続（M9 項目 30 / #51）: 保存する情報の最小化と実行による検証（サイクル30）

- **問題**: 項目 28・29 で状態とハンドラは戻るが、隣接（どのノードと接続していたか）は戻らない。利用者が相手の NodeId を覚えていない限り、リロード後のノードは孤立する。
- **保存する情報**: `PersistedServiceState.neighbors?: NodeId[]`（任意、`version` は 1 のまま）。保存時点で接続中の隣接の NodeId だけ。上限 16 件（`MAX_SAVED_NEIGHBORS`）、自分自身は除く、重複は除く。
  - 含めない: 鍵（§11.5 の鍵管理が担う）、アドレス（古くなる。接続時にシグナリングから得る）、時刻（接続の鮮度は接続そのものが示す）。
  - `version` を上げない: 旧形式の状態は `neighbors` が無いため、隣接なしとして読める（後方互換）。
- **再接続の API**: `restoreState()` は `neighbors` を返すだけで接続しない。接続は `reconnectNeighbors(neighbors, options)` で利用者が呼ぶ。
  - 理由: 接続の開始時点を利用者が決められる。ハンドラ（§3.43）より前に接続が走ると RST になりうるため、自動接続は退けた。
  - 内部では既存の `bootstrap()` を使う（指数バックオフ、既定 3 回）。新しい再試行の仕組みは作らない。
- **自動保存との関係**: 隣接の接続・切断は自動保存（§3.42）の変更として扱う。有効化の後は、利用者が `persistState()` を呼ばなくても隣接が保存される。
- **退けた案**:
  - (a) 隣接のアドレスも保存する: 古いアドレスで接続を試みることになり、利得が無い。
  - (b) 復元時に自動で接続する: 上記の理由で退けた。
  - (c) 別のストアに隣接を保存する: 状態の一貫性（同じ `nodeId` の検査、同じ保存単位）が崩れるため、既存の状態に含めた。
- **検証**:
  - Node（`tests/neighbor-restore.test.mjs`、6 件）: 再起動後の再接続とエコー、隣接なしの対照、オフラインのピアで有限の失敗（`attempts` 2、例外なし）、不正 ID と自分自身の除外、自動保存（明示の `persistState()` 無し）、解析の規則。
  - 実ブラウザ（`examples/verify-neighbors-browser.mjs`、Chromium 158、2 ノード）: 2 回実行し、両方合格。
    - 再接続: 1 回の試行で成功（57 ms、112 ms）。リロード後のエコー `after-reload` が届く。
    - 対照（隣接を保存していない状態）: 復元された隣接 0 件、3 秒後も 0 件。手動で NodeId を指定すれば接続できる。
    - ピアの側: 接続 → 切断（ノードのリロードによる旧リンクの破棄）→ 再接続の順で記録された。ピアが切断を検出したのは、ノードのナビゲーション開始から約 10 ms 後だった。
- **限界（検証していないこと）**:
  - LoopbackNetwork では、ピア側に残る古いリンクを再現できない。そのため Node の試験でこの経路（生き続けたピアの古いリンク）は証明していない。ピア側の切断検出は、実ブラウザ（同一オリジンの遷移）でのみ観測した。
  - 実ブラウザの検証は同一オリジンのページ遷移であり、バックグラウンド化・省電力による凍結・タブの破棄は再現していない（項目 31 の実機確認と、§9.7 の調査の範囲）。
  - 試験環境は sandbox に入れた Chromium 158 である。利用者の端末での実測ではない。
  - 初回接続が約 15 秒止まり、タイムアウトで失敗することがある（#92、`main` でも再現、原因は未確定）。このサイクルの試行では、再接続の試行は 1 回で成功したが、失敗率は測っていない（再接続の試行は合計 2 回の実行のみ）。
  - ピア側で `neighbor-connected` が 1 回の接続で 2 回発火することがある（#93、`main` でも再現）。自動保存は debounce で合流するため、保存結果には影響しない。

### 3.45 リロード後の名前の解決（M9 項目 32 / #51）: 検証の方法、結果、#51 のクローズ判断（サイクル31）

- **問題**: 項目 28〜30 で、名前・待ち受け・隣接は戻るようになった。しかし、他のノードがリロード後に名前で解決・接続できるかは未測定だった（§3.41 の未解決）。
- **検証の設計**:
  - 実ブラウザ（`examples/verify-name-reload-browser.mjs`、ページ `examples/verify-name-reload/index.html`）: 2 ノード（別の鍵・別の IndexedDB）。解決する側（client）は再読み込みしない。保持者（owner）は名前 `svc.test` を登録し、client へ接続して保存する。
  - 成功の定義: リモートの問い合わせで解決され（毎回 `clearCache()` の後）、解決先が owner の NodeId と一致し、7002 でエコーが届くこと。キャッシュからの解決は成功に数えない。
  - 切断の時刻は、client が `neighbor-disconnected` を受けた時刻で測る（ページ遷移の開始時刻ではない）。「リロード直後」は、この切断以後の試行とする。
  - 対照: 保持者の再読み込みは 2 通り（`reconnectNeighbors()` あり / なし）。同じ保存状態から復元する。
  - Node（`tests/name-after-restore.test.mjs`、2 件）: 保持者を再起動し、名前が復元され、`reconnectNeighbors()` の後に別ノードが解決・エコーできること（主経路）。再接続しない場合は解決できないこと（対照）。
- **結果**: 仕様 §9.10 の表のとおり（3 回実行、すべての確認が合格）。要点は次のとおり。
  - 解決できない期間は、切断から最初の成功までの約 0.39〜0.40 秒だった。この長さは、再接続の完了（遷移開始から 230〜310 ms）と試行間隔（250 ms）で決まる。
  - 再接続しない対照では、15 秒間に一度も解決されなかった。保存された名前は、隣接が戻るまでは解決の根拠にならない。
- **退けた案**:
  - (a) 保持者が復元時に名前を告知（push）する: 未要求の登録を隣接へ push しない規定（§9.4、MUST NOT）に反する。
  - (b) キャッシュの古い答えで解決を代替する: 保持者の不在を隠すため、解決の成否の判定を壊す。検証ではキャッシュを毎回消した。
  - (c) 解決する側の自動再接続: 今回は実装しない。保持者の再接続だけで、解決できることを測定したため。解決する側が保持者の NodeId を覚えている場合の再接続は、未検証の候補として残す。
- **限界**: §9.10 の限界に加えて、次を記録する。
  - 検証は同一オリジンの遷移による。実機での長時間の非表示は、項目 31 と §9.7 の範囲で未了である。
  - 解決の結果は TTL の間キャッシュされる（コードの読み取り。実測はしていない）。古い答えが返る期間の長さは、TTL（既定 60 秒）で決まる。
- **#51 のクローズ判断（閉じない）**:
  - #51 の課題は「タブ停止・リロードに耐えるサービス継続」である。リロード後の状態の回復（項目 28〜30）と、名前での再解決（本項目）は、同一オリジンの遷移で実測した。
  - しかし、実機での長時間の非表示・凍結・破棄の下での挙動は、項目 31（無音オーディオ）を含めて未測定である（§9.7）。この部分は #51 の課題の中心であり、未了のまま閉じると、残りの課題が追跡されなくなる。
  - 初回接続の 15 秒停止（#92）は、再接続の信頼性に関わるため、解決まで追跡する。
  - よって、#51 は M9 の完了まで開いたままとする（クローズはマージ時に Muse が判断する）。

### 3.46 応答側の DTLS identity 未準備による接続失敗（#92 / #97）: 実行による測定と修正の方式（サイクル33）

- **問題**: 負荷の高いときに、応答側の `setRemoteDescription` / `createAnswer` / `setLocalDescription` が `Fingerprint provided but no identity available` で失敗する。応答が送られないため、発信側は `connectTimeoutMs`（15 000 ms）の満了まで待つ（#92、§3.42 の調査と同じ環境）。原因の切り分けは PR #98 と #92 のコメントに記録した。
- **測定 1（同じ接続の再試行は回復しない）**: 応答側の `createAnswer` / `setLocalDescription` を identity の失敗時だけ再試行した。25 ms × n（合計 約 0.4 秒）では 3/160 が失敗し、回復は 0 回。50 ms 間隔・合計 4 秒まででも 5/160 が失敗し、再試行 395 回の回復は 0 回。identity は遅れて届くのではなく、その接続では届かない。
- **測定 2（直ちに作り直しても失敗する）**: 失敗したら同じ offer で新しい接続を直ちに作り直した（負荷: `PARALLEL=8 N=20 POLL=50`）。作り直しは 4 回発生し、4 回とも同じ identity 失敗で、いずれもタイムアウトした。作り直しは約 10 ms 後に、同じ条件で失敗する。
- **測定 3（1 秒待ってから作り直すと回復する）**: 同じ条件で、作り直しの前に 1 000 ms 待った（最大 3 回）。作り直しは 12 回発生し、12 回すべてが回復した。タイムアウトは 0/160、最長は 1 655 ms、p50 は 345 ms。identity の失敗は、作成の瞬間の状態による一時的なもので、同じ接続には残るが、後で作った接続には届く。
- **比較**: 測定 1（同じ接続）は回復しない。測定 2（直ちに作り直す）も回復しない。測定 3（1 秒待ってから作り直す）は回復する。作り直しは、待ちを入れたときにだけ効く。
- **検討して採らなかった方式**:
  - 証明書の事前生成（`generateCertificate()` を接続前に行い、`certificates` に渡す）: 8/160 から 4/160 に減るだけで、0 にならない。単独では採らない。
  - 同じ接続の再試行（測定 1）: 回復しない。
  - 作り直しを待ちなしで行う（測定 2）: 回復しない。
  - 待ちを延ばす（4 秒など）: 同じ接続では回復しなかったため、長く待つ根拠がない。1 秒で回復し、15 秒の枠内に 3 回が収まる。
- **採用する方式**: 応答側で、identity の無い失敗のときだけ、接続を破棄して 1 000 ms 待ち、同じ offer で新しい接続を作る。作り直しは最大 3 回。適用済みの ICE 候補は新しい接続へ渡す。接続待ちの Promise は引き継ぐ。仕様は §10.3 の 7。
- **影響範囲**: `WebRTCChannel.handleOffer` の初回 offer の経路（既存の接続がない場合）。`flushCandidates` が、適用した候補を返すようにした。再ネゴシエーション（ICE 再起動）と glare の経路は変更しない（既存の接続は identity を持つため、この失敗は起きない）。発信側（`startOffer`）の identity 失敗は、これまでの計測では起きていないため、対象外とする。
- **互換**: `NodeWebRTCChannel` の `createPeerConnection` オプションは変えない。再試行の判定は、エラーメッセージの `no identity available` で行う（Node の `node-datachannel` でも同じ文言かは、このサイクルでは未確認。Node の回帰テストは fake 接続で、失敗の注入を再現する）。
- **限界**: 1 秒の待ちと 3 回の上限は、この環境（2 コア、Chromium 158、8 並列）での測定に基づく。他の端末では最適な値が違う可能性がある。作り直しで接続が遅れる（約 1 秒ごと）。実機での再現率は未測定。
- **検証（実行）**:
  - 再現条件（`PARALLEL=8 N=20 POLL=50`、320 試行、修正後）: タイムアウト 0、identity 失敗 0。作り直しは 11 回発生し、11 回すべて接続できた。p50 322 ms、p99 1 278 ms、最長 1 369 ms。
  - 負荷なし（`PARALLEL=1 N=40 POLL=50`）: タイムアウト 0、p50 57 ms。作り直しは 2 回発生し、2 回とも接続できた（最長 1 067 ms）。負荷なしでも、まれに identity の失敗が起きることを示す。修正前の負荷なしの 0 件（70 試行）は、まれな事象の標本が小さかったためである。
  - Node（`tests/webrtc-identity-rebuild.test.mjs`、3 件）: 修正前の `main` では 2 件が失敗し、修正後は合格する（identity の失敗 1 回で接続できること、上限 3 回で止まること）。identity 以外の失敗は作り直さない（この件は修正前も合格し、過剰な再試行が無いことを守る）。
  - `npm test`: 345 件、336 合格、0 失敗、9 スキップ（既存のスキップと同じ）。`tsc --noEmit` は 0。

### 3.47 `neighbor-connected` の重複発火（#93）: 再現、原因、修正（サイクル34）

- **問題**: 1 回の接続で `neighbor-connected` が 2 回発火することがある（Issue #93）。直接の機能破壊は確認していないが、「1 接続 1 イベント」の契約と異なる。
- **再現（実行、`main` `e84c1fb`、Chromium 158、1 プロセス・30 試行）**: `examples/probe-neighbor-connected/run.mjs`。応答側（peer）で 2/30 が重複（`neighbor-connected` が 2 回）。発信側（node）は 0/30。
- **計測（重複した試行のトレース）**: 応答側の同じ `RTCPeerConnection` で、同じリモートのデータチャネルの `open` イベントが 2 回、3 ms の間隔で届いた。ライブラリのログには `Neighbor connected` が 2 回出ている。発信側は `open` が 1 回だった。`datachannel` イベントは 1 回だけなので、チャネルは重複していない。同じチャネルの `open` が重複して通知されている。
- **原因（計測と読み取り）**: `WebRTCChannel.attachDataChannel` の `dataChannel.onopen` は、状態が現在のものかだけを確かめ、一度開いたかを確かめない。そのため、2 回目の `open` で `connection-status(true)` を再び発火し、`LinkManager` が `neighbor-connected` を再び発火する。どのブラウザ実装が重複させるかは、このサイクルでは特定していない（Chromium 158 で観測）。
- **採用する修正**: `onopen` の先頭で `state.opened` を確かめ、既に開いていれば何もしない（一度だけ処理する）。`opened` は `false` から `true` へ一度だけ変わる。切断は `destroyPeer` で状態ごと破棄されるため、同じ状態が再び開くことはない。したがって、この保護で正当な再開が妨げられることはない。
- **採らなかった方式**:
  - `LinkManager` で接続状態の重複を除く: 上流で二重に発火しているため、利用者に届く前に隠すだけになる。`connection-status` の契約が崩れたまま残る。
  - 利用者側で `neighbor-connected` を数えない: 契約（1 接続 1 イベント）を守らない。
- **互換**: 公開 API は変えない。`connection-status` の発火は、接続ごとに 1 回になる（仕様 §10.3 の 4）。
- **検証**: 修正前は再現ドライバで 2/30（重複）。修正後は同じ条件で重複 0。ネガティブコントロールとして、修正後もトレース上の重複 `open` は観測されることを確認する（ブラウザの挙動は変わらず、ライブラリ側で無視していることの証拠）。Node の回帰テストで、同じ `open` が 2 回届いても `connection-status(true)` は 1 回であることを確認する。

### 3.48 セッション境界を跨ぐ `SYN` のリプレイ検知（#48）: 方式の選択と検証計画（サイクル36）

- **問題**: 署名付きパケットは有効期限を持たない。`TransportLayer.handleIncomingPacket` は既存セッションに
  一致しない `SYN` を受けると新しい受動セッションを作り、待ち受けハンドラを再び呼ぶ。捕獲した v2 の `SYN` を
  別セッションへ注入すると、アプリケーションに二重の接続が届く。
- **調査で分かったこと（コード）**:
  - ISN はセッションごとに乱数（`VirtualStream` の `initialSendSeqNum`）。捕獲した `DATA` / `FIN` は、
    新しいセッションの受信窓に入らないため既に受理されない。危険なのは `SYN` だけである。
  - `SYN` のペイロードは `handleSyn` が読まない。署名対象には含まれる（署名は直列化済みパケット全体）。
    したがって、ヘッダーを変えずにペイロードへ拡張を載せられる。
  - `SYN` の生成は `initiateConnection()` の 1 箇所（`createPacket('SYN', …)`）。
- **採った方式**: `SYN` のペイロードに 28 バイトの拡張（`WSN1` + 送信時刻 ms + 16 バイト乱数 Nonce）を載せる。
  受信側は既存セッションに一致しない `SYN` について、時刻の窓（±300 秒）と `(senderId, nonce)` の
  受理済み記録（300 秒保持、上限 4096 件、満杯は fail-closed）で検査する。拒否は無言の破棄。
- **採らなかった方式**:
  - **ヘッダーの拡張（v3）**: 24 バイトのヘッダーを変えると、v1 / v2 ノードと互換を失う。issue も
    「拡張は negotiated / capability 宣言」を求めている。
  - **全パケットへの Nonce 付与**: 検査は `SYN` だけで足りる（上記）。全パケットに載せると、
    帯域と検証のコストが増え、効果も増えない。
  - **`DATA` / `FIN` の署名へのセッション Nonce の織り込み**: ISN の乱数化で既に防げているため不要。
    ただし ISN の乱数化が将来失われた場合は、この検証の不在がそのまま露出する点を残余リスクとする。
  - **`SYN` の受理に RST で応答する**: 攻撃者に拒否の理由を教えるため採らない。
- **互換性**: 送信側は拡張付きの `SYN` を送る。旧受信側はペイロードを無視するため動作は変わらない。
  旧送信側の `SYN`（空ペイロード）は `allowLegacySyn`（既定 true）で受理する。したがって旧実装との接続は
  維持される。その代わり旧実装からの `SYN` の再生は防げない（仕様 §11.6 の限界）。`allowLegacySyn: false` で
  拡張のない `SYN` を拒否できる（新しい実装だけの網で使う）。
- **既定値の根拠**: 時刻の窓 300 秒は `SessionManager` の既定の session timeout と揃える。
  記録の上限 4096 件は、300 秒間に 1 ノードが開く新規セッション数の十分な余裕を見込んだ値。
- **検証計画（実行で確かめる）**:
  1. 回帰テスト `tests/syn-replay.test.mjs`: 2 つの署名付きノードで接続し、A→B の `SYN` の生バイト列を
     リンク層で捕獲する。セッションを閉じた後、同じバイト列を B のリンク層へ注入する。
     修正前は B のハンドラが 2 回呼ばれ（再生が通る）、修正後は 1 回（再生が拒否される）ことを確かめる。
     修正前後で結果が変わる点がこの issue の受け入れ条件である。
  2. 拡張の単体試験: 窓外の時刻、同じ Nonce の再送、magic の不一致、上限到達、拡張なしの `allowLegacySyn` 切り替え。
  3. 互換性: 旧実装の `SYN`（空ペイロード）の受理。既存の `npm test` が全て通ること。
  4. 能力の宣言: 受信側は拡張を読む前に、ペイロード長で旧 `SYN` と区別する。
- **実行結果（サイクル36）**:
  - 修正前（`main` の `TransportLayer` / `VirtualStream`、拡張なし）: 回帰テストは「再生で B のハンドラが 2 回目に呼ばれる」（期待 1、実際 2）で失敗した。ログは `/tmp/cy36/before-syn-replay.log`。捕獲したバイト列（SYN, ACK, DATA）は署名検証を通り、再生はアプリケーションに届いていた。
  - 修正後: 回帰テスト 1 件、単体試験 11 件が合格。`syn-replay.test.mjs` は 20 回連続で合格（20/20）。
  - `npm test`: 359 合格、0 失敗、0 スキップ（サイクル34 の 347 件から、本件の 12 件が増えた）。`npx tsc --noEmit` 合格。
  - 残余リスク: 旧実装の `SYN` の再生（`allowLegacySyn` 既定 true のため）、受理済み記録の上限到達時の正規 `SYN` の拒否。
