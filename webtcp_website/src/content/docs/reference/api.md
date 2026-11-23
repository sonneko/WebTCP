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
- `connect(remoteId: NodeId, remotePort: VirtualPort, localPort?: VirtualPort, options?: { signal?: AbortSignal }): Promise<VirtualStream>` — 必要ならリンク確立を行ったうえで仮想 TCP 接続を確立。`signal` で途中の接続試行を中断できます（中断時は `AbortError` で reject し、途中の資源を解放します。仕様 §8.6、#44）。
- `connectURL(url: string | WebTCPUrl, options?: ConnectURLOptions): Promise<VirtualStream>` — `webtcp://` URL へ接続（M4 / #25）。名前指定には `options.nameServer` が必要。NodeId リテラルなら不要。返るのは**生のバイトストリーム**で、`path` / `query` は送りません。
- `serveHTTP(port: VirtualPort, handler: HTTPHandler, options?: HTTPServerOptions): HTTPServer` — 仮想ポートで HTTP/1.1 を待ち受ける（M6 / #50）。`server.close()` で解除。
- `fetchURL(url: string | WebTCPUrl, options?: FetchURLOptions): Promise<HTTPResponse>` — `webtcp://` URL へ HTTP リクエストを送る（M6 / #50）。`path` / `query` をリクエストターゲットとして転送し、`fragment` は送りません。1 リクエストごとに接続を閉じます。
- `connectToPeer(remoteId: NodeId, options?: { signal?: AbortSignal }): Promise<void>` — リンク層の隣接接続のみを確立。`signal` で中断できます（#44）。
- `bootstrap(searcher: IEntranceSearcher, options?: BootstrapOptions): Promise<BootstrapResult>` — エントランス候補へ順に接続を試行（失敗時は指数バックオフでリトライ）。
- `getNeighbors(): NodeId[]` — 直接接続中の隣接ノード ID 一覧。
- `getRoutingTable(): RoutingTable` — 現在のルーティングテーブル。
- `close(): void` — 全層・全タイマー・全セッションを停止。

### `ConnectURLOptions`

| 項目 | 型 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `nameServer` | `NameServer` | — | 名前指定の解決に使う NameServer |
| `localPort` | `VirtualPort` | 自動割当 | ローカル仮想ポート |
| `signal` | `AbortSignal` | — | 中断用シグナル |

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
- `destroy(): void` — 相手へ `RST` を送って即座に中断（abort）。`FIN` / `TIME_WAIT` は待たない。正常終了は `end()`（#54）。
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

## 名前解決 API（M4 / #25）

### `NameServer`

| API | 説明 |
| :--- | :--- |
| `new NameServer(network, options?)` | アプリケーション層名前解決サービス。既定ポート 5300 |
| `registerA(name, nodeId, ttlMs?)` | A レコード相当（`name -> NodeId`）をローカル登録 |
| `registerCNAME(name, target, ttlMs?)` | CNAME レコード相当（`name -> canonical name`）をローカル登録 |
| `unregister(name)` / `clearCache()` | ローカル登録の削除 / キャッシュ消去 |
| `listen()` / `close()` | 問い合わせ受付の開始 / 停止（ネットワークは閉じない） |
| `resolve(name, { signal?, timeoutMs? })` | ローカル → キャッシュ → 既知ノード問い合わせの順で解決。`NameResolution` を返す |
| `registerDomain(record, { ttlMs? })` | `domain.global` の所有権レコードを登録（**検証に失敗したレコードは登録しない**）。例外ではなく `DomainResolution` を返す（M5 / #25） |
| `unregisterDomain(domain)` | ゾーン内の提供を取り下げる（`boolean`） |
| `servedDomainRecords()` | 提供中の所有権レコード一覧（診断・可視化用） |

`NameServerOptions`: `port`, `defaultTtlMs`（60000）, `queryTimeoutMs`（2000）, `resolveTimeoutMs`（5000）, `maxCnameDepth`（8）, `maxCacheEntries`（1024）, `maxQueriedNodes`（16）, `queryConcurrency`（4）, `resolvers`, `domains`（`DomainAuthority`、M5）, `logger`。

