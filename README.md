# WebTCP

**P2P接続のための実験的なWebRTCトンネリングライブラリ**

## 概要

WebTCPは、ブラウザを単なるクライアントではなく、**自己完結型のサーバー実行環境**として再定義するための実験的なライブラリです。従来のWebアプリケーションは、外部のクラウドサーバーに依存しています。本ライブラリは、WebRTC（Web Real-Time Communication）の**信頼性の高いデータチャネル（SCTP）を基盤とし、アプリケーション層で仮想的なTCP/HTTPトンネル**を構築することで、このパラダイムに挑戦します。

これにより、**Webブラウザ内で動作するサービス**に対し、他のデバイスから**直接**、セキュアにアクセスできるP2P接続を確立します。これは、未来の**分散型コンピューティング（Web3）**において、サービスが中央集権的なインフラストラクチャから解放されるための、**新しいネットワークの抽象化**を目指すものです。

ブラウザの制限付きの`fetch`を使っているわけではないので、TCPレイヤーから自由に通信を操ることができます。

> **現在のステータス**: **M3（セキュリティ / Ed25519 署名と NodeId の鍵指紋化）実装済み**。M2 のフル TCP セマンティクス（自動分割・動的 RTO・輻輳制御・Fast Retransmit / SACK・Half-Close）に加え、**Ed25519 署名（プロトコル v2）・NodeId の公開鍵指紋化・`BrowserKeyManager` / `NodeKeyManager`・公開鍵の自動配布**に対応しています。名前解決・分散ドメイン（M4–M5 / #25）は未実装です。詳細は [plan.md](./plan.md) を参照してください。

## 主な機能

1. **Ed25519 署名と自己証明型 NodeId（M3 / #28）**: すべてのパケットは送信元の Ed25519 署名で保護され（プロトコル v2）、NodeId は公開鍵の指紋（`SHA-256` の先頭 16 バイト）です。改ざん・なりすましは受信側で検出され破棄されます。
2. **SCTP上の多重化 (Multiplexing)**: WebRTC の単一のデータチャネル上で、複数の仮想 TCP 接続を仮想ポートとセッション ID により多重化します。
3. **フル TCP セマンティクス（M2）**: バイト単位の Seq/Ack（32 ビットラップアラウンド対応）、ランダム ISN、60 KiB 超メッセージの自動分割・再結合、部分読み取り（`read` / `readExact`）、RFC 6298 動的 RTO、RFC 5681 輻輳制御、3 重複 ACK Fast Retransmit + SACK、RFC 793 準拠の Half-Close を実装しています。
4. **シグナリング抽象化と自動ブートストラップ**: `SignalingAdapterHub`・`EntranceSearcherAdapterHub` を同梱し、`WebTCPNetwork.bootstrap(searcher)` により候補ノードへ指数バックオフ付きで自動接続できます。
5. **NAT 越え（STUN / TURN / ICE 再起動）**: 静的 `iceServers` に加え、短期 TURN 資格情報を都度取得する `iceServersProvider` フック、接続障害時の自動 ICE 再起動（DataChannel 維持）と Glare 解決を備えます。
6. **マルチホップルーティング**: 距離ベクトル方式の経路表（撤回伝播・生存時刻更新付き）と TTL / RPF を持ち、中継ノードを経由した通信ができます。
7. **ブラウザで直接動き、ロガー注入可能**: コアは `Buffer` や `events` に非依存。`tsc` の出力を `<script type="module">` から直接読み込め、レベル付きロガー（既定 `warn` 以上）を注入できます。
8. **プラットフォーム別の鍵管理**: ブラウザは **Web Crypto + IndexedDB（非抽出 CryptoKey）**、Node.js は **`node:crypto`**。秘密鍵は生バイトとしてエクスポートされないため、XSS 等でストレージが読まれても鍵そのものは漏れません。

## 仕組み

### 全体像

