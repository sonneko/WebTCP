# WebTCP 開発計画書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.8.1 |
| 対応仕様 | `specification.md` 0.8.1 |
| 対応設計 | `design.md` 0.8.1 |
| 最終更新 | 2026-11-17 |
| 現在のマイルストーン | **0.8.1（サイクル11: GitHub Pages への公開デモ。版は据え置き）** |

---

## 1. 開発経緯

- **M0（設計文書化）**: `specification.md` / `design.md` / `plan.md` の整備と既存課題の Issue 化を完了。
- **M1（最小の end-to-end）**: ブラウザ非依存コア再構成、v1 シリアライザ、WebRTC / シグナリング / エントランス探索アダプタ、2 タブデモ、テスト 18 件、CI を完了し `main` へマージ済み。
- **M2（TCP セマンティクス完成と運用基盤）**: バイト単位 Seq/Ack・ランダム ISN・60 KiB 超の自動分割・動的 RTO・輻輳制御・Fast Retransmit / SACK・Half-Close・レベル付きロガー・`bootstrap()` 自動接続・TURN/ICE 設定と自動 ICE 再起動・Starlight ドキュメントサイト・実ブラウザ 2 タブ検証の仕組みを整備した。
- **M4（NameServer / #25 前半）**: PR #39 で main にマージ済み。NameServer（A/CNAME・TTL キャッシュ・既知ノード反復解決）、`webtcp://` URL と `connectURL()`、永続 NodeId（署名チャレンジ復元・`keyFile` 永続化・衝突検出）、`RT_UPDATE` の受信元検証とマルチホップ鍵伝播、デモと Playwright 検証拡張、ドキュメント全面同期を実施。#25 のうち `domain.global` / ブロックチェーン連携は M5 へ持ち越した。
- **M5（`domain.global` と検証可能なドメイン所有権証明 / #25）**: PR #53 で **main にマージ済み**。署名付き所有権レコード、追記型 Merkle 台帳とチェックポイント検証、プラガブルな検証器、`NameServer` 統合、参照 HTTP レジストリ、デモと Playwright 検証。#25 は完了し、残り（実チェーン・ガバナンス）は #42 / #43 へ切り出した。
- **M3（セキュリティ / #28）**: PR #34 で main にマージ済み。**Ed25519 署名**と **NodeId の公開鍵指紋化**（プロトコル v2）、ブラウザ用 `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）、Node.js 用 `NodeKeyManager`、公開鍵の配布（シグナリング交換 + `RT_UPDATE` 同梱）、署名・検証・鍵導出のテストを追加した。

## 2. マイルストーン

| ID | 名称 | 状態 | 概要 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | ✅ 完了 | 仕様書・設計書・計画書、Issue 整理 |
| M1 | 最小の end-to-end | ✅ 完了 | アダプタ実装、コア修正、ビルド、デモ、テスト |
| M2 | TCP セマンティクスの完成と運用基盤 | ✅ 完了 | バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close・ロガー・`bootstrap()`・TURN/ICE 再起動・ドキュメントサイト・実ブラウザ検証 |
| M3 | セキュリティ | ✅ 完了（#34 マージ済み） | Ed25519 署名（プロトコル v2）・NodeId の鍵指紋化・`KeyManager`（IndexedDB / node:crypto）・公開鍵の配布（#28） |
| **M4** | **NameServer と webtcp:// URL** | ✅ 完了（#39 マージ済み） | NameServer（A/CNAME・ローカル登録・既知ノード問い合わせ）、`webtcp://`、永続 NodeId と衝突検出、デモ/サイト（#25） |
| M5 | `domain.global` と検証可能なドメイン所有権証明 | ✅ 完了（PR #53 マージ済み） | 署名付き所有権レコード、追記型台帳の Merkle / チェックポイント検証、プラガブルな検証インターフェース、`NameServer` 統合、参照レジストリ（HTTP）、デモ（#25 / #40 / #41）。RPF 厳格化・SSE/WebSocket・鍵ライフサイクル等は #42〜#49 へ切り出し |
| **M6** | **アプリケーション層 HTTP トンネル（L7）** | **完了（#50）** | `core/http`（HTTP/1.1 サブセット）、`HTTPServer` / `HTTPClient`、`network.serveHTTP()` / `fetchURL()`、`webtcp://` の `path` / `query` 転送、デモと実ブラウザ検証。将来課題は #51 / #52 と §4 に継続 |
| **M7** | **生存期間（サービス役の稼働維持）** | **完了（#51）** | `persistState` / `restoreState`（IndexedDB）、`neighbor-*` の再発行、`startBrowserKeepAlive`（Wake Lock・無音オーディオ・前面復帰・pagehide）。仕様 §9 |
| **M8** | **ブラウザ外 TCP クライアント向けブリッジ** | **完了（#52）** | `examples/bridge.mjs` / `bridge-service.mjs`、ループバック既定・署名必須・アクセスログ（仕様 §19）。UDP・SOCKS・ローカル認証は未実装 |
| 0.8.1 | M8 の未検証項目の検証と既知バグの修正 | 完了（#54・#63 ほか） | §3.9 |
| **M9** | **タブ停止・リロードへの耐性（#51 の残課題）** | **実装中（項目 28〜30 と 32 の検証が完了。項目 31 は未了、#51 は開いたまま、サイクル32）。#92（初回接続の 15 秒停止）は原因を実行で特定し、修正は #97 に分割（#92 は開いたまま）** | 調査は実行で実施（仕様 §9.7、設計 §3.41）。自動保存・ハンドラ再付与・隣接の再確立・無音オーディオの実機検証を §3.25 の順に実装する。M8 は #52 で完了済みのため、番号は M9 とした |

## 3. 完了済みマイルストーンのスコープ

### 3.1 M1（完了）

- [x] `specification.md` / `design.md` / `plan.md` の作成
- [x] コアのコンパイル修正とブラウザ対応（`Uint8Array`、独自 `EventEmitter`）
- [x] パケットシリアライザの再実装（v1 バイナリ形式、フラグのビット判定）
- [x] `LinkManager` / `RoutingLayer` / `RoutingTableManager` / `TransportLayer` / `VirtualStream` / `WebTCPNetwork` 修正
- [x] `BrowserWebRTCChannel` / `NodeWebRTCChannel` / `SignalingAdapterHub` / `EntranceSearcherAdapterHub`
- [x] `npm run build`（ESM + 型定義）、デモ・シグナリングサーバー、テスト 18 件、CI、README 更新

### 3.2 M2（完了）

- [x] ドキュメントと実装の同期チェックおよび新規発見バグ（#30, #31, #32）の修正
- [x] `specification.md` §8.2〜§8.5 / §10.3〜§10.6 / §12〜§13 の拡張
- [x] **#23 TCP セマンティクス完成**:
  - バイト単位 Seq/Ack（RFC 1982 mod 2^32 ラップアラウンド対応）と部分読み取り（`read` / `readExact` / `readable`）
  - 60 KiB 超メッセージの MSS（既定 16 KiB）自動分割・送信バッファ・再結合
  - 動的 RTO 計算（RFC 6298 Jacobson / Karn + 指数バックオフ）
  - 輻輳制御（RFC 5681 Slow Start / AIMD Congestion Avoidance / Fast Recovery）
  - Fast Retransmit（3 重複 ACK）とプロトコル v1 互換の SACK（最大 4 ブロック）
  - 初期シーケンス番号（ISN）の暗号学的ランダム化
  - 正しい Half-Close（`CLOSE_WAIT` / `FIN_WAIT_1` / `FIN_WAIT_2` / `LAST_ACK` / `CLOSING` / `TIME_WAIT`、`allowHalfOpen` 既定 `true`）
- [x] **#26 レベル付きロガー**: `Logger` / `ConsoleLogger`（既定 `warn` 以上）/ `noopLogger` を導入し `WebTCPNetwork` および全層・全アダプタへ注入可能化（`console.*` 直書きを根絶）
- [x] **#27 エントランス探索からの自動接続**: `WebTCPNetwork.bootstrap(searcher, options)` を実装（候補への順次接続、リトライ、指数バックオフ、`AbortSignal` 対応）
- [x] **#24 TURN / ICE と NAT 越え**: `iceServers` の文書化、TURN 資格情報の動的取得フック（`iceServersProvider`）、接続失敗・切断時の自動 ICE 再起動（既存 DataChannel 維持）、デモへの STUN 設定例追加
- [x] **#22 ドキュメントサイト**: `webtcp_website` を Starlight テンプレートから WebTCP 公式ドキュメントへ刷新し、CI でビルド検証
- [x] **実ブラウザ 2 タブデモ検証の整備**: デモ内蔵の自己チェックモード（`?selftest=1` / `?role=server/client&autostart=1`）と Playwright ヘッドレス Chromium 2 タブ検証（`examples/verify-browser.mjs` + CI `browser-e2e` ジョブ）を追加
- [x] テスト拡張（M2 完了時点で 43 件すべて通過）およびドキュメント同期

### 3.3 M3（完了 / #34 マージ済み）

- [x] ドキュメントと実装の同期チェック（本書・`specification.md`・`design.md`・`README.md`・`docs/layer.md`・`webtcp_website`）
- [x] **#28 Ed25519 署名と NodeId の鍵指紋化**:
  - [x] **NodeId = Ed25519 公開鍵の指紋**（`SHA-256(rawPublicKey)` の先頭 16 バイトを hex 化した 32 文字、`deriveNodeId()`）
  - [x] **`Ed25519PacketVerifier`**（`IPacketVerifier` 実装）: 署名対象は「署名フィールドを除くシリアライズ済みパケット」。
        送信時に 1 度だけ署名し、中継転送では再署名しない（TTL は署名対象外・0 に正規化）。
  - [x] **ブラウザ = Web Crypto API**（`crypto.subtle`）、**Node.js = `node:crypto`** を利用する鍵管理
  - [x] **`BrowserKeyManager`**: 秘密鍵を **IndexedDB** に **非抽出 CryptoKey**（`extractable: false`）として保存。
        公開鍵・NodeId は IndexedDB のレコードに同居させ、起動時に指紋を再検証する。
  - [x] **`NodeKeyManager`**: `node:crypto` の Ed25519 `KeyObject` で生成し、署名・検証は `webcrypto.subtle`。
        PKCS#8 PEM / シード hex での復元・エクスポートに対応。
  - [x] **公開鍵の配布方法の決定と実装**:
        (1) シグナリング時の `public-key` メッセージ交換（`WebRTCChannel` がリンク確立時に自動送信）
        (2) `RT_UPDATE` ペイロードへの `publicKey` 同梱（マルチホップへ伝播）
        (3) 受信側は `KeyDirectory` に指紋一致を検証して登録。`IPublicKeyResolver` で分散ストレージへ差し替え可能。
  - [x] **署名必須化に伴うプロトコルバージョン更新**: v2（24 バイトヘッダーは共通、`signature` に 64 バイトの Ed25519 署名）。
        v1 パケットは後方互換のため受信のみ受理する（`requireSignatures` で拒否可能。鍵管理を渡すと既定で必須）。
  - [x] **specification.md §11 の全面更新**（脅威モデル・署名対象・鍵配布・リプレイ対策・既知の制約）
- [x] テスト追加（`tests/keys.test.mjs` / `tests/signed-network.test.mjs` / `tests/browser-keys.test.mjs`）— 全 86 件通過
- [x] デモと Playwright 実ブラウザ検証を Ed25519 署名（v2）に対応（`?insecure=1` で v1 比較、`?e2e=1` でタブごとに独立した鍵）

### 3.4 M4（完了 / #39 マージ済み）

着手前に M3 までの実装と文書を網羅同期し、差分を #35（文書）、#36（永続鍵/衝突）、#37（RT_UPDATE/鍵伝播）、#38（起動/状態/ICE）へ整理した。

- [x] 仕様書 0.4.0 → 設計書 0.4.0 → 計画書 0.4.0 の順に更新
- [x] **NameServer**: A/CNAME 相当、ローカル登録、既知ノード（明示リゾルバ/隣接/経路表）への問い合わせ、TTL キャッシュ、CNAME ループ/深度/並列/サイズ制限
- [x] **`webtcp://` URL**: NodeId/名前 + 必須ポート + path/query/fragment のパース、`connectURL()`、名前解決経由接続
- [x] **永続 NodeId**: ブラウザ復元時の署名チャレンジ、`NodeKeyManager.open({ keyFile })`、`NodeIdCollisionError`
- [x] **#37**: RT_UPDATE 受信元検証と `entries[].publicKey` 伝播（事前鍵共有なしマルチホップ）
- [x] **#38**: 起動失敗再試行、end イベント状態、cwnd 上限の回帰、ICE 再起動例外時の挙動修正
- [x] デモに名前登録/解決/URL 接続を追加し、Playwright 検証を拡張
- [x] README / docs/layer / webtcp_website を同期
- [x] `npm run build` / `npm test`（webtcp_jslib、105 件通過）、`npm run build`（webtcp_website、10 ページ）
- [x] CI（build-and-test / build-website / browser-e2e）— PR #39 で全ジョブ成功

