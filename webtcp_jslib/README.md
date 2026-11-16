# @sonneko/webtcp-tunneler

WebRTC データチャネル上にバイトストリーム指向の仮想 TCP/HTTP トンネルを構築する実験的ライブラリです。M4 で `NameServer`（A/CNAME 名前解決）と `webtcp://` URL、永続 NodeId に、M5 で `domain.global` の所有権レコード検証（Ed25519 署名 + 追記専用 Merkle 台帳）に対応しました。

- リポジトリ全体の説明・デモ: [github.com/sonneko/WebTCP](https://github.com/sonneko/WebTCP)
- プロトコル仕様: [specification.md](https://github.com/sonneko/WebTCP/blob/main/specification.md)（0.5.0）
- 設計: [design.md](https://github.com/sonneko/WebTCP/blob/main/design.md)

> このパッケージはまだ npm に公開されていません。利用するにはリポジトリをビルドするか、公開後に `npm install @sonneko/webtcp-tunneler` を実行してください。

## 使い方（ブラウザ）

```ts
import {
    BrowserKeyManager,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
    NameServer,
} from '@sonneko/webtcp-tunneler';

const hubUrl = 'https://your-hub.example.com';

// Ed25519 識別子。秘密鍵は IndexedDB に非抽出 CryptoKey として保存され、
// NodeId は公開鍵の指紋（SHA-256 の先頭 16 バイト）になる。
const keys = await BrowserKeyManager.open();

const signaling = new SignalingAdapterHub({ url: hubUrl, nodeId: keys.nodeId });
const network = createBrowserNetwork({
    signaling,
    keyManager: keys,   // プロトコル v2（すべてのパケットに Ed25519 署名）
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    logLevel: 'warn',   // 既定は warn 以上
});
await network.start();

// サーバー側
network.listen(8080, (stream) => {
    stream.on('data', (data) => {
        void stream.send(data);
    });
    stream.on('end', () => stream.end());
});

// NameServer（M4）: 名前を登録して待ち受ける
const ns = new NameServer(network);
ns.registerA('my-service', network.localNodeId);
ns.listen();

// クライアント側（エントランス探索からの自動リンク確立 + 仮想 TCP 接続）
const searcher = new EntranceSearcherAdapterHub({ url: hubUrl, exclude: network.localNodeId });
const { connected } = await network.bootstrap(searcher);
if (connected.length > 0) {
    const stream = await network.connectURL('webtcp://my-service:8080/', { nameServer: ns });
    await stream.send('hello');
    stream.end();
}
```

## 使い方（Node.js / Ed25519 署名）

```ts
import {
    NodeKeyManager,
    WebTCPNetwork,
    createEd25519Verifier,
} from '@sonneko/webtcp-tunneler';

// node:crypto で Ed25519 鍵を生成・永続化（既存 keyFile は再利用）
const keys = await NodeKeyManager.open({ keyFile: './webtcp-identity.pem' });
const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });

const network = new WebTCPNetwork({
    channel: myChannel,   // NodeWebRTCChannel など IChannel 実装
    keyManager: keys,     // NodeId = keys.nodeId（公開鍵の指紋）、署名必須
    keyDirectory,         // ピア公開鍵を RT_UPDATE から自動学習
    verifier,
});
await network.start();
```

公開鍵は DataChannel 開設時の `public-key` メッセージと `RT_UPDATE` の `publicKey` / `entries[].publicKey` フィールドで配布され、
受信側は `KeyDirectory` に登録する前に必ず指紋一致を検証します（`specification.md` §10）。これにより事前鍵共有なしのマルチホップ署名検証が可能です。

## 名前解決と `webtcp://` URL（M4 / #25）

```ts
import { NameServer, parseWebTCPUrl } from '@sonneko/webtcp-tunneler';

const ns = new NameServer(network, { port: 5300 });
ns.registerA('my-service', network.localNodeId);
ns.registerCNAME('alias', 'my-service');
ns.listen();

const resolved = await ns.resolve('alias'); // { nodeId, ttlMs, source, chain }
const parsed = parseWebTCPUrl('webtcp://alias:8080/path?x=1#frag');
const stream = await network.connectURL('webtcp://alias:8080/path', { nameServer: ns });
```

- 解決順序: ローカル登録 → TTL キャッシュ → 既知ノード（`resolvers` / 隣接 / 経路表）への反復問い合わせ。
- `webtcp://` はポート必須（1–65535）。NodeId リテラルなら NameServer なしで接続できます。
- `path` / `query` / `fragment` はアプリケーション用で、接続自体には送信しません。
- ゾーン外の名前は上記のとおり自己申告です。`.domain.global` に限って、次節の所有権レコード検証が効きます。

> `keyManager` を渡さない場合、後方互換のためプロトコル v1（署名なし・`NullPacketVerifier`）で動作します。

## `domain.global` の所有権（M5 / #25）

```ts
import {
    NameServer,
    createDomainAuthority,
    createDomainOwnershipRecord,
    createHttpDomainRegistryClient,
} from '@sonneko/webtcp-tunneler';

// 所有者: canonical バイト列への Ed25519 署名でレコードを発行する
const record = await createDomainOwnershipRecord({
    domain: 'shop.domain.global',
    keyManager: keys,
    serial: 1,
    port: 8080,
});

// 台帳（任意・推奨）: 受理されると Merkle 包含証明 `anchor` が付く
const registry = createHttpDomainRegistryClient({ baseUrl: 'https://registry.example.com' });
const { anchor } = await registry.submit(record);

// 検証にはピン留めしたログ鍵が必須（未知の台帳は anchor-untrusted-log で棄却）
const authority = createDomainAuthority({
    sources: [registry],
    verifierOptions: { requireAnchor: true, logKeys: { [logId]: logPublicKey } },
});

const ns = new NameServer(network, { domains: authority });
await ns.registerDomain({ ...record, anchor }); // 検証に失敗したレコードは登録されない
const resolved = await ns.resolve('shop.domain.global'); // source: 'domain' / proof.anchorVerified: true
```

- レコード形式・検証順序・HTTP 契約は [specification.md](https://github.com/sonneko/WebTCP/blob/main/specification.md) §13 に規範的に定義しています。
- 実ブロックチェーンへの裏付け（#42）とレジストリ運用ガバナンス（#43）は未実装です。ブラウザにチェーンクライアントは組み込みません。

## セキュリティ（M3 / #28）

| 項目 | 内容 |
| :--- | :--- |
| NodeId | Ed25519 公開鍵の指紋 `hex(SHA-256(rawPub)[0..16])`（32 文字） |
| 署名 | Ed25519 64 B、プロトコル v2。署名対象は署名フィールドを除くシリアライズ済みパケット（TTL は 0 に正規化） |
| ブラウザ鍵管理 | `BrowserKeyManager` — Web Crypto + IndexedDB（**非抽出 CryptoKey**） |
| Node.js 鍵管理 | `NodeKeyManager` — `node:crypto`（PKCS#8 PEM / シード hex で入出力、`open({ keyFile })` で 0600 永続化） |
| 衝突検出 | `NodeIdCollisionError` — 同一 NodeId に異なる鍵/身元が対応する場合に送出 |
| 公開鍵配布 | シグナリング `public-key` 交換 + `RT_UPDATE.publicKey` / `entries[].publicKey`（どちらも指紋照合必須） |
| 必要環境 | Chrome 137+ / Firefox 129+ / Safari 17+ / Node.js 22+（Ed25519 非対応時は v1 へフォールバック） |
| ドメイン所有権（M5） | 所有者 Ed25519 署名 + SHA-256 commitment + 台帳の Merkle アンカー。信頼根拠はピン留めしたログ鍵で、未 PIN は fail-closed（`specification.md` §13） |

## ビルド・テスト・デモ

```bash
npm ci
npm run build
npm test
npm run demo    # ../examples/server.mjs を起動
```
