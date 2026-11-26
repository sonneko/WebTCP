---
title: ロードマップと既知の制約
description: WebTCP のマイルストーン計画（M0–M8）と現在の制約事項。
---

詳細はリポジトリルートの `plan.md` および GitHub Issues を参照してください。

## マイルストーン

| ID | 名称 | 状態 | 主な内容 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | 完了 | `specification.md` / `design.md` / `plan.md` の整備 |
| M1 | 最小の end-to-end | 完了 | コアのブラウザ対応、v1 シリアライザ、WebRTC / シグナリングアダプタ、デモ、CI |
| M2 | TCP セマンティクス完成と運用基盤 | 完了 | バイト単位 Seq/Ack、自動分割、動的 RTO、輻輳制御、Fast Retransmit / SACK、Half-Close、レベル付きロガー、`bootstrap()`、TURN/ICE 再起動、ドキュメントサイト |
| M3 | セキュリティ | **完了（#28 / #34 マージ済み）** | Ed25519 署名（プロトコル v2）、NodeId の公開鍵指紋化、`BrowserKeyManager` / `NodeKeyManager`、公開鍵の自動配布 |
| M4 | NameServer と webtcp:// URL | **完了（#25 / #39 マージ済み）** | NameServer（A/CNAME）、`webtcp://` URL、永続 NodeId と衝突検出、RT_UPDATE 受信元検証と鍵伝播 |
| M5 | `domain.global` と検証可能な所有権証明 | **完了（#25 / PR #53 マージ済み）** | `domain.global` の所有権レコード（Ed25519 署名 + canonical commitment）、追記専用 Merkle 台帳とチェックポイント、fail-closed 検証器と `DomainAuthority`、`NameServer` 統合、参照 HTTP レジストリ。**実チェーンへの裏付け・運用ガバナンスは未実装（#42 / #43）** |
| M6 | アプリケーション層 HTTP トンネル | **完了（#50）** | `core/http`（HTTP/1.1 サブセット）、`HTTPServer` / `HTTPClient` / `HTTPRouter`、`network.serveHTTP()` / `fetchURL()`、`webtcp://` の `path` / `query` 転送、デモと実ブラウザ検証。**HTTP/2・WebSocket・`CONNECT`・圧縮・認証・リダイレクト追従は未実装（#57）** |
| M7 | 生存期間（サービス役の稼働維持） | **完了（#51）** | `persistState` / `restoreState`（IndexedDB）、`neighbor-*` の再発行、`startBrowserKeepAlive`（Wake Lock・無音オーディオ・前面復帰の再接続）。仕様 §9 |
| M8 | ブラウザ外 TCP クライアント向けブリッジ | **完了（#52）** | `examples/bridge.mjs` / `bridge-service.mjs`。ループバック既定・署名必須・アクセスログ。仕様 §19。UDP・SOCKS・ローカル認証は未実装 |
| 0.8.1 | M8 の未検証項目の検証と既知バグの修正 | **完了（#54・#63 ほか）** | ブラウザ上サービスの Chromium E2E、`@roamhq/wrtc` 経由のブリッジ、`destroy()` の RST 送信 |

## 現在の制約（0.8.1 時点）

- **署名は鍵管理の注入で有効になる**: `keyManager`（または `Ed25519PacketVerifier`）を渡すとプロトコル v2（署名必須）になります。渡さない既定構成は後方互換のため v1（署名なし・`NullPacketVerifier`）です。
- **Ed25519 非対応ブラウザ**: Web Crypto の Ed25519 は Chrome 137+ / Firefox 129+ / Safari 17+。デモは自動で v1 にフォールバックします。
- **未実装のセキュリティ強化**: 鍵ローテーション、アプリケーションデータの E2E 暗号化、セッション Nonce による明示的なリプレイ検知（仕様書 §11.7）。
- **名前解決はローカル信頼モデル（M4）**: `NameServer` と `webtcp://` URL は実装済みで、M5 で `.domain.global` だけが検証可能な所有権レコードの対象です。ゾーン外の名前はいまも「応答ノードがそう登録している」という自己申告です。
- **`domain.global` は検証の実装まで（M5 / #25）**: 所有者署名・Merkle アンカー・チェックポイント後退検出・fail-closed 検証は入りましたが、**公開ブロックチェーンへの裏付け（#42）**、**レジストリの運用ガバナンス（紛争解決・失効回収・IDNA、#43）**、台帳の永続化は未実装です。同梱の参照レジストリは起動のたびに鍵を作り直す実験用プロセスにすぎません。
- **Node.js 鍵ファイルは平文 PEM**: `NodeKeyManager.open({ keyFile })` は `0600` で保存しますが、ディスク暗号化やバックアップは利用者の責任です。
- **Node.js 向け WebRTC 実装は非同梱**: `createNodeNetwork()` は導入済みの `@roamhq/wrtc`、次に `node-datachannel` を自動で使います（どちらも無ければ `WebRTCProviderUnavailableError`）。`node-datachannel` は自動バインドで ICE 候補を 0 件にすることがあります（[#61](https://github.com/sonneko/WebTCP/issues/61)）。
- **HTTP はサブセット（M6 / #50）**: リクエストライン・ヘッダ・本文（`Content-Length` / `chunked`）・`keep-alive`・`HEAD` は実装済みですが、HTTP/2・HTTP/3・`Upgrade` / WebSocket・`CONNECT`・パイプライン・圧縮・Cookie ジャー・認証・リダイレクト追従・TLS 終端は未実装です（#57）。`webtcp://` URL の `fragment` は送りません。
- **受信フロー制御は対応済み（#56）**: v2 の `WIN` ビットで受信ウィンドウを交渉し、受信側のバッファを `maxRecvBufferBytes`（既定 1 MiB）以内に保ちます。交渉しない旧実装の相手とは窓無しで通信し、上限超過分は再送で回復します（回復は遅くなります）。`HTTPClient` の接続プールにも上限がありません（#58）。
- **サービスはタブに縛られる**: M7 で、待ち受け・名前登録・所有権レコードを保存して再読み込み後に復元できるようになりました（`persistState` / `restoreState`）。ただし非可視タブが凍結されている間は応答せず、HTTP ハンドラは再登録が必要です（#51、仕様 §9）。既存の TCP/HTTP クライアント（curl 等）を入れるブリッジはありません（#52）。

詳細は [domain.global と所有権証明](/guides/domain-ownership/) を参照してください。
