# WebTCP 開発計画書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.5.0 |
| 対応仕様 | `specification.md` 0.5.0 |
| 対応設計 | `design.md` 0.5.0 |
| 最終更新 | 2026-11-14 |
| 現在のマイルストーン | **M5 実装（`domain.global` と検証可能なドメイン所有権証明。次フェーズ: M6 実チェーン検証とネットワーク強化）** |

---

## 1. 開発経緯

- **M0（設計文書化）**: `specification.md` / `design.md` / `plan.md` の整備と既存課題の Issue 化を完了。
- **M1（最小の end-to-end）**: ブラウザ非依存コア再構成、v1 シリアライザ、WebRTC / シグナリング / エントランス探索アダプタ、2 タブデモ、テスト 18 件、CI を完了し `main` へマージ済み。
- **M2（TCP セマンティクス完成と運用基盤）**: バイト単位 Seq/Ack・ランダム ISN・60 KiB 超の自動分割・動的 RTO・輻輳制御・Fast Retransmit / SACK・Half-Close・レベル付きロガー・`bootstrap()` 自動接続・TURN/ICE 設定と自動 ICE 再起動・Starlight ドキュメントサイト・実ブラウザ 2 タブ検証の仕組みを整備した。
- **M4（NameServer / #25 前半）**: PR #39 で main にマージ済み。NameServer（A/CNAME・TTL キャッシュ・既知ノード反復解決）、`webtcp://` URL と `connectURL()`、永続 NodeId（署名チャレンジ復元・`keyFile` 永続化・衝突検出）、`RT_UPDATE` の受信元検証とマルチホップ鍵伝播、デモと Playwright 検証拡張、ドキュメント全面同期を実施。#25 のうち `domain.global` / ブロックチェーン連携は M5 へ持ち越した。
- **M3（セキュリティ / #28）**: PR #34 で main にマージ済み。**Ed25519 署名**と **NodeId の公開鍵指紋化**（プロトコル v2）、ブラウザ用 `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）、Node.js 用 `NodeKeyManager`、公開鍵の配布（シグナリング交換 + `RT_UPDATE` 同梱）、署名・検証・鍵導出のテストを追加した。

## 2. マイルストーン

| ID | 名称 | 状態 | 概要 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | ✅ 完了 | 仕様書・設計書・計画書、Issue 整理 |
| M1 | 最小の end-to-end | ✅ 完了 | アダプタ実装、コア修正、ビルド、デモ、テスト |
| M2 | TCP セマンティクスの完成と運用基盤 | ✅ 完了 | バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close・ロガー・`bootstrap()`・TURN/ICE 再起動・ドキュメントサイト・実ブラウザ検証 |
| M3 | セキュリティ | ✅ 完了（#34 マージ済み） | Ed25519 署名（プロトコル v2）・NodeId の鍵指紋化・`KeyManager`（IndexedDB / node:crypto）・公開鍵の配布（#28） |
| **M4** | **NameServer と webtcp:// URL** | ✅ 完了（#39 マージ済み） | NameServer（A/CNAME・ローカル登録・既知ノード問い合わせ）、`webtcp://`、永続 NodeId と衝突検出、デモ/サイト（#25） |
| **M5** | **`domain.global` と検証可能なドメイン所有権証明** | **実装済み（PR レビュー待ち）** | 署名付き所有権レコード、追記型台帳の Merkle / チェックポイント検証、プラガブルな検証インターフェース、`NameServer` 統合、参照レジストリ（HTTP）、デモ（#25 / #40 / #41）。RPF 厳格化・SSE/WebSocket・鍵ライフサイクル等は #42〜#49 へ切り出し |
| M6 | 分散ドメインの実運用化とネットワーク強化 | 未着手 | 実チェーン検証（#42）、ガバナンス（#43）、RPF 厳格化（#46）、SSE/WebSocket（#45）、鍵ライフサイクル（#47）、リプレイ強化（#48）、パッケージ公開（#49） |

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
- [x] `specification.md` §8.2〜§8.5 / §9.3〜§9.6 / §11〜§12 の拡張
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
  - [x] **specification.md §10 の全面更新**（脅威モデル・署名対象・鍵配布・リプレイ対策・既知の制約）
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

