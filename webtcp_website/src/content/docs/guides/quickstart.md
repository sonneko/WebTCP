---
title: クイックスタート
description: WebTCP のインストール、2 タブデモの起動、最小のサーバー・クライアント実装手順。
---

## インストール

> `@sonneko/webtcp-tunneler` はまだ npm に公開されていません。現時点ではリポジトリからビルドして利用してください。公開後に `npm install @sonneko/webtcp-tunneler` を使えるようにします。

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
4. 「名前を解決」「URL で接続」で `demo-service` / `demo-alias` の名前解決と `webtcp://` 接続を確認

1 タブで即座に実 WebRTC 検証したい場合は `http://localhost:8787/examples/demo/?selftest=1` を開いてください。
デモは既定で **Ed25519 署名（プロトコル v2）** を使います。署名なし（v1）で比較したい場合は `?insecure=1` を付けます。

## サーバー側（待ち受ける）

```ts
import {
  BrowserKeyManager,
  SignalingAdapterHub,
  createBrowserNetwork,
  createLogger,
} from '@sonneko/webtcp-tunneler';

const logger = createLogger({ level: 'info' });

// Ed25519 識別子（IndexedDB に非抽出 CryptoKey として保存。NodeId は公開鍵の指紋）
const keys = await BrowserKeyManager.open({ logger });

const signaling = new SignalingAdapterHub({
  url: 'https://your-signaling-hub.example.com',
  nodeId: keys.nodeId,
  logger,
});

const network = createBrowserNetwork({
  signaling,
  keyManager: keys,  // ← プロトコル v2・署名必須
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
  BrowserKeyManager,
  EntranceSearcherAdapterHub,
  SignalingAdapterHub,
  createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const hubUrl = 'https://your-signaling-hub.example.com';
const keys = await BrowserKeyManager.open();
const signaling = new SignalingAdapterHub({ url: hubUrl, nodeId: keys.nodeId });
const network = createBrowserNetwork({ signaling, keyManager: keys });
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


## 名前解決と `webtcp://` URL（M4 / #25）

サービス側で `NameServer` に名前を登録して待ち受けます。

```ts
import { NameServer } from '@sonneko/webtcp-tunneler';

const ns = new NameServer(network);
ns.registerA('my-service', network.localNodeId);
ns.registerCNAME('alias', 'my-service');
ns.listen(); // 既定の仮想ポート 5300
```

クライアント側は、隣接または経路表で既知のノードへ問い合わせって名前を解決し、URL で接続します。

```ts
import { parseWebTCPUrl } from '@sonneko/webtcp-tunneler';

const url = 'webtcp://alias:8080/path?x=1#frag';
const parsed = parseWebTCPUrl(url); // path / query / fragment はアプリケーション用
const stream = await network.connectURL(url, { nameServer: ns });
await stream.send('hello');
```

- 解決順序はローカル登録 → TTL キャッシュ → 既知ノード（明示 `resolvers` / 隣接 / 経路表）への反復問い合わせ。
- `webtcp://` のポートは必須（1–65535）。NodeId リテラル（32 文字 hex）なら NameServer なしで接続できます。
- ゾーン外の名前解決はグローバルな所有権証明ではありません（応答ノードの自己申告）。`.domain.global` に限って、次節の所有権レコード検証が効きます。
- 詳しくは [名前解決ガイド](/guides/name-resolution/) を参照してください。

## `domain.global` の所有権を検証する（M5 / #25）

ゾーン名 `*.domain.global` は、所有者の Ed25519 署名付きレコード（と台帳の Merkle アンカー）を通じて検証可能な名前に変わります。

```ts
import {
    NameServer,
    createDomainAuthority,
    createDomainOwnershipRecord,
    createHttpDomainRegistryClient,
} from '@sonneko/webtcp-tunneler';

const registry = createHttpDomainRegistryClient({ baseUrl: 'https://registry.example.com' });
const record = await createDomainOwnershipRecord({
    domain: 'shop.domain.global',
    keyManager: keys,   // NodeId は公開鍵の指紋
    serial: 1,
    port: 8080,
});
const { anchor } = await registry.submit(record);           // 台帳の包含証明（任意だが推奨）

const authority = createDomainAuthority({
    sources: [registry],
    verifierOptions: { requireAnchor: true, logKeys: { [logId]: logPublicKey } },
});
const ns = new NameServer(network, { domains: authority });
await ns.registerDomain({ ...record, anchor });             // 検証に失敗したレコードは登録されない

const resolved = await ns.resolve('shop.domain.global');   // source: 'domain' / proof.anchorVerified: true
await network.connectURL('webtcp://shop.domain.global:8080/', { nameServer: ns });
```

- **信頼の根拠はピン留めしたログ鍵**です。`logKeys` に無い台帳のアンカーは `anchor-untrusted-log` で棄却されます（fail-closed）。
- `logKeys` を設定せず `requireAnchor: false`（既定）なら、所有者署名・有効期間・serial までを検証して受理します。
- 実ブロックチェーンへの裏付けは #42、レジストリ運用ガバナンスは #43 として切り出しています。詳細は [domain.global と所有権証明](/guides/domain-ownership/) を参照してください。
