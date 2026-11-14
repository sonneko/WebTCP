# WebTCP 設計書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.1.0 |
| 対応仕様 | `specification.md` 0.1.0 / プロトコル v1 |
| 最終更新 | 2026-11-14 |

本書は `specification.md` を満たすための**実装構造と技術判断**を記述する。

---

## 1. 設計原則

1. **プラットフォーム非依存のコア**: `src/core` はブラウザにも Node.js にも依存しない。DOM API・Node 組み込みモジュールを直接使わない。
2. **依存は上から下への一方向**: アプリケーション → トランスポート → ルーティング → リンク → アダプタ。逆方向はイベントとインターフェースで解決する。
3. **アダプタで差し替え可能**: WebRTC・シグナリング・エントランス探索・鍵管理はすべてインターフェースの実装として注入する。
4. **小さく検証可能**: 1 ファイル 1 責務。ユニットテストは Node.js の `node:test` のみで実行できる。
5. **ブラウザで直接動く成果物**: バンドラを必須にしない。`tsc` の ESM 出力をそのまま `<script type="module">` から読める形にする。

## 2. モジュール構成

```
webtcp_jslib/
├── package.json          # ESM, exports, build/test スクリプト
├── tsconfig.json         # ES2022 + DOM, strict
├── src/
│   ├── index.ts          # 公開エントリポイント（全 export）
│   ├── core/
│   │   ├── types/
│   │   │   ├── protocol.ts      # NodeId, VirtualPort, SequenceNumber, WebTCPFlags ...
│   │   │   ├── packet.ts        # WebTCPPacket
│   │   │   ├── serializer.ts    # BinaryPacketSerializer (v1 バイナリ形式)
│   │   │   └── index.ts
│   │   ├── util/
│   │   │   ├── EventEmitter.ts  # DOM/Node 非依存の最小実装
│   │   │   └── id.ts            # generateNodeId()
│   │   ├── link/
│   │   │   ├── IChannel.ts          # データチャネル抽象
│   │   │   ├── ISignalingAdapter.ts # シグナリング抽象
│   │   │   ├── LinkManager.ts       # 近隣管理 + パケット入出力
│   │   │   └── index.ts
│   │   ├── routing/
│   │   │   ├── PacketVerifier.ts    # IPacketVerifier / NullPacketVerifier
│   │   │   ├── RoutingTable.ts
│   │   │   ├── RoutingTableManager.ts
│   │   │   ├── RoutingLayer.ts
│   │   │   └── index.ts
│   │   ├── transport/
│   │   │   ├── TransportLayer.ts
│   │   │   ├── VirtualStream.ts
│   │   │   ├── RetransmitQueue.ts
│   │   │   ├── SessionManager.ts
│   │   │   └── index.ts
│   │   └── network/
│   │       ├── WebTCPNetwork.ts
│   │       └── index.ts
│   └── adapters/
│       ├── webrtc/
│       │   ├── WebRTCChannel.ts          # RTCPeerConnection 共通実装（抽象）
│       │   ├── BrowserWebRTCChannel.ts   # ブラウザ用（RTCPeerConnection を注入）
│       │   └── NodeWebRTCChannel.ts      # Node 用（生成関数を注入）
│       ├── signaling/
│       │   ├── SignalingAdapterHub.ts    # HTTP ポーリング型ハブクライアント
│       │   └── index.ts
│       └── entrance-searcher/
│           ├── IEntranceSearcher.ts
│           ├── EntranceSearcherAdapterHub.ts
│           └── index.ts
├── tests/                # node:test（dist を import）
└── examples/
    ├── demo/             # 2 タブ/2 ブラウザで動くデモ
    └── server.mjs        # 静的配信 + シグナリングハブ + エントランス探索
```

## 3. 主要な設計判断

### 3.1 `Buffer` を捨てて `Uint8Array` を使う

**課題**: 既存コードは `Buffer` と `NodeJS.Timeout`、`events` に依存しており、ブラウザでそのまま動かない。

