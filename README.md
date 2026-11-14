# WebTCP

**P2P接続のための実験的なWebRTCトンネリングライブラリ**

## 概要

WebTCPは、ブラウザを単なるクライアントではなく、**自己完結型のサーバー実行環境**として再定義するための実験的なライブラリです。従来のWebアプリケーションは、外部のクラウドサーバーに依存しています。本ライブラリは、WebRTC（Web Real-Time Communication）の**信頼性の高いデータチャネル（SCTP）を基盤とし、アプリケーション層で仮想的なTCP/HTTPトンネル**を構築することで、このパラダイムに挑戦します。

これにより、**Webブラウザ内で動作するサービス**に対し、他のデバイスから**直接**、セキュアにアクセスできるP2P接続を確立します。これは、未来の**分散型コンピューティング（Web3）**において、サービスが中央集権的なインフラストラクチャから解放されるための、**新しいネットワークの抽象化**を目指すものです。

ブラウザの制限付きの`fetch`を使っているわけではないので、TCPレイヤーから自由に通信を操ることができます。

> **現在のステータス**: M1（最小の end-to-end）実装済み。2つのブラウザ間で仮想TCPの接続・送受信・切断が動作します。暗号学的な署名や名前解決は未実装です。詳細は [plan.md](./plan.md) を参照してください。

## 主な機能

1. **SCTP上の多重化 (Multiplexing)**: WebRTCの単一のデータチャネル上で、複数の仮想的なTCP接続を仮想ポートとセッションIDにより多重化します。
2. **仮想TCPトランスポート**: SYN / SYN_ACK / ACK / DATA / FIN / RST による状態機械、順序保証、再送、フロー制御を実装しています。
3. **シグナリング抽象化**: 接続に必要な情報（SDP Offer/Answer、ICE候補）の交換プロセスを抽象化します。HTTPポーリング型の `SignalingAdapterHub` を同梱しています。
4. **マルチホップルーティング**: 距離ベクトル方式の経路表と TTL / RPF を持ち、中継ノードを経由した通信ができます。
5. **ブラウザで直接動く**: コアは `Buffer` や Node.js の `events` に依存しません。`tsc` の出力をそのまま `<script type="module">` から読み込めます。

## 仕組み

### 全体像

WebTCP は、WebRTC のデータチャネル（メッセージ指向・順序保証あり）の上に、TCP に相当する機能を**アプリケーション層で**再実装します。データチャネルは「バイトストリーム」ではなく「メッセージの連続」を提供するため、その上に独自の L3/L4 ヘッダーを持つパケットを流します。

```
+-----------------------------------------------------------+
| L7  アプリケーション (任意のプロトコル / 将来のHTTP)         |
+-----------------------------------------------------------+
| L4  TransportLayer : 仮想ポート多重化 / SessionManager      |
|     VirtualStream  : 状態機械 / Seq-Ack / 再送 / 順序制御    |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF / 署名検証  |
|     RoutingTable   : 距離ベクトル経路表                      |
+-----------------------------------------------------------+
| L2  LinkManager    : 隣接管理 / パケットのシリアライズ        |
|     IChannel       : WebRTC DataChannel の抽象化             |
|     ISignalingAdapter : Offer/Answer/ICE の運搬              |
+-----------------------------------------------------------+
| L1  WebRTC (SCTP over DTLS over ICE) / ブラウザ API          |
+-----------------------------------------------------------+
```

### パケットの流れ

送信側では、アプリケーションが `VirtualStream.send()` を呼ぶと次の順に処理されます。

1. **VirtualStream** が L4 ヘッダー（ポート、フラグ、Seq/Ack）を付け、再送キューに積む。
2. **TransportLayer** がルーティング層へ渡す。
3. **RoutingLayer** が L3 ヘッダー（送信元・宛先 NodeId、TTL）を付け、経路表からネクストホップを決める。
4. **LinkManager** が 24 バイトの固定ヘッダー + 可変長フィールドのバイナリへシリアライズする。
5. **IChannel**（WebRTC DataChannel）が1メッセージとして送信する。

受信側は逆順に処理します。デシリアライズ → 署名検証 → RPF チェック → 宛先判定（自分宛なら L4 へ、そうでなければ転送）→ セッション検索 → アプリケーションへ `data` イベント。

### パケットフォーマット

すべてのパケットはバイナリで、マルチバイト整数はビッグエンディアンです（全 24 バイトの固定ヘッダー）。

