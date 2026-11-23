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
| S5 | `specification.md` §8.3.1 / `design.md` §11 | パケットに受信ウィンドウが無い（フロー制御なし）ことが何処にも書かれていない。実装は `maxWindowBytes` と輻輳制御のみ | 「受信ウィンドウの広告は行わない」を明記し、HTTP 層の大きな応答に関する注意を追加 |
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
- **スコープ判断**: プロトコル・API・版番号は変えない（文書バージョン 0.8.1 のまま。版上げは別指示）。設計判断は `design.md` §3.32。
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
  - [x] `design.md` §3.33（ICE 候補の事前診断）
  - [x] 自己チェックの step 0（ICE 候補の事前診断）と、step 1 の失敗時の内訳表示
  - [x] `verify-static-demo.mjs`: 既定の起動設定で実行し、候補 0 件の場合の早期の診断も確認する
  - [x] デモガイドに「自己チェックが失敗するとき」の節を追加
- **未確認**: 訪問者の実際の環境（ブラウザ・ネットワーク）。公開 URL もこのサンドボックスからは到達できない。

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
| シグナリングの低遅延化 | SSE / WebSocket ベースの `ISignalingAdapter` 実装追加。 | #45 |
| 鍵学習の最適化 | 未知公開鍵の待機（既定 5 秒）を、オンデマンドな鍵照会リクエストに置き換える。 | #47 |
| API の中断伝播 | `connect()` / `connectToPeer()` / `TransportLayer.connect()` への `AbortSignal` 伝播（#40 の恒久対策）。 | #44 |

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
| HTTP のフロー制御 | 受信ウィンドウの広告が無く、大きな HTTP 応答は受信側メモリに依存する（`specification.md` §8.3.1）。 → #56 |
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
| #44 | enhancement | `connect()` 系への `AbortSignal` 伝播 | 未定 |
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
| #56 | enhancement | 受信ウィンドウ（フロー制御）の広告が無く、大きな HTTP 応答が受信側メモリに依存する | 起票して 未定（§4.4） |
| #57 | enhancement | HTTP/2・WebSocket アップグレード・`CONNECT`・圧縮・Cookie ジャー・認証・リダイレクト追従（HTTP 層のフル実装） | 起票して 未定（§4.4） |
| #58 | enhancement | `HTTPClient` の接続プールが上限・LRU を持たず、多数の `(nodeId, port)` で `VirtualStream` を保持し続ける | 起票して 未定（§4.4） |

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
| #67 | bug | `node-datachannel/polyfill` が `icecandidate` を `addEventListener` のリスナーへ配送しない（#61 の調査中に発見） | 起票。本 PR では SDP で候補を数えて回避。上流の挙動は未確認 |
