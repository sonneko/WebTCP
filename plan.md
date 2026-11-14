# WebTCP 開発計画書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.3.0 |
| 対応仕様 | `specification.md` 0.3.0 |
| 対応設計 | `design.md` 0.3.0 |
| 最終更新 | 2026-11-14 |
| 現在のマイルストーン | **M3 実装（次フェーズ: M4 マルチホップ強化と名前解決）** |

---

## 1. 開発経緯

- **M0（設計文書化）**: `specification.md` / `design.md` / `plan.md` の整備と既存課題の Issue 化を完了。
- **M1（最小の end-to-end）**: ブラウザ非依存コア再構成、v1 シリアライザ、WebRTC / シグナリング / エントランス探索アダプタ、2 タブデモ、テスト 18 件、CI を完了し `main` へマージ済み。
- **M2（TCP セマンティクス完成と運用基盤）**: バイト単位 Seq/Ack・ランダム ISN・60 KiB 超の自動分割・動的 RTO・輻輳制御・Fast Retransmit / SACK・Half-Close・レベル付きロガー・`bootstrap()` 自動接続・TURN/ICE 設定と自動 ICE 再起動・Starlight ドキュメントサイト・実ブラウザ 2 タブ検証の仕組みを整備した。
- **M3（セキュリティ / #28）**: 本サイクルで実装。**Ed25519 署名**と **NodeId の公開鍵指紋化**（プロトコル v2）、ブラウザ用 `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）、Node.js 用 `NodeKeyManager`、公開鍵の配布（シグナリング交換 + `RT_UPDATE` 同梱）、署名・検証・鍵導出のテストを追加した。

## 2. マイルストーン

| ID | 名称 | 状態 | 概要 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | ✅ 完了 | 仕様書・設計書・計画書、Issue 整理 |
| M1 | 最小の end-to-end | ✅ 完了 | アダプタ実装、コア修正、ビルド、デモ、テスト |
| M2 | TCP セマンティクスの完成と運用基盤 | ✅ 完了 | バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close・ロガー・`bootstrap()`・TURN/ICE 再起動・ドキュメントサイト・実ブラウザ検証 |
| **M3** | **セキュリティ** | **✅ 実装済み（PR レビュー待ち）** | Ed25519 署名（プロトコル v2）・NodeId の鍵指紋化・`KeyManager`（IndexedDB / node:crypto）・公開鍵の配布（#28） |
| M4 | マルチホップ強化と名前解決 | 未着手 | RPF 厳格化、SSE/WebSocket シグナリング、NameServer、`webtcp://`（#25） |
| M5 | 分散ドメイン | 未着手 | `domain.global`、ブロックチェーン連携（#25） |

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

### 3.3 M3（本サイクル / 完了）

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

## 4. 将来課題

### 4.1 セキュリティ（M3 で完了、残課題は M3.5 以降）

| 課題 | 内容 | 状態 |
| :--- | :--- | :--- |
| Ed25519 署名 | `Ed25519PacketVerifier` による署名付与・検証（プロトコル v2） | ✅ 完了 |
| NodeId の鍵指紋化 | `SHA-256(公開鍵)` の先頭 16 バイトを NodeId とする自己証明型識別子 | ✅ 完了 |
| 鍵管理 | `BrowserKeyManager`（IndexedDB + 非抽出 CryptoKey）/ `NodeKeyManager`（`node:crypto`） | ✅ 完了 |
| 公開鍵配布 | シグナリング時交換 + `RT_UPDATE` 同梱 + `KeyDirectory` / `IPublicKeyResolver` | ✅ 完了 |
| リプレイ対策 | 基本方針は仕様化（§10.6）。トランスポートのシーケンス空間で重複を排除する。セッション Nonce による明示的な再生検知は将来強化 | 仕様化済み・強化は M4 |
| 鍵のローテーション | NodeId が鍵指紋であるため、鍵更新 = ノード ID 変更。証明書チェーン的な移行手段は未実装 | M4 以降 |
| 鍵の分散ストレージ | `IPublicKeyResolver` を実装した IPFS 等のバックエンド | M4 以降 |