**M4 スコープ外**: `domain.global` へのドメイン登録、ブロックチェーンによるドメイン所有権証明 → M5 で実装（§3.5）。

### 3.5 M5（完了 / PR #53 マージ済み）

着手前に main（`b4a9c54` = PR #39 マージ後）でドキュメントと実装の網羅同期チェックを行い、新規発見分を #40（`NameServer.resolve()` のデッドライン未遵守）と #41（`Ed25519PacketVerifier` のシリアライザ非同一性）へ整理した。M4 で修正済みだった #35〜#38 は内容確認のうえ close した。

- [x] 仕様書 0.5.0 → 設計書 0.5.0 → 計画書 0.5.0 の順に更新（§13 を新設し、公開 API を §14 へ繰下げ）（当時）
- [x] **`domain.global` ゾーン**（specification.md §14.1）: 単一ゾーン、ASCII LDH、ローカル登録からの予約（`registerA` / `registerCNAME` はゾーン名を拒否）
- [x] **所有権レコード**（§14.2）: 固定キー順の canonical バイト列 + 所有者 Ed25519 署名 + 指紋照合 + `serial` / 有効期間 / 失効。**未知キー拒否の厳格パース**を必須化
- [x] **追記型台帳と検証可能なアンカー**（§14.3）: 領域分離付き Merkle 木（葉 `0x00`、内部 `0x01`、奇数 promote）、包含証明、ログ鍵による署名済みチェックポイント、`treeSize` 単調性と `prevHash` 連鎖によるロールバック検出
- [x] **プラガブルな検証インターフェース**（§14.4）: `IDomainOwnershipVerifier`（既定実装は fail-closed）、`IChainAnchorVerifier`（実チェーン検証への差し替え点。未設定は `chainVerified: null` として正直に区別）、`createDomainProofCache`
- [x] **解決フロー**（§14.5）: `DomainAuthority`（ローカル / `IDomainRecordSource` / 既知ノードの 3 系統を並列収集 → 検証 → `serial` → `leafIndex` → commitment で勝敗決定、同 serial 異内容は `conflict` で失敗）、成功・失敗両キャッシュ、上限とタイムアウト
- [x] **NameServer / `webtcp://` 統合**（§13.2 / §13.3）: `protocol: 1` への `wantOwnership` / `ownership` 追加（後方互換）、`ns.registerDomain()`、ゾーン名の `registerA` 拒否、`NameResolution.source === 'domain'`、所有権レコード無し応答は不使用
- [x] **参照レジストリの実装**（§14.6）: `examples/server.mjs` に `/domain/*`（登録・検索・チェックポイント）、`HttpDomainRegistryClient` アダプタ
- [x] **`HttpDomainRegistryClient` の `fetch` バインド修正**: `globalThis.fetch` を切り離して保持していたため実ブラウザで `Illegal invocation` になっていた（CI の browser-e2e で発覚、Node テストは素通り）。既存アダプタと同じく `bind(globalThis)` に統一し、レシーバを要求する `fetch` を渡す回帰テストを追加
- [x] **#40 修正**: 問い合わせを `AbortController` で統一し、`connect()` 宙吊りでもデッドラインを守る（最初の成功 or 全体タイムアウトで return、待機残は破棄）
- [x] **§14.5 の失敗分類を規範化**: 候補 0 件（台帳にも既知ノードにも無い）は `NameNotFoundError`、候補はあるが検証に落ちたものは `DomainOwnershipError`（`code` を伝播）へ書き分ける。実ブラウザ自己チェック 1d がこの区別を要求しており、CI 実行でデモ側の逆アサーションとして露見したため仕様・テスト・実装を揃えた
- [x] **#41 修正**: `WebTCPNetwork` が注入 `serializer` を検証器へ伝播、`serializeForSigning` 非実装時の黙ったフォールバックを構築時エラーへ変更
- [x] **CI が拾った実バグ修正**: `HttpDomainRegistryClient` が `fetch` をレシーバ切り離しで保持しており、実ブラウザ（Chromium）で `POST /domain/record` が `Illegal invocation` で失敗した。`SignalingAdapterHub` / `EntranceSearcherAdapterHub` と同じく `bind(globalThis)` に統一し、レシーバを要求する `fetch` を渡す回帰テストを追加（Node のみで通るテストではこの種のバグは出てこない）
- [x] デモ拡張: セクション 3 で「自分のドメインクレームに署名 → 参照台帳へ submit → アンカー付きで `registerDomain()` →ピア経由で解決」を手動操作でき、1 タブ自己チェックのステップ **1d** が同じ流れを自動化する（(a) 台帳経由、(b) 既知ノードの `wantOwnership` 応答のみ、(c) 未登録名前は `NameNotFoundError` / 検証に落ちた名前は `DomainOwnershipError` という書き分け、(d) 改ざんの 400 拒否）。`examples/verify-browser.mjs` は 1d の成功を必須化した
      ※ 2 タブ自動モード（`?role=…&autostart=1`）は M4 までのフローのまま残している。ドメイン登録は手動ボタンと自己チェック 1d のみで自動実行しない（自動モード側へ足す価値は低いが、差は認識しておく）
- [x] README / docs/layer / webtcp_website を同期（新ガイド `guides/domain-ownership.md`、API リファレンス、ロードマップ、仕様サマリー）
- [x] テスト追加（`domain-record` / `domain-merkle` / `domain-verify` / `domain-ledger` / `domain-resolution` / `domain-registry-http` の 41 + 1 ケース、`demo-server.test.mjs` に `/domain/*` ルーティング）— M5 完了時点で `npm test` は 150 件全通過（M6 完了時点は 206 件）
- [x] **スコープ外 → Issue 化**: 実チェーン検証（#42）、ガバナンス / IDNA / 複数ログ合意（#43）、`connect()` 系の中断伝播（#44）、SSE / WebSocket（#45）、RPF 厳格化（#46）、鍵ライフサイクル（#47）、リプレイ強化（#48）、パッケージ公開（#49）
- [x] PR #53 としてレビュー・マージ済み（`main`）。#25 は close 済み


### 3.6 M6（完了 / #50）

着手前に main（`80488fd` = PR #53 マージ後）で**ドキュメントと実装の網羅同期チェック**をやり直し、下記の不整合を PR 内で修正した（新規 Issue は §6.6）。

#### 3.6.1 同期チェックで修正した既存のずれ（M6 の前提整備）

| # | 箇所 | ずれ | 対応 |
| :--- | :--- | :--- | :--- |
| S1 | `plan.md` §2 / §3.5 | M5 が「実装済み（PR #53・レビュー待ち）」のまま。実際は PR #53 が main にマージ済みで、M6 の記述も「未着手」 | 状態を「✅ 完了（マージ済み）」へ更新し、M6 を本サイクルの実装として記述。M5 節の最終チェックボックスを `[x]` に |
| S2 | `README.md` ロードマップ / `webtcp_website/reference/roadmap.md` | M4 が「実装済み」のまま（M4 は #39 でマージ済み）。README のテスト件数も 150 件（M5 時点）で古い | M4 / M5 を「完了」に、テスト件数を 206 件（実測）へ更新 |
| S3 | `specification.md` §13.3 / `docs/layer.md` / website `guides/name-resolution` | 「`path` / `query` は送信しない。HTTP セマンティクスは定義しない」と明記されており、#50 の実装と矛盾する | M6 で `query` は HTTP 層が転送する旨へ改訂し、生ストリームでは送らないことを明示（§13.3 / §16.6） |
| S4 | `specification.md` §12.3 | `DomainAuthority.queryTimeoutMs`（実装既定 1 500 ms）が既定値表に無い | 表へ追加し、HTTP 層の既定値も併記 |
| S5 | `specification.md` §8.3.1 / `design.md` §11 | パケットに受信ウィンドウが無い（フロー制御なし）ことが何処にも書かれていない。実装は `maxWindowBytes` と輻輳制御のみ | 「受信ウィンドウの広告は行わない」を明記（当時）。サイクル22（§3.20）で `WIN` ビットによる交渉と受信側の上限を実装 |
| S6 | `design.md` §3.22 / §4 | 存在しない `DomainQueryTransport` を依存として記載。実装は `NameServer.settleCandidates()` に候補配列を渡す形 | 記述を実装に合わせて修正 |
| S7 | `README.md` ビジョン評価 | 全角の混入（`范围`）と「HTTP が無い」の記述（M6 で解消） | 修正 |
| S8 | `webtcp_website` の roadmap / API | M5 が「一部実装済み（#25）」で、HTTP の記述が無い | M5 完了・M6 実装済みへ更新し、HTTP ガイドを追加 |

> S1〜S8 は「コードは正しいが文書が古い」型のずれであり、機能の欠陥ではなかった。サイクル冒頭の同期チェックを省略すると、レビューで「実装と違う」と指摘される種類のものである。

#### 3.6.2 M6 の本体（#50）

- [x] 仕様書 0.6.0（§15 を新設、§16/§17 を繰り下げ）→ 設計書 0.6.0（§3.24〜3.27、§5.5）→ 計画書 0.6.0 の順に更新
- [x] **`core/http`（HTTP/1.1 サブセット）**:
  - メッセージ: リクエストライン / ステータスライン / ヘッダ（大文字小文字を区別しない名前、重複の配列保持）
  - 本文: `Content-Length` / `chunked` / 本文なしの 3 経路。両立は `400`（リクエストスマグリング回避）
  - CRLF 厳格（裸の `LF` 拒否）、上限（リクエストライン 8 KiB / ヘッダ行 8 KiB / 100 個 / 合計 32 KiB / chunk-size 行 1 KiB）
  - ヘッダ書き込み時の**インジェクション拒否**（名前は token、値に CR/LF/NUL を許さない）
- [x] **`HTTPServer`**: 仮想ポート待ち受け、接続ごとの逐次リクエストループ、`keep-alive`、`HEAD` の本文抑止、`501` / `405`、ハンドラ例外時の `500`（応答開始済みなら切断）、本文の読み捨て、同時接続上限 64（超過は `503`）、アイドルタイムアウト 30 秒
- [x] **`HTTPClient`**: `fetch` 風 API（`fetch(url, init)` / `request({nodeId, port, ...})`）、`webtcp://` の `path` + `search` を request-target へ写像、`Host` 自動付与、`(nodeId, port)` 単位の `keep-alive` プール、ストリーミング本文（`AsyncIterable`）、`text()` / `json()` / `arrayBuffer()`、`timeoutMs`（ヘッダ到着まで）、`maxResponseBytes`、`AbortSignal`
- [x] **`WebTCPNetwork.serveHTTP()` / `fetchURL()`**: 薄いヘルパーとして追加（`core/http` へ委譲）
- [x] **`HTTPRouter`**: `method + '/users/:id'` パターンの補助ディスパッチャ
- [x] テスト（`http-parse` / `http-server` / `http-client`）— 分割耐性・上限・chunked・keep-alive・Half-Close 中応答・タイムアウト・二重読み取り
- [x] デモ: サーバータブで `serveHTTP(8080)` による HTTP サービスを公開し、クライアントタブから `fetchURL('webtcp://demo-alias:8080/api/echo?x=1')` を実行する UI と自己チェック項目（1e）を追加
- [x] `examples/verify-browser.mjs` に HTTP ステップを追加（実ブラウザでの `serveHTTP` + `fetchURL`）
- [x] `README.md` / `docs/layer.md` / `webtcp_website`（新ガイド `guides/http-tunnel`）を同期

**M6 のスコープ外**: 稼働維持（#51）、ブリッジ（#52）、HTTP/2 以降（§16.9）、受信フロー制御（`specification.md` §8.3.1 に注記、Issue 化は §6.6）。

### 3.7 M7（完了 / #51）

#### 3.7.1 スコープ判断

- 「タブが止まらないこと」は Web の制約上保証できない。M7 は**停止後に失った状態を回復する**ことと、止まりにくくする補助に限定した。
- 名前は **pull 型**のまま（NameServer は自分のローカル登録だけを応答する、§13.2 の不変条件）。未要求の push は行わない。再広告は既存の RT_UPDATE（隣接確立時）と、復元後の登録で行う。
- 状態は JSON（`PersistedServiceState`、version 1）。鍵は既存の `BrowserKeyManager`（IndexedDB）に任せ、重複保存しない。

#### 3.7.2 M7 の本体（#51）