`NameResolution` は `name`, `nodeId`, `ttlMs`, `source`（`local` / `cache` / `remote` / **`domain`**）, `chain`, およびゾーン名解決のとき `record`（検証済みレコード）と `proof`（`code` / `anchorVerified` / `chainVerified`）。

エラー: `NameNotFoundError` / `NameResolutionTimeoutError` / `NameLoopError`。

### `webtcp://` URL

| API | 説明 |
| :--- | :--- |
| `parseWebTCPUrl(input)` | `webtcp://host:port/path?query#fragment` を厳格にパースし `WebTCPUrl` を返す。ポート必須 |
| `formatWebTCPUrl(url)` | `WebTCPUrl` を正規形文字列へ整形 |
| `normalizeWebTCPName(value)` | 名前を小文字化・末尾ドット除去・LDH 検証。NodeId リテラルは予約 |

`WebTCPUrl`: `host`, `nodeId?`, `name?`, `zone?`（`domain.global` のとき設定、M5）, `port`, `path`, `search`, `hash`。

## 所有権ドメイン API（M5 / #25）

`domain.global` の検証器・台帳・権威はすべてルートの `@sonneko/webtcp-tunneler` から export されています。

### レコード

| API | 説明 |
| :--- | :--- |
| `createDomainOwnershipRecord({ domain, keyManager, serial, lifetimeMs?, expiresAt?, revoked?, port?, txt?, anchor?, issuedAt? })` | canonical バイト列へ Ed25519 署名を付与して `DomainOwnershipRecord` を発行（既定寿命 30 日、上限 365 日） |
| `parseDomainOwnershipRecord(value, options?)` | 未知の JSON を検証付きでパース（16 KiB 上限、未知フィールドは拒否） |
| `domainRecordToJSON(record)` / `serializeDomainRecord(record)` | HTTP 転送用の JSON / バイト列へ変換 |
| `canonicalDomainRecordBodyBytes(body)` / `commitDomainRecord(body)` / `domainCommitmentBytes(commitment)` | canonical シリアライズと SHA-256 commitment（64 hex / 32 バイト） |
| `normalizeDomainName(input)` / `isDomainGlobalName(name)` / `domainZone(name)` / `isValidDomainName(name)` / `domainLabels(name)` / `domainNameInZone(name, zone)` | ゾーンと LDH ルールの判定・正規化（`DOMAIN_GLOBAL_ZONE` = `'domain.global'`） |

### 検証と台帳

| API | 説明 |
| :--- | :--- |
| `createDomainOwnershipVerifier(options?)` | `IDomainOwnershipVerifier`。`requireAnchor`（既定 `false`）, `logKeys`（既定なし = fail-closed）, `resolveLogKey`, `checkpointMaxAgeMs`, `maxLifetimeMs`（既定 1 年）, `clockSkewMs`（既定 300000）, `requireChainAnchor`, `chainAnchorVerifier`, `verifySignature`, `hashFn` |
| `IChainAnchorVerifier` | 実ブロックチェーン等への裏付け検証の差し替え点（参照実装は #42） |
| `createDomainLedger({ keyManager, logId?, requireOwnerSignature?, maxEntries?, hashFn?, logger? })` | 追記専用 Merkle 台帳。`append()` / `buildAnchor(leafIndex)` / `checkpoint()` / `checkpointsBetween()` / `lookupByDomain()` / `lookupByNodeId()` / `listCurrent()` / `snapshot()` / `clear()` |
| `verifyDomainRecordSelfSignature(record)` | 所有者自己署名のみの検証（台帳が受理前に使う） |
| `computeDomainMerkleRoot` / `buildDomainMerkleRoot` / `buildDomainMerkleProof` / `verifyDomainMerkleProof` / `bindDomainMerkleRoot` | ルートは `H(0x02 \|\| uint64BE(treeSize) \|\| top)` でツリーサイズに束縛。証明長上限 32 |
| `signDomainCheckpoint` / `verifyDomainCheckpoint` / `verifyDomainCheckpointChain` / `checkpointRollsBack` / `parseDomainCheckpoint` / `parseDomainAnchor` | チェックポイントの署名・検証・後退検出（`GENESIS_PREV_HASH` から繋がる） |

