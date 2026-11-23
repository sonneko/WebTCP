---
title: デモと実ブラウザ検証
description: 2 タブデモの操作手順、内蔵の自己チェック機能（Self-Check）、Playwright による実ブラウザ自動検証の使い方。
---

## 公開版（GitHub Pages）で動く範囲

公開版は <https://sonneko.github.io/WebTCP/examples/demo/> にあります。サーバー（シグナリングハブ・`domain.global` の台帳）を置かず、ブラウザだけで動きます。

| 機能 | 公開版 | ローカルデモサーバー（`node examples/server.mjs`） |
| :--- | :--- | :--- |
| 1 タブの自己チェック（`?selftest=1`）: 2 つの実 `RTCPeerConnection` を同一ページ内で接続、署名・名前解決・`webtcp://`・96 KiB 分割・Half-Close | ✅ 動く | ✅ 動く（台帳の検査も含む） |
| 同じブラウザの 2 タブ（`BroadcastChannel` で探索・接続、テキストと大容量の往復） | ✅ 動く | ✅ 動く |
| 別のブラウザ・別のデバイスとの接続 | ❌ できない（交換経路が無い） | ✅ シグナリングハブ経由で可能 |
| `domain.global` の登録・解決（台帳のアンカー検証と偽造拒否を含む） | ❌ 省略（自己チェックは「省略」と表示） | ✅ 動く |
| ICE サーバーの指定（STUN / TURN） | 指定は可能だが、同一マシン内では不要 | ✅ 動く |

公開版は静的モードです。デモサーバーが応答しなければ自動的に静的モードになり、ページ上部のバナーに表示されます。`?static=1` を付けると、ローカルでも静的モードを強制できます（検証用）。

### 自己チェックが失敗するとき

自己チェックは最初に **step 0「WebRTC ICE 候補の収集（事前診断）」** を行います。この環境で候補を 1 つも得られない場合、step 0 が数秒で FAIL になり、理由と対処が表示されます（以前は約 45 秒待ってから「bootstrap がサーバーノードへ接続できませんでした」と表示されていました）。

- 原因の多くは、ブラウザの WebRTC 設定（IP 処理の制限）、VPN、企業ネットワークやファイアウォールによる UDP の遮断です。
- 対処: 別のネットワークやブラウザで試す。ローカルで試すなら `node examples/server.mjs` を起動して `http://localhost:8787/examples/demo/?selftest=1` を開く。
- step 0 が PASS なのに step 1 が失敗した場合は、詳細に ICE 候補の内訳（`host(mdns)` / `host(ip)` / `srflx` / `relay`）が表示されます。その内訳を Issue に添えてください。

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

ブラウザで次を開くと、1 ページ内に **2 つの実 `BrowserWebRTCChannel`（実 `RTCPeerConnection`）** を立ち上げ、以下の項目を自動検証します。シグナリングは、デモサーバーがあればそのハブ経由、無ければ同一ページ内のメモリ上で行います。公開版では項目 1d（`domain.global` の台帳検証）を省略として表示しますします。

```
http://localhost:8787/examples/demo/?selftest=1
```

0. WebRTC ICE 候補の事前診断（候補ゼロなら以降を止めて理由を表示、#73）
1. エントランス探索と `network.bootstrap()` による実 WebRTC リンク確立
1b. Ed25519 署名検証と NodeId の鍵指紋一致（プロトコル v2）
1c. NameServer 名前解決（A/CNAME）と `webtcp://` URL パース（M4 / #25）
1d. `domain.global` 所有権レコードと台帳アンカー検証（M5 / #25）
1e. HTTP トンネル: `serveHTTP` + `fetchURL` のリクエスト/レスポンス（M6 / #50）
2. `webtcp://` URL 接続と仮想 TCP 3 ウェイハンドシェイク（`ESTABLISHED`）
3. 双方向テキスト送受信と部分読み取り（`readExact`）
4. 96 KiB（> 60 KiB）バイナリの自動分割・再結合とバイト完全一致・動的 RTO / `cwnd`
5. Half-Close（`end()` → `CLOSE_WAIT` での応答受信 → 双方 `CLOSED`）

STUN を有効にして試す場合は `?selftest=1&stun=1` を指定します。

ステップ 1e では、サーバー側ノードが `serveHTTP(8081)` で JSON を返す HTTP サービスを公開し、
クライアント側が `fetchURL('webtcp://demo-service:8081/api/echo?x=1#ignored')` で呼び出します。
`path` / `query` が往復すること、`remoteNodeId` がクライアントの NodeId と一致すること、
`fragment` が送られないことを検証します。詳細は [HTTP トンネル](/guides/http-tunnel/) を参照してください。

## 検証方法 2: 2 タブ手動 / 自動検証

- **手動**: `http://localhost:8787/examples/demo/` を 2 タブで開き、タブ A で「ポート 8080 で待ち受ける」、タブ B で「接続先を探す」→「接続」→ テキスト送信 /「80 KiB 分割送信テスト」を実行します。さらに「名前を解決」「URL で接続」で `demo-service` / `demo-alias` の名前解決と `webtcp://` 接続を確認できます。

**セクション 3「domain.global 所有権レコード」**では、このタブのノードでレコードを署名 → 参照レジストリ（`/domain/*`）へ submit → 受領したアンカー付きで `registerDomain()` → ピアへ解決、という流れをボタン 1 つで試せます。改ざんレコードはレジストリが `400` で拒否し、未登録名前は fail-closed で失敗します。詳細は [domain.global と所有権証明](/guides/domain-ownership/) を参照してください。
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