### 3.5 M5（本サイクル / #25 残り）

着手前に main（`b4a9c54` = PR #39 マージ後）でドキュメントと実装の網羅同期チェックを行い、新規発見分を #40（`NameServer.resolve()` のデッドライン未遵守）と #41（`Ed25519PacketVerifier` のシリアライザ非同一性）へ整理した。M4 で修正済みだった #35〜#38 は内容確認のうえ close した。

- [x] 仕様書 0.5.0 → 設計書 0.5.0 → 計画書 0.5.0 の順に更新（§13 を新設し、公開 API を §14 へ繰下げ）
- [x] **`domain.global` ゾーン**（specification.md §13.1）: 単一ゾーン、ASCII LDH、ローカル登録からの予約（`registerA` / `registerCNAME` はゾーン名を拒否）
- [x] **所有権レコード**（§13.2）: 固定キー順の canonical バイト列 + 所有者 Ed25519 署名 + 指紋照合 + `serial` / 有効期間 / 失効。**未知キー拒否の厳格パース**を必須化
- [x] **追記型台帳と検証可能なアンカー**（§13.3）: 領域分離付き Merkle 木（葉 `0x00`、内部 `0x01`、奇数 promote）、包含証明、ログ鍵による署名済みチェックポイント、`treeSize` 単調性と `prevHash` 連鎖によるロールバック検出
- [x] **プラガブルな検証インターフェース**（§13.4）: `IDomainOwnershipVerifier`（既定実装は fail-closed）、`IChainAnchorVerifier`（実チェーン検証への差し替え点。未設定は `chainVerified: null` として正直に区別）、`createDomainProofCache`
- [x] **解決フロー**（§13.5）: `DomainAuthority`（ローカル / `IDomainRecordSource` / 既知ノードの 3 系統を並列収集 → 検証 → `serial` → `leafIndex` → commitment で勝敗決定、同 serial 異内容は `conflict` で失敗）、成功・失敗両キャッシュ、上限とタイムアウト
- [x] **NameServer / `webtcp://` 統合**（§12.2 / §12.3）: `protocol: 1` への `wantOwnership` / `ownership` 追加（後方互換）、`ns.registerDomain()`、ゾーン名の `registerA` 拒否、`NameResolution.source === 'domain'`、所有権レコード無し応答は不使用
- [x] **参照レジストリの実装**（§13.6）: `examples/server.mjs` に `/domain/*`（登録・検索・チェックポイント）、`HttpDomainRegistryClient` アダプタ
- [x] **#40 修正**: 問い合わせを `AbortController` で統一し、`connect()` 宙吊りでもデッドラインを守る（最初の成功 or 全体タイムアウトで return、待機残は破棄）
- [x] **#41 修正**: `WebTCPNetwork` が注入 `serializer` を検証器へ伝播、`serializeForSigning` 非実装時の黙ったフォールバックを構築時エラーへ変更
- [x] デモ拡張: セクション 3 で「自分のドメインクレームに署名 → 参照台帳へ submit → アンカー付きで `registerDomain()` →ピア経由で解決」を手動操作でき、1 タブ自己チェックのステップ **1d** が同じ流れを自動化する（(a) 台帳経由、(b) 既知ノードの `wantOwnership` 応答のみ、(c) 未登録名前の fail-closed、(d) 改ざんの 400 拒否）。`examples/verify-browser.mjs` は 1d の成功を必須化した
      ※ 2 タブ自動モード（`?role=…&autostart=1`）は M4 までのフローのまま残している。ドメイン登録は手動ボタンと自己チェック 1d のみで自動実行しない（自動モード側へ足す価値は低いが、差は認識しておく）
- [x] README / docs/layer / webtcp_website を同期（新ガイド `guides/domain-ownership.md`、API リファレンス、ロードマップ、仕様サマリー）
- [x] テスト追加（`domain-record` / `domain-merkle` / `domain-verify` / `domain-ledger` / `domain-resolution` / `domain-registry-http` の 41 + 1 ケース、`demo-server.test.mjs` に `/domain/*` ルーティング）— `npm test` は 150 件全通過
- [ ] **スコープ外 → Issue 化**: 実チェーン検証（#42）、ガバナンス / IDNA / 複数ログ合意（#43）、`connect()` 系の中断伝播（#44）、SSE / WebSocket（#45）、RPF 厳格化（#46）、鍵ライフサイクル（#47）、リプレイ強化（#48）、パッケージ公開（#49）