- [x] 仕様書 0.7.0（§9 生存期間を新設、§10 以降を繰り下げ。§18 から #51 の非目標を除去）→ 設計書 0.7.0（§3.28）→ 計画書 0.7.0 の順に更新
- [x] **`core/persistence`**: `PersistedServiceState`、`ServiceStateStorage`、`MemoryServiceStateStorage`、`parsePersistedServiceState()`（不正な版・ポート・名前を拒否）
- [x] **`adapters/persistence/IndexedDBServiceStateStorage`**: 既定 DB `webtcp-service` / store `state`、`indexedDB` を注入可能（テストは FakeIndexedDB）
- [x] **`NameServer.exportState()` / `restoreState()`**: ローカル A/CNAME と所有権レコード（JSON）の往復。所有権レコードは `registerDomain()` と同じ検証を通し、失敗は登録しない
- [x] **`WebTCPNetwork.persistState({ nameServer? })` / `restoreState({ nameServer? })`**: `stateStorage` オプション、NodeId 不一致の拒否、NameServer ポートの再待ち受け
- [x] **`WebTCPNetwork` の `neighbor-connected` / `neighbor-disconnected` 再発行**（LinkManager から転送）
- [x] **`startBrowserKeepAlive()`**（`adapters/keepalive`）: Wake Lock（非対応は no-op）、無音オーディオ（既定オフ）、`visibilitychange` での再接続、`pagehide` での `onPageHide` と状態保存、`stop()` で全解除
- [x] デモ（`?selftest=1`）に **1f 項目**（IndexedDB 永続化 → 別 NameServer へ復元）を追加。`verify-browser.mjs` が「永続化」を含むステップを検査
- [x] テスト `service-persistence.test.mjs`（7 件）。既存 206 件と合わせて 213 件

**M7 のスコープ外（残課題）**: 凍結中のタブの到達不能（本質的制約、仕様 §9.6）。HTTP ハンドラ・`onPageHide` の再登録は利用者の責務。定期的な自動 `persistState()`（現状は利用者が呼ぶ / pagehide のみ）。

---

### 3.8 M8（完了 / #52）

#### 3.8.1 スコープ判断

- **対象**: ローカル TCP 待ち受け → `network.connect(nodeId, port)` の双方向中継（Half-Close・背圧あり）、`webtcp://<nodeId|name>:<port>` の宛先指定、`NodeWebRTCChannel` の既定プロバイダ解決と型付きエラー、`requireSignatures`（v2）必須・ループバック既定・アクセスログ・v1 宛先の転送拒否（仕様 §19.4）。
- **パッケージ分割の判断（#49 との関係）**: `webtcp-bridge` の `bin` と別パッケージへの分割は**行わない**。npm 公開の方針（semver・`exports`）が #49 で未決のため、先に分割すると公開単位が二度動く。ブリッジは `webtcp_jslib/src/adapters/bridge` に置き、CLI は `examples/bridge.mjs` とする（設計 §3.29）。`bin` 登録は #49 の決定後に行う。
- **Node の WebRTC は同梱しない**: `@roamhq/wrtc` / `node-datachannel` は任意導入の依存（`optionalDependencies` にも入れない）。導入済みのものを `createNodeNetwork()` が解決し、無ければ `WebRTCProviderUnavailableError` で導入方法を示す。README / ロードマップの「同梱しない」方針と一致させる。
- **既存クライアントの入口**: 本ブリッジは「curl からトンネルへ入る」ことを証明するもので、§6.6 の線引き（「HTTP を話せる」と「既存の HTTP クライアントから使える」は別）の後者を解消する。

#### 3.8.2 実装チェックリスト

- [x] 仕様書 0.8.0（§19 を新設、§18 から #52 の非目標を除去）→ 設計書 0.8.0（§3.29）→ 計画書 0.8.0 の順に更新
- [x] `WebTCPNetwork.signaturesRequired`（安全条件の検査に使う読み取り専用の公開値）
- [x] `adapters/bridge/TcpBridge`: 安全条件（`assertBridgeSecurity`）、ループバック既定、v1 宛先の拒否（鍵ディレクトリで判定、5 秒待機）、`allowHalfOpen: true`、`drain` 待ちの再送、`onAccess` のログ（`open` / `refused` / `error` / `close`）
- [x] `adapters/webrtc/nodeProvider`: `@roamhq/wrtc` → `node-datachannel` の順で解決、`WebRTCProviderUnavailableError`（`tried` 一覧）、`createNodeNetwork()`、`peerConnectionOptions` の上書き
- [x] `examples/bridge.mjs`（CLI）: `--listen` / `--resolve-name` / `--key-file` / `--rtc-bind` / `--allow-non-loopback` / `--allow-unsigned-peers`。安全条件違反は**ネットワークへ参加する前**に拒否する
- [x] `examples/bridge-service.mjs`（確認用サービス）: `/api/echo`、`/big?n=`（大きな応答の確認用）、NameServer への名前登録
- [x] テスト: `bridge.test.mjs`（6 件: 安全条件・TCP 往復・Half-Close・アクセスログ・300 KiB の sha256・HTTP 素通し・v1 拒否・非ループバック opt-in）、`node-provider.test.mjs`（6 件）、`bridge-webrtc.test.mjs`（実 WebRTC E2E 1 件。実装が無ければ skip）
- [x] `README.md` / `docs/layer.md` の同期（ブリッジの入口と CLI）
- [x] `webtcp_website` の同期（0.8.1 で `guides/bridge` を追加。M8 時点では未実施だった）
- [x] Issue 起票: #61（ICE 候補 0 件）、#62（`allowHalfOpen` 既定）、#63（#40 テストの不安定さ）

#### 3.8.3 検証状況（正直な記録）

| 項目 | 結果 |
| :--- | :--- |
| `npm test`（`webtcp_jslib`） | 226 件中 225 件成功（M8 時点の記録）。失敗は #40 の既存テストの負荷依存の不安定さ（#63）。0.8.1 で #63 を修正し、233 件全通過。 |
| 実 WebRTC E2E（テスト） | `bridge-webrtc.test.mjs` 成功（`node-datachannel`、`bindAddress: 127.0.0.1`） |
| 実プロセスの E2E（シグナリング・Node サービス・ブリッジ・`curl`） | 成功。`curl /api/echo?x=1` のクエリ、`/`、`--resolve-name` による名前解決、512 KiB の応答（2 回・すべて 'x' を確認）を確認。アクセスログに `open` / `close` と転送バイト数が出ることを確認。 |
| 安全条件（CLI） | `0.0.0.0` の待ち受けは `--allow-non-loopback` 無しで拒否。名前を `--resolve-name` 無しで渡すと拒否。いずれもネットワーク参加前に停止する。 |
| `@roamhq/wrtc` | M8 時点は単体の probe のみ。**0.8.1 で検証済み**（§3.9.3）。 |
| **ブラウザ上のサービスへの E2E（Chromium）** | M8 時点は未検証（Playwright のブラウザ取得が失敗）。**0.8.1 で検証済み**（§3.9.3）。 |
| 半クローズ後の応答 | テストと実プロセス（`curl`）の双方で確認。#62 の修正で解消。 |

#### 3.8.4 M8 のスコープ外（記録）

- `webtcp-bridge` の `bin` と npm 公開（#49 の決定に従う）。
- ローカル側の認証、UDP、SOCKS、接続数上限、受信ウィンドウ（#56）。
- ブリッジ経由のブラウザページからの CSRF 的要求（仕様 §19.4 の 5 の既知の制約。ループバック既定で緩和）。

### 3.9 0.8.1（完了 / パッチ: M8 の未検証項目の検証と既知バグの修正）

#### 3.9.1 スコープ判断

- **対象**: M8 で未検証のまま残した 3 項目（Chromium のブラウザ E2E、`@roamhq/wrtc` 経由のブリッジ E2E、website ガイド）の検証と記録。既知の不具合 #54（`destroy()`）、#63（フレーキーなテスト）、#61（ICE 候補 0 件）の修正・切り分け。ドキュメントとソースのズレ（§17 → §19、#55 の残り）。
- **バージョン**: 0.8.1（パッチ）。仕様・設計・計画・README・docs の版表記を揃えた。npm パッケージの版（`package.json` 0.1.0）は #49 まで変えない。
- **プロトコルは変えない**: 仕様 §8.2 の `destroy()` の意味づけを変えたが、ワイヤー形式（パケット）は変えていない。RST は既存のフラグ。

#### 3.9.2 実装チェックリスト

- [x] **#54**: `destroy()` が相手へ `RST` を送ってから `finalize()`。`TransportLayer` は対応セッションの無い `RST` に返信しない（ping-pong 防止）。受信 `RST` の `error` はリスナーがある場合だけ発火（例外防止）。仕様 §8.2 / §16.5 の 7 / §10、設計 §3.30、HTTP サーバーの注釈、website の API ページを同期。
- [x] **#63**: `domain-resolution` の経過時間の上限を、デッドライン（500 ms）ではなく停止接続の待ち（8000 ms）に対して判定する（不変条件に合わせた）。
- [x] **#61**: 既定のバインドは変えない。収集完了で候補 0 件なら `bindAddress` を指示する警告（`watchIceGathering`）。候補数は SDP で数える（設計 §3.31）。原因の切り分けは Issue に記録（ネイティブ側は未確認）。
- [x] **§17 → §19 の参照修正**（`TcpBridge.ts` / `nodeProvider.ts` / `WebTCPNetwork.ts` / テスト / CLI）。
- [x] **#55 の残り**: `crypto.ts` の簡体字（`前缀`）を接頭辞に直した。他の項目（M5 のステータス、README の M4/M5、#43〜#49 の目標、`queryTimeoutMs`、`id.ts` のコメント）は既に修正済みと確認。
- [x] テスト: `destroy-abort.test.mjs`（4 件）、`node-provider.test.mjs`（ICE 警告 3 件を追加）、`bridge-webrtc.test.mjs`（`WEBTCP_TEST_RTC_BIND` で bind を選べるように）。
- [x] 実ブラウザ E2E: `examples/verify-bridge-browser.mjs`（新規）、`examples/bridge/browser-service.{html,js}`（新規）。
- [x] website: `guides/bridge`（新規）、サイドバー、`guides/http-tunnel` の注記、roadmap、protocol の版、API リファレンス（ブリッジ・プロバイダ解決・`destroy()`）。`npm run build` 成功（13 ページ）。

#### 3.9.3 検証結果（0.8.1）

| 項目 | 結果 |
| :--- | :--- |
| `npm test`（`webtcp_jslib`） | **233 件全通過**（M8 の 226 件 / 失敗 1 件から、#63 の修正と新規テスト 7 件） |
| `destroy()` の回帰（ミューテーション） | 旧 `destroy()` に戻すとテスト 1・2 が失敗（peer が CLOSED にならない）。RST の返信抑止を外すとテスト 3 が失敗（ping-pong を検出）。いずれも修正後に全通過へ戻したことを確認 |
| ICE 警告（実 `node-datachannel`） | 自動バインドで警告が出る。`127.0.0.1` では出ない（候補数は SDP で確認）。 |
| `@roamhq/wrtc` 経由の bridge E2E | `bridge-webrtc.test.mjs` が **自動バインド**（`WEBTCP_TEST_RTC_BIND=`）と `127.0.0.1` の両方で通過。`node-datachannel` が自動バインドで失敗する条件でも通ることが、#61 の回避策として重要。 |
| **Chromium のブラウザ E2E** | `examples/verify-bridge-browser.mjs` **9/9 通過**。Chromium 153（headless、署名付き v2 ノード）が 8080 で HTTP を公開し、ブリッジ経由で **実 curl** の `/api/echo?x=1`（runtime=browser）と `/big?n=524288`（sha256 一致）を往復。アクセスログの open / close、ページエラー無し。 |
| website ビルド | `npm run build` 成功（13 ページ、`guides/bridge` を含む） |

Chromium は次の手順で動かした（環境の記録。repo には含めない）。Playwright のブラウザ取得先は使えないため、npm レジストリの `@sparticuz/chromium` パッケージに含まれる Chromium バイナリを使った。このパッケージは共有ライブラリ（NSS 等）を同梱しているので、それを展開して `LD_LIBRARY_PATH` に指定した。`WEBTCP_CHROMIUM_PATH` と `LD_LIBRARY_PATH` を指定すれば、既存のブラウザでも同じスクリプトで検証できる。

#### 3.9.4 0.8.1 のスコープ外（記録）

- `node-datachannel` の既定バインドの扱い（#61 の残り）。原因がネイティブ側の仕様なら上流へ報告する。
- `webtcp-bridge` の `bin` と npm 公開（#49）。
- `VirtualStream` の受信ウィンドウ（#56）、HTTP 層のフル実装（#57）、接続プール（#58）。
- ブラウザ E2E の CI 組み込み。CI（GitHub Actions）の `browser-e2e` ジョブの構成は 0.8.1 では変えていない。