**判断**: パケットのペイロードと署名を `Uint8Array` にする。Node.js の `Buffer` は `Uint8Array` の派生なので、Node 側からはそのまま渡せる。シリアライザは `DataView` と `TextEncoder`/`TextDecoder` のみを使う。

**影響**: Node 組み込み型が不要になり、`tsconfig` の `types` を空にできる。`node_modules` なしでブラウザが直接 import できる。

### 3.2 独自の `EventEmitter`

**課題**: `events` は Node 組み込みで、ブラウザではポリフィルが必要。

**判断**: `src/core/util/EventEmitter.ts` に `on` / `once` / `off` / `emit` / `removeAllListeners` / `listenerCount` だけを持つ実装を置く。`on` は `this` を返し、Node の `EventEmitter` と構造的に互換にする。

**代替案**: `EventTarget` を使う。→ イベントごとの型付けが弱く、`once` や `off` の実装が冗長になるため却下。

### 3.3 IChannel の責務を「メッセージ輸送」に限定する

シグナリングは `IChannel` の実装（`WebRTCChannel`）が内部で利用する。`LinkManager` は隣接状態とパケットのシリアライズだけを扱う。

**理由**: 旧実装では `LinkManager` と `IChannel` と `RoutingTableManager` がそれぞれシグナリング/生データ送信を実装しており、責務が三重重複していた。シグナリングの所有権を `IChannel` に一本化し、ルーティング情報も通常の `RT_UPDATE` パケットに載せることで、シリアライズ経路が 1 本になる。

### 3.4 ルーティング情報を WebTCP パケットに載せる

旧実装はルーティング更新を生 JSON で `channel.send()` していたため、受信側の `RoutingLayer` がデシリアライズに失敗していた。`RT_UPDATE` フラグのパケットに統一する。

経路の削除は距離ベクトルだけでは伝播できない（「エントリが無い」ことは「到達不能」を意味しない）。そのため `withdrawals`（撤回リスト）を受信側で処理する。撤回は、その宛先のネクストホップが送信元と一致する場合のみ適用する。

### 3.5 署名検証を差し替え可能にする（M1 は Null）

**課題**: `PacketVerifier` が `KeyManager` を必須にしており、実装が存在しないため全パケットが破棄される。ブラウザで鍵管理を入れるのは M3 の範囲。

**判断**: `IPacketVerifier` を定義し、M1 の既定を `NullPacketVerifier`（署名なし・常に有効）とする。`WebTCPNetwork` のオプションで検証器を注入できる。署名フィールドはワイヤーフォーマットに予約済みなので、後から互換性を壊さず導入できる。

### 3.6 RPF を「直接隣接なら許可」に緩和する

**課題**: 距離ベクトルが収束する前は経路表にエントリがなく、厳格な RPF だと最初のパケットがすべて落ちる。

**判断**: 経路が未学習で、かつ受信元が直接の隣接なら許可する。マルチホップ導入時に厳格化する（`plan.md`）。

### 3.7 パケット種別は必ずフラグで判定する

旧実装は `payload.includes('ACK')` で種別を判定しており、本文に "ACK" を含むデータが壊れていた。`WebTCPFlags` をビットマスクとしてシリアライズし、判定は `flags & MASK` で行う。`SYN_ACK` は `SYN|ACK` として正規化する。

### 3.8 WebRTC 実装を 1 つの基底クラスに集約する

`WebRTCChannel`（抽象）が offer/answer/ICE/データチャネルの扱いをすべて実装し、サブクラスは `createPeerConnection()` だけを提供する。

- `BrowserWebRTCChannel`: グローバルの `RTCPeerConnection` を使用。
- `NodeWebRTCChannel`: 利用者が `wrtc` や `node-datachannel` から生成関数を注入。**依存パッケージを増やさない**。

### 3.9 シグナリングは HTTP ポーリングを既定にする

