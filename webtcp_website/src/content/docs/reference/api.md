---
title: API リファレンス
description: "@sonneko/webtcp-tunneler の公開クラス・関数・オプション一覧。"
---

すべての公開 API は `@sonneko/webtcp-tunneler` のルートエントリポイントからエクスポートされます。

## `createBrowserNetwork(options)`

ブラウザ環境で `BrowserWebRTCChannel` と `WebTCPNetwork` を一括生成するヘルパーです。

| オプション | 型 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `signaling` | `ISignalingAdapter` | **必須** | シグナリングアダプタ |
| `nodeId` | `NodeId` | `keyManager.nodeId` → `signaling.getLocalNodeId()` | ノード ID（鍵管理を渡す場合は指紋と一致必須） |
| `keyManager` | `Ed25519KeyManager` | — | Ed25519 鍵管理。渡すとプロトコル v2（署名必須）になる |
| `keyDirectory` | `KeyDirectory` | 鍵管理から自動生成 | ピア公開鍵のディレクトリ |
| `iceServers` | `RTCIceServer[]` | `[]` | 静的 STUN / TURN 設定 |
| `iceServersProvider` | `() => RTCIceServer[] \| Promise<RTCIceServer[]>` | — | 接続生成・ICE 再起動時の動的 ICE 設定取得フック |
| `maxIceRestarts` | `number` | `2` | ICE 失敗時の自動再起動上限（`0` で無効） |
| `iceRestartDelayMs` | `number` | `3000` | `disconnected` 継続後に ICE 再起動するまでの猶予（ms） |
| `dataChannelLabel` | `string` | `'webtcp'` | DataChannel のラベル |
| `connectTimeoutMs` | `number` | `15000` | WebRTC リンク確立タイムアウト（ms） |
| `logger` | `Logger` | `defaultLogger` | カスタムロガー（指定時は `logLevel` より優先） |
| `logLevel` | `LogLevel` | `'warn'` | 既定コンソールロガーのログレベル |

## `WebTCPNetwork`

プロトコルスタック全体を束ねる最上位クラスです。

### メソッド

- `start(): Promise<void>` — 全層を起動（冪等）。完了時に `'ready'` イベントを発火。
- `listen(port: VirtualPort, handler: (stream: VirtualStream) => void): void` — 指定ポートで待ち受け。ハンドラは `ESTABLISHED` 到達時に呼ばれます。
- `connect(remoteId: NodeId, remotePort: VirtualPort, localPort?: VirtualPort): Promise<VirtualStream>` — 必要ならリンク確立を行ったうえで仮想 TCP 接続を確立。
- `connectToPeer(remoteId: NodeId): Promise<void>` — リンク層の隣接接続のみを確立。
- `bootstrap(searcher: IEntranceSearcher, options?: BootstrapOptions): Promise<BootstrapResult>` — エントランス候補へ順に接続を試行（失敗時は指数バックオフでリトライ）。
- `getNeighbors(): NodeId[]` — 直接接続中の隣接ノード ID 一覧。
- `getRoutingTable(): RoutingTable` — 現在のルーティングテーブル。
- `close(): void` — 全層・全タイマー・全セッションを停止。

### `BootstrapOptions`

| 項目 | 型 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `targetConnections` | `number` | `1` | 確立したい隣接接続数 |
| `maxRetries` | `number` | `3` | 最大試行ラウンド数（初回含む） |
| `initialBackoffMs` | `number` | `500` | 初回リトライまでの待機時間（ms） |
| `maxBackoffMs` | `number` | `10000` | バックオフ上限（ms） |
| `backoffFactor` | `number` | `2` | 指数バックオフ倍率 |
| `signal` | `AbortSignal` | — | 中断用シグナル |

## `VirtualStream`

単一の仮想 TCP セッションを表します。

### メソッド・プロパティ

