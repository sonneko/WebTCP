# @sonneko/webtcp-tunneler

WebRTC データチャネル上にバイトストリーム指向の仮想 TCP/HTTP トンネルを構築する実験的ライブラリです。

- リポジトリ全体の説明・デモ: [github.com/sonneko/WebTCP](https://github.com/sonneko/WebTCP)
- プロトコル仕様: [specification.md](https://github.com/sonneko/WebTCP/blob/main/specification.md)
- 設計: [design.md](https://github.com/sonneko/WebTCP/blob/main/design.md)

## 使い方（ブラウザ）

```ts
import {
    BrowserKeyManager,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
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

// クライアント側（エントランス探索からの自動リンク確立 + 仮想 TCP 接続）
const searcher = new EntranceSearcherAdapterHub({ url: hubUrl, exclude: network.localNodeId });
const { connected } = await network.bootstrap(searcher);
if (connected.length > 0) {
    const stream = await network.connect(connected[0], 8080);
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

// node:crypto で Ed25519 鍵を生成（既存鍵は privateKeyPem / secretKeyHex で復元）
const keys = await NodeKeyManager.create();
const { verifier, keyDirectory } = createEd25519Verifier({ keyManager: keys });

const network = new WebTCPNetwork({
    channel: myChannel,   // NodeWebRTCChannel など IChannel 実装
    keyManager: keys,     // NodeId = keys.nodeId（公開鍵の指紋）、署名必須
    keyDirectory,         // ピア公開鍵を RT_UPDATE から自動学習
    verifier,
});
await network.start();
```

公開鍵は DataChannel 開設時の `public-key` メッセージと `RT_UPDATE` の `publicKey` フィールドで配布され、
受信側は `KeyDirectory` に登録する前に必ず指紋一致を検証します（`specification.md` §10）。

> `keyManager` を渡さない場合、後方互換のためプロトコル v1（署名なし・`NullPacketVerifier`）で動作します。

## セキュリティ（M3 / #28）

| 項目 | 内容 |
| :--- | :--- |
| NodeId | Ed25519 公開鍵の指紋 `hex(SHA-256(rawPub)[0..16])`（32 文字） |
| 署名 | Ed25519 64 B、プロトコル v2。署名対象は署名フィールドを除くシリアライズ済みパケット（TTL は 0 に正規化） |
| ブラウザ鍵管理 | `BrowserKeyManager` — Web Crypto + IndexedDB（**非抽出 CryptoKey**） |
| Node.js 鍵管理 | `NodeKeyManager` — `node:crypto`（PKCS#8 PEM / シード hex で入出力） |
| 公開鍵配布 | シグナリング `public-key` 交換 + `RT_UPDATE.publicKey`（どちらも指紋照合必須） |
| 必要環境 | Chrome 137+ / Firefox 129+ / Safari 17+ / Node.js 22+（Ed25519 非対応時は v1 へフォールバック） |

## ビルド・テスト・デモ

```bash
npm ci
npm run build
npm test
npm run demo    # ../examples/server.mjs を起動
```