### 3.10 サイクル11: GitHub Pages への自動デプロイと公開デモ（0.8.1 のまま）

- **依頼**: sonneko（2026-11-21 20:20 JST）。`https://sonneko.github.io/WebTCP/` で目に見える成果（ドキュメントとデモ）を公開する。
- **スコープ判断**: プロトコル・API・版番号は変えない（文書バージョン 0.8.1 のまま。版上げは別指示）。設計判断は `design.md` §3.33。
- **変更**:
  - [x] `.github/workflows/deploy-pages.yml`（`main` push と手動実行、`pages: write` / `id-token: write` / `contents: read`）
  - [x] `webtcp_website/astro.config.mjs`（`site` / `base`）、`src/plugins/base-links.mjs`（内部リンクの base 前置）
  - [x] `webtcp_website/scripts/sync-demo.mjs`（デモとライブラリを `public/` へ複製、生成物は Git 管理外）
  - [x] `examples/demo/`：静的モード（`local-signaling.js`、モード判定、スキップ表示、ドメイン操作のガード）
  - [x] `examples/verify-static-demo.mjs`（Playwright による公開相当の検証）と CI の `browser-e2e` への組み込み
  - [x] `ci.yml` の `build-website` に jslib ビルドを追加
  - [x] README の公開 URL・デモ導線・デプロイ説明、website のデモガイドの更新
- **Pages 設定の確認**: `gh api repos/sonneko/WebTCP/pages` で `build_type` は `workflow`（Actions 方式）。ブランチ指定ではないため、ワークフローの配信がそのまま反映される。
- **未確認の項目**: 公開 URL の実アクセス（サンドボックスは `sonneko.github.io` へ出られない）。ローカルの `astro build` 出力を `verify-static-demo.mjs` で検証した結果で代替し、要約に明記する。
- **検証結果（サイクル11 の作業時点）**:
  - `webtcp_website` の `npm run build`: 13 ページ、リンクは `/WebTCP` 配下（`base-links` の効果を `dist` の href で確認）。`astro dev` / `astro preview` も `/WebTCP/` で応答。
  - `verify-static-demo.mjs`（静的配信、デモサーバー無し、Chromium 153）: 全項目 PASS。自己チェックは 10 項目 PASS と 1d（台帳）の省略。2 タブ（BroadcastChannel）の往復（テキスト・80 KiB）PASS。`/domain/*` への POST は 0 件。
  - `verify-browser.mjs`（サーバー有り、回帰確認）: 3 テスト PASS（自己チェックは台帳検査を含む 10 項目）。
  - 見つかったバグ: #70（自己チェックの後始末の ReferenceError）。同じ PR で修正し、回帰の検出は `verify-static-demo.mjs` の「ページエラーが無い」検査で行う。
  - `astro dev` の既知の差: `/WebTCP/examples/demo/`（末尾スラッシュ）は dev で 404。`/WebTCP/examples/demo/index.html` と本番ビルド（preview・Pages）では 200。

### 3.11 サイクル13: 公開デモの自己チェック失敗の調査（0.8.1 のまま）

- **依頼**: Muse（2026-11-23 13:34〜13:37 JST）。公開デモの自己チェックが step 1 で失敗（45.6 秒）。
- **再現と切り分け**（実行で確認）:
  - 既定の起動（mDNS 候補）と、mDNS 無効（IP 候補）の両方で、ローカルの自己チェックは PASS（約 0.6 秒）。
  - ICE 候補を UDP ホスト候補から作れない条件（`disable_non_proxied_udp`）で、生の 2 接続は候補 0 件のまま接続せず、自己チェックは公開版と同じ文言・約 45.9 秒で FAIL。→ 訪問者の環境で ICE 候補が出ていない可能性が高い。
  - 既存の検証は mDNS 無効で起動していたため、既定の経路を検証していなかった（#73 に記録）。
- **変更**:
  - [x] `design.md` §3.34（ICE 候補の事前診断）
  - [x] 自己チェックの step 0（ICE 候補の事前診断）と、step 1 の失敗時の内訳表示
  - [x] `verify-static-demo.mjs`: 既定の起動設定で実行し、候補 0 件の場合の早期の診断も確認する
  - [x] デモガイドに「自己チェックが失敗するとき」の節を追加
- **未確認**: 訪問者の実際の環境（ブラウザ・ネットワーク）。公開 URL もこのサンドボックスからは到達できない。

### 3.12 サイクル14: シグナリングの低遅延化（SSE / WebSocket、#45）

- **依頼**: sonneko（2026-11-23）。`plan.md` §4.2 の継続課題。
- **スコープ判断**: 仕様は §10.4.1 に追加（§9.4 は依頼文の参照違いで、シグナリングは §10.4 にある）。既定はポーリングのまま。版番号は 0.8.1 のまま。
- **変更**:
  - [x] 仕様 §10.4.1（トランスポート別の契約、再生・重複排除・順序・public-key の扱い）
  - [x] 設計 §3.35
  - [x] 参照サーバーの `/events`（SSE）と `/ws`（WebSocket）、`examples/lib/ws-server.mjs`
  - [x] `SseSignalingAdapter` / `WebSocketSignalingAdapter`（ライブラリの公開 API に追加）
  - [x] デモの `?signaling=poll|sse|ws`（既定 poll）
  - [x] 検証: `examples/verify-signaling-transports.mjs`（同一メッセージ列 30 件・80 KiB SDP を 3 経路で送り、受信結果の完全一致と遅延を計測）、`examples/verify-signaling-browser.mjs`（Chromium で経路ごとに 2 タブ実 WebRTC 接続、使われた経路（`/messages` / `/events` / `/ws`）も記録）。いずれも CI の `browser-e2e` で実行
  - [x] 単体テスト `webtcp_jslib/tests/signaling-transports.test.mjs`（17 件: 再接続・カーソル・`resume`・バックオフ・大容量フレーム・断片化フレーム・マスク・切断後の購読解除）
  - [x] 設計上の修正（開発中に検出）: 初回接続で以前の受信者向けのメッセージを再送すると、同じ NodeId の新しいリスナーに古い offer/candidate が届く。初回は未配信のみ再送、再接続（`resume=1`）は全件再送に分けた（仕様 §10.4.1）
  - [x] 修正（開発中に検出）: WebSocket の FIN だけの切断で購読が残り、サーバーの `close()` が完了しない。`ws-server.mjs` で `end` でも後始末
- **未確認**: 実際の中継（プロキシ・CDN）越しの挙動。GitHub Pages は静的配信のため、このトランスポートは使えない（サーバーが必要）。

### 3.13 サイクル15: API の中断伝播（`AbortSignal`、#44）

- **依頼**: sonneko（2026-11-23）。`plan.md` §4.2 の継続課題（#40 の恒久対策）。
- **スコープ判断**: Issue #44 が挙げる仕様の節（§9.1 IChannel 契約、§13.1 公開 API）は、現在の仕様書では別の内容を指している。IChannel 契約は §10.1、公開 API は §15.1、トランスポート層のタイムアウトは §8.5 にあるため、契約は新設の §8.6 にまとめ、§10.1 と §15.1 を更新した。既定の動作は変えない。版番号は 0.8.1 のまま。
- **変更**:
  - [x] 仕様 §8.6（中断の契約）、§10.1（`IChannel.connect` の行）、§15.1（公開 API の署名と説明）
  - [x] 設計 §3.36
  - [x] `core/util/abort.ts`（共通ヘルパー）、`TransportLayer.connect()` の中断（RST・タイマー・リスナーの解放）
  - [x] `IChannel.connect(targetId, options?)` / `LinkManager.connectToNeighbor()` / `WebRTCChannel.connect()`（待機者単位の中断、発信側かつ待機者ゼロのときだけ破棄）
  - [x] `WebTCPNetwork.connect()` / `connectToPeer()` / `connectURL()` / `bootstrap()`、`NameServer` と `HTTPClient` からの伝播
  - [x] 単体テスト `tests/abort-propagation.test.mjs`（9 件。変異で失敗することを確認）
  - [x] 実ブラウザ検証 `examples/verify-abort-browser.mjs`（実 RTCPeerConnection で接続試行中に中断し、閉じること・タイマーが残らないこと・warn が出ないこと・後続接続が成功すること。3 回実行して安定を確認。変異で失敗することを確認）。CI の `browser-e2e` で実行
- **既存の検証**: `npm test`、`verify-browser.mjs`、`verify-signaling-browser.mjs`、`verify-signaling-transports.mjs`、`verify-static-demo.mjs`（21 件）で回帰がないことを確認。
- **未確認 / 制限**: 送信済みの offer / SYN は取り消せない。`ISignalingAdapter.sendMessage()` は中断を受け取らない（HTTP 送信そのものは打ち切らない）。実ネットワーク（TURN 経由・NAT 越え）での中断は未検証。

### 3.14 サイクル16: 名前解決のデッドライン競合の修正（#72）

- **依頼**: sonneko（2026-11-23）。flaky テスト `domain-resolution: resolve honors its deadline and caller abort even when a peer stalls (#40)` を恒久対応する。
- **原因（実行で確認）**: 解決デッドラインのタイマーと問い合わせタイマーが同時刻に満了する。タイマー処理順によっては、期限で打ち切られた空応答が `NameNotFoundError` として `resolve()` を決着させた。同一プロセスで 60 回試行すると約 10%（7 / 60、3 / 60、8 / 60）で発生。修正前の単発 15 回・負荷下 15 回は偶然通っていた。
- **変更**:
  - [x] 仕様 §13.2（期限切れは `NameResolutionTimeoutError`、MUST）、設計 §3.23（#72 の項）
  - [x] `NameServer.queryNode()`: 解決デッドラインで打ち切られたら `NameResolutionTimeoutError`
  - [x] `NameServer.queryKnownNodes()`: 期限到達を記録し、空応答で終わった場合はタイムアウトとして返す
  - [x] 回帰テスト `domain-resolution: a deadline that ties with the query timer ...`（25 回連続で必ずタイムアウトになることを確認。修正前のコードでは失敗、修正後は通過）
- **検証**: 修正後の同一プロセス 60 回 × 2 回で `NameNotFoundError` 0 件（120 / 120 タイムアウト）。`domain-resolution.test.mjs` 単体を 5 回連続で 9 / 9 合格。`npm test` 260 件中 259 合格、0 失敗、1 skip。

### 3.15 サイクル17: HTTPClient の接続プールに上限・LRU・アイドル回収を入れる（#58）

- **依頼**: sonneko（2026-11-23）。Issue #58。仕様 → 設計 → 計画の順に更新してから実装する。関連 #50（L7 HTTP トンネルのビジョン、クローズ済み）を PR から参照する。
- **変更**:
  - [x] 仕様 §16.5（規則 5 を MUST に、規則 9〜11 を追加）、§16 の API 一覧（`maxPooledConnections` / `getPoolStats()`）
  - [x] 設計 §3.37（決定と既存の上書き不具合の扱い）、§3.26 のプール記述から §3.37 への参照
  - [x] `HTTPClient`: `maxPooledConnections`（既定 32）と LRU 追い出し（アイドルのみ、使用中は追い出さない）
  - [x] アイドル接続のタイマー回収（`idleTimeoutMs`、`unref`）と、アイドル中の相手切断の即時除去
  - [x] 同キーの並行接続で前の接続を上書きして閉じられなくなる不具合の修正（返却は 1 本だけ）
  - [x] `getPoolStats()` の公開（`HTTPPoolStats`）、`pooledConnectionCount` の互換維持
  - [x] テスト `tests/http-client-pool.test.mjs`（8 件。修正前のコードで 6 件失敗、変異 2 種で該当テストが失敗することを確認）、`npm test` 268 件中 267 件合格・0 失敗・1 skip
  - [x] 公開ドキュメント（website `reference/api.md`）の更新
- **既定値・API の互換**: 既定の keep-alive 挙動、`fetchURL()` の切断、`pooledConnectionCount` は変えない。版数は変更しない（ユーザー指示がない限り据え置き）。

### 3.17 サイクル19: 自動バインドで候補 0 件のときの接続失敗を原因つきにする（#61）