WebTCP は、WebRTC のデータチャネル（メッセージ指向・順序保証あり）の上に、バイトストリーム指向の TCP 機能を**アプリケーション層で**再実装します。

```
+-----------------------------------------------------------+
| L7  アプリケーション (任意のプロトコル / 将来のHTTP)         |
+-----------------------------------------------------------+
| L4  TransportLayer : 仮想ポート多重化 / SessionManager      |
|     VirtualStream  : バイト単位 Seq-Ack / MSS自動分割 /     |
|                      動的RTO / 輻輳制御 / SACK / Half-Close |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF 署名検証     |
|     Ed25519 署名・検証 / KeyDirectory（公開鍵の指紋）          |
|     RoutingTable   : 距離ベクトル経路表（撤回伝播付き）       |
+-----------------------------------------------------------+
| L2  LinkManager    : 隣接管理 / パケットのシリアライズ        |
|     IChannel       : WebRTC DataChannel の抽象化             |
|     ISignalingAdapter / IEntranceSearcher                   |
+-----------------------------------------------------------+
| L1  WebRTC (SCTP over DTLS over ICE) / ブラウザ API          |
+-----------------------------------------------------------+
```

### パケットの流れ

送信側では、アプリケーションが `VirtualStream.send()` を呼ぶと次の順に処理されます。

1. **VirtualStream** がデータを送信バッファへ積み、MSS（既定 16 KiB）以下の `DATA` セグメントへ自動分割して輻輳ウィンドウ（`cwnd`）に従い L4 ヘッダー（ポート、フラグ、バイト単位 Seq/Ack）を付与し再送キューに積む。
2. **TransportLayer** がルーティング層へ渡す。
3. **RoutingLayer** が L3 ヘッダー（送信元・宛先 NodeId、TTL）を設定し、Ed25519 署名を付与して、経路表からネクストホップを決める。
4. **LinkManager** が 24 バイトの固定ヘッダー + 可変長フィールドのバイナリへシリアライズする。
5. **IChannel**（WebRTC DataChannel）が 1 メッセージとして送信する。

受信側は逆順に処理します。デシリアライズ → **Ed25519 署名検証（`senderId` の指紋と署名の照合）** → RPF チェック → 宛先判定（自分宛なら L4 へ、そうでなければ TTL 減算して転送）→ セッション検索 → 順序外再結合・SACK 生成 → アプリケーションへ `data` イベントまたは `read()` / `readExact()`。

### パケットフォーマット

すべてのパケットはバイナリで、マルチバイト整数はビッグエンディアンです（全 24 バイトの固定ヘッダー、プロトコル v2 / v1 共通）。

| Offset | Size | Field | 説明 |
| ---: | ---: | :--- | :--- |
| 0 | 1 | `magic` | `0x57`（`'W'`） |
| 1 | 1 | `version` | プロトコルバージョン（`2` 既定 / `1` レガシー） |
| 2 | 1 | `ttl` | 残ホップ数（初期値 64） |
| 3 | 1 | `flags` | DATA / SYN / ACK / FIN / RST / SYN_ACK / RT_UPDATE のビットマスク |
| 4 | 2 | `sourcePort` | 送信元の仮想ポート（1–65535） |
| 6 | 2 | `destinationPort` | 宛先の仮想ポート（1–65535） |
| 8 | 4 | `seqNum` | バイト単位シーケンス番号（mod 2^32、ランダム ISN） |
| 12 | 4 | `ackNum` | 次に期待する受信バイト番号（mod 2^32） |
| 16 | 1 | `senderIdLen` | 送信元 NodeId の長さ |
| 17 | 1 | `destIdLen` | 宛先 NodeId の長さ |
| 18 | 2 | `signatureLen` | 署名長（v2 は 64、v1 は 0） |
| 20 | 4 | `payloadLen` | ペイロード長（上限 60 KiB） |
| 24 | var | … | senderId / destinationId / **signature（Ed25519, 64 B）** / payload（`ACK` 時は任意で SACK ブロック） |