**判断**: `SignalingAdapterHub` は `POST /signal` と `GET /messages` のポーリングで実装する。SSE/WebSocket よりも実装・デプロイが単純で、静的ホスティング + 小さな関数サーバーで動く。

**トレードオフ**: 接続確立に最大 1 ポーリング間隔の遅延が乗る。`pollIntervalMs` で調整可能。将来的に SSE/WebSocket 実装を追加する（`plan.md`）。

### 3.10 `WebTCPNetwork` のコンストラクタをオプション形式にする

旧実装は `(adapter, keyManager)` で、`KeyManager` の実装が存在せず利用不能だった。オプションオブジェクトにして `signaling` / `channel` / `nodeId` / `verifier` を任意にする。`channel` を渡せば WebRTC 以外（テスト用ループバック等）でも動く。

## 4. クラス責務

| クラス | 責務 | 依存 |
| :--- | :--- | :--- |
| `WebTCPNetwork` | 層の組み立て、公開 API、リンク確立のオーケストレーション | 全層 |
| `LinkManager` | 近隣集合の維持、`WebTCPPacket` ⇄ バイト列、IChannel への送信 | `IChannel`, `BinaryPacketSerializer` |
| `RoutingLayer` | 宛先判定、転送、TTL、RPF、RT_UPDATE の振り分け | `LinkManager`, `RoutingTable`, `IPacketVerifier` |
| `RoutingTableManager` | 距離ベクトル更新、エイジング、ブロードキャスト | `RoutingTable`, 送信コールバック |
| `TransportLayer` | ポート多重化、ストリーム生成、RST | `RoutingLayer`, `SessionManager` |
| `VirtualStream` | 状態機械、Seq/Ack、再送、順序制御、アプリ I/O | `TransportLayer` context |
| `SessionManager` | セッション表、アイドル回収 | — |
| `WebRTCChannel` | offer/answer/ICE、DataChannel、近隣状態 | `ISignalingAdapter` |
| `SignalingAdapterHub` | HTTP によるシグナリングメッセージの送受信 | `fetch` |
| `EntranceSearcherAdapterHub` | HTTP による参加ノードの発見 | `fetch` |

循環依存の回避:

- `RoutingLayer` ⇄ `TransportLayer` は `setTransportLayer()` による後からの注入で解消。
- `TransportLayer` ⇄ `VirtualStream` は `TransportContext` インターフェース（`localNodeId`, `sendPacket`, `deregister`）で解消。

## 5. シーケンス

### 5.1 リンク確立（2 ノード、HTTP ハブ）

```
A                           hub                           B
|-- POST /signal (offer) -->|                             |
|                           |<-- GET /messages (poll) -----|
|                           |--- offer ------------------>|
|                           |<-- POST /signal (answer) ----|
|<-- GET /messages ---------|                             |
|-- POST /signal (candidate)-->|                          |
|                           |--- candidate -------------->|
|============ DTLS/SCTP データチャネル ====================|
|   connection-status(true)                              |
```

### 5.2 仮想接続の確立

```
Client (TransportLayer)                     Server (TransportLayer)
| stream=SYN_SENT, send SYN seq=0            |
|------------------------------------------->| no session + listener
|                                            | stream=SYN_RCVD
|                                            | send SYN_ACK seq=0 ack=1
|<-------------------------------------------|
| ackNum==nextSend -> ESTABLISHED            |
| emit connect                               |
| send ACK ack=1                             |
|------------------------------------------->| ackNum>=nextSend -> ESTABLISHED
|                                            | emit connect, handler(stream)
```

### 5.3 データ送信

```
Client                                        Server
| sendData("hello")                          |
| DATA seq=1, enqueue                        |
|------------------------------------------->| seq==expected -> emit data
|                                            | expected=2, send ACK ack=2
|<-------------------------------------------|
| ACK -> dequeueCumulative(2), emit drain    |
```

### 5.4 切断

