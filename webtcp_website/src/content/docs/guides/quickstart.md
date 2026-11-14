---
title: クイックスタート
description: WebTCP のインストール、2 タブデモの起動、最小のサーバー・クライアント実装手順。
---

## インストール

```bash
npm install @sonneko/webtcp-tunneler
```

リポジトリから直接ビルドして試す場合:

```bash
git clone https://github.com/sonneko/WebTCP.git
cd WebTCP/webtcp_jslib
npm ci
npm run build
npm test
```

## 2 つのブラウザタブで動かす

依存パッケージなしのデモサーバー（静的配信 + シグナリングハブ + エントランス探索）を同梱しています。

```bash
# リポジトリのルートから
node examples/server.mjs
```

`http://localhost:8787/examples/demo/` を **2 つのブラウザタブ** で開きます。

1. タブ A で「ポート 8080 で待ち受ける」をクリック
2. タブ B で「接続先を探す」→ 相手を選択 →「接続」（または「自動接続 (`bootstrap`)」）
3. テキスト送信や「80 KiB 分割送信テスト」で往復通信を確認

1 タブで即座に実 WebRTC 検証したい場合は `http://localhost:8787/examples/demo/?selftest=1` を開いてください。

## サーバー側（待ち受ける）

```ts
import {
  SignalingAdapterHub,
  createBrowserNetwork,
  createLogger,
} from '@sonneko/webtcp-tunneler';

const logger = createLogger({ level: 'info' });
const signaling = new SignalingAdapterHub({
  url: 'https://your-signaling-hub.example.com',
  logger,
});

const network = createBrowserNetwork({
  signaling,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  logger,
});
await network.start();

network.listen(8080, (stream) => {
  // ハンドラ呼び出し時点で stream.state === 'ESTABLISHED'
  stream.on('data', (chunk) => {
    const text = new TextDecoder().decode(chunk);
    void stream.send(`echo:${text}`);
  });

  // Half-Close: 相手の送信終了 (FIN) を受けたら必要に応じて応答を返してから閉じる
  stream.on('end', () => {
    stream.end();
  });
});
```

## クライアント側（エントランス探索 + 自動接続）

```ts
import {
  EntranceSearcherAdapterHub,
  SignalingAdapterHub,
  createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const hubUrl = 'https://your-signaling-hub.example.com';
const signaling = new SignalingAdapterHub({ url: hubUrl });
const network = createBrowserNetwork({ signaling });
await network.start();

// 自身を除外して接続候補を探索し、指数バックオフ付きで自動リンク確立
const searcher = new EntranceSearcherAdapterHub({
  url: hubUrl,
  exclude: network.localNodeId,
});
const { connected } = await network.bootstrap(searcher, {
  targetConnections: 1,
  maxRetries: 3,
  initialBackoffMs: 500,
});

if (connected.length > 0) {
  const stream = await network.connect(connected[0], 8080);

  // 60 KiB を超えるデータも自動分割・再結合される
  await stream.send('hello WebTCP');

  // プルモードでの部分読み取り（`on('data')` と併用しない場合）
  const reply = await stream.readExact('echo:hello WebTCP'.length);
  console.log(new TextDecoder().decode(reply));

  // 片方向クローズ（Half-Close）
  stream.end();
}
```
