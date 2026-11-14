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
| M3 | セキュリティ | 予定（#28） | Ed25519 署名、NodeId の公開鍵指紋化、`KeyManager`（IndexedDB 等）、プロトコル v2 |
| M4 | マルチホップ強化と名前解決 | 予定（#25） | 厳格な RPF、SSE/WebSocket シグナリング、`webtcp://` URL、NameServer |
| M5 | 分散ドメイン | 予定（#25） | `domain.global`、ブロックチェーンによるドメイン所有権証明 |

## 現在の制約（M2 時点）

- **署名・暗号学的認証は未実装（#28）**: パケットの `signature` は空で、NodeId はランダム hex の自己申告です（トランスポート層の DTLS 暗号化のみ）。M3 で Ed25519 署名を導入予定です。
- **名前解決・分散ドメインは未実装（#25）**: `NameServer`、`webtcp://` URL、`domain.global`、ブロックチェーン連携は M4–M5 の将来課題です。
- **Node.js 向け WebRTC 実装は非同梱**: `NodeWebRTCChannel` に `@roamhq/wrtc` や `node-datachannel` 等の `createPeerConnection` を注入して利用します。
