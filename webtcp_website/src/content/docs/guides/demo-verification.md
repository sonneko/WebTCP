---
title: デモと実ブラウザ検証
description: 2 タブデモの操作手順、内蔵の自己チェック機能（Self-Check）、Playwright による実ブラウザ自動検証の使い方。
---

## デモサーバーの起動

事前にライブラリをビルドしてから、デモサーバーを起動します。

```bash
cd webtcp_jslib
npm ci
npm run build
cd ..
node examples/server.mjs
```

デフォルトでは `http://localhost:8787/examples/demo/` で待ち受けます（`PORT` / `HOST` 環境変数で変更可能）。

## 検証方法 1: 1 タブ内蔵自己チェック（最速）

ブラウザで次を開くと、1 ページ内に **2 つの実 `BrowserWebRTCChannel`（実 `RTCPeerConnection`）** を立ち上げ、シグナリングハブ経由で以下の 5 項目を自動検証します。

```
http://localhost:8787/examples/demo/?selftest=1
```

1. エントランス探索と `network.bootstrap()` による実 WebRTC リンク確立
2. 仮想 TCP 3 ウェイハンドシェイク（`ESTABLISHED`）とランダム ISN
3. 双方向テキスト送受信と部分読み取り（`readExact`）
4. 96 KiB（> 60 KiB）バイナリの自動分割・再結合とバイト完全一致・動的 RTO / `cwnd`
5. Half-Close（`end()` → `CLOSE_WAIT` での応答受信 → 双方 `CLOSED`）

STUN を有効にして試す場合は `?selftest=1&stun=1` を指定します。

## 検証方法 2: 2 タブ手動 / 自動検証

- **手動**: `http://localhost:8787/examples/demo/` を 2 タブで開き、タブ A で「ポート 8080 で待ち受ける」、タブ B で「接続先を探す」→「接続」→ テキスト送信 /「80 KiB 分割送信テスト」を実行します。
- **ワンクリック 2 タブ自動検証**: タブ A の「別タブで 2 タブ自動検証」を押すか、以下を 2 つのタブで開きます。
  - タブ A: `http://localhost:8787/examples/demo/?role=server&autostart=1`
  - タブ B: `http://localhost:8787/examples/demo/?role=client&autostart=1`

## 検証方法 3: Playwright によるヘッドレス Chromium 自動 E2E

リポジトリには Playwright で 2 つの実 Chromium タブを操作して検証する `examples/verify-browser.mjs` を同梱しています。

```bash
# 初回のみ Playwright と Chromium を準備
npm install --no-save playwright
npx playwright install chromium

# 実行（2 タブ UI 操作 + 2 タブ自動モード + 1 タブ自己チェックをすべて検証）
node examples/verify-browser.mjs
```

この検証スクリプトは GitHub Actions CI（`.github/workflows/ci.yml` の `browser-e2e` ジョブ）でも自動実行されます。
