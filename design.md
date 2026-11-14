# WebTCP 設計書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.4.0 |
| 対応仕様 | `specification.md` 0.4.0 / プロトコル v2（v1 後方互換） |
| 最終更新 | 2026-11-14 |

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
│   ├── server.mjs        # 静的配信 + シグナリングハブ + エントランス探索
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
    │   │   ├── naming/                  # M4 / #25
    │   │   │   ├── url.ts               # parseWebTCPUrl / formatWebTCPUrl
    │   │   │   ├── NameServer.ts        # A/CNAME・キャッシュ・問い合わせサービス
    │   │   │   └── index.ts
    │   │   └── network/
    │   │       ├── WebTCPNetwork.ts     # listen / connect / connectURL / bootstrap
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
    │       └── entrance-searcher/
    │           ├── IEntranceSearcher.ts      # core/link からの re-export
    │           ├── EntranceSearcherAdapterHub.ts
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

距離ベクトル収束前に最初のパケットが落ちないよう、経路未学習かつ直接隣接からの受信を許可している。本格なマルチホップ強化は M5 以降。M4 では RT_UPDATE 自体を直接隣接・sender 一致・正 TTL に限定する。
なお署名検証（§10.2）は RPF より前に行うため、RPF の緩和がなりすましを許すことはない。

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
「送信元が 1 度だけ署名し、中継ノードは再署名しない」モデルを成立させている（`specification.md` §10.3）。
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

**公開鍵の配布**は 2 経路の併用とした（`specification.md` §10.4）。

1. **シグナリング時の交換**: `WebRTCChannel` が DataChannel open 直後に `public-key` メッセージを送る。
   直接の隣接とは `RT_UPDATE` を待たずに検証を始められる。
2. **`RT_UPDATE` への同梱**: `RoutingTableManager.createRoutingInfoPacket()` に `publicKey` を加え、
   マルチホップの中継ノードへも伝播させる。

受信側は `KeyDirectory` に登録する前に **必ず指紋一致を検証**する。配布経路（ハブ・中継ノード）が
信頼できなくても、指紋が一致しない鍵は登録しない。このため「分散ストレージに置く」方式も
`IPublicKeyResolver` の差し替えだけで同じ安全性で導入できる（M5 以降）。

**初回パケットの取りこぼし対策**。隣接確立直後は公開鍵がまだ届いていないことがあるため、
`Ed25519PacketVerifier` は未知の署名者について `keyWaitTimeoutMs`（既定 5000 ms）だけ
`KeyDirectory.waitForPublicKey()` で待機してから検証する。`RT_UPDATE` は同梱鍵で自己証明できるため、
典型的なケースでは待機は発生しない。

**バージョンの決め方**。シリアライザは「`signature` が 64 バイトなら v2、空なら v1」で送信バージョンを決める。
`WebTCPNetwork` に `keyManager`（または `Ed25519PacketVerifier`）を渡すと署名必須（`requireSignatures: true`）になり、
渡さなければ v1 後方互換モードで動く。受信側は v1 / v2 の両方をデシリアライズできる。

### 3.18 NameServer と `webtcp://` URL（M4 / #25）

**配置**: `core/naming` は L7 アプリケーション層サービスとして `WebTCPNetwork` の公開 API のみに依存する。L3/L4 へ名前を漏らさない。新しいワイヤーフラグは追加せず、既存の署名付き `VirtualStream` 上で JSON 要求/応答を運ぶ。これにより v2 のセキュリティ境界をそのまま利用する。

**解決モデル**: ローカル登録を権威データとし、クライアント側で反復解決する。サーバーはローカル登録のみを返し、他ノードへ再帰問い合わせしない。問い合わせ先は明示リゾルバ、隣接、経路表宛先から重複除外で選ぶ。CNAME はクライアントが最大 8 段辿り、訪問済み名前で拒否する。ノード間再帰を使わないため問い合わせ増幅とループを抑える。

**キャッシュ**: 名前ごとの A/CNAME レコードを TTL 付きで保持し、最大 1024 件。ローカル登録が常に優先。リモートの名前応答は所有権証明ではないため、グローバルな名前衝突解決は M5 の `domain.global` / ブロックチェーンに委ねる。

**URL**: `URL` コンストラクタは非特殊スキームのホスト/ポート解釈が環境依存になるため、`webtcp://` は明示的な正規表現と検証でパースする。ポートは必須、パス省略時は `/`。`connectURL()` は名前なら NameServer、NodeId なら直接 `connect()` へ振り分ける。パス/クエリ/フラグメントは接続先ルーティングには使わずアプリケーションへ返す。

**並行性と終了**: 問い合わせは全体デッドラインとノード単位タイムアウトを持ち、AbortSignal で中断できる。ストリームはタイムアウト・中断・不正応答時に `destroy()` する。NameServer.close() は自身の listen ハンドラと問い合わせを停止し、ネットワークは閉じない。

### 3.19 永続 NodeId と衝突検出（M4 / #36）

- ブラウザ: IndexedDB 復元時に公開鍵指紋だけでなく、秘密鍵で署名したチャレンジを公開鍵で検証する。壊れた身元は黙って使わず再生成。`expectedNodeId` 不一致は `NodeIdCollisionError`。
- Node.js: `NodeKeyManager.open({ keyFile })` は既存 PEM を復元、無ければ生成して `0600` で原子的に保存する。競合作成時は既存ファイルを読み直す。秘密鍵をネットワークやログへ出さない。
- `KeyDirectory.setPublicKey()` は後方互換の同期 API だが、既存鍵と異なる場合は `NodeIdCollisionError` で拒否する。非同期経路は従来どおり `false`。
- `WebTCPNetwork` はローカル鍵とディレクトリ内の既存鍵の衝突を起動前に検出する。