| Offset | Size | Field | 説明 |
| ---: | ---: | :--- | :--- |
| 0 | 1 | `magic` | `0x57`（`'W'`） |
| 1 | 1 | `version` | プロトコルバージョン（現在 `1`） |
| 2 | 1 | `ttl` | 残ホップ数（初期値 64） |
| 3 | 1 | `flags` | DATA / SYN / ACK / FIN / RST / SYN_ACK / RT_UPDATE のビットマスク |
| 4 | 2 | `sourcePort` | 送信元の仮想ポート |
| 6 | 2 | `destinationPort` | 宛先の仮想ポート |
| 8 | 4 | `seqNum` | シーケンス番号 |
| 12 | 4 | `ackNum` | 次に期待する受信シーケンス番号 |
| 16 | 1 | `senderIdLen` | 送信元 NodeId の長さ |
| 17 | 1 | `destIdLen` | 宛先 NodeId の長さ |
| 18 | 2 | `signatureLen` | 署名長（M1 は 0） |
| 20 | 4 | `payloadLen` | ペイロード長 |
| 24 | 可変 | … | senderId / destinationId / signature / payload |

パケット種別は**必ずフラグ**で判定します。ペイロードの内容で種別を推定してはいけません（本文に "ACK" を含むデータが壊れるため）。詳細は [specification.md](./specification.md) §6 を参照してください。

### 多重化とセッション

1つの DataChannel の上を、複数の仮想 TCP セッションが流れます。セッションは `(remoteNodeId, localPort, remotePort)` の三つ組で識別されます。

```
DataChannel (peer A <-> B)
 ├─ 8080 <- 50001  : HTTPサーバーへの接続 #1
 ├─ 8080 <- 50002  : HTTPサーバーへの接続 #2
 └─ 3000 <- 50003  : 別サービスの接続
```

受信側は `destinationPort` で待ち受け中のアプリケーションハンドラを選び、`sourcePort` と組み合わせて既存セッションに振り分けます。セッションが無い状態で SYN 以外が届いた場合は RST を返します。

### 接続確立（ハンドシェイク）

```
Client                                Server
  |--- SYN (seq=0) -------------------->|
  |<-- SYN_ACK (seq=0, ack=1) ----------|
  |--- ACK (ack=1) -------------------->|  ← 双方 ESTABLISHED
  |--- DATA (seq=1) -------------------->|  → アプリへ 'data'
  |<-- ACK (ack=2) ---------------------|
  |--- FIN ---------------------------->|
  |<-- ACK + FIN -----------------------|  ← 双方 CLOSED
```

再送は RTO 1 秒・最大 5 回、送信ウィンドウは 10 パケットです。

### リンク確立とシグナリング

WebRTC の接続には Offer/Answer と ICE 候補の交換が必要です。WebTCP はこの運搬を `ISignalingAdapter` に委譲します。同梱の `SignalingAdapterHub` は次の HTTP エンドポイントを使うポーリング型の実装です。

| メソッド | パス | 用途 |
| :--- | :--- | :--- |
| `POST` | `/signal` | Offer/Answer/ICE の送信 |
| `GET` | `/messages?nodeId=...&after=...` | 自分宛メッセージの受信 |
| `GET` | `/entrances` | 接続候補ノードの探索 |

`examples/server.mjs` がこのサーバーのリファレンス実装です（依存パッケージなし）。

### ルーティング

各ノードは距離ベクトル方式で経路表を維持します。隣接が接続されるとコスト1の経路を登録し、30秒ごとに経路情報（`RT_UPDATE`）を交換、60秒更新のない経路は削除します。切断時は「撤回（withdrawal）」を伝播します。

経路が未学習でも、直接の隣接ノード宛なら送信できます。3ノード以上の構成では中継ノードがパケットを転送します。

### 現状の制約（M1）

- シーケンス番号は**パケット単位**です（バイトストリームではありません）。アプリケーションはメッセージ境界を意識する必要があります。
- 1パケットのペイロード上限は 60 KiB。自動分割は未実装です。
- 署名・暗号化は未実装です（DTLS によるトランスポート暗号化のみ）。NodeId は自己申告です。
- 輻輳制御はありません（固定ウィンドウ・固定 RTO）。
- NAT 越えは `iceServers` の設定に依存します。TURN は同梱していません。

## インストール