### 権威とレジストリ

| API | 説明 |
| :--- | :--- |
| `createDomainAuthority(options?)` | `DomainAuthority`。`local`, `sources`, `peers`, `verifier` / `verifierOptions`, `checkpointChain`, `cacheTtlMs`（60000）, `negativeTtlMs`（5000）, `resolveTimeoutMs`（5000）, `queryTimeoutMs`（1500）, `maxRecordsPerDomain`（8）, `pinCheckpoints`（`true`）, `logger` |
| `resolve` / `settle` / `settleCandidates` | 完全名（またはゾーン外と判定可能な入力）を解決。`settle` は衝突を 1 件に絞り、`settleCandidates` は候補をそのまま返す |
| `register(record)` / `remember(record)` / `forget(domain)` / `verifyRecord(domain, record)` | 検証付き登録 / 検証のみで缓存 / 削除 / 単一レコードの再検証 |
| `createPublicKeyResolver(inner?)` | 検証済みレコードから `NodeId -> 公開鍵` を返す `IPublicKeyResolver` bridge（§11.4.3） |
| `memoryDomainRecordSource({ records? })` / `chainDomainRecordSources(sources)` | `IDomainRecordSource` の簡易実装（`lookupByDomain` / `lookupByNodeId` / `put` / `remove` / `list`） |
| `createHttpDomainRegistryClient({ baseUrl, fetchImpl?, timeoutMs?, tolerateNotFound?, logger? })` | `examples/domain-registry.mjs` の HTTP 契約（§14.6）に対するクライアント。`lookupByDomain` / `lookupByNodeId` / `submit` / `checkpoint` / `checkpointsBetween` / `logInfo` |

### 型付きエラー

`DomainResolution` の `code`（および `DomainProofCode`）: `ok`, `invalid-record`, `zone-mismatch`, `fingerprint-mismatch`, `bad-signature`, `expired`, `not-yet-valid`, `stale-serial`, `revoked`, `conflict`, `anchor-missing`, `anchor-bad-proof`, `anchor-untrusted-log`, `anchor-bad-checkpoint`, `anchor-rollback`, `chain-unverified`, `resolution-unavailable`。

例外クラス: `DomainRecordError`（解析・形式）, `DomainLedgerAppendError`（台帳が拒否）, `DomainConflictError`（同一シサル内容衝突）, `DomainRegistryError`（HTTP、`status` を保持）, `DomainOwnershipError`（解決時に検証へ失敗）, `DomainResolutionUnavailableError`（収集元が全滅）。

## HTTP トンネル API（M6 / #50）

### `HTTPServer`

| 項目 | 型 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `maxConnections` | `number` | `64` | 同時接続の上限（超過は `503`） |
| `idleTimeoutMs` | `number` | `30000` | `keep-alive` 接続のアイドルタイムアウト |
| `maxRequestBodyBytes` | `number` | `0` | リクエスト本文の上限（`0` は無制限・ストリーミング） |
| `send100Continue` | `boolean` | `false` | `Expect: 100-continue` に自動応答する |
| `serverName` | `string` | `'webtcp'` | `Server` ヘッダ。`''` で付与しない |
| `limits` | `HTTPParserLimits` | 既定 §16.2.1 | 行長・ヘッダ数・ヘッダ合計などの上限 |

`HTTPServer` は `port` / `connectionCount` / `listen()` / `close()` を公開します。

### `HTTPClient`