### 4.2 ネットワーク強化（M4）

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| マルチホップ厳格化 | RPF の厳格化、ループ検出・スプリットホライズンの強化。 | M4 |
| シグナリングの低遅延化 | SSE / WebSocket ベースの `ISignalingAdapter` 実装追加。 | M4 |
| 鍵学習の最適化 | 未知公開鍵の待機（既定 5 秒）を、オンデマンドな鍵照会リクエストに置き換える。 | M4 |

### 4.3 名前解決と分散ドメイン（M4–M5、据え置き）

**#25（NameServer / `webtcp://` URL / `domain.global` / ブロックチェーン）は M3 のスコープ外**であり、M4–M5 の将来課題として据え置く。
M3 で NodeId が公開鍵の指紋になったことで、「名前解決の前提となるノードの真正性」は解決済みである。

| 課題 | 内容 | 目標 | Issue |
| :--- | :--- | :--- | :--- |
| `webtcp://` URL | `webtcp://nodeId:port/path` のパースとルーティング。 | M4 | #25 |
| NameServer | `connection.on(port, ns.on)` による名前解決、CNAME / A レコード相当。 | M5 | #25 |
| `domain.global` | グローバルドメインの登録・解決。 | M5 | #25 |
| ブロックチェーン連携 | ドメイン所有権の証明と分散台帳への登録。 | M5 | #25 |
| 永続 NodeId | Ed25519 鍵の永続化は `BrowserKeyManager`（IndexedDB）で実現済み。マルチデバイス同期・バックアップは未対応。 | M4 | #25 |

### 4.4 品質・開発体験（継続課題）

| 課題 | 内容 |
| :--- | :--- |
| パッケージ公開 | npm 公開、`exports` のサブパス（`/adapters`）、セマンティックバージョニング。M3 の成果（Ed25519 / プロトコル v2 / 鍵管理）は **0.3.0** としてリリースする。パッケージのバージョンは現状 0.1.0 のままで、リリース時に更新する。 |
| パフォーマンス | シリアライザのゼロコピー化、バッファプール、大量セッション時のベンチマーク。Ed25519 署名のバッチ検証。 |
| 相互運用 | v1 のみのノードとの併存運用（`NullPacketVerifier` + `requireSignatures: false`）。 |

## 5. リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| ブラウザごとの SCTP/DataChannel のメッセージサイズ差異 | 大きなパケットが送れない | 既定 MSS を 16 KiB に設定し 60 KiB 超を自動分割（M2 で解消）。 |
| Symmetric NAT での接続失敗 | P2P 直接接続不可 | `iceServers` と動的 TURN 資格情報フック `iceServersProvider`、自動 ICE 再起動を提供（M2 で対応）。TURN サーバー自体は利用者配備。 |
| Web Crypto の Ed25519 非対応ブラウザ（Chrome 136 以前等） | 署名付き通信ができない | デモは自動で v1 へフォールバック。ライブラリは `keyManager` 未指定なら v1（`NullPacketVerifier`）で動作し、対応ブラウザでは v2 を使う（M3 で対応）。 |
| 未知ピアの公開鍵未着による初回パケットの取りこぼし | 接続直後に一時的に通信できない | `RT_UPDATE` への公開鍵同梱（自己証明）+ シグナリング時交換 + 最大 5 秒の鍵待機（M3 で対応）。 |
| 距離ベクトルの収束遅延 | 3 ノード以上で一時的に到達不能 | 直接隣接への送信は常に許可。M4 でルーティングを強化。 |
| 仕様と実装の乖離 | 保守性低下 | 各サイクル冒頭でドキュメント同期チェックを行い、仕様変更時は同一 PR で更新する。 |

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

### 6.4 M4 以降に据え置いた Issue

| # | 内容 | 予定 |
| :--- | :--- | :--- |
| #25 | NameServer / `webtcp://` / `domain.global` / ブロックチェーン連携 | M4–M5 |