```bash
npm install @sonneko/webtcp-tunneler
```

このリポジトリから直接使う場合:

```bash
cd webtcp_jslib
npm install
npm run build     # dist/ に ESM + 型定義を生成
```

## デモ（2つのブラウザで動かす）

```bash
# リポジトリのルートで
node examples/server.mjs
```

`http://localhost:8787/examples/demo/` を **2つのタブ**（または2つのブラウザ）で開きます。

1. タブAで「ポート 8080 で待ち受ける」を押す
2. タブBで「接続先を探す」→ 相手を選択 →「接続」
3. テキストを送信すると、エコーサーバーから応答が返る

シグナリングは同一オリジンの `/signal` と `/messages` を使います。別ホストから試す場合は `SignalingAdapterHub` の `url` をサーバーのアドレスに変更してください（LAN 内ならそのまま接続できます）。

## 利用方法

### サーバー側（待ち受ける）

```ts
import { SignalingAdapterHub, createBrowserNetwork } from '@sonneko/webtcp-tunneler';

const signaling = new SignalingAdapterHub({
    url: 'https://your-signaling-hub.example.com',
});

const network = createBrowserNetwork({ signaling });
await network.start();

network.listen(8080, (stream) => {
    console.log('connected:', stream.remoteNodeId);

    stream.on('data', (data) => {
        console.log('received:', new TextDecoder().decode(data));
        void stream.send('pong');
    });

    stream.on('close', () => console.log('closed'));
});
```

### クライアント側（接続する）

```ts
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const url = 'https://your-signaling-hub.example.com';
const signaling = new SignalingAdapterHub({ url });
const network = createBrowserNetwork({ signaling });
await network.start();

// 接続候補を探す
const searcher = new EntranceSearcherAdapterHub({ url });
const [targetNodeId] = await searcher.search();

// リンク確立 + 仮想TCP接続（自動）
const stream = await network.connect(targetNodeId, 8080);

stream.on('data', (data) => {
    console.log('reply:', new TextDecoder().decode(data));
});
await stream.send('hello');
```

### 低レベル API

`WebTCPNetwork` は `IChannel` を注入できます。WebRTC を使わずにテストしたい場合や、独自のトランスポートを使いたい場合に便利です。

```ts
const network = new WebTCPNetwork({
    channel: myChannel,   // IChannel の実装
    nodeId: 'a'.repeat(32),
});
await network.start();
```

## ドキュメント

| 文書 | 内容 |
| :--- | :--- |
| [specification.md](./specification.md) | プロトコル仕様（パケット形式、状態機械、シグナリング契約） |
| [design.md](./design.md) | 実装構造と設計判断 |
| [plan.md](./plan.md) | マイルストーン、将来課題、リスク |
| [docs/layer.md](./docs/layer.md) | 将来構想（名前解決・分散ドメイン）のメモ |

## ディレクトリ構成

```
webtcp_jslib/      ライブラリ本体（TypeScript）
  src/core/        ブラウザ・Node非依存のプロトコル実装
  src/adapters/    WebRTC / シグナリング / エントランス探索
  tests/           node:test によるテスト
  dist/            npm run build の生成物（Git管理外）
examples/
  server.mjs       静的配信 + シグナリングハブ
  demo/            2タブで動くデモ
webtcp_website/    ドキュメントサイト（Astro / 未整備）
```

## 開発

```bash
cd webtcp_jslib
npm test            # ビルド + テスト (node --test)
```

テストはインメモリのループバックチャネルを使うため、ブラウザなしで以下を検証できます。

- シリアライザの往復・不正入力の拒否
- 2ノード間のハンドシェイク・双方向データ・切断
- 3ノード構成でのマルチホップ転送と経路の撤回
- シグナリングハブの配送とエントランス探索
- フェイクの `RTCPeerConnection` を注入した WebRTC 経路の end-to-end

## ロードマップ

- **M1（完了）**: 最小の end-to-end。アダプタ、コア修正、ビルド、デモ、テスト
- **M2**: バイトストリーム化、自動分割、輻輳制御、ランダム ISN
- **M3**: Ed25519 署名、NodeId の鍵指紋化、鍵管理
- **M4**: マルチホップの厳格化、`webtcp://` URL、NameServer
- **M5**: `domain.global`、ブロックチェーン連携

詳細は [plan.md](./plan.md) を参照してください。

## ライセンス

MIT