### 3.20 RT_UPDATE の信頼境界と鍵伝播（M4 / #37）

`RT_UPDATE` は直接隣接からのみ、外側 sender・payload sender・受信元が一致し、外側 destination が自ノードで、正の TTL・制御ポート 0 の場合のみ受理する。中継しない。`entries[].publicKey` に既知鍵を同梱して経路と一緒に伝播し、受信側は各鍵の指紋を検証して `KeyDirectory` へ登録する。これにより事前鍵共有なしのマルチホップ v2 通信を可能にする。送信側は `entries` / `withdrawals` を各 256 件以内的 `RT_UPDATE` に分割する。

## 4. クラス責務

| クラス | 責務 | 依存 |
| :--- | :--- | :--- |
| `WebTCPNetwork` | 層の組み立て、公開 API（`listen`/`connect`/`connectURL`/`bootstrap`）、ロガー伝播 | 全層 |
| `NameServer` | A/CNAME ローカル登録、TTL キャッシュ、既知ノードへの反復問い合わせ | `WebTCPNetwork`, `Logger` |
| `parseWebTCPUrl` / `formatWebTCPUrl` | `webtcp://` の厳格パースと正規整形 | `NodeId` 検証 |
| `NodeIdentityStorage` | Node.js 秘密鍵 PEM の 0600 永続化・原子的作成 | `node:fs/promises` |
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

## 8. テスト戦略

- **ユニット**: シリアライザ（不正フラグ・v1/v2 の長さ制約を含む）、NodeId 指紋導出、Base64url コーデック、
  Ed25519 署名/検証（改ざん・なりすまし・TTL 正規化）、`KeyDirectory` の指紋照合、RFC 1982 算術、SACK コーデック、
  RFC 6298 `RttEstimator`、ロガーレベル制御。
- **統合（LoopbackChannel）**: 2 ノード E2E、ランダム ISN & 32 ビットラップアラウンド、160 KiB 自動分割・再結合、部分読み取り（`read` / `readExact`）、損失チャネルでの 3 重複 ACK Fast Retransmit + SACK、RTO タイムアウトと `cwnd` 縮小、Half-Close（`CLOSE_WAIT` 中の送信継続 / `allowHalfOpen: false` / 順序外 `FIN`）、3 ノードマルチホップ転送、経路撤回、`RT_UPDATE` の `lastSeen` 更新、TTL=1 境界、`bootstrap()` リトライと指数バックオフ。
- **署名付きネットワーク（#28）**: 2 ノード v2 E2E、署名欠落パケットの拒否、リンク上での改ざん注入の破棄、
  3 ノードマルチホップでの各ホップ検証、`RT_UPDATE` による公開鍵配布。
- **鍵管理アダプタ（#28 / M4）**: `NodeKeyManager`（PEM / シード復元・指紋照合・keyFile 永続化・衝突）、`BrowserKeyManager`
  （IndexedDB への非抽出 CryptoKey 保存・復元・署名チャレンジ・再生成・IndexedDB 無しのセッション限定動作。テストは `FakeIndexedDB` シムを使用）。
- **名前解決（M4 / #25）**: URL 正常/異常、A/CNAME、ループ・深度上限、TTL キャッシュ、ローカル優先、問い合わせタイムアウト/中断、実スタック 2 ノード解決、事前鍵共有なし 3 ノードの名前解決と URL 接続。
- **アダプタ**: `SignalingAdapterHub`、`EntranceSearcherAdapterHub`（`exclude` 対応）、`examples/server.mjs` の配信・API 検証。
- **WebRTC 経路（FakeRTCPeerConnection）**: Offer/Answer/DataChannel、動的 TURN 資格情報（`iceServersProvider`）、ICE 障害時の自動 ICE 再起動と資格情報更新、再起動上限超過時の切断、同時接続 Glare 解決。
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

## 10. 既知の制約（M4 時点）

- **鍵管理を渡さない場合は v1（署名なし）で動く**: 既定の `WebTCPNetwork(options)` は後方互換のため `NullPacketVerifier`。
  署名必須にするには `keyManager` または `Ed25519PacketVerifier` を注入する（`createBrowserNetwork({ keyManager })` など）。
- **Ed25519 非対応ブラウザ**: Web Crypto の Ed25519 は Chrome 137+ / Firefox 129+ / Safari 17+。デモは v1 へ自動フォールバックする。
- **鍵ローテーション・E2E 暗号化・リプレイ検知の強化は未実装**: `specification.md` §10.7 を参照。
- **RPF は緩和版**: 経路未学習の直接隣接からの受信を許可している。本格なマルチホップ強化は M5 以降。
- **名前解決はローカル信頼モデル（M4）**: `NameServer` と `webtcp://` は実装済みだが、グローバルな名前所有権・`domain.global`・ブロックチェーン連携は M5（#25）。
- **Node.js 鍵ファイルは平文 PEM**: `0600` で保存するが、ディスク暗号化やバックアップは利用者の責任。
- **Node.js 向け WebRTC 実装は非同梱**: `NodeWebRTCChannel` へ利用者が注入する設計。