| 項目 | 型 | 既定値 | 説明 |
| :--- | :--- | :--- | :--- |
| `nameServer` | `NameServer` | — | 名前解決に使う NameServer |
| `timeoutMs` | `number` | `30000` | 応答ヘッダ到着までのタイムアウト |
| `maxResponseBytes` | `number` | `8 * 1024 * 1024` | `text()` / `json()` / `arrayBuffer()` の上限。`0` は無制限 |
| `keepAlive` | `boolean` | `true` | 接続プールを使う |
| `idleTimeoutMs` | `number` | `30000` | プールした接続のアイドル期限 |
| `limits` | `HTTPParserLimits` | 既定 §16.2.1 | パーサの上限 |

- `fetch(url, init)` — `method` / `headers` / `body`（`string` / `Uint8Array` / `AsyncIterable<Uint8Array>`）/ `timeoutMs` / `signal` / `keepAlive`。
- `request({ nodeId, port, path, ... })` — NodeId と仮想ポートを直接指定する。
- `pooledConnectionCount` / `close()`。

### メッセージと型

- `HTTPHeaders` — 大文字小文字を区別しない。`get()` はカンマ連結、`getAll()` は配列、`rawEntries()` は書き出し順。
- `HTTPRequest` — `method` / `target` / `path` / `query` / `headers` / `httpVersion` / `remoteNodeId` / `body`。
- `HTTPResponseWriter` — `statusCode` / `setHeader()` / `appendHeader()` / `write()` / `end()` / `headersSent` / `finished`。
- `HTTPResponse` — `status` / `statusText` / `headers` / `body` / `ok` / `text()` / `json()` / `arrayBuffer()`。
- `HTTPRouter` — `add(method, pattern, handler)` / `get` / `post` / `put` / `delete` / `handle`。`:name` は 1 セグメント、`*` は残りすべて。

### 型付きエラー

`HTTPError`（基底）/ `HTTPParseError`（`status` に 4xx を持つ）/ `HTTPHeaderInjectionError` / `HTTPTimeoutError` / `HTTPResponseTooLargeError` / `HTTPConnectionClosedError` / `HTTPBodyConsumedError` / `HTTPAbortError`（`name === 'AbortError'`）。

## セキュリティ API（M3 / #28・M4 / #36）

### 鍵管理

| API | 説明 |
| :--- | :--- |
| `BrowserKeyManager.open({ databaseName?, expectedNodeId?, regenerate?, keyDirectory?, logger? })` | ブラウザ用。秘密鍵を **IndexedDB に非抽出 CryptoKey** として保存。復元時に指紋と署名チャレンジを検証。`expectedNodeId` 不一致は `NodeIdCollisionError` |
| `BrowserKeyManager.regenerate(options)` | 新しい鍵ペアで IndexedDB を上書き |
| `NodeKeyManager.create({ privateKeyPem?, secretKeyHex?, nodeId?, keyDirectory? })` | Node.js 用（`node:crypto`）。`exportPrivateKeyPem()` / `exportSecretKeyHex()` |
| `NodeKeyManager.open({ keyFile, nodeId?, keyDirectory? })` | PKCS#8 PEM ファイルから復元、無ければ `0600` で原子的に作成（M4 / #36） |
| `NodeIdCollisionError` | 同一 NodeId に異なる鍵/身元が対応する衝突を表す型付きエラー |
| `deriveNodeId(publicKey)` | `hex(SHA-256(公開鍵)[0..16])` を返す（NodeId の鍵指紋化） |
| `nodeIdMatchesPublicKey(nodeId, publicKey)` | 指紋の照合 |
| `isValidNodeId(value)` | `^[0-9a-f]{32}$` の判定 |
| `encodePublicKey(publicKey)` / `decodePublicKey(text)` | Base64url（パディングなし）エンコード |

### 署名・検証・公開鍵ディレクトリ