## 4. 将来課題

### 4.1 セキュリティ（M3 完了、残課題は M6 以降）

| 課題 | 内容 | 状態 |
| :--- | :--- | :--- |
| Ed25519 署名 | `Ed25519PacketVerifier` による署名付与・検証（プロトコル v2） | ✅ 完了 |
| NodeId の鍵指紋化 | `SHA-256(公開鍵)` の先頭 16 バイトを NodeId とする自己証明型識別子 | ✅ 完了 |
| 鍵管理 | `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）/ `NodeKeyManager`（`node:crypto`） | ✅ 完了 |
| 公開鍵配布 | シグナリング時交換 + `RT_UPDATE` 同梱 + `KeyDirectory` / `IPublicKeyResolver` | ✅ 完了 |
| リプレイ対策 | 基本方針は仕様化（§10.6）。トランスポートのシーケンス空間で重複を排除する。セッション Nonce による明示的な再生検知は将来強化 | 仕様化済み・強化は #48 |
| 鍵のローテーション | NodeId が鍵指紋であるため、鍵更新 = ノード ID 変更。証明書チェーン的な移行手段は未実装 | #47 |
| 鍵の分散ストレージ | `IPublicKeyResolver` を実装した IPFS 等のバックエンド | #47 |

### 4.2 ネットワーク強化（M6 以降）

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| マルチホップ厳格化 | RPF の厳格化、ループ検出・スプリットホライズンの強化。 | #46 |
| シグナリングの低遅延化 | SSE / WebSocket ベースの `ISignalingAdapter` 実装追加。 | #45 |
| 鍵学習の最適化 | 未知公開鍵の待機（既定 5 秒）を、オンデマンドな鍵照会リクエストに置き換える。 | #47 |
| API の中断伝播 | `connect()` / `connectToPeer()` / `TransportLayer.connect()` への `AbortSignal` 伝播（#40 の恒久対策）。 | #44 |

### 4.3 名前解決と分散ドメイン（M4 / M5 で実装・残課題は M6）

M3 の NodeId 鍵指紋化により**ノードの真正性**は検証できるが、**名前のグローバル所有権**は別問題である。M5 ではこれを「フルクライアントを載せない代わりに、検証可能にする」方針で解いた（specification.md §13、design.md §3.21）。チェーンへの実際の書き込み・実データとの照合は範囲外として切り出した。

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
| パッケージ公開 | npm 公開、`exports` のサブパス（`/adapters`）、セマンティックバージョニング。パッケージは未公開。文書バージョン 0.5.0 と npm パッケージバージョンは別管理とし、公開時に semver を決定する（現状 package.json は 0.1.0）。 → #49 |
| パフォーマンス | シリアライザのゼロコピー化、バッファプール、大量セッション時のベンチマーク。Ed25519 署名のバッチ検証。 |
| 相互運用 | v1 のみのノードとの併存運用（`NullPacketVerifier` + `requireSignatures: false`）。 |

### 4.5 ビジョンとの差分（M5 完了時の正直な評価）

README の主張「ブラウザを自己完結型のサーバー実行環境にする」に対して、M5 完了時点で**プロトコル層は揃い、運用層が無い**。率直な差分は次の 3 本として起票した（ビジョン側の宿題なので M4 までのスコープ表には入らない）。

| ギャップ | 現状 | Issue |
| :--- | :--- | :--- |
| アプリケーション層 HTTP が無い | 「仮想 TCP/**HTTP** トンネル」の後半が未実装。リクエスト/レスポンスの約束を定義せず、`webtcp://` URL の `path` / `query` は転送されない。ブラウザ上のサービスは独自プロトコルを話せる相手にしか使えない | **#50** |
| ブラウザはサーバーとして生き残れない | 非可視タブのサスペンド、リロード時の待ち受け・名前登録・提供レコードの消失（鍵だけが永続する非対称）。Wake Lock / Service Worker / 状態復元はいずれも未実装 | **#51** |
| 入口が WebRTC 話者に限定される | curl や既存アプリをトンネルへ入れるブリッジ（ローカル TCP リッスン → `connect()`）が無く、Node 側 WebRTC 実装も非同梱 | **#52** |

