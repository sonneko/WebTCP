---
title: HTTP トンネル（M6）
description: ブラウザ上のサービスを HTTP/1.1 のまま公開し、webtcp:// URL で fetch 風に呼び出す方法。
---

WebTCP の HTTP トンネル（M6 / [#50](https://github.com/sonneko/WebTCP/issues/50)）は、
`VirtualStream`（仮想 TCP）の上で **HTTP/1.1 のサブセット**を運びます。
ワイヤー（パケット）形式は変わらないため、L4 までの実装・プロトコル v2 の署名検証・
`NameServer` / `domain.global` とは独立に使えます。

> 仕様は [specification.md §16](https://github.com/sonneko/WebTCP/blob/main/specification.md)、
> 設計判断は [design.md §3.24–3.27](https://github.com/sonneko/WebTCP/blob/main/design.md) を参照してください。

## サーバー側: `serveHTTP()`

```ts
import { HTTPRouter, NameServer } from '@sonneko/webtcp-tunneler';

const router = new HTTPRouter();

router.get('/api/hello', async (request, response) => {
    // request.method / path / query / headers / body（AsyncIterable<Uint8Array>）
    // request.remoteNodeId は接続元の NodeId（署名で検証済み）
    response.setHeader('content-type', 'application/json; charset=utf-8');
    await response.end(JSON.stringify({ hello: request.query, from: request.remoteNodeId }));
});

router.post('/api/items', async (request, response) => {
    const item = await request.body.json();   // text / json / arrayBuffer / for await
    response.statusCode = 201;
    await response.end(JSON.stringify({ created: item }));
});

// 仮想ポート 8080 で HTTP を待ち受ける（戻り値は HTTPServer）
const server = network.serveHTTP(8080, router.handle, {
    maxConnections: 64,        // 同時接続の上限（超過は 503）
    idleTimeoutMs: 30_000,     // keep-alive のアイドル
    maxRequestBodyBytes: 0,    // 0 = 無制限（ストリーミング）
});

// 後始末: 待ち受けを解除し、全接続を閉じる
server.close();
```

`serveHTTP()` は `network.listen()` の薄いラッパーです。同じポートに HTTP と生 TCP を混在させることはできません（1 ポート 1 ハンドラ）。

## クライアント側: `fetchURL()` / `HTTPClient`

```ts
// 1 リクエストだけ送る（接続は本文の読み終わりで閉じる）
const response = await network.fetchURL('webtcp://my-service:8080/api/hello?name=web', {
    nameServer: ns,            // 名前を使う場合は必須。NodeId リテラルなら不要
    timeoutMs: 5_000,
    signal: controller.signal,
});

response.status;                       // 200
response.headers.get('content-type');  // 'application/json; charset=utf-8'
await response.json();                 // text / json / arrayBuffer（1 度だけ）

// keep-alive を維持して複数リクエストを再利用する
const client = new HTTPClient(network, { nameServer: ns });
try {
    const a = await client.fetch('webtcp://my-service:8080/api/hello');
    const b = await client.fetch('webtcp://my-service:8080/api/hello?page=2');
    for await (const chunk of b.body) {
        // ストリーミングで読む（maxResponseBytes の制限を受けない）
    }
} finally {
    client.close();
}
```

- `webtcp://` URL の `path` と `query` は**リクエストターゲット**として転送されます。`fragment` は送りません。
- `HTTPClient` は `(NodeId, 仮想ポート)` 単位で 1 本の接続をプールし、`keep-alive` で逐次再利用します（パイプラインはしません）。
- `maxResponseBytes`（既定 8 MiB）は `text()` / `json()` / `arrayBuffer()` にだけ効きます。大きな応答は `for await` で読んでください。
- 生の TCP API（`listen()` / `connect()` / `connectURL()`）は**バイトストリームのまま**です。`connectURL()` は今も `path` / `query` を送らないので、HTTP は `serveHTTP()` / `fetchURL()` / `HTTPClient` を使ってください。

## 何を実装していて、何を実装していないか

| 実装済み | 未実装 |
| :--- | :--- |
| リクエストライン / ステータスライン / ヘッダ（大文字小文字を区別しない、重複保持） | HTTP/2・HTTP/3 |
| 本文: `Content-Length` / `chunked` / 本文なし | `Upgrade` / WebSocket ハンドシェイク |
| `keep-alive`（逐次・非パイプライン）、アイドルタイムアウト | `CONNECT`（メソッドとしては 405） |
| `HEAD`（本文抑止）、`Expect: 100-continue`（既定は無効、`send100Continue` で有効化） | パイプライン |
| エラー応答: `400` / `404` / `413` / `414` / `417` / `431` / `500` / `501` / `503` / `505` | 圧縮（`gzip` 等）、Cookie ジャー、認証、リダイレクト追従 |
| CRLF 厳格・行長 / ヘッダ数 / ヘッダ合計の上限（§16.2.1） | TLS 終端（`webtcp://` の外側で行う） |
| ヘッダ**インジェクション拒否**（値の CR/LF/NUL、名前の token 検証）とスマグリング拒否（`Content-Length` と `Transfer-Encoding` の併用） | 受信ウィンドウ（フロー制御、[#55](https://github.com/sonneko/WebTCP/issues/55)） |
| `HTTPRouter`（`/users/:id` 記法） | 接続プールの上限 / LRU（[#57](https://github.com/sonneko/WebTCP/issues/57)） |

## セキュリティ境界

- HTTP 層に**認証・認可はありません**。守りは `VirtualStream` の外側（Ed25519 署名・RPF・NodeId）だけです。`request.remoteNodeId` を使った許可リストはアプリケーションの責務です。
- `request.remoteNodeId` は**転送ノードではなく接続元**です。マルチホップでは、最後の 1 ホップのノードが「誰から受け取ったか」を示します。エンドツーエンドのアプリケーション認証には使えません。
- ヘッダ書き込みは名前（`token`）と値（CR/LF/NUL 不在）を検証します。ユーザー入力をそのままヘッダへ入れても、スマグリングは成立しません。

## デモでの確認

`examples/demo/?selftest=1` の自己チェックに **1e. HTTP トンネル**のステップがあります。
サーバー側タブが `serveHTTP(8081)` で JSON を返し、クライアント側が
`fetchURL('webtcp://demo-service:8081/api/echo?x=1#ignored')` で呼び出して、
`path` / `query` の往復と `remoteNodeId` を検証します。
`examples/verify-browser.mjs` もこのステップの成否を確認します。

## 既知の制約

- タブが非可視になると凍結され、その間は待ち受けに応答しません。リロード後は `restoreState()` で待ち受けポート・名前・所有権レコードを回復できますが、HTTP ハンドラは付け直す必要があります（[#51](https://github.com/sonneko/WebTCP/issues/51)、仕様 §9）。
- 既存の TCP/HTTP クライアント（curl 等）をトンネルへ入れるブリッジはありません（[#52](https://github.com/sonneko/WebTCP/issues/52)）。HTTP を話せても、入り口は `HTTPClient` を呼べる相手だけです。
- パケット形式に受信ウィンドウが無いため、巨大な応答は受信側メモリに依存します（[#55](https://github.com/sonneko/WebTCP/issues/55)）。