- **依頼**: sonneko（2026-11-24）。自動バインドで接続できないホストでも、接続するか、原因の分かるエラーで失敗させる。黙って 20 秒タイムアウトする状態をなくす。既定値は安易に変えない。
- **再現（実行で確認）**: この sandbox は `eth0` が `169.254.0.21/30` のみ（#61 の条件）。自動バインドの 2 ノードは候補 0 件（両方）、20 秒後に bootstrap が失敗。`bindAddress: '127.0.0.1'` は候補 1 件ずつ、250 ms で接続。
- **方針**: 既定の bind は変えない。候補 0 件のままのタイムアウトに原因を付ける（設計 §3.32）。自動フォールバックと既定の固定は採らない。
- **変更**:
  - [x] 仕様 §19.8 の #61 の制約行に、タイムアウトのエラーに原因を示す MUST を追記（`specification.md`）
  - [x] 設計 §3.32（問題、検討した (a)(b)(c)、判定、早期失敗を採らない理由、#67 / `watchIceGathering` との関係）
  - [x] `WebRTCChannel` の protected フック `describeConnectTimeout`（既定は空）と、`NodeWebRTCChannel` の判定の実装
  - [x] テスト `tests/webrtc-connect-timeout.test.mjs`（4 件）と子プロセス `tests/helpers/node-datachannel-timeout-probe.mjs`
  - [x] 公開ガイド `guides/bridge.md` に、タイムアウトのエラーに原因が含まれる旨を追記
- **検証（修正前後、実行）**:
  - 修正前: 原因の文言（fake・実 `node-datachannel`）が失敗 2 件、誤検出防止（候補あり・収集中）は合格 2 件。
  - 修正後: 4 件合格。自動バインドの bootstrap の警告に「0 local candidates」「bindAddress」「#61」が出ることを再現スクリプトで確認。接続の成否と待ち時間（20 秒）は変わらない。`127.0.0.1` は従来どおり 250 ms で接続。
- **順序の注意**: 指示は仕様 → 設計 → 計画の順で更新してから実装することだったが、実装を先に行った（実装の後にドキュメントを更新した）。PR の説明で明記する。
- **版数**: 0.8.1 のまま（挙動の変更はエラーメッセージの文言のみ。指示がない限り据え置き）。

### 3.16 サイクル18: node-datachannel/polyfill の icecandidate 配送（#67）

- **依頼**: sonneko（2026-11-24）。Issue #67 の原因切り分けと、上流の挙動の固定。
- **結論**: 上流（node-datachannel 0.33.6 の polyfill）の登録タイミング依存。リポジトリの実装は影響を受けない。「リスナーだけ届かない」という元の症状は再現せず、`addEventListener` と `onicecandidate` は同じ条件で同じ結果になった。
- **変更**:
  - [x] 仕様 §19.8（既知の制約 #67: 生成直後の同期登録が MUST）
  - [x] 設計 §3.31（#67 の原因、タイムライン、設計上の扱い。従来の「リスナーに届かなかった」記述を訂正）
  - [x] characterization テスト `tests/node-datachannel-polyfill.characterization.test.mjs`（(a) 同期登録は届く、(b) 遅延登録は 0 回、(c) `null` 終了イベントは送られない）。`node-datachannel` が無い環境では skip
  - [x] `nodeProvider.ts` の `watchIceGathering` のコメントを登録タイミングの説明に更新（挙動は変えない）
- **検証**: characterization テストを実行して回数を記録（下記）。上流の挙動を一時的に変えた変異（複製し、検証後に元へ戻した）でテストが失敗することを確認。`npm test` は `node-datachannel` を入れた状態で全件実行。
- **#61 への影響**: なし。`watchIceGathering` の判定は SDP なので、`127.0.0.1` で警告なし、自動バインドで警告ありのまま。
- **結果（候補の呼び出し回数。修正前・修正後とも同一。挙動は変えていない）**:
  - (a) 生成直後に登録: SDP 1 件 → `addEventListener` 1 回、`onicecandidate` 1 回。
  - (b) 約 300 ms 後に登録（収集は `complete` 済み）: SDP 1 件 → `addEventListener` 0 回、`onicecandidate` 0 回。
  - (c) `candidate === null`: `addEventListener` 0 回、`onicecandidate` 0 回。
  - 繰り返し: characterization テストを 5 回連続で実行し、いずれも 3/3 合格。`npm test` は 271 件すべて合格（`node-datachannel` を導入した状態）。`node-datachannel` を退避すると 3 件とも skip。
  - 変異の確認（上流の `RTCPeerConnection.mjs` を一時的に変更し、SHA-256 で元に戻したことを確認）: 遅延登録のリスナーへ候補を再送する変異では (b) が失敗（`addEventListener` 1 回）。`complete` 時に `candidate === null` を送る変異では (c) が失敗（各 2 回）。
- **実装上の注意**: `node-datachannel` は、PC を `close()` しても（生成のみでも）ネイティブのハンドルが残り、`node --test` のプロセスが終わらない（実測で 300 秒のタイムアウト）。そのため、各シナリオは子プロセス（`tests/helpers/node-datachannel-probe.mjs`、末尾で `process.exit`）で実行し、テストはその JSON 出力を検証する。

### 3.18 サイクル20: node-datachannel/polyfill の ICE 候補と終了マーカーの橋渡し（#67）

- **依頼**: sonneko（2026-11-25）。`icecandidate` をリスナーで受け取っても候補が届かない問題を修正する。上流で直せない場合は再現テストと回帰テストを残し、調査を記録する。
- **結論**: 上流（polyfill）は未修正のまま、アダプタ層で橋渡しした（設計 §3.38）。上流の挙動は characterization テストで固定し、変わったら検出する。
- **変更**:
  - [x] 仕様 §19.8 の #67 の制約を、橋渡しの MUST に更新（生の PC の同期登録は引き続き MUST）
  - [x] 設計 §3.31 の #67 の扱いを訂正し、§3.38 を追加（方針、仕組み、#61 との関係、適用範囲）
  - [x] `nodeProvider.ts` に `bridgeIceCandidateEvents` を追加し、`createNodeNetwork()` の factory に適用
  - [x] テスト `tests/icecandidate-bridge.test.mjs`（fake PC）、子プロセス probe（実 `node-datachannel`、修正前後の比較）
- **#61**: open のまま（host の自動バインド設定の問題で、この変更では解決しない）。
- **検証（実行）**:
  - 実 `node-datachannel` の修正前（生の PC）と修正後（橋渡し）。loopback の SDP 候補 1 件。
    - 修正前: 同タイミングの候補 1/1、後から登録 0/0、後から `onicecandidate` 0/0、終了マーカー 0 回。
    - 修正後: 同タイミング 1/1、後から登録 1/1、後から `onicecandidate` 1/1。終了マーカーは各リスナーで 1 回、候補の後。
    - 自動バインド（SDP 0 件）: 候補 0 件、終了マーカーは各リスナーで 1 回。
  - fake PC の論理テスト 12 件すべて合格。変異 M1（後から登録への再送を止める）で 7 件、M2（終了マーカーを出さない）で 6 件が失敗し、元に戻したことをハッシュで確認。
  - `npm test`: 289 件すべて合格、0 fail、0 skip（修正前は 275）。
- **#61 / #67 の関係**: #61 の判定（SDP 基準）と `describeConnectTimeout` は変わらない。#61 は open のまま。#67 の上流は未修正のため、characterization テストは従来どおり上流の挙動を固定する。

### 3.19 サイクル21: `once` リスナーの再登録（PR #81 のフォローアップ）

- **依頼**: sonneko（2026-11-25）。PR #81 のレビューで見つかった、DOM の `once` との意味論のずれを直す。
- **原因**: `registered` Set が、発火済みの `once` リスナーを除去しない。そのため、同じリスナーの再登録が重複として無言で捨てられる。
- **変更**:
  - [x] 仕様 §19.8 の #67 の制約に、`once` の意味論（発火後に除去、再登録可）を MUST として追記
  - [x] 設計 §3.38 に `once` の意味論と実装（配送後の除去、再登録は新しい登録）を追記
  - [x] 実装: `once` のリスナーは、発火時（コールバックの直前）に除去するラッパー経由で登録する（`nodeProvider.ts`）
  - [x] テスト: 再登録、一度だけの配送、発火前の重複、発火前の除去と再登録（`tests/icecandidate-bridge.test.mjs`）
- **検証（実行）**: 下記の PR の検証表。

### 3.20 サイクル22: 受信ウィンドウ（フロー制御、#56）

- **依頼**: sonneko（2026-11-26）。Issue #56 の受信ウィンドウを、方式を選んで実装する。プロトコル変更がある場合は v2 との互換性を設計に含める。
- **方式の比較**（詳細は `design.md` §3.39）:

  | 方式 | 後方互換 | 実装コスト | 効果 | 判定 |
  | :--- | :--- | :--- | :--- | :--- |
  | (1) v3 で窓を広告（ヘッダーまたは SYN オプション） | 旧ノードは更新かバージョン交渉が必要。長さ検証と署名の規則が変わる | 大（全テスト・シリアライザ） | 広告は得られる | 不採用 |
  | (2) v2 のまま `maxWindowBytes` を空きで縮める | 変更なし | 小 | 受信側は ACK を落とすしかなく、RTO と再送で切断に至る。フロー制御にならない | 不採用 |
  | (3) HTTP 層の `highWaterMark` を受信残量で縮める | 変更なし | 小 | `VirtualStream` の受信チャネルは ACK を返し続けるため L4 のバッファは伸びる。HTTP 以外を守れない | 単独では不採用。既存の `highWaterMark` と併用 |
  | (4) v2 のまま `WIN` ビット（bit 7）で交渉し、ACK 先頭 4 バイトに窓を載せる | 旧実装はビット 7 を無視。交渉しない接続は従来どおり | 中（シリアライザ 1 箇所、`VirtualStream` の交渉・広告・右端・問い合わせ） | 交渉した接続は送信が右端で止まり、受信側は全接続で上限を強制 | **採用** |

- **選んだ理由**: 後方互換（バージョンも署名規則も変えない）を保ったまま、受信バッファを有界にできる。(1) は効果が同等でもコストと互換のリスクが大きい。(2) と (3) は L4 のメモリを抑えられない。
- **変更**:
  - [x] 仕様 §6.3（ビット 7 を `WIN` とする）・§8.3.1・§8.3.3（`readExact` の上限）・§8.3.4（新設）・§19.7
  - [x] 設計 §3.39（方式の比較、交渉、フォールバック、実装の要点）・§10 と関連箇所
  - [x] 実装: `WebTCPPacket.windowFlag`（シリアライザの読み書き）、`VirtualStream`（`maxRecvBufferBytes`、交渉、窓付き ACK、右端、破棄、窓更新、問い合わせ、`getStats()`）
  - [x] 欠陥の修正: 先頭の欠損を埋めるセグメントは順序外保持バイトを押し出して格納する（相互運用試験で発見。§3.39）
  - [x] テスト: `tests/flow-control.test.mjs`（10 件: 修正前後の再現、交渉、フォールバック、窓更新の喪失、不正な相手、先頭の欠損の決定的回帰）
  - [x] 文書: README、`webtcp_website`（HTTP トンネル・ロードマップ）の「ウィンドウが無い」記述を更新。仕様 §8.3.4 と §19.7 に旧実装の回復時間の限界を記載
- **互換性の注意**: 旧実装の相手が、読み手の止まった接続で上限を超えて送ると、破棄→再送の末に切断されうる。従来は無制限にメモリを使っていた。利用者は `maxRecvBufferBytes` で調整する。
- **検証（実行）**:
  - 修正前（窓の実装前の `d4ef07d`）: `tests/flow-control.test.mjs` 0 / 7 合格（`/tmp/cy22/before.log`）。
  - 最終: `node --test tests/flow-control.test.mjs` 10 / 10 合格。`npm test` 304 / 304 合格（`/tmp/cy22/npmtest_final.log`）。
  - 変異試験（実ソースに 1 箇所ずつ適用し、SHA-256 で復元を確認）: M1 受信側の上限を外す → テスト 2 が失敗。M2 窓の問い合わせを外す → テスト 5 が失敗。M3 送信側の右端を外す → テスト 1・5・8 が失敗。M4 窓更新を外す → テスト 8 が失敗。M5 先頭の欠損の押し出しを外す → テスト 10 が失敗。M6 先頭の欠損を空き（順序外保持を含む）で判定する旧規則に戻す → テスト 10 が失敗。
  - 相互運用（`/tmp/cy22/interop_final.log`）: 旧→新（読み手 1.5 秒後、上限 256 KiB）は 1 MiB を受信し一致（約 122 秒。押し出し前は 245763 バイトで永久に停止）。新→旧は 59 ms で一致。
  - 受信メモリ: テスト 1 は遅い読み手で受信バッファが上限を超えないことと、送信側が止められることを確認する。

### 3.21 サイクル23: `bridgeIceCandidateEvents` の once リスナーが先頭の候補を再配送する（#83）

