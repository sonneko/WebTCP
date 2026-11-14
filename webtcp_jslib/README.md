# @sonneko/webtcp-tunneler

WebRTC データチャネル上に仮想 TCP/HTTP トンネルを構築する実験的ライブラリです。

- リポジトリ全体の説明・デモ: [github.com/sonneko/WebTCP](https://github.com/sonneko/WebTCP)
- プロトコル仕様: [specification.md](https://github.com/sonneko/WebTCP/blob/main/specification.md)
- 設計: [design.md](https://github.com/sonneko/WebTCP/blob/main/design.md)

## 使い方（ブラウザ）

```ts
import { SignalingAdapterHub, createBrowserNetwork } from '@sonneko/webtcp-tunneler';

const signaling = new SignalingAdapterHub({ url: 'https://your-hub.example.com' });
const network = createBrowserNetwork({ signaling });
await network.start();

network.listen(8080, (stream) => {
    stream.on('data', (data) => {
        void stream.send(new TextDecoder().decode(data));
    });
});
```

クライアント側は `network.connect(nodeId, 8080)` で `VirtualStream` を取得します。

## ビルドとテスト

```bash
npm install
npm run build
npm test
```