なお、これらは M5 の受け入れ条件（ブラウザにチェーンクライアントを載せず、検証可能な所有権に絞る）とは別軸の評価である。**「検証可能にした」ことと「サービスとして常時利用可能」であることを混同しない**ことが、次サイクル以降の文档でも守るべき線引きになる。

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
| サービス役のブラウザが停止する | 「常時稼働する P2P サービス」の実用性がゼロに近い | 未解決（#51）。M5 までは稼働維持策を一切実装していないことを README / サイトで明示する。 |
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
| #28 | security | Ed25519 署名（`Ed25519PacketVerifier`）・NodeId の鍵指紋化・`BrowserKeyManager` / `NodeKeyManager`・公開鍵配布・プロトコル v2・仕様書 §10 更新 |
| #13 | security | Null 検証器の暫定対応を解消（既定は v2。`NullPacketVerifier` は v1 相互運用専用として残置） |

### 6.4 M4 で参照した Issue（完了・close 済み）

| # | 内容 | 扱い |
| :--- | :--- | :--- |
| #25 | NameServer / `webtcp://` / `domain.global` / ブロックチェーン連携 | M4 で前半、M5 で残りを実装 → M5 PR で close |
| #35 | M3 時点の文書同期ずれ | M4 PR #39 で修正 → C5 で close |
| #36 | 永続鍵復元・NodeId 衝突・Node.js 永続化 | M4 PR #39 で修正 → C5 で close |
| #37 | RT_UPDATE 受信元検証とマルチホップ鍵伝播 | M4 PR #39 で修正 → C5 で close |
| #38 | 起動再試行・end 状態・cwnd 上限回帰・ICE 再起動 | M4 PR #39 で修正 → C5 で close |

### 6.5 M5（本サイクル）で対応・起票した Issue

| # | 種別 | 内容 | 扱い |
| :--- | :--- | :--- | :--- |
| #25 | enhancement | NameServer / `webtcp://` / `domain.global` / ブロックチェーン連携 | M5 で完遂 → 本 PR で close |
| #40 | bug | `NameServer.resolve()` が `resolveTimeoutMs` / `AbortSignal` を `connect()` 宙吊り中に無視する | 本 PR で修正 |
| #41 | bug | `Ed25519PacketVerifier` が注入シリアライザを無視し、`serializeForSigning` 欠落時に v1 署名対象へ黙ってフォールバック | 本 PR で修正 |
| #42 | enhancement | 実チェーン（Namecoin / L1 / SPV / EVM 証明）によるアンカー検証 | M6（スコープ外） |
| #43 | enhancement | `domain.global` のガバナンス（紛争裁定・失効回収・複数ログ合意・IDNA） | M6（スコープ外） |
| #44 | enhancement | `connect()` 系への `AbortSignal` 伝播 | M6 |
| #45 | enhancement | SSE / WebSocket ベースの `ISignalingAdapter` | M6 |
| #46 | enhancement | RPF 厳格化と距離ベクトル収束強化 | M6 |
| #47 | enhancement | 鍵ライフサイクル（オンデマンド照会・ローテーション・分散ストレージ） | M6 |
| #48 | enhancement | セッション Nonce / タイムスタンプによるリプレイ検知 | M6 |
| #49 | enhancement | npm 公開・semver・`exports` サブパス | M6 |
| #50 | enhancement | アプリケーション層 HTTP トンネル（L7）未実装 — README 構想の後半 | ビジョン評価で起票（M6 以降） |
| #51 | enhancement | タブ停止・リロードに耐えるサービス継続（稼働維持と状態の永続化） | ビジョン評価で起票（M6 以降） |
| #52 | enhancement | ブラウザ外部の既存クライアントをトンネルへ入れるブリッジ | ビジョン評価で起票（M6 以降） |
