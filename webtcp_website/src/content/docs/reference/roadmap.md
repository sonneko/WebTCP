---
title: ロードマップと既知の制約
description: WebTCP のマイルストーン計画（M0–M5）と現在の制約事項。
---

詳細はリポジトリルートの `plan.md` および GitHub Issues を参照してください。

## マイルストーン

| ID | 名称 | 状態 | 主な内容 |
| :--- | :--- | :--- | :--- |
| M0 | 設計文書化 | 完了 | `specification.md` / `design.md` / `plan.md` の整備 |
| M1 | 最小の end-to-end | 完了 | コアのブラウザ対応、v1 シリアライザ、WebRTC / シグナリングアダプタ、デモ、CI |
| M2 | TCP セマンティクス完成と運用基盤 | 完了 | バイト単位 Seq/Ack、自動分割、動的 RTO、輻輳制御、Fast Retransmit / SACK、Half-Close、レベル付きロガー、`bootstrap()`、TURN/ICE 再起動、ドキュメントサイト |
| M3 | セキュリティ | **完了（#28 / #34 マージ済み）** | Ed25519 署名（プロトコル v2）、NodeId の公開鍵指紋化、`BrowserKeyManager` / `NodeKeyManager`、公開鍵の自動配布 |
| M4 | NameServer と webtcp:// URL | **実装済み（#25）** | NameServer（A/CNAME）、`webtcp://` URL、永続 NodeId と衝突検出、RT_UPDATE 受信元検証と鍵伝播 |
| M5 | 分散ドメインとネットワーク強化 | **一部実装済み（#25）** | `domain.global` の所有権レコード（Ed25519 署名 + canonical commitment）、追記専用 Merkle 台帳とチェックポイント、fail-closed 検証器と `DomainAuthority`、`NameServer` 統合、参照 HTTP レジストリ。**実チェーンへの裏付け・運用ガバナンス・RPF 厳格化・SSE/WebSocket シグナリングは未実装（#42 / #43 / #45 / #46）** |

## 現在の制約（M5 時点）

- **署名は鍵管理の注入で有効になる**: `keyManager`（または `Ed25519PacketVerifier`）を渡すとプロトコル v2（署名必須）になります。渡さない既定構成は後方互換のため v1（署名なし・`NullPacketVerifier`）です。
- **Ed25519 非対応ブラウザ**: Web Crypto の Ed25519 は Chrome 137+ / Firefox 129+ / Safari 17+。デモは自動で v1 にフォールバックします。
- **未実装のセキュリティ強化**: 鍵ローテーション、アプリケーションデータの E2E 暗号化、セッション Nonce による明示的なリプレイ検知（仕様書 §10.7）。
- **名前解決はローカル信頼モデル（M4）**: `NameServer` と `webtcp://` URL は実装済みで、M5 以降は `.domain.global` だけが検証可能な所有権レコードの対象です。ゾーン外の名前はいまも「応答ノードがそう登録している」という自己申告です。
- **`domain.global` は検証の実装まで（M5 / #25）**: 所有者署名・Merkle アンカー・チェックポイント後退検出・fail-closed 検証は入りましたが、**公開ブロックチェーンへの裏付け（#42）**、**レジストリの運用ガバナンス（紛争解決・失効回収・IDNA、#43）**、台帳の永続化は未実装です。同梱の参照レジストリは起動のたびに鍵を作り直す実験用プロセスにすぎません。
- **Node.js 鍵ファイルは平文 PEM**: `NodeKeyManager.open({ keyFile })` は `0600` で保存しますが、ディスク暗号化やバックアップは利用者の責任です。
- **Node.js 向け WebRTC 実装は非同梱**: `NodeWebRTCChannel` に `@roamhq/wrtc` や `node-datachannel` 等の `createPeerConnection` を注入して利用します。

詳細は [domain.global と所有権証明](/guides/domain-ownership/) を参照してください。
