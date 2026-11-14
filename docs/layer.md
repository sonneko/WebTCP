# WebTCP の将来構想（レイヤーと名前解決）

> **注意**: この文書は構想メモです。ここに書かれた API の多くは**まだ実装されていません**。
> 現在の実装仕様は [specification.md](../specification.md)、設計は [design.md](../design.md)、
> マイルストーンは [plan.md](../plan.md) を参照してください。
>
> M1 で実装済み: `WebTCPNetwork` / `VirtualStream` / `BrowserWebRTCChannel` / `SignalingAdapterHub` / `EntranceSearcherAdapterHub`
>
> M1 で未実装: `webtcp://` URL、`generateIp`、`NameServer`、`HTTP2WebTCPAdapter`、`domain.global`、ブロックチェーン連携

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

### 想定 API（未実装）

```ts
// 現状のAPI（M1）
import { createBrowserNetwork, SignalingAdapterHub } from '@sonneko/webtcp-tunneler';

const signaling = new SignalingAdapterHub({ url: location.origin });
const network = createBrowserNetwork({ signaling });
await network.start();

network.listen(8080, (stream) => {
    stream.on('data', (data) => {
        console.log(new TextDecoder().decode(data));
        void stream.send('<h1>Hello World</h1>');
    });
});

// クライアントは NodeId を直接指定する
const stream = await network.connect(nodeId, 8080);
await stream.send(JSON.stringify({ message: 'Hello World', status: 'ok' }));
```

```ts
// 将来構想（未実装）
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

- `NodeId` は現在ランダムな hex であり、公開鍵と結びついていない。名前解決の前提となる「ノードの真正性」が未解決（M3）。
- ドメインの所有権を誰が保証するか（ブロックチェーンか、信頼できるレジストリか）が未決定（M5）。
- HTTP 層の API（`HTTPRes` など）はトランスポートのバイトストリーム化（M2）を待つ必要がある。

これらは [plan.md](../plan.md) の §4.4 に将来課題として整理しています。
