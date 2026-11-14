# WebTCP のレイヤーと名前解決

> この文書は [specification.md](../specification.md) 0.4.0 / [design.md](../design.md) 0.4.0 の補助解説です。
> M4 で `NameServer` と `webtcp://` URL は実装済みになりました。`domain.global` とブロックチェーンによる
> ドメイン所有権証明は M5 の将来課題です（#25）。マイルストーンは [plan.md](../plan.md) を参照してください。
>
> M1–M4 で実装済み: `WebTCPNetwork`（`bootstrap` / `connectURL` 含む） / `VirtualStream`（バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close） / `BrowserWebRTCChannel`（ICE 再起動・`iceServersProvider`） / `SignalingAdapterHub` / `EntranceSearcherAdapterHub` / `Logger` / Ed25519 署名・NodeId の鍵指紋化・`BrowserKeyManager` / `NodeKeyManager` / `KeyDirectory` / **`NameServer`・`parseWebTCPUrl`・永続 NodeId と衝突検出**
>
> 未実装（M5 以降）: `HTTP2WebTCPAdapter`、`domain.global`、ブロックチェーン連携、グローバル名前所有権、鍵ローテーション、明示的なリプレイ検知強化

## レイヤーモデル

```
アプリケーション (任意のプロトコル / 将来の HTTP 層)
        ↓
NameServer (webtcp://name -> NodeId)      ← M4 実装済み（L7 アプリケーション層サービス）
        ↓
WebTCPNetwork / VirtualStream           ← connectURL() / listen() / connect()
        ↓
ルーティング (NodeId -> NodeId)          ← Ed25519 署名の検証 / 公開鍵ディレクトリ / TTL / RPF
        ↓
リンク (WebRTC DataChannel)
```

`NameServer` は新しい L3/L4 フラグを追加しません。既存の署名付き `VirtualStream` 上で JSON の要求/応答を運ぶアプリケーション層サービスです。したがって名前問い合わせもプロトコル v2 の署名検証境界の内側に入ります。

## NodeId と永続化

M3 以降、`NodeId` は Ed25519 公開鍵の指紋（`SHA-256` の先頭 16 バイト）です。名前で引いた NodeId が本当にそのノードのものであるかは、パケット署名の検証で確認できます。

M4 では識別子の永続化と衝突検出を追加しました。

- ブラウザ: `BrowserKeyManager.open()` が IndexedDB の非抽出 CryptoKey を復元し、公開鍵指紋だけでなく署名チャレンジで秘密鍵との対応を検証します。`expectedNodeId` を渡すと不一致時に `NodeIdCollisionError` を投げます。
- Node.js: `NodeKeyManager.open({ keyFile })` が PKCS#8 PEM を `0600` で原子的に作成し、既存ファイルがあれば再利用します。
- `KeyDirectory.setPublicKey()` は既存鍵と異なる鍵を拒否し、`NodeIdCollisionError` を投げます。

旧構想にあった `generateIp()` / `localStorage` による IP 風識別子は採用しません。識別子は鍵指紋であり、鍵管理が永続化を担います。

## 名前解決の使い方（M4 実装済み）

```ts
import {
    BrowserKeyManager,
    EntranceSearcherAdapterHub,
    NameServer,
    SignalingAdapterHub,
    createBrowserNetwork,
    parseWebTCPUrl,
} from '@sonneko/webtcp-tunneler';

const keys = await BrowserKeyManager.open();
const signaling = new SignalingAdapterHub({ url: location.origin, nodeId: keys.nodeId });
const network = createBrowserNetwork({ signaling, keyManager: keys });
await network.start();

// サービス側: アプリケーションポートと名前を登録する
network.listen(8080, (stream) => {
    stream.on('data', (data) => void stream.send(data));
    stream.on('end', () => stream.end());
});

const ns = new NameServer(network);
ns.registerA('my-service', network.localNodeId);
ns.registerCNAME('alias', 'my-service');
ns.listen(); // 既定の仮想ポート 5300

// クライアント側: まず何らかの手段で NameServer を持つノードへの経路を作る
const searcher = new EntranceSearcherAdapterHub({ url: location.origin, exclude: network.localNodeId });
await network.bootstrap(searcher);

const url = 'webtcp://alias:8080/path?x=1#frag';
const parsed = parseWebTCPUrl(url);
const stream = await network.connectURL(url, { nameServer: ns });
await stream.send(JSON.stringify({ path: parsed.path, message: 'hello' }));
```

### 解決モデル

1. ローカル登録（利用者が設定した権威データ）
2. TTL キャッシュ
3. 既知ノードへの問い合わせ（明示 `resolvers` → 直接隣接 → 経路表の宛先）

サーバーは自分のローカル登録だけを返します。再帰問い合わせはせず、クライアントが CNAME 連鎖を反復的に辿ります。これによりノード間の問い合わせループと増幅を抑えます。

### `webtcp://` URL

```
webtcp://<host>:<port><path>?<query>#<fragment>
```

- `host` は NodeId（32 文字小文字 hex）または LDH 名。
- `port` は必須（1–65535）。既定ポートはありません。
- `path` 省略時は `/`。`query` / `fragment` は保持しますが、WebTCP 接続自体には送信しません。HTTP セマンティクスは定義しません。
- NodeId リテラルなら `nameServer` なしで `connectURL()` できます。名前なら `nameServer` が必要です。
- `webtcp://` はブラウザのナビゲーション可能スキームではなく、ライブラリ API としてパース・接続します。

## セキュリティ境界と M5 将来構想

NameServer の応答は下層の v2 署名で保護されますが、**名前のグローバルな所有権証明ではありません**。同一名前に複数の異なる応答があり得るため、M4 ではローカル登録を信頼するモデルです。

M5 以降で検討するもの:

- `domain.global` へのドメイン登録とグローバル名前解決
- ブロックチェーン等によるドメイン所有権証明
- 権威サーバー階層 / DNS 相互運用
- `HTTP2WebTCPAdapter` のような HTTP 風アプリケーション層

これらは [plan.md](../plan.md) §4.3 に将来課題として整理しています。
