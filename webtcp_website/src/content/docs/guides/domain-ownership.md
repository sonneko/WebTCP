---
title: domain.global と所有権証明
description: M5 の `domain.global` ゾーン。所有者署名付きレコード、Merkle ツリー台帳アンカー、fail-closed な検証と `NameServer` 統合、参照 HTTP レジストリ。
---

M5（#25）では `webtcp://` 名前のうち **`domain.global` ゾーン**を特別扱いし、「その名前をその NodeId に紐づけている所有者が誰であるか」を**検証可能な形で**扱うようになりました。

重要なのはスコープです。ブラウザにブロックチェーンクライアントは組み込みません。代わりに、**検証可能な所有権レコード**（所有者の Ed25519 署名 + 台帳が発行するアンカー）と、**検証器を差し替えられるインターフェース**を実装しています。Namecoin や L1 トランザクションなど**実ブロックチェーンへのアンカー検証** ([#42](https://github.com/sonneko/WebTCP/issues/42)) と、レジストリの**運用ガバナンス**（紛争解決・失効回収・IDNA、[#43](https://github.com/sonneko/WebTCP/issues/43)）は将来課題として Issue 化しました。

## 名前ルール

- ゾーン名は **`domain.global`**（固定）。その直下の 1 ラベルのみがドメイン名です（`shop.domain.global` は可、`a.b.domain.global` は不可）。
- ラベルは LDH（英小数字と `-`、先頭/末尾の `-` 不可）、1 ラベル 1–63 文字、完全名 253 文字まで。大文字は正規化で小文字になります。
- `*.node` と同様に、`domain.global` 自体やゾーン外のopportunistic な名前は `NameServer` の登録 API で拒否されます。

```ts
import { isDomainGlobalName, normalizeDomainName, domainZone } from '@sonneko/webtcp-tunneler';

isDomainGlobalName('Shop.Domain.Global'); // true
normalizeDomainName('Shop.Domain.Global'); // 'shop.domain.global'
domainZone('shop.domain.global'); // 'domain.global'
```

## 所有権レコード

`DomainOwnershipRecord` は「所有者が自分の NodeId への主張に署名した」だけです。ブラウザは**常に検証してから**受理します。

| 項目 | 意味 |
| :--- | :--- |
| `body.domain` | 正規化された完全名 |
| `body.nodeId` | 名前が束縛される NodeId（公開鍵 SHA-256 指紋） |
| `body.ownerPublicKey` | 署名に使った Ed25519 公開鍵（Base64url、32 バイト） |
| `body.serial` | ドメイン内の連番。**単調増加**で、小さいものは `stale-serial` で棄却 |
| `body.issuedAt` / `body.expiresAt` | 有効期間（既定 30 日、上限 365 日） |
| `body.revoked` | 自発失効。真のレコードは他のどのレコードにも優先して「焼却済み」を告げる |
| `body.port` / `body.txt` | 推奨ポート・自由記述（255 文字） |
| `anchor` | 台帳が発行する包含証明（後述）。**無くてもレコードは成立**するが、検証ポリシー次第で拒否される |
| `signature` | `body` の canonical バイト列に対する Ed25519 署名 |

canonical シリアライズ（固定長ヘッダ + 長さ接頭辞付き文字列）と SHA-256 による 32 バイトの commitment は仕様 §13.2 のとおりです。commitment が台帳に載る値であり、レコード本体は carrier として扱われます。

```ts
import { createDomainOwnershipRecord, commitDomainRecord, domainRecordToJSON } from '@sonneko/webtcp-tunneler';

const record = await createDomainOwnershipRecord({
  domain: 'shop.domain.global',
  keyManager,      // 所有者の Ed25519 鍵（NodeId は指紋から導出）
  serial: 1,
  port: 8080,
  txt: 'orders',
});

const commitment = await commitDomainRecord(record.body); // 64 hex 文字
```

## 台帳アンカーとチェックポイント

参照台帳は**追記専用**のハッシュチェーン + Merkle ツリーです（仕様 §13.3）。

- 各レコードはリーフ `H(0x00 || commitment)` としてツリーに追加され、`DomainAnchor` が包含証明（`leafIndex` と `proof`）を返します。
- ルートはツリーサイズに束縛されます: `H(0x02 || uint64BE(treeSize) || top)`。よって 5 リーフの証明を 4 リーフのルートに通すことはできません。
- `treeSize` ごとにログ鍵が署名した**チェックポイント**が発行され、クライアントは受理した最新の `treeSize` をピン留めして**後退（ロールバック）を拒否**します。チェックポイントを追跡して連続性を検証することもできます（`checkpointChain`）。
- `MAX_DOMAIN_TREE_SIZE`（65536）でツリーを区切り、新しいルートへ `prevHash` で繋がれます。

## 検証は fail-closed

`DomainAuthority` は次の順序で**1 つでも失敗したらその候補を棄却**します（§13.4.1）。候補が 0 件なら「解決失敗」であり、空の結果を黙って受理することはありません。

1. レコード形式と canonical バイト列の一致（16 KiB 上限を含む）
2. 公開鍵 → NodeId 指紋の一致、および `expectedDomain` / ゾーンの一致
3. 所有者自己署名（Ed25519）
4. 有効期間（`clockSkewMs` は既定 300 秒）
5. `serial` 単調増加と失効
6. 同一シリアルでの内容衝突 → `conflict`
7. 台帳アンカー（包含証明 → チェックポイント署名 → ピン留め後退検査 → 必要なら連結追跡）
8. 収集元が 1 つも応答しない → `resolution-unavailable`（失敗として扱う）

```ts
import { createDomainAuthority } from '@sonneko/webtcp-tunneler';

const authority = createDomainAuthority({
  sources: [client],                 // HTTP レジストリ等（任意の数だけ並列に引く）
  verifierOptions: {
    requireAnchor: true,             // アンカー必須にする（既定は false）
    logKeys: { [logId]: logPublicKey }, // 信頼するログ鍵のピン留め（未指定なら fail-closed）
    // clockSkewMs: 300_000,
  },
  checkpointChain: client,           // チェックポイント連結の追跡（任意）
  resolveTimeoutMs: 5_000,
});

const resolution = await authority.resolve('shop.domain.global');
// { ok: true, domain, nodeId: '<nodeId>', record, proof: { code: 'ok', anchorVerified: true, ... } }
```

`logKeys` を設定しない限り、未知の台帳が発行したアンカーは `anchor-untrusted-log` で棄却されます。**信頼の根拠はピン留めされたログ鍵**であり、HTTP で取れた文字列であることではありません。

## `NameServer` 統合

`NameServer` に権威を渡すと、`.domain.global` が解決対象の名前として扱われます。

```ts
const ns = new NameServer(network, { domains: authority });
ns.listen();

// サーバー側: 自分のレコードを登録（検証に失敗したレコードは登録されない）
const registered = await ns.registerDomain(record);
if (!registered.ok) console.error(registered.code, registered.message); // 例外にはならない

// クライアント側: 通常の名前解決と同じ入口でゾーン名を引ける
const resolved = await ns.resolve('shop.domain.global');
// resolved.source === 'domain' / resolved.record は検証済みの所有権レコード

// URL 経由なら connectURL() が同じ権威で解決する
const stream = await network.connectURL('webtcp://shop.domain.global:8080/orders', { nameServer: ns });
```

- 解決順序は **ローカル → 明示的な収集元（HTTP レジストリ）→ 既知ノードへの `wantOwnership` 問い合わせ**。ピア応答に含まれた `ownership` レコードも、権限を持つノードの回答として同じ検証を通ります。
- 名前問い合わせ JSON は後方互換に拡張されました（`query.wantOwnership`、`answer.ownership`）。M4 までのクライアントは無視します。
- ゾーン外の名前を `registerDomain()` に渡すと拒否されます。取り下げは `ns.unregisterDomain('shop.domain.global')`、現在提供中のレコードは `ns.servedDomainRecords()`。
- 解決は `resolveTimeoutMs` と `AbortSignal` が**必ず**効きます（ハングするピアがあってもデッドラインで reject される。#40 はこの修正です）。

## 参照 HTTP レジストリ

`examples/domain-registry.mjs` は仕様 §13.6 のエンドポイントを実装した実験用の台帳です。`examples/server.mjs` が `/domain/*` としてマウントし、デモページから使えます（**起動のたびに ephemeral なログ鍵**を発行し、永続化しません）。

| エンドポイント | 用途 |
| :--- | :--- |
| `POST /domain/record` | `{ record }` を受理。検証済みなら `{ accepted: true, anchor, leafIndex, treeSize }`。改ざんは `400`、`serial` 衝突は `409` |
| `GET /domain/record?name=` / `?nodeId=` | 候補レコード配下。0 件は `404` |
| `GET /domain/checkpoint` | 最新チェックポイント |
| `GET /domain/checkpoints?after=&to=` | 区間チェックポイント（連結検証用） |
| `GET /domain/log` | `logId` とログ公開鍵（ピン留め用） |

クライアント側が `HttpDomainRegistryClient`（`createHttpDomainRegistryClient({ baseUrl })`）で、`fetchImpl` を注入すればテストや独自トランスポートに差し替えられます。

## デモでの確認

`examples/demo/` のセクション 3「domain.global 所有権レコード」では、このタブのノードでレコードを生成 → レジストリへ submit → 受領したアンカー付きで `registerDomain()` → ピアタブ（または別タブ）で `webtcp://<その名前>:8080/` を解決、という流れをボタン 1 つで試せます。

1 タブ自己チェック（`?selftest=1`）のステップ **1d** も同じ経路を自動化したもので、(a) 台帳経由の解決、(b) 台帳を引かず既知ノードの `wantOwnership` 応答だけの解決、(c) 未登録名前の fail-closed、(d) 改ざんレコードの `400` 拒否を確認します。Playwright のヘッドレス E2E（`examples/verify-browser.mjs`）でもこのステップが必須化されています。

## 制約

- **公開ブロックチェーンへの裏付けは未実装**（#42）。参照台帳は信頼できる第三者ではなく、単なる実験用プロセスです。実運用にはログ鍵のピン留め方針（監視・複数鍵・CT 風の散発収集）と、紛争解決・失効回収を含むガバナンス設計が必要です（#43）。
- **台帳の永続化・合意・監査は未実装**。参照実装はメモリ上で、再起動すると履歴を失います（`treeSize` が戻るため、ピン留め側はロールバックとして検出します）。
- **レコードの発行・更新は手動**です。所有者側で `serial` を増やして再署名し、再び submit する必要があります。
- **名前空間は実験用 zone** です。ICANN の `.global` 実在や DNS との排他は扱いません（仕様 §13.1）。
- 鍵ローテーションやオンデマンドの公開鍵照会は未実装です（#47）。レコードを失効させても、ピアが保持する古い公開鍵のマッピングは自動的に無効になりません。
