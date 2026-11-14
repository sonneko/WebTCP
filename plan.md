# WebTCP 開発計画書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.1.0 |
| 対応仕様 | `specification.md` 0.1.0 |
| 対応設計 | `design.md` 0.1.0 |
| 最終更新 | 2026-11-14 |
| 現在のマイルストーン | **M1: 最小の end-to-end** |

---

## 1. 現状の評価

リポジトリには L2〜L4 の骨格とインターフェースが存在するが、次の理由で「動く状態」ではなかった。

- アダプタ（`BrowserWebRTCChannel`, `SignalingAdapterHub`, `EntranceSearcherAdapterHub`, `NodeWebRTCChannel`）がすべて空ファイル。
- コアがコンパイルできない（存在しない型・ファイルの import、シグネチャ不一致）。
- Node.js 組み込み（`Buffer`, `events`, `NodeJS.Timeout`）に依存し、ブラウザで動作しない。
- `dist/` には存在しない `hello()` の古い成果物だけがあり、`npm run build` が実質機能していない。
- テスト・CI・デモ・シグナリングサーバーが存在しない。

M1 ではこれらを解消し、「2 つのブラウザが実際に仮想 TCP でデータを送受信できる」最小構成を完成させる。

## 2. マイルストーン

| ID | 名称 | 状態 | 概要 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | ✅ 完了 | 仕様書・設計書・計画書、Issue 整理 |
| **M1** | **最小の end-to-end** | **🚧 本作業** | アダプタ実装、コア修正、ビルド、デモ、テスト |
| M2 | TCP セマンティクスの完成 | 未着手 | バイトストリーム化、自動分割、輻輳制御、ランダム ISN |
| M3 | セキュリティ | 未着手 | Ed25519 署名、NodeId の鍵指紋化、KeyManager |
| M4 | マルチホップと名前解決 | 未着手 | 3 ノード以上のルーティング、NameServer、`webtcp://` |
| M5 | 分散ドメイン | 未着手 | `domain.global`、ブロックチェーン連携 |

## 3. M1 のスコープ

### 3.1 実装

- [x] `specification.md` / `design.md` / `plan.md` の作成
- [x] コアのコンパイル修正とブラウザ対応（`Uint8Array`、独自 `EventEmitter`）
- [x] パケットシリアライザの再実装（v1 バイナリ形式、フラグのビット判定）
- [x] `LinkManager` の再実装（`IChannel` 注入、シリアライザ経由の送受信）
- [x] `RoutingLayer` / `RoutingTableManager` の修正（送信経路の一本化、RPF 緩和、経路撤回の伝播）
- [x] `TransportLayer` / `VirtualStream` の修正（フラグ判定、状態遷移、ACK、タイムアウト、リーク解消）
- [x] `WebTCPNetwork` の公開 API 整備（オプション形式、リンク自動確立）
- [x] `BrowserWebRTCChannel`（+ 共通基底 `WebRTCChannel`、`NodeWebRTCChannel`）
- [x] `SignalingAdapterHub`（HTTP ポーリング）
- [x] `EntranceSearcherAdapterHub`（HTTP）
- [x] `npm run build` で `dist/` に ESM + 型定義を生成
- [x] `examples/` にデモとシグナリングサーバー
- [x] 自動テスト（シリアライザ、トランスポート E2E、シグナリング、ルーティング）
- [x] CI（build + test）
- [x] README の「仕組み」節と利用方法の更新

### 3.2 完了条件 (DoD)

1. `npm ci && npm run build` が成功し、`dist/index.js` と `dist/index.d.ts` が生成される。
2. `npm test` が通る。テストには 2 ノード間の `connect` → `send` → 受信 → `close` が含まれる。
3. `node examples/server.mjs` を起動し、2 つのブラウザタブ（または 2 ブラウザ）で同一オリジンのハブを介して接続し、メッセージの往復ができる。
4. 未実装のアダプタが残っていない（空ファイルがない）。
5. 仕様書・設計書・計画書と実装が矛盾しない。

### 3.3 非スコープ

- NameServer、`domain.global`、ブロックチェーン連携（M5）
- NAT 越えの保証、TURN の自動設定
- HTTP サーバーとしての完全な実装

## 4. 将来課題

### 4.1 プロトコル / トランスポート

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| バイトストリーム化 | 現在はパケット単位の Seq。TCP と同様にバイト単位の Seq/Ack にし、部分読み取り・再結合を提供する。 | M2 |
| 自動分割 / 再結合 | 60 KiB 超のメッセージを透過的に分割する。 | M2 |
| 輻輳制御 | 固定ウィンドウ・固定 RTO を、RTT 計測 + 動的 RTO + AIMD に置き換える。 | M2 |
| 高速再送 | 重複 ACK による fast retransmit、SACK。 | M2 |
| ランダム ISN | 初期シーケンス番号のランダム化。 | M2 |
| 半閉鎖 | 現状は FIN 受信で双方向に閉じる。half-close を正しく扱う。 | M2 |