- **依頼**: sonneko（2026-11-26）。Issue #83（PR #84 のマージ後に起票）。`once` リスナーが自己再登録すると、先頭の候補を繰り返し受け取り、後続を取りこぼす。仕様 → 設計 → 計画の順に更新し、実装する。
- **原因**: `addEventListener` の `once` の経路が、常に `events[0]` を渡し、リスナーごとの位置を記録しない（設計 §3.38）。
- **選んだ方式**: リスナーごとの受信済みの位置（`cursor`）を持つ。登録・再登録のたびに、`cursor` 以降の未受信の候補から配送する。発火時と `removeEventListener` で `cursor` を記録の末尾まで進める。
- **選んだ理由**: 他のリスナーの配送に影響せず、DOM の「発火ごとに除去」と両立する。修正が最小で、既存の登録経路（同期の再送、二重登録の無視、`onicecandidate` の代入）を変えない。
- **検討して退けた案**:
  - 再登録のたびに先頭から渡す（修正前）: 重複し、後続を取りこぼす。
  - 発火済みの `once` の再登録を無視する: 候補を取りこぼす。
  - 発火時に記録の先頭を削る: 記録は PC 単位で共有されるため、他のリスナーの位置が壊れる。
- **変更**:
  - [x] 仕様 §19.8 の #67 の制約に、リスナーごとの位置と再登録の意味論（MUST）を追記
  - [x] 設計 §3.38 に、`cursor` の仕組み、`once` の意味論と位置、採用理由と退けた案を追記
  - [x] 実装: `nodeProvider.ts` の `bridgeIceCandidateEvents` に `cursor`（リスナーごと）を追加
  - [x] テスト: 再現（Issue #83 のプローブ）、再登録後の位置、通常リスナーの再登録（`tests/icecandidate-bridge.test.mjs`）
  - [x] 既存の関連テスト（`icecandidate-bridge.test.mjs` の既存 17 件、`icecandidate-bridge-node-datachannel.test.mjs` の実 `node-datachannel` 2 件）が壊れていないことを確認
- **検証（実行）**:
  - 再現（Issue #83 のプローブ、`/tmp/cy23/once_probe.test.mjs`）: 修正前 `received: candidate:1, candidate:1, candidate:1`（0/1 合格）→ 修正後 `candidate:1, candidate:2, candidate:3`（1/1 合格）。
  - `tests/icecandidate-bridge.test.mjs`: 修正前 17/20（#83 の 3 件が失敗、`/tmp/cy23/before.log`）→ 修正後 20/20（`/tmp/cy23/after.log`）。既存 13 番の期待を #83 の仕様に合わせて更新（再登録で候補 1 を重複させず、次の候補 2 から受け取る）。
  - 変異試験（実ソースに 1 箇所ずつ適用し、SHA-256 で復元を確認）: M-A 登録時の位置を常に 0 にする（修正前の動作）→ 4 件が失敗。M-B 発火時に位置を進めない → 2 件が失敗（13 番と 19 番）。
  - 実 `node-datachannel`（`npm install --no-save node-datachannel@0.33.6`、`package.json` は変更なし）: `icecandidate-bridge-node-datachannel.test.mjs` 2/2 合格（修正後）。
  - `npm test`（`webtcp_jslib`）: 300 合格、0 失敗、7 skip（うち実 `node-datachannel` の 2 件は `npm test` では未導入のため skip。上記で個別に 2/2 合格を確認）。

### 3.22 サイクル24: リンクローカルのみのホストで、node-datachannel の既定バインドを置き換える（#61）

- **依頼**: sonneko（2026-11-26）。Issue #61 の残件。Issue #83 の確認と、#61 の既定バインドの扱いを決める。
- **#83 の確認**: PR #85（マージ `ce51e5a`）は §19.8 の期待を満たす（再現プローブ 1/1、`icecandidate-bridge.test.mjs` 20/20、実 `node-datachannel` 2/2 を `main` で再実行）。Issue #83 をクローズした。
- **再現（実行、サイクル24）**: 非ループバックがリンクローカルのみ（`eth0` 169.254.0.21）の sandbox で、実 `node-datachannel` の 2 ノードを接続。自動と `0.0.0.0` は候補 0 件で開かない。`127.0.0.1` と `169.254.0.21` は候補 1 件で開く（設計 §3.40 の表）。ライブラリのログは、自動で IPv6 ソケットのみ（`any`）を開き `No local host candidates gathered` を出すことを示した。
- **選んだ方式**: (d) リンクローカルのみのホストに限り、既定のバインドをそのリンクローカル IPv4 アドレスへ置き換える（純関数 `chooseNodeDatachannelDefaultBindAddress`、`createNodeNetwork()` で `node-datachannel` のときだけ適用）。
- **選んだ理由**: 実行で、この候補が出て DataChannel が開くことを確認できた。適用範囲は「既定のままでは候補が 0 件になるホスト」に限られ、ルーティング可能なアドレスがあるホストの既定は変わらない（#61 の懸念を避ける）。明示の `bindAddress` は常に優先される。
- **退けた方式**:
  - (a) `127.0.0.1` へ再バインド: 同一ホストでしか成立しない。再収集が必要（§3.40）。
  - (b) 次のプロバイダへ切り替え: `node-datachannel` は既定の順序の最後で、次が無い（§3.40）。
  - (c) 警告のみ: 接続は成立しない（0.8.1 の状態）。
  - 既定を `127.0.0.1` に固定: #61 で却下済み。
- **変更**:
  - [x] 仕様 §19.8 の #61 の制約行（リンクローカル規則、ルーティング可能なアドレスがあるホストは不変、明示の優先、`@roamhq/wrtc` 不変、`127.0.0.1` 再バインドなし）
  - [x] 設計 §3.40（問題の表、観測した原因と推定の区別、(a)〜(d)、判定規則、適用、限界）
  - [x] 実装: `nodeProvider.ts` に純関数 `chooseNodeDatachannelDefaultBindAddress` と、`createNodeNetwork()` での適用（`node-datachannel` のときだけ、利用者の `bindAddress` が無いときだけ）
  - [x] テスト: 純関数の表形式テスト 8 件（`tests/default-bind-address.test.mjs`）と、実 `node-datachannel` の既定接続・優先のプローブ 2 件（`tests/default-bind-address-node-datachannel.test.mjs`、子プロセス `tests/helpers/node-datachannel-default-bind-probe.mjs`）
  - [x] 利用者向け文書: README（`--rtc-bind` の注記）、`webtcp_website` の bridge ガイド（リンクローカルのみのホストの注記）
  - [x] 既存の関連テスト（`bridge-webrtc`、`webrtc-connect-timeout`、`icecandidate-bridge-node-datachannel`）と `npm test`
  - [x] 上流への報告文案を Issue #61 のコメントに記録（下書き。外部へは起票しない。Muse の確認後）
- **検証（実行）**:
  - 修正前（実 `node-datachannel`、`createNodeNetwork()` の既定、2 ノード）: 接続失敗。`WebRTC connection ... timed out after 6000ms (ICE gathering finished with 0 local candidates ...)`（`/tmp/cy24/red_ndc.log`）。
  - 修正後: 接続成功、44 ms（`{"connected":true,"elapsedMs":44,"provider":"node-datachannel/polyfill","defaultAppliedWithoutOption":true,"defaultAppliedWithUserBind":false}`）。
  - 純関数: 修正前は import できず失敗（関数が無い）、修正後 8/8 合格。
  - 変異試験（実ソースに 1 箇所ずつ適用し、SHA-256 で復元を確認）: M1 既定を適用しない → 実 node-datachannel のテスト 2 件が失敗。M2 ルーティング可能なアドレスを無視 → 純関数のテスト 2 件が失敗（実 node-datachannel のテストは、この sandbox がリンクローカルのみのため通る。想定どおり）。M3 利用者の `bindAddress` による抑止を外す → 優先のテストが失敗。
  - 既定の順序: `@roamhq/wrtc`（`--no-save`）を入れて既定の順で解決すると、`@roamhq/wrtc` が選ばれ、既定の自動バインドで 47 ms で接続。リンクローカルの既定は適用されない（`defaultAppliedWithoutOption: false`）。`package.json` は変更なし。
  - `npm test`（`webtcp_jslib`、`@roamhq/wrtc` と `node-datachannel` の両方を導入した状態）: 317 合格、0 失敗、0 skip。`bridge-webrtc` は既定の解決で `@roamhq/wrtc` を使う（`127.0.0.1` 指定のまま）。
  - 限界: ルーティング可能なアドレスがあるホストは、この sandbox で実行できない（既定のまま、という規則のみ、テストは純関数の表で確認）。上流（libjuice の列挙）は直していない。
- **版数**: 0.8.1 のまま（指示がない限り据え置き）。

### 3.23 サイクル25: #61 のクローズアウトと上流報告の判断

- **依頼**: sonneko（2026-11-27）。PR #86（`Refs #61`）のマージ後、マージ済み main で再検証し、Issue #61 の扱いと上流報告を決める。
- **再検証（マージ済み main `ff69ec6`、実行）**: 修正前（`ce51e5a`）の既定接続は 3 回とも失敗（6010 / 6006 / 6006 ms、候補 0 件）。修正後（`ff69ec6`）は 3 回とも成功（45 / 46 / 46 ms）。生の `node-datachannel` の候補数（未指定 0、`0.0.0.0` 0、`127.0.0.1` 1、`169.254.0.21` 1）と libjuice のログは、報告文案の記述と一致した。
- **Issue #61 の判断: open のまま**。理由: (1) 上流（libjuice の wildcard 列挙）の挙動は残り、まだ報告されていない。(2) WebTCP の対応はリンクローカルのみのホストに限る。ルーティング可能なアドレスがあるホストは、この sandbox では検証していない。(3) 上流の起票先が確定して URL を記録してから、上流の修正を見て閉じる。
- **上流への報告: 起票できず**。報告文案の事実は `main` で確認でき、起票先は `murat-dogan/node-datachannel`（npm パッケージの宣言リポジトリ）で、同種の既存 Issue は無かった。しかし `gh issue create` が権限不足（`pull` のみ）で 2 回拒否された。別のリポジトリや別の認証では起票しない。報告文案は Issue #61 のコメントと `/tmp/cy25/upstream_issue.md` にあり、権限のある利用者が起票できる。
- **ドキュメント同期**: 設計 §3.40 の判定規則は実装どおり。仕様 §19.8 の文言が「すべてリンクローカル IPv4」となっており、実装（IPv6 のリンクローカルが混在しても、IPv4 があれば適用する）と合わなかったため、仕様を実装と設計に合わせて修正した。
- **変更**:
  - [x] 仕様 §19.8 の #61 の制約行（リンクローカルの定義を IPv4 と IPv6 の両方にし、IPv4 があることを条件とした）
  - [x] 計画 §3.23（本節）
- **版数**: 0.8.1 のまま。

### 3.24 サイクル26: #67 のクローズアウト判断と上流報告（polyfill の ICE 候補配送）

- **依頼**: sonneko（2026-11-27）。マージ済み main で #67 の挙動を再検証し、クローズの可否、上流報告の条件、ドキュメント同期を確認する。
- **再検証（マージ済み main `9e48e7e`、実行）**:
  - 既存の characterization（`tests/node-datachannel-polyfill.characterization.test.mjs`）3/3 成功。生成直後に登録したリスナーは候補 1/1（`addEventListener` / `onicecandidate`）、数百 ms 後に登録したリスナーは 0/0、`candidate === null` は 0 件。
  - 直接プローブ（`/tmp/cy26/issue67_probe.mjs`）: 生の PC の早期登録 1 件、遅延登録 0 件。`createNodeNetwork()` と同じ経路（橋渡し + `watchIceGathering`）の遅延登録は候補 1 件と終了マーカー 1 件を受け取る。既定バインド（候補 0 件）では警告が 1 回出て、`null` は 1 件。`127.0.0.1` では警告なし。
  - タイミング（20 回、`createDataChannel()` からの中央値）: `complete` 0.59 ms、`setLocalDescription()` の完了 0.65 ms、最初の候補イベント 0.75 ms。20/20 回で `complete` が完了より先。設計 §3.31 の旧記述（約 2 ms / 約 1 ms）は計測と合わないため修正した。
  - `npm test` 317/317 成功。
- **#67 の判断: open のまま**。リポジトリ側の対応（SDP での計数、橋渡し、characterization）は確認済みだが、上流の polyfill の挙動は未修正で、報告先の上流 Issue がまだ無い。閉じると追跡先が失われるため、上流 Issue の URL を記録してから判断する。
- **上流への報告: 起票できず**。条件（事実の再検証、起票先の確認、再現スクリプト）は満たした。起票先は `murat-dogan/node-datachannel`（npm の `repository`）で、既存の同種 Issue は見つからなかった。しかし `gh issue create` は `Resource not accessible by integration` で拒否された（サイクル25と同じ。統合の権限は READ）。繰り返さず、草稿を `/tmp/cy26/upstream_issue.md`、再現を `/tmp/cy26/upstream_repro.mjs` に保存し、草稿を #67 のコメントにも載せた。
- **ドキュメント同期**: 仕様 §19.8、設計 §3.31 / §3.38 / §3.40、計画 §3.16 / §3.18 は実装と一致。設計 §3.31 の計時の数値のみ計測値に修正した。
- **版数**: 0.8.1 のまま。