```
Client (FIN_WAIT_1)                           Server (ESTABLISHED)
| FIN seq=N --------------------------------->| send ACK; send FIN; CLOSING
|<---------------------------------- ACK+FIN  |
| -> CLOSED, emit close                       | -> CLOSED, emit close
```

## 6. 状態と並行性

- すべての処理は単一スレッドのイベントループ上で動く。共有状態のロックは不要。
- タイマーは `ReturnType<typeof setTimeout>` で保持し、`close()` で必ず解除する。
- `WebTCPNetwork.start()` は冪等（二重呼び出しで多重タイマーを作らない）。
- 未処理 Promise の reject を避けるため、イベントハンドラ内の非同期処理は `catch` でログ化する。

## 7. エラー処理方針

| 層 | 方針 |
| :--- | :--- |
| シリアライザ | 不正入力は `Error` を投げる。呼び出し側（LinkManager）が捕捉して破棄。 |
| リンク | 送信失敗は隣接を切断し `false` を返す。プロセスを落とさない。 |
| ルーティング | 経路なし・TTL 切れ・検証失敗は破棄 + 警告。 |
| トランスポート | アプリ向け API は Promise を reject。イベントで通知。 |
| アダプタ | ネットワークエラーはログ + 再試行（ポーリング）。`connect()` はタイムアウトで reject。 |

## 8. テスト戦略

- **ユニット**: シリアライザの往復、境界値、不正データ。`node:test`。
- **統合**: `LoopbackChannel`（テスト専用の `IChannel` 実装）を使い、2 つの `WebTCPNetwork` をメモリ内で接続して
  SYN/SYN_ACK/ACK、データ送受信、切断、ルーティング学習を検証する。WebRTC を介さないため CI で安定して動く。
- **アダプタ**: `SignalingAdapterHub` をローカル HTTP サーバーに対して 2 クライアントで動かし、メッセージ配送を検証。
- **WebRTC 経路**: フェイクの `RTCPeerConnection` / `RTCDataChannel` を `NodeWebRTCChannel` に注入し、
  Offer/Answer の交換からデータ送受信までを Node.js 上で検証する（`tests/webrtc.test.mjs`）。
- **手動**: `examples/server.mjs` + 2 タブで実際の WebRTC 接続を確認。

WebRTC そのものの自動テストは CI 環境でブラウザが必要なため、M2 で Playwright 導入を検討する。

## 9. 既存コードからの移行

| 旧 | 新 | 理由 |
| :--- | :--- | :--- |
| `core/routing/PacketVarifier.ts` | `core/routing/PacketVerifier.ts` | ファイル名 typo。中身も未完成だったため書き直し。 |
| `core/transport/RetrainsmitQueue.ts` | `core/transport/RetransmitQueue.ts` | ファイル名 typo。import 名と一致していなかった。 |
| `core/transport/PortMultiplexer.ts` | 削除 | `TransportLayer.ts` の完全なコピーで、参照もされていなかった。 |
| `core/types/serializer.ts` の Buffer 実装 | `Uint8Array` + DataView 実装 | ブラウザ互換。フラグ復元のバグも修正。 |
| `LinkManager` のダミー `IChannel` | `IChannel` 実装の注入 | ダミーでは接続が確立しなかった。 |
| `WebTCPNetwork(adapter, keyManager)` | `WebTCPNetwork(options)` | `KeyManager` 実装が存在せず利用不能だった。 |

## 10. 既知の制約（M1）

- パケット単位のシーケンス（バイトストリームではない）。
- 単一隣接（2 ノード）を主対象としたルーティング。3 ノード以上は距離ベクトルが動くが、RPF は緩和版。
- 署名・暗号化なし。
- メッセージサイズの自動分割なし（上限 60 KiB）。
- TURN サーバー設定は利用者責任。NAT 越えの保証なし。
- 再送は固定 RTO。輻輳制御なし。

これらは `plan.md` の将来課題に対応する。