| API | 説明 |
| :--- | :--- |
| `new Ed25519PacketVerifier({ keyManager, keyDirectory?, serializer?, keyWaitTimeoutMs? })` | `IPacketVerifier` 実装。署名付与と検証 |
| `createEd25519Verifier({ keyManager, keyDirectory?, ... })` | `{ verifier, keyDirectory, publicKey, publicKeyEncoded, nodeId }` を返すヘルパー |
| `new KeyDirectory({ logger? })` | `addPublicKey()`（指紋不一致・既存鍵衝突は `false`）/ `setPublicKey()`（衝突は `NodeIdCollisionError`）/ `getPublicKey()` / `waitForPublicKey()` |
| `NullPacketVerifier` | 署名なしのレガシー検証器（v1 相互運用専用） |
| `isEd25519KeyManager(value)` | 鍵管理の型ガード |

### `WebTCPNetwork` の署名関連プロパティ

- `keyManager: Ed25519KeyManager | null` — 指定した鍵管理
- `keyDirectory: KeyDirectory | null` — 公開鍵ディレクトリ
- `verifier: IPacketVerifier` — 実際に使われている検証器
- オプション `requireSignatures?: boolean` — 既定は鍵管理 / `Ed25519PacketVerifier` 指定時に `true`

## ブリッジ API（M8 / #52）

- `createNodeNetwork({ signaling, keyManager?, peerConnectionOptions?, rtcPackages?, createPeerConnection?, iceServers?, logger?, ... })`: 導入済みの Node.js WebRTC 実装（既定の順は `@roamhq/wrtc` → `node-datachannel`）で `WebTCPNetwork` を作る。`peerConnectionOptions` は RTC 設定へ浅くマージする（例: `{ bindAddress: '127.0.0.1' }`）。
- `resolveNodeRTCProvider({ packages? })`: 実装の名前と `createPeerConnection` を返す。無ければ `WebRTCProviderUnavailableError`（`tried` に試したパッケージ名の一覧）。
- `DEFAULT_NODE_RTC_PACKAGES`: 既定の解決順（`['@roamhq/wrtc', 'node-datachannel']`）。
- `WebTCPNetwork.signaturesRequired`: 署名必須（v2）として動いているかを返す読み取り専用の値。

ブリッジ本体（`TcpBridge`、`BridgeSecurityError`、`isLoopbackHost`、`assertBridgeSecurity`）は Node 専用で、ブラウザ向けの入口からは再エクスポートしていません。`webtcp_jslib/dist/adapters/bridge/TcpBridge.js` から直接読み込みます（公開パッケージの `exports` にはまだ含めていません）。

```ts
// リポジトリ内では webtcp_jslib/dist を指定する（パッケージ公開は #49 の後）
import { TcpBridge } from './webtcp_jslib/dist/adapters/bridge/TcpBridge.js';

const bridge = new TcpBridge({
    network,                           // requireSignatures（v2）のノードのみ
    target: { nodeId, port: 8080 },
    host: '127.0.0.1',                 // 既定。ループバック以外は allowNonLoopbackBind が必要
    port: 18080,
    onAccess: (entry) => console.log(entry), // open / refused / error / close
});
const address = await bridge.start();
```

- `TcpBridgeOptions`: `allowNonLoopbackBind?`、`allowUnsignedPeers?`（既定 false。v1 宛先の転送を許可する）、`keyWaitMs?`（既定 5000）、`connectTimeoutMs?`（既定 10000）、`logger?`、`onAccess?`。
- `BridgeSecurityError`（`code`: `signatures-required` / `non-loopback-bind`）は起動時の安全条件の違反で投げられる。

## アダプタとロガー

- `BrowserWebRTCChannel` / `NodeWebRTCChannel` / `WebRTCChannel.restartIce(peerId)`
- `SignalingAdapterHub({ url, nodeId?, pollIntervalMs?, fetchImpl?, logger?, logLevel? })`
- `EntranceSearcherAdapterHub({ url, path?, exclude?, fetchImpl? })`
- `ConsoleLogger` / `createLogger({ level?, prefix?, sink? })` / `createScopedLogger(logger, scope)` / `noopLogger`
