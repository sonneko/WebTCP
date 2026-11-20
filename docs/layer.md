# WebTCP のレイヤーと名前解決

> この文書は [specification.md](../specification.md) 0.8.1 / [design.md](../design.md) 0.8.1 の補助解説です。
> M4 で `NameServer` と `webtcp://` URL が、M5 で `domain.global` の**所有権レコード検証**（#25）が、M6 で **HTTP トンネル**（#50）が実装済みです。
> 実ブロックチェーンへの裏付け（#42）とレジストリの運用ガバナンス（#43）は将来課題として切り出しています。
> マイルストーンは [plan.md](../plan.md) を参照してください。
>
> M1–M7 で実装済み（M7 で `persistState` / `restoreState`・`startBrowserKeepAlive` を追加）: `WebTCPNetwork`（`bootstrap` / `connectURL` / `serveHTTP` / `fetchURL` 含む） / `VirtualStream`（バイトストリーム・自動分割・動的 RTO・輻輳制御・SACK・Half-Close） / `BrowserWebRTCChannel`（ICE 再起動・`iceServersProvider`） / `SignalingAdapterHub` / `EntranceSearcherAdapterHub` / `Logger` / Ed25519 署名・NodeId の鍵指紋化・`BrowserKeyManager` / `NodeKeyManager` / `KeyDirectory` / `NameServer`・`parseWebTCPUrl`・永続 NodeId と衝突検出 / `core/domain`（所有権レコード・Merkle 台帳・チェックポイント・`DomainAuthority`・HTTP レジストリクライアント） / **`core/http`（`HTTPServer` / `HTTPClient` / `HTTPRouter` / HTTP/1.1 サブセット）**
>
> 未実装: 実ブロックチェーンへのアンカー検証（#42）、レジストリ運用ガバナンス（#43）、HTTP/2・WebSocket・`CONNECT` などのフル実装（#57）、受信フロー制御（#56）、接続プールの上限（#58）、鍵ローテーション（#47）、明示的なリプレイ検知強化（#48）

## レイヤーモデル

```
HTTP トンネル (HTTPServer / HTTPClient / HTTPRouter)   ← M6 実装済み（HTTP/1.1 サブセット）
        ↓
アプリケーション (任意のプロトコル)
        ↓
DomainAuthority (domain.global -> 検証済み NodeId)   ← M5 実装済み（所有権レコード + 台帳アンカー）
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

## 所有権ドメイン（M5 実装済み）

ゾーン外の名前について NameServer の応答は「応答ノードがそう登録している」という自己申告のままです（下層の v2 署名で改ざんは検知できますが、名前そのものの所有権は示せません）。M5 はこの穴を `.domain.global` に限って塞ぎます。

```ts
import { createDomainAuthority, NameServer } from '@sonneko/webtcp-tunneler';

const authority = createDomainAuthority({
    sources: [registry],                              // HTTP レジストリ等（無くてもよい）
    verifierOptions: { requireAnchor: true, logKeys: { [logId]: logPublicKey } },
});
const ns = new NameServer(network, { domains: authority });
await ns.registerDomain(record);                      // 検証に失敗したレコードは登録しない
await ns.resolve('shop.domain.global');               // source: 'domain'
```

設計の要点（詳細は specification.md §14 / design.md §3.21–§3.23）:

- **レコードは carrier、commitment が真実**: 台帳に載るのは SHA-256 commitment（32 バイト）だけで、レコード本体は carrier として運ばれます。よって台帳は名前空間を保持しません。
- **ルートはツリーサイズに束縛**: `H(0x02 || uint64BE(treeSize) || top)`。別のサイズの包含証明を通せません。チェックポイントの署名対象はこのルートと `prevHash` で、**読取時に再署名してはいけません**（`prevHash` の自己一致性が壊れるため）。
- **信頼根拠はログ鍵のピン留め**: `logKeys` に無い台帳は `anchor-untrusted-log`。HTTP で取れた文字列を信頼する設計にはしていません。
- **検証は fail-closed で順序固定**: 形式 → 指紋とゾーン → 所有者署名 → 有効期間 → serial と失効 → 衝突 → アンカー → 収集元全滅（`resolution-unavailable` は失敗）。
- **`core/domain` はストリーム I/O を知らない**: ピアへの `wantOwnership` 問い合わせは `NameServer` が `DomainAuthority` へ候補を渡す形で行い、HTTP レジストリはアダプタ（`adapters/domain`）に分離しています。

## 残っている構想

- 実チェーン（Namecoin / L1 トランザクション）への裏付け検証 — #42
- レジストリの紛争解決・失効回収・IDNA など運用ガバナンス — #43
- HTTP のフル実装（HTTP/2・WebSocket アップグレード・`CONNECT`・圧縮・Cookie ジャー・認証・リダイレクト追従・TLS 終端） — #57
- 受信ウィンドウ（フロー制御）の広告と、`HTTPClient` の接続プール上限 — #56 / #58
- タブが凍結されている間の到達不能（#51 の本質的制約、仕様 §9.6）。状態の永続化・復元は M7 で対応済み
- ブラウザ外部の既存クライアントのためのブリッジ — #52 は M8 で対応（仕様 §19）。ローカル TCP 待ち受けからトンネルへ中継する。UDP・SOCKS・ローカル側の認証は未実装
- 権威サーバー階層 / DNS 相互運用 — 未 Issue（必要になるまで起票しない）

これらは [plan.md](../plan.md) §4.3 と GitHub Issues に整理しています。