パケット種別は**必ずフラグ**で判定します。詳細は [specification.md](./specification.md) §6 を参照してください。

### 接続確立・送受信・Half-Close

```
Client                                Server
  |--- SYN (seq=C, ack=0) -------------->|
  |<-- SYN_ACK (seq=S, ack=C+1) ---------|
  |--- ACK (seq=C+1, ack=S+1) ---------->|  ← 双方 ESTABLISHED (listen handler 起動)
  |--- DATA (seq=C+1, len=N) ----------->|  → アプリへ 'data' / read()
  |<-- ACK (ack=C+1+N, optional SACK) ---|
  |--- FIN (end() -> FIN_WAIT_1) ------->|  → サーバーは CLOSE_WAIT ('end' 発火、送信継続可)
  |<-- ACK ------------------------------|  ← クライアントは FIN_WAIT_2（受信継続可）
  |<-- DATA / FIN (end() -> LAST_ACK) ---|
  |--- ACK (TIME_WAIT -> CLOSED) ------->|  ← 双方 CLOSED
```

### リンク確立・シグナリング・NAT 越え

WebRTC の接続には Offer/Answer と ICE 候補の交換が必要です。同梱の `SignalingAdapterHub` と `EntranceSearcherAdapterHub` は次の HTTP エンドポイントを利用します。

| メソッド | パス | 用途 |
| :--- | :--- | :--- |
| `POST` | `/signal` | Offer/Answer/ICE の送信 |
| `GET` | `/messages?nodeId=...&after=...` | 自分宛メッセージの受信 |
| `GET` | `/entrances?exclude=<NodeId>` | 接続候補ノードの探索 |

インターネット越しの接続には `iceServers`（STUN / TURN）または短期資格情報を都度取得する `iceServersProvider` を設定します。接続障害時は `WebRTCChannel` が自動で ICE 再起動（既定最大 2 回）を行います。

### ルーティング

各ノードは距離ベクトル方式で経路表を維持します。隣接が接続されるとコスト 1 の経路を登録し、30 秒ごとに経路情報（`RT_UPDATE`）を交換、60 秒更新のない経路は削除して「撤回（`withdrawals`）」を伝播します。同一ネクストホップからの定期更新で生存時刻（`lastSeen`）を更新し、稼働中経路を維持します。

### セキュリティ（M3）

- **NodeId = Ed25519 公開鍵の指紋**（`SHA-256(rawPublicKey)` の先頭 16 バイト）。`senderId` と検証鍵の指紋が一致しなければパケットは破棄されます。
- **すべてのパケットが Ed25519 署名されます**（プロトコル v2、64 バイト。署名対象は署名フィールドを除くシリアライズ済みパケット、TTL は 0 に正規化）。
- **鍵管理**: ブラウザは `BrowserKeyManager`（Web Crypto + **IndexedDB に非抽出 CryptoKey**）、Node.js は `NodeKeyManager`（`node:crypto`）。
- **公開鍵の配布**: シグナリング時の `public-key` 交換 + `RT_UPDATE` への同梱。`KeyDirectory` が指紋一致を検証して登録します。
- `keyManager` を渡さない場合は後方互換のため v1（署名なし）で動作します。

### 現状の制約（M3）

- 鍵のローテーション（同一 NodeId のままの鍵更新）、アプリケーションデータの E2E 暗号化、明示的なリプレイ検知の強化は未実装です（[specification.md](./specification.md) §10.7）。
- Web Crypto の Ed25519 は Chrome 137+ / Firefox 129+ / Safari 17+ / Node.js 22+ です。非対応環境では v1 にフォールバックします。
- NameServer / `webtcp://` URL / `domain.global` / ブロックチェーン連携は未実装です（M4–M5 / #25）。
- TURN サーバー自体は同梱していません（`iceServers` / `iceServersProvider` で利用者側サーバーを指定）。

## インストール

```bash
npm install @sonneko/webtcp-tunneler
```

このリポジトリから直接ビルドする場合:

```bash
cd webtcp_jslib
npm ci
npm run build     # dist/ に ESM + 型定義を生成
```

## デモ（実ブラウザでの 2 タブ検証 & 自己チェック）

```bash
# リポジトリのルートで
node examples/server.mjs
```

- **2 タブ手動デモ**: `http://localhost:8787/examples/demo/` を **2 つのタブ** で開きます。
  1. タブ A で「ポート 8080 で待ち受ける」を押す
  2. タブ B で「接続先を探す」→ 相手を選択 →「接続」（または「自動接続 (`bootstrap`)」）
  3. テキスト送信、および「80 KiB 分割送信テスト」（> 60 KiB 自動分割・再結合）を確認
  4. 上部のパネルから STUN / カスタム TURN 設定（`?stun=1` でも有効化可能）を切り替えられます
- **1 タブ自動自己チェック**: `http://localhost:8787/examples/demo/?selftest=1` を開くと、同一ページ内で 2 つの実 `RTCPeerConnection` を起動し、`bootstrap()`・ハンドシェイク・テキスト往復・96 KiB 自動分割・Half-Close の 5 項目を自動検証します。
- **2 タブ自動検証**: タブ A の「別タブで 2 タブ自動検証」を押すか、`?role=server&autostart=1` と `?role=client&autostart=1` を 2 タブで開きます。
- **Playwright ヘッドレス Chromium 自動 E2E**:
  ```bash
  npm install --no-save playwright && npx playwright install chromium
  node examples/verify-browser.mjs
  ```

## 利用方法

### サーバー側（待ち受ける）

```ts
import {
    BrowserKeyManager,
    SignalingAdapterHub,
    createBrowserNetwork,
    createLogger,
} from '@sonneko/webtcp-tunneler';

const logger = createLogger({ level: 'info' });

// Ed25519 識別子（IndexedDB に非抽出 CryptoKey として保存。NodeId は公開鍵の指紋）
const keys = await BrowserKeyManager.open({ logger });

const signaling = new SignalingAdapterHub({
    url: 'https://your-signaling-hub.example.com',
    nodeId: keys.nodeId,
    logger,
});

const network = createBrowserNetwork({
    signaling,
    keyManager: keys, // ← 署名必須（プロトコル v2）になる
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    logger,
});
await network.start();

network.listen(8080, (stream) => {
    // コールバック到達時点で ESTABLISHED
    stream.on('data', (data) => {
        const text = new TextDecoder().decode(data);
        void stream.send(`echo:${text}`);
    });

    // Half-Close: 相手の FIN 受信後、必要なら応答を返してから閉じる
    stream.on('end', () => {
        stream.end();
    });
});
```

### クライアント側（自動ブートストラップ + 接続 + 部分読み取り）

```ts
import {
    BrowserKeyManager,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const url = 'https://your-signaling-hub.example.com';

// 同じ鍵を使い回せば NodeId はタブ再読込後も安定する
const keys = await BrowserKeyManager.open();
const signaling = new SignalingAdapterHub({ url, nodeId: keys.nodeId });
const network = createBrowserNetwork({
    signaling,
    keyManager: keys,
    // 短期 TURN 資格情報を都度取得したい場合は iceServersProvider を利用
    iceServersProvider: async () => [{ urls: 'stun:stun.l.google.com:19302' }],
});
await network.start();

// 自身を除いた候補へ指数バックオフ付きで自動リンク確立
const searcher = new EntranceSearcherAdapterHub({ url, exclude: network.localNodeId });
const { connected } = await network.bootstrap(searcher, { maxRetries: 3 });

if (connected.length > 0) {
    const stream = await network.connect(connected[0], 8080);

    // 60 KiB 超のデータも自動分割・再結合される
    await stream.send('hello');

    // 部分読み取り（プルモード）
    const reply = await stream.readExact('echo:hello'.length);
    console.log(new TextDecoder().decode(reply));

    stream.end();
}
```

### 低レベル API

