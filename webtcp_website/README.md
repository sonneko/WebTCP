# WebTCP ドキュメントサイト (`webtcp_website`)

[Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/) で構築された WebTCP の公式ドキュメントサイトです。

## 収録コンテンツ

- トップページ（特徴一覧・導線）
- クイックスタート（インストール、2 タブデモ、最小コード例）
- NAT 越えと STUN / TURN 設定（`iceServers`、`iceServersProvider`、ICE 再起動）
- デモと実ブラウザ検証（`?selftest=1`、2 タブ自動検証、`examples/verify-browser.mjs`）
- アーキテクチャ解説（`design.md` の要約）
- プロトコル仕様サマリー（`specification.md` の要約）
- API リファレンス / ロードマップと制約

## コマンド

```bash
cd webtcp_website
npm ci
npm run dev      # 開発サーバー (http://localhost:4321)
npm run build    # 静的サイト生成 (dist/)
npm run preview  # ビルド結果のプレビュー
```