### 3.25 M9: タブ停止・リロードへの耐性（#51 の残課題、サイクル27）

- **依頼と前提の訂正**: sonneko（2026-11-27）。依頼は M8 を #51 とした。しかし M8 は #52 で完了しており（§3.8）、#51 の永続化と稼働維持の補助は M7 で実装済み（§3.7）。このため **M9** とし、#51 の残課題を扱う。M8 の行は変更しない。Issue #51 は open のままとし、閉じる判断は M9 の完了後に行う。
- **調査**: 実ブラウザで実行により確認した（仕様 §9.7、設計 §3.41）。核となる方式は不可能と分かった（Service Worker と Worker には `RTCPeerConnection` が無い）。このため、データプレーンは前面のページに残し、状態の保存・復元と前面復帰の再接続を中心に据えた。
- **スコープ（#51 の提案との対応）**

| #51 の提案 | 状態 | M9 での扱い |
| :--- | :--- | :--- |
| 1. `persistState()` / 起動時の復元 | M7 で実装済み | 自動保存（デバウンス）を追加する（§3.25 の 28） |
| 2. 稼働維持ヘルパー（Wake Lock・無音オーディオ・前面復帰・pagehide） | M7 で実装済み | 無音オーディオの実機検証と既定の判断（31）。Wake Lock は補助に限ると仕様化済み |
| 3. 再接続後の再告知 | 未実装 | 名前は pull 型のまま（§9.4）。リロード後の解決をリモートから検証する（32） |
| 4. 仕様 §9 の新設 | 完了（M7） | 限界を §9.7 に追記済み（本サイクル） |

- **マイルストーン**（各項目は実行で確認する。ヘッドレス Chromium と `/tmp/cy27/` の測定スクリプトを用いる。ブラウザが無い環境では実行しない）

| # | 内容 | 状態 |
| :--- | :--- | :--- |
| 27 | 調査（実行）と仕様 §9.7 / 設計 §3.41 / 計画 §3.25 | ✅ 文書化（本サイクル） |
| 28 | 自動 `persistState()`（名前・待ち受けの変更後にデバウンス）。Node（FakeIndexedDB）と実ブラウザの両方で検証 | ✅ 実装（本サイクル）。仕様 §9.8 / 設計 §3.42。Node 12 件（`tests/auto-persist.test.mjs`）、`npm test` 329 件合格。実ブラウザ `examples/verify-persistence-browser.mjs` 9/9 合格（有効化なしでは 7 件不合格）。`/tmp/cy27/measure_save.mjs` は廃止し、同じ計測を `examples/verify-persistence/index.html` の `window.measureSaveCost` で行う（リポジトリに含める理由: 再現可能な計測を残すため）。調査用の他のプローブ（keep-alive・凍結・SW）は sandbox 固有の依存（`@sparticuz/chromium`、puppeteer-core）があるため含めず、結果は設計 §3.41 に残す |
| 29 | `restoreState({ handlers })` でハンドラを付けられる形の API。リロード後に 7002 への接続が RST にならないことを実行で確認 | ✅ 実装（本サイクル）。仕様 §9.3、設計 §3.43。Node 5 件（`tests/restore-handlers.test.mjs`）、実ブラウザ 2 ノード（`examples/verify-reconnect-browser.mjs`、3 回合格）。対照（ハンドラを 15 秒後に付ける）では RST 49 件、修正では RST 0 件 |
| 30 | 既知の隣接先の保存と、復元後の `connectToPeer()`。2 タブで実測 | ✅ 実装（本サイクル）。仕様 §9.9、設計 §3.44。`neighbors` を任意で保存（NodeId のみ、16 件まで）、`reconnectNeighbors()` で再接続。Node 6 件（`tests/neighbor-restore.test.mjs`）、実ブラウザ 2 ノード（`examples/verify-neighbors-browser.mjs`）で再接続 1 回成功（57 ms、112 ms）、エコー `after-reload` 受信。対照（隣接未保存）は 0 件。ピア側の生存リンクは Node で再現できず、実ブラウザでも未検証（§9.9 の限界）。既知の不具合 #92（初回接続の 15 秒停止）、#93（`neighbor-connected` の重複発火）を別 Issue で追跡 |
| 31 | 無音オーディオ: 実機の自動再生ポリシー下で `AudioContext` の状態と効果を測定し、既定を決める（この環境では判定できなかった） | 未着手（未了。サイクル31では着手しない。ヘッドレスでは自動再生ポリシーの効果を判定できないため、実機検証が必要。#51 のクローズ判断の材料として残す） |
| 32 | 2 ノード以上で、リロード後の名前の解決を検証。Issue #51 を閉じるかの判断 | ✅ 検証（本サイクル）。仕様 §9.10、設計 §3.45。実ブラウザ（`examples/verify-name-reload-browser.mjs`、3 回合格、14/14）: 基準の解決 4〜12 ms、保持者の再読み込み後は切断から 387〜399 ms で解決とエコーが成功（再接続あり）、再接続なしは 15 秒間で解決 0 件。Node 2 件（`tests/name-after-restore.test.mjs`）。`npm test` 333 合格。#51 は**閉じない**（項目 31 が未了で、実機の非表示・凍結の下での挙動が未測定のため。判断と根拠は設計 §3.45 と PR 本文） |

- **非スコープ**: Service Worker の常駐化、データプレーンの移送、実機での長時間非表示の完全な再現（この環境では間引きが観測できないため、実機での検証を 31 と併せて行う）。
- **版数**: 0.8.1 のまま（文書のみ）。

## 4. 将来課題

### 4.1 セキュリティ（M3 完了、残課題は未定）

| 課題 | 内容 | 状態 |
| :--- | :--- | :--- |
| Ed25519 署名 | `Ed25519PacketVerifier` による署名付与・検証（プロトコル v2） | ✅ 完了 |
| NodeId の鍵指紋化 | `SHA-256(公開鍵)` の先頭 16 バイトを NodeId とする自己証明型識別子 | ✅ 完了 |
| 鍵管理 | `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）/ `NodeKeyManager`（`node:crypto`） | ✅ 完了 |
| 公開鍵配布 | シグナリング時交換 + `RT_UPDATE` 同梱 + `KeyDirectory` / `IPublicKeyResolver` | ✅ 完了 |
| リプレイ対策 | 基本方針は仕様化（§11.6）。トランスポートのシーケンス空間で重複を排除する。セッション Nonce による明示的な再生検知は将来強化 | 仕様化済み・強化は #48 |
| 鍵のローテーション | NodeId が鍵指紋であるため、鍵更新 = ノード ID 変更。証明書チェーン的な移行手段は未実装 | #47 |
| 鍵の分散ストレージ | `IPublicKeyResolver` を実装した IPFS 等のバックエンド | #47 |

### 4.2 ネットワーク強化（未定）

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| マルチホップ厳格化 | RPF の厳格化、ループ検出・スプリットホライズンの強化。 | #46 |
| シグナリングの低遅延化 | SSE / WebSocket ベースの `ISignalingAdapter` 実装を追加（サイクル14 / §3.12、既定はポーリングのまま）。 | #45 |
| 鍵学習の最適化 | 未知公開鍵の待機（既定 5 秒）を、オンデマンドな鍵照会リクエストに置き換える。 | #47 |
| API の中断伝播 | `connect()` / `connectToPeer()` / `TransportLayer.connect()` への `AbortSignal` 伝播（#40 の恒久対策）。サイクル15 / §3.13 で対応（仕様 §8.6、設計 §3.36）。 | #44 |

### 4.3 名前解決と分散ドメイン（M4 / M5 で実装・残課題は未定）

M3 の NodeId 鍵指紋化により**ノードの真正性**は検証できるが、**名前のグローバル所有権**は別問題である。M5 ではこれを「フルクライアントを載せない代わりに、検証可能にする」方針で解いた（specification.md §14、design.md §3.21）。チェーンへの実際の書き込み・実データとの照合は範囲外として切り出した。

| 課題 | 内容 | 状態 | Issue |
| :--- | :--- | :--- | :--- |
| `webtcp://` URL | `webtcp://nodeId:port/path` のパースと `connectURL()` による接続。 | ✅ M4 | #25 |
| NameServer | A/CNAME ローカル登録、TTL キャッシュ、既知ノードへの反復問い合わせ。 | ✅ M4 | #25 |
| 永続 NodeId | `BrowserKeyManager`（IndexedDB + 署名チャレンジ）と `NodeKeyManager.open({ keyFile })`。 | ✅ M4（マルチデバイス同期は #47） | #25 |
| `domain.global` | ゾーン定義、名前予約、解決フロー（`DomainAuthority`）。 | ✅ M5 | #25 |
| 署名付き所有権レコード | canonical バイト列 + 所有者 Ed25519 署名 + 指紋照合 + serial / 失効。 | ✅ M5 | #25 |
| 追記型台帳アンカー | Merkle 包含証明 + 署名済みチェックポイント + `prevHash` 連鎖による転落検知。 | ✅ M5（参照実装） | #25 |
| 検証の差し替え点 | `IDomainOwnershipVerifier` / `IChainAnchorVerifier`。 | ✅ M5（インターフェース + 既定実装） | #25 |
| **実ブロックチェーン検証** | Namecoin / EVM の実データ照合、SPV ヘッダー検証、keccak-256 + RLP 証明、`finality`。 | ❌ 未実装 | **#42** |
| **ガバナンス** | 紛争裁定、失効回収、複数ログ M-of-N 合意、IDNA / homoglyph、問い合わせ秘匿。 | ❌ 未実装 | **#43** |
| レジストリ運用 | 永続ログ鍵の管理、ディスク永続化、レート制限、スナップショット。 | ❌ デモはインメモリのみ | #42 / #49 |

### 4.4 品質・開発体験（継続課題）

| 課題 | 内容 |
| :--- | :--- |
| パッケージ公開 | npm 公開、`exports` のサブパス（`/adapters`）、セマンティックバージョニング。パッケージは未公開。文書バージョン 0.6.0 と npm パッケージバージョンは別管理とし、公開時に semver を決定する（現状 package.json は 0.1.0）。 → #49 |
| HTTP のフロー制御 | 交渉した接続は受信ウィンドウで送信が止まり、受信側は全接続で `maxRecvBufferBytes` を超えない（`specification.md` §8.3.4）。旧実装の相手とは窓が無く、上限超過分は再送になる。 → #56（サイクル22） |
| HTTP のフル実装 | HTTP/2・WebSocket アップグレード・`CONNECT`・圧縮・Cookie ジャー・認証・リダイレクト追従 → #57 |
| HTTP の性能 | ヘッダパースのゼロコピー化、接続プールの上限・LRU（#58）、`chunked` 書き込みのバッファリング。ベンチマーク未整備。 |
| `VirtualStream.destroy()` の通知 | ~~`destroy()` が RST も FIN も送らない~~（0.8.1 で修正。`destroy()` は RST で中断する）→ #54 |
| パフォーマンス | シリアライザのゼロコピー化、バッファプール、大量セッション時のベンチマーク。Ed25519 署名のバッチ検証。 |
| 相互運用 | v1 のみのノードとの併存運用（`NullPacketVerifier` + `requireSignatures: false`）。 |

### 4.5 ビジョンとの差分（M6 完了時の正直な評価）

README の主張「ブラウザを自己完結型のサーバー実行環境にする」に対して、M6 完了時点で**プロトコル層（TCP 相当・身元・名前・所有権の検証・HTTP）が揃い、運用層が無い**。率直な差分は次の 2 本である（#50 は本サイクルで解消）。

| ギャップ | 現状 | Issue |
| :--- | :--- | :--- |
| ブラウザはサーバーとして生き残れない（M7 で緩和。凍結中の到達不能は残る） | 非可視タブのサスペンド、リロード時の待ち受け・名前登録・提供レコード・HTTP ハンドラの消失（鍵だけが永続する非対称）。Wake Lock / Service Worker / 状態復元はいずれも未実装 | **#51** |
| 入口が WebRTC 話者に限定される | M8 で解消（#52）: curl や既存アプリをトンネルへ入れるブリッジ（仕様 §19）を追加した。Node 側 WebRTC は引き続き非同梱で、導入済みのものを解決する。 | ~~#52~~（M8 で対応） |

