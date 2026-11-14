# WebTCP の将来構想（レイヤーと名前解決）

> **注意**: この文書は構想メモです。ここに書かれた API の多くは**まだ実装されていません**。
> 現在の実装仕様は [specification.md](../specification.md)、設計は [design.md](../design.md)、
> マイルストーンは [plan.md](../plan.md) を参照してください。
>
> M1–M2 で実装済み: `WebTCPNetwork`（`bootstrap` 含む） / `VirtualStream`（バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close） / `BrowserWebRTCChannel`（ICE 再起動・`iceServersProvider`） / `SignalingAdapterHub` / `EntranceSearcherAdapterHub` / `Logger`
>
> 未実装（M3–M5）: Ed25519 署名と鍵指紋化（#28）、`webtcp://` URL、`generateIp`、`NameServer`、`HTTP2WebTCPAdapter`、`domain.global`、ブロックチェーン連携（#25）

## 目標とするレイヤーモデル

```
アプリケーション (HTTP 風 API)
        ↓
WebTCPNetwork / VirtualStream
        ↓
ルーティング (NodeId -> NodeId)
        ↓
名前解決 (webtcp://name -> NodeId:port)
        ↓
リンク (WebRTC DataChannel)
```

## 名前解決とドメインの構想

WebTCP では、ノードを `NodeId` で直接指定するだけでなく、ドメイン名でサービスを発見できる世界を目指しています。

### 想定 API（現状と将来構想の対比）

```ts
// 現状の API（M2）
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const signaling = new SignalingAdapterHub({ url: location.origin });
const network = createBrowserNetwork({ signaling });
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

- `NodeId` は現在ランダムな hex であり、公開鍵と結びついていない。名前解決の前提となる「ノードの真正性」が未解決（M3 / #28）。
- ドメインの所有権を誰が保証するか（ブロックチェーンか、信頼できるレジストリか）が未決定（M5 / #25）。
- バイトストリーム化（M2）は完了したため、M3 のセキュリティ導入後に M4–M5 で `webtcp://` と `NameServer` へ進む。

これらは [plan.md](../plan.md) の §4.3 に将来課題として整理しています。
