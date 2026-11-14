# WebTCP の将来構想（レイヤーと名前解決）

> **注意**: この文書は構想メモです。ここに書かれた API の多くは**まだ実装されていません**。
> 現在の実装仕様は [specification.md](../specification.md)、設計は [design.md](../design.md)、
> マイルストーンは [plan.md](../plan.md) を参照してください。
>
> M1–M3 で実装済み: `WebTCPNetwork`（`bootstrap` 含む） / `VirtualStream`（バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close） / `BrowserWebRTCChannel`（ICE 再起動・`iceServersProvider`） / `SignalingAdapterHub` / `EntranceSearcherAdapterHub` / `Logger` / **Ed25519 署名・NodeId の鍵指紋化・`BrowserKeyManager` / `NodeKeyManager` / `KeyDirectory`（#28）**
>
> 未実装（M4–M5）: `webtcp://` URL、`generateIp`、`NameServer`、`HTTP2WebTCPAdapter`、`domain.global`、ブロックチェーン連携（#25）

## 目標とするレイヤーモデル

```
アプリケーション (HTTP 風 API)
        ↓
WebTCPNetwork / VirtualStream
        ↓
ルーティング (NodeId -> NodeId)          ← Ed25519 署名の検証 / 公開鍵ディレクトリ（実装済み）
        ↓
名前解決 (webtcp://name -> NodeId:port)  ← 未実装（M4–M5）
        ↓
リンク (WebRTC DataChannel)
```

**M3 で解決した前提**: `NodeId` は Ed25519 公開鍵の指紋（`SHA-256` の先頭 16 バイト）となり、
名前解決の前提だった「ノードの真正性」は担保されるようになりました。名前で引いた NodeId が
本当にそのノードのものであるかは、パケット署名の検証で確認できます。

## 名前解決とドメインの構想

WebTCP では、ノードを `NodeId` で直接指定するだけでなく、ドメイン名でサービスを発見できる世界を目指しています。

### 想定 API（現状と将来構想の対比）

```ts
// 現状の API（M3）
import {
    BrowserKeyManager,
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const keys = await BrowserKeyManager.open();  // Ed25519 識別子（IndexedDB に非抽出 CryptoKey）
const signaling = new SignalingAdapterHub({ url: location.origin, nodeId: keys.nodeId });
const network = createBrowserNetwork({ signaling, keyManager: keys });  // プロトコル v2・署名必須
await network.start();

network.listen(8080, (stream) => {
    stream.on('data', (data) => {
        console.log(new TextDecoder().decode(data));
        void stream.send('<h1>Hello World</h1>');
    });
    stream.on('end', () => stream.end());
});

// クライアントはエントランス探索 + NodeId で接続する
const searcher = new EntranceSearcherAdapterHub({
    url: location.origin,
    exclude: network.localNodeId,
});
const { connected } = await network.bootstrap(searcher);
const stream = await network.connect(connected[0], 8080);
await stream.send(JSON.stringify({ message: 'Hello World', status: 'ok' }));
```

```ts
// 将来構想（未実装: M4–M5 / #25）
import { WebTCPNetwork, generateIp } from '@sonneko/webtcp';
import { BrowserWebRTCChannel } from '@sonneko/webtcp/channel';
import { HTTP2WebTCPAdapter } from '@sonneko/webtcp/adapter';
import { NameServer } from '@sonneko/webtcp/nameserver';

const network = new WebTCPNetwork(
    new BrowserWebRTCChannel(),      // WebRTC チャネル
    new HTTP2WebTCPAdapter(),        // シグナリングを含む HTTP -> WebTCP のアップグレード
);

// WebTCP におけるアドレス。ノードごとに生成し、永続化する。
let ip = localStorage.getItem('WEBTCP_ip');
if (!ip) {
    ip = generateIp();
    localStorage.setItem('WEBTCP_ip', ip);
}

try {
    const connection = await network.connect(ip);
} catch (err) {
    // IP の衝突、または WebRTC 接続の失敗
    console.error(err);
}

// domain.global はブロックチェーン上で実行される分散アプリケーション。
// ネームサーバーをこのデバイスの 3000 番で動かすことを登録する。
connection.send('webtcp://domain.global/add/my-domain', {
    payload: `${ip}:3000`,
});

// @ は Apex ドメインを意味する
const ns = new NameServer([
    'CNAME @ -> www.my-domain.com',
    `A www.my-domain.com -> ${ip}:8080`,
]);
connection.on(3000, ns.on);
```

### なぜ未実装なのか

- `NodeId` の公開鍵指紋化と Ed25519 署名は **M3 で完了**した（#28）。名前解決の前提となる「ノードの真正性」は解決済みである。
- 次に必要なのは名前解決そのもの（`webtcp://`、`NameServer`）であり、これは公開鍵の指紋に紐づく **不変の識別子**を前提に設計できる（M4）。
- ドメインの所有権を誰が保証するか（ブロックチェーンか、信頼できるレジストリか）が未決定（M5 / #25）。
- なお永続 NodeId は鍵管理で実現済み（ブラウザは IndexedDB に非抽出 CryptoKey を保存、`generateIp` 相当）。
  マルチデバイス間の鍵同期・バックアップは未対応。

### 分散ストレージに公開鍵を置く場合

M3 では公開鍵を「シグナリング時の交換」と「`RT_UPDATE` への同梱」で配布する（[specification.md](../specification.md) §10.4）。
`IPublicKeyResolver` を実装すれば、IPFS 等の分散ストレージから鍵を引く方式に同じ安全性のまま差し替えられる
（いずれの経路でも、受信側は `NodeId == deriveNodeId(publicKey)` を必ず検証する）。

これらは [plan.md](../plan.md) の §4.3 に将来課題として整理しています。M3 で完了したセキュリティ関連は §3.3（M3 のスコープ）と §4.1 を参照してください。