`WebTCPNetwork` は任意の `IChannel` と `Logger` を注入できます。

```ts
import { WebTCPNetwork, noopLogger } from '@sonneko/webtcp-tunneler';

const network = new WebTCPNetwork({
    channel: myChannel,
    nodeId: 'a'.repeat(32),   // 鍵管理を渡さない場合は任意の 32 文字 hex（v1 動作）
    logger: noopLogger,       // 既定は warn 以上の ConsoleLogger
});
await network.start();
```

### Ed25519 署名（Node.js / プロトコル v2）

```ts
import { NodeKeyManager, WebTCPNetwork, createEd25519Verifier } from '@sonneko/webtcp-tunneler';

const keys = await NodeKeyManager.create();             // node:crypto で Ed25519 鍵を生成
const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });

const network = new WebTCPNetwork({
    channel: myChannel,
    keyManager: keys,       // ← NodeId = keys.nodeId（公開鍵の指紋）、署名必須
    keyDirectory,           // ピアの公開鍵ディレクトリ（RT_UPDATE で自動学習）
    verifier,
});
await network.start();
console.log('my NodeId:', network.localNodeId);  // = deriveNodeId(keys.publicKey)
```

既存の鍵を復元する場合:

```ts
const keys = await NodeKeyManager.create({ privateKeyPem });  // PKCS#8 PEM
// または const keys = await NodeKeyManager.create({ secretKeyHex });  // 32 バイトのシード
```

## ドキュメント

| 文書 | 内容 |
| :--- | :--- |
| [specification.md](./specification.md) | プロトコル仕様（パケット形式、TCP セマンティクス、状態機械、シグナリング・ICE 契約、**セキュリティ §10**） |
| [design.md](./design.md) | 実装構造と設計判断 |
| [plan.md](./plan.md) | マイルストーン、将来課題、リスク |
| [docs/layer.md](./docs/layer.md) | 将来構想（名前解決・分散ドメイン）のメモ |
| [webtcp_website/](./webtcp_website/) | Astro + Starlight 公式ドキュメントサイト |

## ディレクトリ構成

```
webtcp_jslib/      ライブラリ本体（TypeScript）
  src/core/        ブラウザ・Node 非依存のプロトコル実装（routing/keys, KeyDirectory を含む）
  src/adapters/    WebRTC / シグナリング / エントランス探索 / 鍵管理（keys）
  tests/           node:test によるテスト（86 件）
  dist/            npm run build の生成物（Git 管理外）
examples/
  server.mjs       静的配信 + シグナリングハブ + エントランス探索
  verify-browser.mjs Playwright 2 タブ実ブラウザ検証スクリプト
  demo/            2 タブデモ + STUN 設定例 + 内蔵自己チェック
webtcp_website/    公式ドキュメントサイト（Astro + Starlight）
```

## 開発とテスト

```bash
# ライブラリビルド + 自動テスト (node --test)
cd webtcp_jslib
npm ci
npm test

# ドキュメントサイトのビルド
cd ../webtcp_website
npm ci
npm run build
```

## ロードマップ

- **M1（完了）**: 最小の end-to-end。アダプタ、コア修正、ビルド、デモ、テスト
- **M2（完了）**: バイトストリーム化、自動分割、動的 RTO、輻輳制御、Fast Retransmit / SACK、ランダム ISN、Half-Close、ロガー、`bootstrap()`、TURN/ICE 再起動、ドキュメントサイト、実ブラウザ検証
- **M3（完了 / #28）**: Ed25519 署名（プロトコル v2）、NodeId の鍵指紋化、`BrowserKeyManager` / `NodeKeyManager`、公開鍵の自動配布
- **M4（予定 / #25）**: マルチホップ厳格化、SSE/WebSocket シグナリング、`webtcp://` URL、NameServer
- **M5（予定 / #25）**: `domain.global`、ブロックチェーン連携

詳細は [plan.md](./plan.md) を参照してください。

## ライセンス

MIT