なお、これらは各マイルストーンの受け入れ条件（ブラウザにチェーンクライアントを載せず検証可能な所有権に絞る、HTTP はサブセットに留める）とは別軸の評価である。**「HTTP を話せるようにした」ことと「既存の HTTP クライアントから使える」ことは別**であり、#52 が無い限り後者は成立しない — この線引きは次サイクルでも守る。

## 5. リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| ブラウザごとの SCTP/DataChannel のメッセージサイズ差異 | 大きなパケットが送れない | 既定 MSS を 16 KiB に設定し 60 KiB 超を自動分割（M2 で解消）。 |
| Symmetric NAT での接続失敗 | P2P 直接接続不可 | `iceServers` と動的 TURN 資格情報フック `iceServersProvider`、自動 ICE 再起動を提供（M2 で対応）。TURN サーバー自体は利用者配備。 |
| Web Crypto の Ed25519 非対応ブラウザ（Chrome 136 以前等） | 署名付き通信ができない | デモは自動で v1 へフォールバック。ライブラリは `keyManager` 未指定なら v1（`NullPacketVerifier`）で動作し、対応ブラウザでは v2 を使う（M3 で対応）。 |
| 未知ピアの公開鍵未着による初回パケットの取りこぼし | 接続直後に一時的に通信できない | `RT_UPDATE` への公開鍵同梱（自己証明）+ シグナリング時交換 + 最大 5 秒の鍵待機（M3 で対応）。 |
| 距離ベクトルの収束遅延 | 3 ノード以上で一時的に到達不能 | 直接隣接への送信は常に許可。ルーティング強化は #46。 |
| ドメイン台帳のログ鍵が単一障害点 | 台帳が過去を書換えると検出不可能（PIN 以降のみ検出） | チェックポイントの `prevHash` 連鎖と `treeSize` 単調性で抑止（M5）。複数ログの M-of-N 合意は #43。ログ鍵は `KeyDirectory` と同じ指紋自己証明。 |
| 実チェーン未検証の誤解 | 「オンチェーンで保証されたドメイン」と誤読されるリスク | `chainVerified: null` を結果へ明示し、`requireChainAnchor` で fail-closed。README / サイトにも「検証可能な設計まで」を明記（M5）。 |
| 仕様と実装の乖離 | 保守性低下 | 各サイクル冒頭でドキュメント同期チェックを行い、仕様変更時は同一 PR で更新する。 |
| サービス役のブラウザが停止する | 「常時稼働する P2P サービス」の実用性がゼロに近い | M7 で緩和（#51）: 状態の永続化・復元と keep-alive 補助。凍結中のタブは到達不能のままで、仕様 §9.6 と README / サイトに明記する。 |
| HTTP 層の入力検証漏れ（スマグリング・インジェクション） | プロキシ的な位置づけのため、フレーミングの曖昧さが乗っ取りに直結する | `Content-Length` と `Transfer-Encoding` の併用拒否、CRLF 厳格、ヘッダ書き込みのインジェクション拒否、行長・ヘッダ数・本文サイズの上限を仕様（§16.2.1 / §16.7）とテストで固定する。 |
| HTTP 応答の無制限バッファ | 遅い／巨大なレスポンスでメモリを枯渇させる | `HTTPClient` の `maxResponseBytes`（既定 8 MiB）とストリーミング API を既定にする。受信ウィンドウが無いことは仕様に明記（§8.3.1）。 |
| ブリッジ経由の無認証アクセス | ローカルポートを開く設計はトンネルへの無認証入口を作る | #52 では `requireSignatures` 必須・localhost バインド既定・v1 ノードへの転送拒否を設計条件として明記する。 |

## 6. Issue 運用

### 6.1 M1 で修正した Issue

#1 〜 #21（すべてクローズ済み）。

### 6.2 M2 で対応した Issue

| # | 種別 | 内容 |
| :--- | :--- | :--- |
| #22 | documentation | `webtcp_website` を WebTCP 公式 Starlight ドキュメントサイトへ刷新 |
| #23 | enhancement | TCP セマンティクス完成（バイトストリーム・自動分割・動的 RTO・輻輳制御・Fast Retransmit / SACK・ランダム ISN・Half-Close） |
| #24 | enhancement | TURN / ICE 設定文書化、動的資格情報フック、デモ STUN 設定例、自動 ICE 再起動 |
| #26 | enhancement | レベル付きロガー導入と `console.*` 直書き廃止 |
| #27 | enhancement | `WebTCPNetwork.bootstrap(searcher)` とリトライ・指数バックオフ |
| #30 | bug | `RoutingTableManager` の同一コスト `RT_UPDATE` `lastSeen` 未更新・重複送信・TTL 減算タイミング修正 |
| #31 | bug | `TransportLayer` の `listen` ハンドラ呼出時期（`ESTABLISHED` 化）・`SYN` の `ackNum=0`・ピギーバック ACK・ポート衝突回避 |
| #32 | bug | `WebRTCChannel` 同時接続 Glare 解決、`EntranceSearcherAdapterHub` `exclude` オプション、デモ UI と `package.json` の不備修正 |

### 6.3 M3 で対応した Issue

| # | 種別 | 内容 |
| :--- | :--- | :--- |
| #28 | security | Ed25519 署名（`Ed25519PacketVerifier`）・NodeId の鍵指紋化・`BrowserKeyManager` / `NodeKeyManager`・公開鍵配布・プロトコル v2・仕様書 §11 更新 |
| #13 | security | Null 検証器の暫定対応を解消（既定は v2。`NullPacketVerifier` は v1 相互運用専用として残置） |

### 6.4 M4 で参照した Issue（完了・close 済み）

| # | 内容 | 扱い |
| :--- | :--- | :--- |
| #25 | NameServer / `webtcp://` / `domain.global` / ブロックチェーン連携 | M4 で前半、M5 で残りを実装 → M5 PR で close |
| #35 | M3 時点の文書同期ずれ | M4 PR #39 で修正 → C5 で close |
| #36 | 永続鍵復元・NodeId 衝突・Node.js 永続化 | M4 PR #39 で修正 → C5 で close |
| #37 | RT_UPDATE 受信元検証とマルチホップ鍵伝播 | M4 PR #39 で修正 → C5 で close |
| #38 | 起動再試行・end 状態・cwnd 上限回帰・ICE 再起動 | M4 PR #39 で修正 → C5 で close |

### 6.5 M5 で対応・起票した Issue（振り返り）

| # | 種別 | 内容 | 扱い |
| :--- | :--- | :--- | :--- |
| #25 | enhancement | NameServer / `webtcp://` / `domain.global` / ブロックチェーン連携 | M5 で完遂 → PR #53 で close |
| #40 | bug | `NameServer.resolve()` が `resolveTimeoutMs` / `AbortSignal` を `connect()` 宙吊り中に無視する | 本 PR で修正 |
| #41 | bug | `Ed25519PacketVerifier` が注入シリアライザを無視し、`serializeForSigning` 欠落時に v1 署名対象へ黙ってフォールバック | 本 PR で修正 |
| #42 | enhancement | 実チェーン（Namecoin / L1 / SPV / EVM 証明）によるアンカー検証 | 未定 |
| #43 | enhancement | `domain.global` のガバナンス（紛争裁定・失効回収・複数ログ合意・IDNA） | 未定 |
| #44 | enhancement | `connect()` 系への `AbortSignal` 伝播 | 本 PR で対応（サイクル15 / §3.13） |
| #45 | enhancement | SSE / WebSocket ベースの `ISignalingAdapter` | 未定 |
| #46 | enhancement | RPF 厳格化と距離ベクトル収束強化 | 未定 |
| #47 | enhancement | 鍵ライフサイクル（オンデマンド照会・ローテーション・分散ストレージ） | 未定 |
| #48 | enhancement | セッション Nonce / タイムスタンプによるリプレイ検知 | 未定 |
| #49 | enhancement | npm 公開・semver・`exports` サブパス | 未定 |
| #50 | enhancement | アプリケーション層 HTTP トンネル（L7）未実装 — README 構想の後半 | ビジョン評価で起票 → **M6 で実装**（§6.6） |
| #51 | enhancement | タブ停止・リロードに耐えるサービス継続（稼働維持と状態の永続化） | ビジョン評価で起票 → M7 で部分対応（仕様 §9） |
| #52 | enhancement | ブラウザ外部の既存クライアントをトンネルへ入れるブリッジ | ビジョン評価で起票 → **M8 で実装**（§3.8） |

### 6.6 M6 で対応・起票した Issue

| # | 種別 | 内容 | 扱い |
| :--- | :--- | :--- | :--- |
| #50 | enhancement | アプリケーション層 HTTP トンネル（L7）が未実装 | 本 PR で実装 → close |
| #54 | bug | `VirtualStream.destroy()` が RST も FIN も送らず、相手側ストリームが `ESTABLISHED` のまま残る（M6 実装中に発見。HTTP 層は `end()` のみで回避） | 0.8.1 で修正（§3.9）→ close |
| #55 | documentation | M6 開始時の網羅同期チェックで見つかった文書の陳腐化（`plan.md` の M5 ステータス、README の M4「実装済み」・テスト件数、`path` / `query` の記述、`DomainQueryTransport` の残存、全角混入） | 本 PR で修正 → close |
| #56 | enhancement | 受信ウィンドウ（フロー制御）の広告が無く、大きな HTTP 応答が受信側メモリに依存する | サイクル22（§3.20）で対応中（PR で参照） |
| #57 | enhancement | HTTP/2・WebSocket アップグレード・`CONNECT`・圧縮・Cookie ジャー・認証・リダイレクト追従（HTTP 層のフル実装） | 起票して 未定（§4.4） |
| #58 | enhancement | `HTTPClient` の接続プールが上限・LRU を持たず、多数の `(nodeId, port)` で `VirtualStream` を保持し続ける | 起票して 未定（§4.4）→ サイクル17 / §3.15 で対応（PR 作成、マージ待ち） |

### 6.7 M8 で対応・起票した Issue

| # | 種別 | 内容 | 扱い |
| :--- | :--- | :--- | :--- |
| #52 | enhancement | ブラウザ外部の既存クライアントをトンネルへ入れるブリッジ | 本 PR で実装（§3.8）→ close |
| #61 | bug | `node-datachannel` が、リンクローカルのみのホストで自動バインド時に ICE 候補を 0 件にする | 起票。回避は `peerConnectionOptions.bindAddress` / `--rtc-bind`。既定の扱いは未決 |
| #62 | bug | Node の `net.createServer()` は既定で `allowHalfOpen: false`。半クローズ後の応答が届かない（ブリッジ実装中に発見） | 本 PR で修正（`allowHalfOpen: true`）。回帰テストあり → close |
| #63 | bug | `domain-resolution` の経過時間アサーション（#40）が全体テストの負荷で不安定 | 起票。本 PR では触らない（既存の不安定さ） |

### 6.8 0.8.1 で対応・起票した Issue

| # | 種別 | 内容 | 扱い |
| :--- | :--- | :--- | :--- |
| #54 | bug | `destroy()` が RST を送らず、相手が `ESTABLISHED` のまま残る（M6 から持ち越し） | 本 PR で修正（`destroy()` は RST で中断。§3.9）→ close |
| #63 | bug | `domain-resolution` の経過時間アサーション（#40）が全体テストの負荷で不安定 | 本 PR で修正（不変条件に合わせて判定を変更）→ close |
| #61 | bug | `node-datachannel` が自動バインドで ICE 候補を 0 件にする | 調査の記録を Issue に残し、候補 0 件の警告を入れた（既定は変えない）。原因の切り分けは未確定のため open のまま |
| #55 | documentation | M6 開始時の網羅同期チェックの残り（簡体字の `前缀`、§17 → §19） | 本 PR で修正。他の項目は既に修正済みと確認 |
| #65 | bug | 対応セッションの無い RST に RST を返し、両端 `destroy()` で往復し続ける可能性（#54 修正中に発見） | 本 PR で修正（RST への返信を抑止）。仕様 §8.2 に MUST NOT |
| #66 | bug | 受信 RST で `error` リスナーが無いと例外になる（#54 修正中に発見） | 本 PR で修正（リスナーがある場合のみ発火）。仕様 §8.2 に明記 |
| #61 | bug | 自動バインドで候補 0 件のホストの接続失敗に原因が無い（サイクル19） | タイムアウトのエラーに候補 0 件と `bindAddress` の指定を示した（既定は変えない）。設計 §3.32、§3.17。Issue #61 は open のまま |
| #67 | bug | `node-datachannel/polyfill` が `icecandidate` を `addEventListener` のリスナーへ配送しない（#61 の調査中に発見） | 起票。SDP で候補を数えて回避。サイクル18 / §3.16 で上流の登録タイミング依存と切り分け、characterization テストで固定。サイクル20 / §3.18 で `createNodeNetwork()` 経由の PC に候補と終了マーカーの橋渡しを追加（設計 §3.38） |
