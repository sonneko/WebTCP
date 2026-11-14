# @sonneko/webtcp-tunneler

WebRTC データチャネル上にバイトストリーム指向の仮想 TCP/HTTP トンネルを構築する実験的ライブラリです。

- リポジトリ全体の説明・デモ: [github.com/sonneko/WebTCP](https://github.com/sonneko/WebTCP)
- プロトコル仕様: [specification.md](https://github.com/sonneko/WebTCP/blob/main/specification.md)
- 設計: [design.md](https://github.com/sonneko/WebTCP/blob/main/design.md)

## 使い方（ブラウザ）

```ts
import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const hubUrl = 'https://your-hub.example.com';
const signaling = new SignalingAdapterHub({ url: hubUrl });
const network = createBrowserNetwork({
    signaling,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    logLevel: 'warn', // 既定は warn 以上
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

## ビルド・テスト・デモ

```bash
npm ci
npm run build
npm test
npm run demo    # ../examples/server.mjs を起動
```
