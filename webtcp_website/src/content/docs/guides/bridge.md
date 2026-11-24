---
title: ブリッジ（curl からトンネルへ・M8）
description: curl や既存アプリのような WebTCP を話さない TCP クライアントを、ローカルのブリッジ経由でブラウザや Node のサービスへ入れる方法。
---

WebTCP のブリッジ（M8 / [#52](https://github.com/sonneko/WebTCP/issues/52)）は、**WebTCP を話さない TCP クライアント**を
トンネルの内側のサービスへつなぎます。ローカルで TCP を待ち受け、受け入れた接続を `webtcp://<nodeId>:<port>` の
仮想ストリームへ中継します。HTTP を解釈しないため、`curl` からブラウザ上の HTTP サービスを呼べます。

> 仕様は [specification.md §19](https://github.com/sonneko/WebTCP/blob/main/specification.md)、
> 設計判断は [design.md §3.29](https://github.com/sonneko/WebTCP/blob/main/design.md) を参照してください。

## 使い方

```bash
# 1. 実 WebRTC 実装を導入する（WebTCP には同梱していません）
cd webtcp_jslib && npm install --no-save @roamhq/wrtc   # または node-datachannel

# 2. シグナリングハブと、サービス（ブラウザ or Node）を起動する
node examples/server.mjs
node examples/bridge-service.mjs --name demo-service --port 8080   # Node 上のサービスの例

# 3. ブリッジを起動する（ループバックで待ち受け、宛先は NodeId か名前）
node examples/bridge.mjs webtcp://demo-service:8080 --listen 127.0.0.1:18080 --resolve-name

# 4. curl から呼ぶ
curl 'http://127.0.0.1:18080/api/echo?x=1'
```

名前（`demo-service`）を使うには `--resolve-name` が必要です。付けない場合は NodeId を指定します。

## 既定の安全設定

ブリッジは次の規則を既定で守ります（仕様 §19.4）。

| 規則 | 既定 | 変更するには |
| :--- | :--- | :--- |
| 署名必須（プロトコル v2） | 必須。鍵管理のないノードでは起動しません | 変更不可 |
| 待ち受けアドレス | `127.0.0.1` のみ | `--allow-non-loopback`（危険） |
| v1（未署名）の宛先への転送 | 拒否 | `--allow-unsigned-peers`（危険） |
| アクセスログ | 接続ごとに JSON 1 行（`open` / `refused` / `error` / `close`） | 無効化できません |

ログの例:

```json
{"at":"2026-11-20T04:23:51.501Z","event":"close","id":1,"client":"127.0.0.1:34466","target":"<nodeId>:8080","bytesUp":72,"bytesDown":217,"durationMs":17}
```

## Node.js の WebRTC 実装（プロバイダの解決）

`createNodeNetwork()` は、導入済みの実装を次の順で使います。

1. `@roamhq/wrtc`
2. `node-datachannel`

どちらも無ければ `WebRTCProviderUnavailableError`（試した一覧を含む）を投げます。
`peerConnectionOptions` で RTC の設定を上書きできます（例: `{ bindAddress: '127.0.0.1' }`）。

## 既知の制約

- **ローカル側に認証はありません**。同じマシンのプロセスと、ループバックへ要求を送れるブラウザページから使えます。
  ブリッジ越しに公開するサービスは、呼び出し元を信頼しない前提で作ってください。
- **`node-datachannel` は自動バインドで ICE 候補を 0 件にすることがあります**（非ループバックのインターフェースがリンクローカルのみのホストなど、[#61](https://github.com/sonneko/WebTCP/issues/61)）。その場合は `--rtc-bind` / `bindAddress` を指定してください。ICE 候補が 0 件のまま収集が終わると、ログに警告が出ます。接続はタイムアウトしますが、そのエラーにも候補 0 件であることと `bindAddress` の指定が含まれます。`@roamhq/wrtc` は自動バインドでも開通することを確認しています。
- UDP・SOCKS・TLS 終端・ブリッジの npm 公開（`webtcp-bridge` の `bin`）は未対応です（公開方針は [#49](https://github.com/sonneko/WebTCP/issues/49)）。

## 検証

リポジトリには、Chromium のブラウザタブを HTTP サービスとして、curl 相当のクライアントから呼ぶ検証があります。

```bash
cd webtcp_jslib && npm run build && cd ..
npm install --no-save playwright          # 既存の Chromium を使う場合は WEBTCP_CHROMIUM_PATH を指定
node examples/verify-bridge-browser.mjs
```