- `send(data: Uint8Array | string): Promise<void>` — 任意長データを送信（MSS 自動分割・輻輳制御）。`ESTABLISHED` と `CLOSE_WAIT` で呼び出し可能。
- `read(maxBytes?: number): Uint8Array | null` — 受信バッファから部分読み取り（プルモード）。
- `readExact(bytes: number): Promise<Uint8Array>` — 厳密に `bytes` バイトが揃うまで待機して返す。
- `pause(): this` / `resume(): this` — フローイング配送の一時停止・再開。
- `end(): void` / `close(): void` — 送信バッファをフラッシュ後に `FIN` を送信（Half-Close）。
- `destroy(): void` — `FIN` / `TIME_WAIT` を待たず即座に終了。
- `getStats(): VirtualStreamStats` — `rtoMs`, `srttMs`, `cwndBytes`, `ssthreshBytes`, `inFlightBytes`, `retransmissions`, `fastRetransmits`, SACK 統計などを取得。
- `readonly state: StreamState` / `readonly readableLength: number` / `readonly initialSendSeqNum: SequenceNumber`

### イベント

| イベント | 引数 | 説明 |
| :--- | :--- | :--- |
| `'connect'` | なし | ハンドシェイク完了（`ESTABLISHED`） |
| `'data'` | `Uint8Array` | 受信データ（フローイングモード） |
| `'readable'` | なし | 受信バッファに未読データあり（プルモード） |
| `'end'` | なし | 相手の `FIN` により受信側が EOF に到達（一度だけ） |
| `'drain'` | なし | 送信バッファ・未 ACK キューがともに空になった |
| `'close'` | なし | `CLOSED` へ遷移完了（一度だけ） |
| `'error'` | `Error` | RST または再送上限超過などの異常終了 |

## セキュリティ API（M3 / #28）

### 鍵管理

| API | 説明 |
| :--- | :--- |
| `BrowserKeyManager.open({ databaseName?, regenerate?, keyDirectory?, logger? })` | ブラウザ用。秘密鍵を **IndexedDB に非抽出 CryptoKey** として保存。`nodeId` / `publicKey` / `sign()` / `verify()` / `deriveNodeId()` |
| `BrowserKeyManager.regenerate(options)` | 新しい鍵ペアで IndexedDB を上書き |
| `NodeKeyManager.create({ privateKeyPem?, secretKeyHex?, nodeId?, keyDirectory? })` | Node.js 用（`node:crypto`）。`exportPrivateKeyPem()` / `exportSecretKeyHex()` |
| `deriveNodeId(publicKey)` | `hex(SHA-256(公開鍵)[0..16])` を返す（NodeId の鍵指紋化） |
| `nodeIdMatchesPublicKey(nodeId, publicKey)` | 指紋の照合 |
| `isValidNodeId(value)` | `^[0-9a-f]{32}$` の判定 |
| `encodePublicKey(publicKey)` / `decodePublicKey(text)` | Base64url（パディングなし）エンコード |

### 署名・検証・公開鍵ディレクトリ

| API | 説明 |
| :--- | :--- |
| `new Ed25519PacketVerifier({ keyManager, keyDirectory?, serializer?, keyWaitTimeoutMs? })` | `IPacketVerifier` 実装。署名付与と検証 |
| `createEd25519Verifier({ keyManager, keyDirectory?, ... })` | `{ verifier, keyDirectory, publicKey, publicKeyEncoded, nodeId }` を返すヘルパー |
| `new KeyDirectory({ logger? })` | `addPublicKey()`（指紋不一致は `false`）/ `getPublicKey()` / `waitForPublicKey()` |
| `NullPacketVerifier` | 署名なしのレガシー検証器（v1 相互運用専用） |
| `isEd25519KeyManager(value)` | 鍵管理の型ガード |

### `WebTCPNetwork` の署名関連プロパティ

- `keyManager: Ed25519KeyManager | null` — 指定した鍵管理
- `keyDirectory: KeyDirectory | null` — 公開鍵ディレクトリ
- `verifier: IPacketVerifier` — 実際に使われている検証器
- オプション `requireSignatures?: boolean` — 既定は鍵管理 / `Ed25519PacketVerifier` 指定時に `true`

## アダプタとロガー

- `BrowserWebRTCChannel` / `NodeWebRTCChannel` / `WebRTCChannel.restartIce(peerId)`
- `SignalingAdapterHub({ url, nodeId?, pollIntervalMs?, fetchImpl?, logger?, logLevel? })`
- `EntranceSearcherAdapterHub({ url, path?, exclude?, fetchImpl? })`
- `ConsoleLogger` / `createLogger({ level?, prefix?, sink? })` / `createScopedLogger(logger, scope)` / `noopLogger`