### 4.2 セキュリティ

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| Ed25519 署名 | `PacketVerifier` を実装し、ヘッダー + ペイロードに署名する（#28）。 | M3 |
| NodeId の鍵指紋化 | NodeId を公開鍵から導出し、なりすましを防ぐ。 | M3 |
| 鍵管理 | IndexedDB 等に秘密鍵を保存する `KeyManager` 実装。 | M3 |
| リプレイ対策 | シーケンス番号とセッションNonceの検証。 | M3 |

### 4.3 ネットワーク

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| マルチホップ | 3 ノード以上での転送、RPF の厳格化、ループ検出。 | M4 |
| シグナリングの低遅延化 | SSE / WebSocket 実装の追加、接続確立の高速化。 | M4 |
| TURN / ICE 設定 | `iceServers` の既定値、TURN 資格情報の注入。 | M4 |
| エントランス探索の自動化 | `EntranceSearcherAdapterHub` の結果から自動接続。 | M4 |

### 4.4 名前解決と分散ドメイン（今回のスコープ外）

| 課題 | 内容 | 目標 |
| :--- | :--- | :--- |
| `webtcp://` URL | `webtcp://nodeId:port/path` のパースとルーティング。 | M4 |
| NameServer | `connection.on(port, ns.on)` による名前解決、CNAME / A レコード相当。 | M5 |
| `domain.global` | グローバルドメインの登録・解決。 | M5 |
| ブロックチェーン連携 | ドメイン所有権の証明と分散台帳への登録。 | M5 |
| `generateIp` / 永続 NodeId | ノード識別子の永続化（localStorage）と衝突検出。 | M4 |

> これらは README および `docs/layer.md` に構想として書かれているが、M1 では実装しない。仕様の変更点は `specification.md` に追記する。

### 4.5 品質・開発体験

| 課題 | 内容 |
| :--- | :--- |
| ログ制御 | `console.*` の直書きを廃止し、レベル付きロガーに置き換える。 |
| E2E テスト | Playwright で 2 ブラウザの WebRTC 接続を CI で検証する。 |
| ドキュメントサイト | `webtcp_website` を Starlight テンプレートから WebTCP のドキュメントに置き換える。 |
| パッケージ公開 | npm 公開、`exports` のサブパス（`/adapters`）、バージョニング。 |
| パフォーマンス | シリアライザのゼロコピー化、バッファプール。 |

## 5. リスクと対策

| リスク | 影響 | 対策 |
| :--- | :--- | :--- |
| ブラウザごとの SCTP/DataChannel のメッセージサイズ差異 | 大きなパケットが送れない | 上限 60 KiB を仕様化。M2 で自動分割。 |
| NAT 越え失敗 | デモが接続できない | 同一 LAN・同一ホストのデモを既定にし、TURN は利用者設定とする。 |
| 署名なしのため不正パケットを注入できる | セキュリティ | M1 は実験用途と明記。M3 で署名必須化。 |
| 距離ベクトルの収束遅延 | 3 ノード以上で一時的に到達不能 | 直接隣接への送信は常に許可。M4 で改善。 |
| 仕様と実装の乖離 | 保守性低下 | 仕様変更時は同一 PR で `specification.md` を更新する。 |

## 6. Issue 運用

- 不具合・未実装は GitHub Issues に 1 件ずつ登録する。
- 本マイルストーンで修正した Issue は PR 本文で `Closes #n` として紐付ける。
- 将来課題は `enhancement` ラベルを付け、本計画書の該当節から辿れるようにする。

### 6.1 M1 で修正した Issue

| # | 内容 |
| :--- | :--- |
| #1 | ビルドが dist を生成しない |
| #2 | コアがコンパイルできない |
| #3 | `PacketVarifier.ts` の typo と未完成実装 |
| #4 | `WebTCPNetwork` の import パス誤り |
| #5 | `RoutingTable` のコンストラクタ不一致 |
| #6 | ペイロード文字列によるパケット種別判定 |
| #7 | シリアライザのフラグ復元不正 |
| #8 | `LinkManager` のダミー実装 |
| #9 | `PortMultiplexer.ts` の重複 |
| #10 | `RetrainsmitQueue.ts` の typo |
| #11 | Node.js 組み込み依存（ブラウザ非対応） |
| #12 | RPF が未学習経路で全破棄 |
| #13 | 署名検証の必須化と `KeyManager` 不在 |
| #14 | `VirtualStream` の ACK・状態遷移 |
| #15 | セッションのリーク |
| #16 | `connect()` のタイムアウト不在 |
| #17 | アダプタが空 |
| #18 | シグナリングサーバー・デモ不在 |
| #19 | テスト・CI 不在 |
| #20 | README の未完成・乖離 |
| #21 | package.json の不備 |

### 6.2 M1 の対象外として残した Issue

| # | 内容 | 予定 |
| :--- | :--- | :--- |
| #22 | `webtcp_website` がテンプレートのまま | 文書化フェーズ |
| #23 | バイトストリーム・自動分割・輻輳制御 | M2 |
| #24 | TURN / ICE 設定と NAT 越え | M4 |
| #25 | NameServer / `webtcp://` / `domain.global` / ブロックチェーン | M4–M5 |
| #26 | ログが console 直書き | M2 |
| #27 | エントランス探索からの自動接続 | M4 |
| #28 | Ed25519 署名と NodeId の鍵指紋化 | M3 |
