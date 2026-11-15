---
title: 名前解決と webtcp:// URL
description: M4 の NameServer（A/CNAME・TTL キャッシュ・反復問い合わせ）と webtcp:// URL パース・connectURL() の使い方。
---

M4（#25）では、NodeId を直接指定するだけでなく、名前でサービスを発見して `webtcp://` URL で接続できるようになりました。
ただしこれは**ローカル信頼モデル**です。M5 以降は `.domain.global` ゾーンに限って検証可能な所有権レコードが扱えますが、ゾーン外の名前はいまも「応答ノードがそう登録している」という自己申告にすぎません。所有権証明の詳細は [domain.global と所有権証明](/guides/domain-ownership/) を参照してください。

## NameServer

`NameServer` はアプリケーション層サービスです。新しい L3/L4 フラグは追加せず、既存の署名付き `VirtualStream` 上で JSON の要求/応答を交換します。既定の仮想ポートは **5300** です。

```ts
import { NameServer } from '@sonneko/webtcp-tunneler';

const ns = new NameServer(network, {
  // port: 5300,
  // defaultTtlMs: 60_000,
  // queryTimeoutMs: 2_000,
  // resolveTimeoutMs: 5_000,
  // maxCnameDepth: 8,
  // maxCacheEntries: 1024,
  // maxQueriedNodes: 16,
  // queryConcurrency: 4,
  // resolvers: ['<resolver-node-id>'],
});

ns.registerA('my-service', network.localNodeId);
ns.registerCNAME('alias', 'my-service');
ns.listen();
```

### 解決順序

1. **ローカル登録**: 利用者が設定した権威データ。常に優先します。
2. **TTL キャッシュ**: リモート応答を TTL 経過まで保持します。
3. **既知ノードへの問い合わせ**: 明示 `resolvers` → 直接隣接 → 経路表の宛先。自身は除外し、重複を除いて最大 16 ノードへ最大 4 並列で問い合わせます。

サーバーは自分のローカル登録のみを返します。再帰問い合わせはしません。クライアントが CNAME 連鎖を反復的に辿るため、ノード間の問い合わせループを作らない設計です。

```ts
const result = await ns.resolve('alias', { signal: controller.signal });
// { name: 'alias', nodeId: '…', ttlMs: 60000, source: 'remote', chain: ['alias', 'my-service'] }
```

`source` は `local` / `cache` / `remote` のいずれかです。CNAME ループ・深度超過は `NameLoopError`、不在は `NameNotFoundError`、全体タイムアウトは `NameResolutionTimeoutError` になります。

## `webtcp://` URL

```
webtcp://<host>:<port><path>?<query>#<fragment>
```

- `host` は NodeId（32 文字小文字 hex）または LDH 名（英数字とハイフン、ドット区切り）。
- `port` は**必須**（1–65535）。既定ポートはありません。
- `path` は省略時 `/`。`query` と `fragment` は保持しますが、WebTCP 接続自体には送信しません。HTTP セマンティクスは定義しません。
- userinfo、IPv6、ホスト内のパーセントエンコード、空白・制御文字、バックスラッシュは拒否します。

```ts
import { parseWebTCPUrl, formatWebTCPUrl } from '@sonneko/webtcp-tunneler';

const parsed = parseWebTCPUrl('webtcp://my-service:8080/path?x=1#frag');
// { host: 'my-service', name: 'my-service', port: 8080, path: '/path', search: '?x=1', hash: '#frag' }

const stream = await network.connectURL('webtcp://my-service:8080/path', { nameServer: ns });
// NodeId リテラルなら nameServer は不要
const direct = await network.connectURL(`webtcp://${nodeId}:8080/`);
```

`webtcp://` はブラウザのナビゲーション可能スキームではありません。ライブラリ API としてパース・接続します。

## セキュリティ境界

- 名前問い合わせは下層のプロトコル v2 署名で保護されます。
- しかし NameServer の応答は「応答ノードがその名前をこう登録している」という情報であり、**グローバルな所有権証明ではありません**。
- ローカル登録は利用者設定を信頼します。同一名前に複数の異なる応答がある場合は最初に受理した結果を TTL までキャッシュします。
- `domain.global` への登録と所有権レコードの検証（M5 / #25）は `[NameServer({ domains })](/guides/domain-ownership/)` 経由で有効化できます。ブロックチェーンへの裏付けとグローバルな衝突解決は今後の課題です（#42 / #43）。

## デモでの確認

2 タブデモ（`examples/demo/`）では、サーバータブが待ち受け開始時に `demo-service`（A）と `demo-alias`（CNAME）を登録します。
クライアントタブで「名前を解決」「URL で接続」を押すと、NameServer 経由の解決と `webtcp://` 接続を試せます。
自己チェック（`?selftest=1`）にも名前解決と URL 接続のステップが含まれます。
