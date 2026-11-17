# WebTCP プロトコル仕様書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.6.0 |
| 対象実装 | `webtcp_jslib` (TypeScript) |
| プロトコルバージョン | 2（v1 は受信のみ後方互換。M4 の名前解決・M5 のドメイン所有権証明・M6 の HTTP トンネルはいずれも v2 上のアプリケーション層） |
| ステータス | 実験的（破壊的変更あり） |
| 最終更新 | 2026-11-16 |

本書は WebTCP の**振る舞いの仕様**を定義する。実装内部の構造や技術選定の理由は `design.md`、作業計画と将来課題は `plan.md` を参照すること。

---

## 1. 目的

WebTCP は、WebRTC の信頼性のあるデータチャネル（SCTP）を土台として、アプリケーション層に**仮想的な TCP/HTTP トンネル**を構築する実験的プロトコルである。

最終的な目標は、ブラウザを「サーバーにアクセスするクライアント」ではなく「**他のデバイスから直接アクセスされる自己完結型のサーバー実行環境**」に変えることにある。そのために本プロトコルは次を提供する。

1. 単一の P2P データチャネル上での**複数仮想接続の多重化**（ポート + セッション）
2. バイトストリーム指向の**順序保証・自動分割・再送・輻輳制御・半閉鎖**（TCP に相当する L4 機能）
3. シグナリング手段や STUN/TURN 設定を差し替え可能にする**リンク層の抽象化**
4. 将来のマルチホップルーティングおよび名前解決に耐える**L3 ヘッダー**
5. 改ざん・なりすましを防ぐ **Ed25519 署名**と、公開鍵の指紋に基づく**自己証明型の NodeId**（v2）
6. **NameServer** による名前解決と **`webtcp://` URL**、永続ノード識別子（M4）
7. **`domain.global`** 名前空間と、**検証可能なドメイン所有権レコード**（署名付きレコード + 追記型台帳アンカー + プラガブルな検証器）（M5）
8. **HTTP/1.1 サブセットによるアプリケーション層トンネル**（メソッド + パス + ヘッダ + `Content-Length` / `chunked` の往復、`keep-alive`、ストリーミング）（M6）

1〜7 は「バイト列を運ぶ」ところまでを定めていた。8 はその上に**リクエスト/レスポンスという約束**を与え、`webtcp://name:port/path?query` のパスとクエリを実際に転送可能にする（§15）。8 はプロトコルの拡張ではなく、`VirtualStream` 上で動く**アプリケーション層プロトコル**であり、既存の v1 / v2 パケットと互換である。

## 2. 用語

| 用語 | 定義 |
| :--- | :--- |
| ノード (Node) | WebTCP ネットワークに参加する 1 つの実行環境（通常は 1 ブラウザタブ）。`NodeId` で識別される。 |
| NodeId | ノードを一意に識別する 32 文字の hex。プロトコル v2 では **Ed25519 公開鍵の指紋**（`SHA-256` の先頭 16 バイト）。v1（レガシー）ではランダム値。 |
| 鍵管理 (KeyManager) | Ed25519 の鍵生成・署名・検証・公開鍵解決を担う実装。ブラウザは `BrowserKeyManager`、Node.js は `NodeKeyManager`。 |
| 公開鍵ディレクトリ (KeyDirectory) | `NodeId -> Ed25519 公開鍵` の対応表。指紋一致を検証して登録する。 |
| NameServer | 名前を A レコード（NodeId）または CNAME レコード（別名）へ対応付け、ローカル登録と既知ノードへの問い合わせで解決するアプリケーション層サービス。 |
| `domain.global` | グローバルに一意なドメイン名を割り当てる単一ゾーン。所有権レコード（§13）で裏付けられた名前だけが解決できる（M5）。 |
| 所有権レコード (DomainOwnershipRecord) | 「ドメイン名 ↔ NodeId（公開鍵指紋）」の対応を、その NodeId の所有者が署名した自己証明型のクレーム。§13.2。 |
| 台帳アンカー (DomainAnchor) | 所有権レコードが追記型台帳のいつ・どの位置に記録されたかを表す Merkle 包含証明と署名済みチェックポイント。§13.3。 |
| チェックポイント (DomainCheckpoint) | 台帳の木サイズ・ルート・時刻をログ鍵で署名したもの。`prevHash` による連結で書換え（ロールバック）を検出できる。§13.3。 |
| 所有権検証器 (IDomainOwnershipVerifier) | 所有権レコードの妥当性を判定する差し替え可能なコンポーネント。自己署名検証のほかに台帳・実チェーン検証を委任できる。§13.4。 |
| WebTCP URL | `webtcp://<NodeId または 名前>:<port>/path?query#fragment` 形式の接続先指定。 |
| 隣接ノード (Neighbor) | データチャネルが直接確立している相手ノード。 |
| 仮想ストリーム (VirtualStream) | 仮想 TCP セッション。`(remoteNodeId, localPort, remotePort)` で一意。 |
| 仮想ポート | アプリケーションを識別する 16 ビット整数（有効範囲 1–65535、0 は制御用予約）。 |
| リンク層 | データチャネルとシグナリングの抽象化。`IChannel` / `ISignalingAdapter`。 |
| ルーティング層 | 宛先ノードへの転送、TTL、署名検証、ルーティング情報交換。 |
| トランスポート層 | ポート多重化、セッション、バイトストリーム、再送、輻輳制御、状態機械。 |
| MSS | Maximum Segment Size。1 つの `DATA` パケットに載せる最大アプリケーションデータ長（既定 16 KiB、上限 60 KiB）。 |
| SACK | Selective Acknowledgment。順序外で受信済みのバイト範囲を送信側へ通知する拡張。 |
| HTTP トンネル | `VirtualStream` 上で HTTP/1.1 のメッセージ（リクエスト/レスポンス）を運ぶアプリケーション層プロトコル。§15。 |
| `HTTPServer` | 仮想ポートで待ち受け、`VirtualStream` 上の HTTP/1.1 リクエストを `HTTPHandler` へ渡して応答を書き戻すサーバー。§15.3。 |
| `HTTPClient` | `WebTCPNetwork`（または `VirtualStream`）から HTTP/1.1 リクエストを送るクライアント。`fetch` 風の API を持つ。§15.4。 |

## 3. 準拠のキーワード

本書の「しなければならない (MUST)」「してはならない (MUST NOT)」「すべきである (SHOULD)」「してもよい (MAY)」は RFC 2119 に準ずる。

## 4. アーキテクチャ

```
+-----------------------------------------------------------+
| L7  アプリケーション / NameServer / webtcp:// URL            |
|     HTTP トンネル (HTTPServer / HTTPClient、§15 / M6)        |
+-----------------------------------------------------------+
| L4  TransportLayer : ポート多重化 / SessionManager          |
|     VirtualStream  : 状態機械 / バイト単位 Seq-Ack / 分割    |
|                      動的 RTO / 輻輳制御 / Fast Retransmit  |
|                      SACK / Half-Close / 部分読み取り       |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF             |
|     Ed25519 署名・検証 / KeyDirectory（公開鍵の指紋）          |
|     RoutingTable(+Manager) : 経路表と距離ベクトル交換         |
+-----------------------------------------------------------+
| L2  LinkManager    : 隣接管理 / パケットのフレーミング        |
|     IChannel       : WebRTC DataChannel 等の抽象化           |
|     ISignalingAdapter : Offer/Answer/ICE の運搬              |
+-----------------------------------------------------------+
| L1  WebRTC (SCTP over DTLS over ICE) / ブラウザ API          |
+-----------------------------------------------------------+
```

各層は上位層にのみ API を公開し、下位層から上位層へはイベントで通知する。層をまたぐ参照はインターフェース越しに行わなければならない (MUST)。

## 5. 識別子

### 5.1 NodeId

- 形式: `^[0-9a-f]{32}$`（16 バイトの hex、32 文字）。
- **プロトコル v2（既定）**: NodeId は Ed25519 公開鍵の指紋である。

  ```
  NodeId = hex( SHA-256( rawEd25519PublicKey ) [0..16] )
  ```

  - `rawEd25519PublicKey` は 32 バイトの生公開鍵（SPKI ではなく `raw` 形式）。
  - 指紋は**決定的**であり、同じ公開鍵からは常に同じ NodeId が得られる。
  - したがって NodeId は自己証明型であり、パケットの `senderId` が「署名を検証できる公開鍵の指紋」と
    一致することを確認すれば、なりすましは成立しない（§10.2）。
  - 実装は `deriveNodeId(publicKey)`（`src/core/routing/keys.ts`）で提供する。
- **プロトコル v1（レガシー）**: ランダムな 16 バイトを hex 化した値を自己申告で用いる。
  暗号学的な検証は行えない。v2 ノードは v1 パケットを後方互換のため受理してよい (MAY) が、
  `requireSignatures` が有効な場合は破棄しなければならない (MUST)。
- ノードは自身の NodeId を 1 つだけ持つ。鍵管理が NodeId を導出できない場合、
  そのノードは v2 に参加してはならない (MUST NOT)。
- シグナリングアダプタは `getLocalNodeId()` で同一の値を返さなければならない (MUST)。
  鍵管理を用いる場合、`SignalingAdapterHub` の `nodeId` には鍵管理の NodeId を渡す。
- NodeId の長さは v1 / v2 で共通（32 文字）であり、24 バイト固定ヘッダーのレイアウトは変わらない。

### 5.2 仮想ポート

- 16 ビット符号なし整数。アプリケーションが `listen()` / `connect()` で指定できる有効範囲は `1–65535` とする（`0` は `RT_UPDATE` 等の制御パケット用に予約され、`listen()` / `connect()` では拒否しなければならない (MUST)）。
- 1024 未満は将来の予約（HTTP=80, HTTPS=443 相当）として扱い、アプリケーションが明示しない限り使用しないことが望ましい (SHOULD)。
- クライアント側のローカルポートは 49152–65535 から自動割り当てし、既存のアクティブセッションと衝突しないポートを選択する (SHOULD)。

### 5.3 セッション識別

仮想ストリームは `(remoteNodeId, localPort, remotePort)` の三つ組で識別する。実装内部では文字列 `${remoteNodeId}:${localPort}:${remotePort}` をキーとしてよい。双方向で同一のキーになる必要があるため、送信側は `sourcePort = localPort`, `destinationPort = remotePort` を必ず設定しなければならない (MUST)。

### 5.4 永続ノード識別子と衝突検出（M4）

- v2 の NodeId は鍵指紋であるため、**秘密鍵の永続化と再利用**が NodeId の永続化を意味する。
- `BrowserKeyManager.open()` は IndexedDB の非抽出 CryptoKey を復元し、保存公開鍵の指紋と NodeId の一致に加えて、**署名チャレンジによる秘密鍵/公開鍵の対応**を検証しなければならない (MUST)。検証に失敗した保存身元を黙って再利用してはならない (MUST NOT)。
- `NodeKeyManager.open({ keyFile })` は PKCS#8 PEM ファイルを読み書きする。新規作成時は親ディレクトリを作成し、一時ファイルへの書き込みとリンク/rename による原子的な公開を行い、秘密鍵ファイルのパーミッションは `0600` としなければならない (MUST)。既存ファイルの上書き競合時は既存鍵を読み直して検証する。
- 明示的な `expectedNodeId` / `nodeId` が保存済み NodeId と異なる場合、実装は `NodeIdCollisionError` を投げなければならない (MUST)。
- `KeyDirectory` は同一 NodeId に異なる公開鍵が提示された場合、既存鍵を保持する。非同期 `addPublicKey()` は `false` を返し、同期 `setPublicKey()` は `NodeIdCollisionError` を投げる。`setPublicKey()` は**指紋検証済みの鍵のみ**を受け付ける後方互換 API である。
- `WebTCPNetwork` は鍵管理と公開鍵ディレクトリを併用する場合、ローカル NodeId に既に異なる鍵が登録されていれば `NodeIdCollisionError` を投げなければならない (MUST)。
- ブラウザで IndexedDB が利用できない場合はセッション限定のメモリ身元へ縮退してよい (MAY)。ストレージ障害は警告する。鍵の再生成は `regenerate` / `BrowserKeyManager.regenerate()` の明示操作に限定する。
- `domain.global` ゾーンでは、**NodeId をドメイン名へ束縛するには所有権レコードの署名検証に成功しなければならない**（§13）。永続化された身元そのものは所有権を付与しない。

## 6. パケット形式（プロトコルバージョン 2 / v1 互換）

すべての WebTCP パケットは 1 つのバイナリメッセージとしてデータチャネルで送信される。データチャネルはメッセージ境界を保存するため、追加のフレーミングは行わない。

### 6.1 バイト配置

オフセットは先頭からのバイト数。マルチバイト整数は**ビッグエンディアン**。

| Offset | Size | Field | 型 | 説明 |
| ---: | ---: | :--- | :--- | :--- |
| 0 | 1 | `magic` | uint8 | 固定値 `0x57` (`'W'`)。不正値は破棄。 |
| 1 | 1 | `version` | uint8 | `2`（既定・署名必須）または `1`（レガシー・署名なし）。未知バージョンは破棄。 |
| 2 | 1 | `ttl` | uint8 | 残ホップ数。初期値 64 を推奨。 |
| 3 | 1 | `flags` | uint8 | §6.3 のビットマスク。 |
| 4 | 2 | `sourcePort` | uint16 | 送信元仮想ポート。 |
| 6 | 2 | `destinationPort` | uint16 | 宛先仮想ポート。 |
| 8 | 4 | `seqNum` | uint32 | シーケンス番号（バイト単位、mod 2^32、§8.3）。 |
| 12 | 4 | `ackNum` | uint32 | 次に期待する受信シーケンス番号（バイト単位、mod 2^32）。 |
| 16 | 1 | `senderIdLen` | uint8 | `senderId` の UTF-8 バイト長（1–255）。 |
| 17 | 1 | `destIdLen` | uint8 | `destinationId` の UTF-8 バイト長（1–255）。 |
| 18 | 2 | `signatureLen` | uint16 | `signature` のバイト長。v2 は **64**（Ed25519）、v1 は **0**。 |
| 20 | 4 | `payloadLen` | uint32 | `payload` のバイト長。 |
| 24 | var | `senderId` | UTF-8 | 送信元 NodeId。 |
| … | var | `destinationId` | UTF-8 | 最終宛先 NodeId。 |
| … | var | `signature` | bytes | Ed25519 署名（64 バイト、v2）。v1 では空。 |
| … | var | `payload` | bytes | アプリケーションデータまたは制御ペイロード（`RT_UPDATE` JSON、`ACK` の SACK オプション）。 |

固定ヘッダー長は 24 バイト（v1 / v2 で共通）。合計長 = `24 + senderIdLen + destIdLen + signatureLen + payloadLen`。

v1 と v2 の違いは `version` フィールドと `signature` の有無だけであり、ヘッダーレイアウトは同一である。
送信側は次の規則でバージョンを決める (MUST)。

- `signature` が 64 バイトなら **v2**。
- `signature` が空なら **v1**。

したがって、署名器を差し替えるだけで v1 / v2 を切り替えられる（§16）。

### 6.2 受信時の検証

受信側は次を検証し、いずれかに違反したパケットを**破棄しなければならない** (MUST)。

1. バッファ長が 24 バイト以上である。
2. `magic == 0x57` かつ `version` が `1` または `2`。それ以外は破棄する。
3. 宣言された各長の合計がバッファ長と**厳密に一致する**。
4. `senderId`, `destinationId` が空でない。
5. `payloadLen` が実装の上限（既定 60 KiB）以下である。
6. `flags` の下位 7 ビット（ビット 0–6）に既知のフラグが 1 つ以上立っている。
7. **`version == 2` なら `signatureLen == 64`、`version == 1` なら `signatureLen == 0`。** 違反は破棄 (MUST)。
8. `version == 2` なら `senderId` が `^[0-9a-f]{32}$` に一致する。違反は破棄 (MUST)。
9. `version == 2` なら署名検証（§10）に成功する。失敗は破棄し `warn` ログを出す (MUST)。

7 はシリアライザが構文検証として実施する。8〜9 はルーティング層が呼ぶ**署名検証器**（`Ed25519PacketVerifier`）が担う。
したがって `NullPacketVerifier`（v1 後方互換モード）を注入したノードでは 8〜9 は適用されない (MAY)。v2 ノード間で
のみ一貫して強制される点に注意すること（§10.2）。

### 6.3 フラグ

| ビット | 名称 | 意味 |
| ---: | :--- | :--- |
| 0 | `DATA` | アプリケーションデータを含む。 |
| 1 | `SYN` | 接続要求。 |
| 2 | `ACK` | 確認応答。ペイロードは通常空だが、順序外データがある場合は §8.4.4 の SACK オプションを格納してもよい (MAY)。 |
| 3 | `FIN` | 切断要求（片方向の送信終了）。 |
| 4 | `RST` | 強制切断。 |
| 5 | `SYN_ACK` | SYN + ACK の同時表現。 |
| 6 | `RT_UPDATE` | ルーティング情報の交換用。ペイロードは §7.4 の JSON。 |
| 7 | 予約 | 送信時は 0。受信時は無視。 |

パケット種別の判定は**必ずフラグ**で行わなければならない (MUST)。ペイロードの内容で種別を推定してはならない (MUST NOT)。

`SYN_ACK` は `SYN|ACK` と等価に扱う。受信側は両表現を受け入れなければならない (MUST)。

## 7. ルーティング層

### 7.1 隣接ノード

- `IChannel` の `connection-status` イベントで隣接を管理する。
- 隣接が確立した時点で、ルーティングテーブルに `cost = 1, nextHop = 隣接` を登録する。
- 隣接が切断した時点で、そのノードを nextHop とする全エントリを削除する。

### 7.2 送信と転送

`RoutingLayer.sendPacket(packet)` は次を行う。

1. 署名付与（§10.3）。既に署名が付いているパケット（中継転送）は再署名しない。
2. `destinationId == localNodeId` ならトランスポート層へ渡して終了。
3. `ttl <= 0` のパケットは破棄する。
4. ルーティングテーブルから宛先エントリを取得。存在しなければ、宛先が**直接の隣接**であれば `cost=1` とみなす。それ以外は破棄し警告する。
5. `nextHop` へ `IChannel.send()` でシリアライズ済みバイト列を送る。

### 7.3 受信と RPF

受信側は次を行う。

1. デシリアライズ（失敗時は破棄。§6.2 の 1–7）。
2. **署名検証**（§10.2）。失敗・欠落は破棄し `warn` ログを出す (MUST)。
3. `RT_UPDATE` パケットは次をすべて満たす場合のみ `RoutingTableManager` へ渡し、トランスポート層へは渡さない。満たさない場合は破棄する (MUST)。
   - 受信元が直接の隣接である。
   - 外側 `senderId` と受信元 NodeId、ペイロード内 `senderId` が一致する。
   - 外側 `destinationId` が自ノードである。
   - `ttl > 0` かつ `sourcePort == destinationPort == 0`。
   `RT_UPDATE` は中継してはならない (MUST NOT)。同梱された `publicKey` は公開鍵ディレクトリへ登録する（§10.4.2）。
4. 通常パケットの **RPF (Reverse Path Forwarding)** チェック: 送信元への経路の nextHop が、実際に受信した隣接と一致することを確認する。ただし経路が未学習で、かつ受信元が直接の隣接である場合は許可する（M1–M2 の縮退動作）。それ以外は破棄。
5. `destinationId == localNodeId` ならトランスポート層へ渡して終了。
6. そうでなければ中継転送する: `ttl` を 1 減算し、`ttl <= 0` になった場合は破棄する (MUST)。残っていれば経路表の `nextHop` へ送信する。

中継ノードは `senderId` の署名を TTL 減算後に再計算してはならない (MUST NOT)。
TTL が署名対象外（0 に正規化）であるため、減算しても署名検証は成立する（§10.3）。

### 7.4 ルーティング情報パケット（RT_UPDATE）

`RT_UPDATE` フラグのパケットのペイロードは UTF-8 の JSON であり、次の形をとる。

```json
{
  "senderId": "0123456789abcdef0123456789abcdef",
  "entries": [
    { "destinationId": "fedcba9876543210fedcba9876543210", "cost": 1, "publicKey": "…" }
  ],
  "withdrawals": ["00112233445566778899aabbccddeeff"],
  "publicKey": "ISvn_HoP1dCMEm4bsU7kNzMqrxXPpd-LXRjPPHErhAI"
}
```

- `publicKey`（任意、プロトコル v2）: 送信元の Ed25519 公開鍵（32 バイトの Base64url、パディングなし）。
  詳細は §10.4.2 を参照。v2 ノードは同梱することが望ましい (SHOULD)。

- `entries` には自分自身のエントリを含めてはならない (MUST NOT)。各エントリは任意で `publicKey`（Base64url）を含めてよい (MAY)。受信側は指紋一致を検証して公開鍵ディレクトリへ登録し、経路とともに既知鍵を伝播する。これによりマルチホップ先の署名検証鍵を事前共有なしに学習できる。
- `entries` / `withdrawals` はそれぞれ最大 256 件、`cost` は 0–255 の整数とする。超過・不正値は破棄する (MUST)。送信側は上限を超える場合、複数の `RT_UPDATE` に分割して送る (MUST)。
- 受信側は送信元隣接ノード（`senderId`）の直接経路（`cost = 1`）の `lastSeen` を更新しなければならない (MUST)。
- 受信側は各エントリについて `cost + 1` を計算し、距離ベクトル方式で経路を更新する。現在のネクストホップが送信元と一致し、コストが同一である場合も `lastSeen` を更新しなければならない (MUST)（経路変化は発生しないため再ブロードキャストは行わない）。
- `withdrawals` は到達不能になった宛先のリストである。受信側は、その宛先の現在のネクストホップが送信元と一致する場合に限りエントリを削除する (MUST)。省略可能。
- 隣接が切断された場合、そのノードをネクストホップとする経路を削除し、`withdrawals` として全隣接へ通知する (MUST)。
- 経路表に実質的な変化（追加・削除・コスト変更）が発生した場合、全隣接ノードへ現在のテーブルを再送する。
- 30 秒ごとにメンテナンスを行い、60 秒以上更新のない `cost > 0` のエントリを削除する。削除したエントリは `withdrawals` として通知する。
- ルーティング情報パケットはトランスポート層へ渡してはならない (MUST NOT)。
- `publicKey` が同梱されている場合、受信側は `senderId` の指紋との一致を確認したうえで公開鍵ディレクトリへ登録しなければならない (MUST)。不一致なら破棄する。

### 7.5 TTL

- 初期値は 64。
- 中継転送のたびに 1 減算する。
- 宛先に到着する前に 0 になったパケットは破棄する。

## 8. トランスポート層

### 8.1 多重化

`TransportLayer` は受信パケットを `(senderId, destinationPort, sourcePort)` で既存ストリームに振り分ける。

- 既存ストリームがある場合はそのまま渡す。
- ない場合、`SYN` なら新規ストリームを作り `SYN_ACK` を返す。ハンドシェイクが完了して `ESTABLISHED` に遷移した時点で、そのポートを `listen` しているアプリケーションハンドラへストリームを引き渡す (MUST)。
- 待ち受けしていないポートへの `SYN`、または既存セッションが無い状態での `SYN` 以外のパケットには `RST` を返して破棄する。

### 8.2 状態機械（Half-Close 対応）

M2 では RFC 793 に準拠した片方向終了（half-close）をサポートする。

```
                 SYN (active)                SYN_ACK / ACK
   CLOSED -------------------> SYN_SENT -------------------> ESTABLISHED
      |                            ^                         |         |
      | SYN (passive)              | ACK       local end()   |         | recv FIN
      v                            |           (send FIN)    |         | (send ACK, emit 'end')
   SYN_RCVD -----------------------+                         v         v
                                                        FIN_WAIT_1   CLOSE_WAIT
                                                        /        \        |
                                          recv ACK     /          \       | local end()
                                                      v    recv FIN\      | (send FIN)
                                                FIN_WAIT_2    CLOSING     v
                                                     |           |    LAST_ACK
                                            recv FIN |           |        |
                                            (ACK)    v  recv ACK v        | recv ACK
                                                     +-> TIME_WAIT        |
                                                             |            |
                                                   timeWaitMs|            v
                                                             +--------> CLOSED
```

| 状態 | 送信可否 | 受信可否 | 説明 |
| :--- | :--- | :--- | :--- |
| `CLOSED` | 不可 | 不可 | 初期状態または終了状態。 |
| `SYN_SENT` | 不可 | 不可 | 能動オープンで SYN 送信済み、SYN_ACK 待ち。 |
| `SYN_RCVD` | 不可 | 不可 | 受動オープンで SYN 受信済み、SYN_ACK 送信済み、ACK 待ち。 |
| `ESTABLISHED` | 可 | 可 | 双方向データ送受信可能。 |
| `FIN_WAIT_1` | 不可 | 可 | ローカルから FIN 送信済み、ACK 待ち。相手からのデータは受信可能。 |
| `FIN_WAIT_2` | 不可 | 可 | ローカルの FIN が ACK 済み、相手の FIN 待ち。相手からのデータは受信可能。 |
| `CLOSE_WAIT` | 可 | 不可 | 相手の FIN を受信し ACK 済み（`end` 発火）。ローカルから送信継続可能。 |
| `CLOSING` | 不可 | 不可 | 同時クローズ（FIN を送信し、相手の FIN も受信済み。ACK 待ち）。 |
| `LAST_ACK` | 不可 | 不可 | `CLOSE_WAIT` からローカルも FIN 送信済み、最終 ACK 待ち。 |
| `TIME_WAIT` | 不可 | 不可 | 双方の FIN が完了。重複 FIN への ACK 再送のため `timeWaitMs` 待機後 `CLOSED` へ。 |

状態遷移の条件:

- 能動側は `SYN_ACK` 受信時、`ackNum == nextSendSeqNum` なら `ESTABLISHED` へ遷移し `ACK` を返して `connect` イベントを発火する。
- 受動側は `ACK`（またはピギーバック ACK を含む `DATA` / `FIN`）受信時、自身の `SYN_ACK` が確認されたら `ESTABLISHED` へ遷移し `connect` イベントを発火する。
- ローカルが `end()` または `close()` を呼ぶと、送信バッファに残っているすべてのデータを送信し終えた後に `FIN` を送信する。
  - `ESTABLISHED` からは `FIN_WAIT_1` へ遷移する。
  - `CLOSE_WAIT` からは `LAST_ACK` へ遷移する。
  - `SYN_SENT` / `SYN_RCVD` からは `RST` を送って即座に `CLOSED` へ遷移する。
- 相手の `FIN`（およびそれに先行する全データバイト）を受信したら `ACK` を返し、`end` イベントを一度だけ発火する。
  - `ESTABLISHED` の場合、`CLOSE_WAIT` へ遷移する。既定（`allowHalfOpen = true`）では自動的に `FIN` を送らず、アプリケーションが `send()` を継続した後に明示的に `end()` / `close()` を呼べる。`allowHalfOpen = false` の場合は直ちにローカルからも `end()` を実行する。
  - `FIN_WAIT_1` の場合、自身の `FIN` も ACK 済みなら `TIME_WAIT`、未 ACK なら `CLOSING` へ遷移する。
  - `FIN_WAIT_2` の場合、`TIME_WAIT` へ遷移する。
- `FIN_WAIT_1` で自身の `FIN` に対する `ACK` を受けたら `FIN_WAIT_2` へ遷移する。
- `CLOSING` で自身の `FIN` に対する `ACK` を受けたら `TIME_WAIT` へ遷移する。
- `LAST_ACK` で自身の `FIN` に対する `ACK` を受けたら即座に `CLOSED` へ遷移する。
- `TIME_WAIT` 中に重複した `FIN` を受信した場合は `ACK` を再送する。`timeWaitMs` 経過後（0 の場合は即座に）`CLOSED` へ遷移する。
- `RST` 受信、または再送上限超過で `CLOSED` へ遷移し `error` イベントおよび `close` イベントを発火する。
- `destroy()` は `FIN` や `TIME_WAIT` を待たず即座に `CLOSED` へ遷移する。**ピアへ `RST` も `FIN` も送らない**（ローカルの即時破棄）。したがって、相手側に終了を伝えたい場合は `end()` を使わなければならない (MUST)。

`CLOSED` へ遷移したとき、`close` イベントを**一度だけ**発火しなければならない (MUST)。

### 8.3 シーケンス番号・バイトストリーム・自動分割

#### 8.3.1 バイト単位のシーケンス空間とランダム ISN

- シーケンス番号（`seqNum`）および確認応答番号（`ackNum`）は**バイト単位**の 32 ビット符号なし整数（mod 2^32）である。
- 比較は RFC 1982 のシリアル番号算術（符号付き 32 ビット差分 `((a - b) | 0)`）で行わなければならず (MUST)、`0xFFFFFFFF` から `0` へのラップアラウンドを正しく扱わなければならない (MUST)。
- 接続開始時の初期シーケンス番号（ISN）は、ストリーム生成ごとに 32 ビットの暗号学的乱数（`crypto.getRandomValues`、非対応環境では `Math.random` フォールバック）でランダム化しなければならない (MUST)。テスト用途に限りオプションで明示指定してもよい (MAY)。
- シーケンス番号の消費量:
  - `SYN`: **1**（`ackNum` は `0`）
  - `SYN_ACK`: **1**（`ackNum` は相手の `SYN.seqNum + 1`）
  - `DATA`: **`payload.byteLength`**（0 バイトの `DATA` は送信しない）
  - `FIN`: **1**
  - `ACK` / `RST`: **0**
- `ackNum` は「次に期待する受信バイトのシーケンス番号（`rcvNxt`）」を示す。`SYN_ACK`, `ACK`, `DATA`, `FIN` のすべてが有効な `ackNum`（ピギーバック ACK）を運び、受信側はこれらすべてのパケットから `ackNum` を処理しなければならない (MUST)。
- **受信ウィンドウの広告は行わない**。`ackNum` は「次に期待する番号」であり、受信バッファの空きを示すウィンドウフィールドはパケット形式に存在しない（§6.1）。したがって送信側の制限は**輻輳ウィンドウ**（§8.4.2）と `maxWindowBytes` のみであり、受信側が遅い場合のフロー制御はプロトコルとして保証しない。HTTP 層（§15）の大きな応答を扱う場合、アプリケーションは受信側のメモリ上限に注意しなければならない (SHOULD)。ウィンドウ広告の追加は将来課題（`plan.md`）。

#### 8.3.2 60 KiB 超メッセージの自動分割と送信バッファ

- `VirtualStream.send(data)` は 60 KiB を超える任意長の `Uint8Array` または文字列を受け入れる。
- 送信データは内部の送信バッファに積まれ、**MSS**（Maximum Segment Size、既定 16 KiB = 16,384 バイト、設定可能上限はパケット上限の 60 KiB = 61,440 バイト）以下の `DATA` セグメントへ透過的に自動分割される。
- 送信バッファと輻輳ウィンドウ（§8.4.2）により、未 ACK バイト数（`inFlightBytes`）が実効ウィンドウ（`min(cwnd, maxWindowBytes)`）に達した場合は後続セグメントの送出を保留し、ACK 受信によりウィンドウが空いた時点で順次送出する。
- `send()` が返す `Promise` は、呼び出しで渡された全バイトがセグメント化されて送信キューへ投入された時点で解決する。送信完了前にストリームが切断・エラーとなった場合は reject する。
- 送信バッファの総量が `maxSendBufferBytes`（既定 4 MiB）を超える場合、`send()` は `Send buffer full` エラーで reject する。

#### 8.3.3 バイトストリーム再結合と部分読み取り

- 受信側は、順序外で到着したセグメントをシーケンス番号順に保持し、重複部分や部分的なオーバーラップをバイト単位で切り詰めて連続したバイト列へ再結合しなければならない (MUST)。
- `FIN` が先行する未到着データの前に届いた場合、`FIN` のシーケンス番号を記録しておき、`rcvNxt` がその位置に到達した時点で初めて `FIN` を処理しなければならない (MUST)。
- アプリケーションへの引き渡しは次の 2 モードをサポートする:
  1. **プッシュモード（フローイング）**: `'data'` イベントリスナーが 1 つ以上登録されており、かつ一時停止（`pause()`）されていない場合、連続した受信バイト列を即座に `'data'` イベントで通知する。
  2. **プルモード（部分読み取り）**: `'data'` リスナーが無い、または `pause()` 中の場合、受信バイト列を内部受信バッファに蓄積し `'readable'` イベントを発火する。アプリケーションは次のメソッドで任意バイト数を部分読み取りできる:
     - `read(maxBytes?: number): Uint8Array | null`: `maxBytes` 指定時は最大 `maxBytes` バイトを切り出して返し、残りをバッファに残す。省略時は全バッファを返す。空なら `null`。
     - `readExact(bytes: number): Promise<Uint8Array>`: 指定バイト数が揃うまで複数セグメントにまたがって待機し、厳密に `bytes` バイトの `Uint8Array` を返す。到達前に EOF（`end`）または `close` になった場合は reject する。
     - `readableLength`: 現在バッファに溜まっている未読バイト数。
     - `pause()` / `resume()`: プルモードとプッシュモードを切り替える。

### 8.4 再送・動的 RTO・輻輳制御・Fast Retransmit / SACK

#### 8.4.1 動的 RTO 計算（RFC 6298 — Jacobson / Karn）

- 初期 RTO は既定 `1000 ms`（`initialRtoMs`）。下限 `minRtoMs`（既定 `200 ms`）、上限 `maxRtoMs`（既定 `60 000 ms`）、タイマー粒度 `G = 50 ms`。
- 送信時に各セグメントの初回送信時刻を記録する。
- **Karn のアルゴリズム**: 1 回以上再送されたセグメント（`retransmissionCount > 0`）の確認応答からは RTT を計測してはならない (MUST NOT)。
- 再送されていないセグメントが新たに確認応答されたとき、計測値 `R = max(1, now - firstSendTime)` を用いて次を更新する:
  - 初回サンプル: `SRTT = R`, `RTTVAR = R / 2`
  - 2 回目以降: `RTTVAR = (3/4) * RTTVAR + (1/4) * |SRTT - R|`, `SRTT = (7/8) * SRTT + (1/8) * R`
  - `RTO = clamp(SRTT + max(G, 4 * RTTVAR), minRtoMs, maxRtoMs)`
- 再送タイムアウト発生時は指数バックオフを適用する: `RTO = min(RTO * 2, maxRtoMs)`。
- セグメントごとの最大再送回数は既定 5 回（`maxRetransmissions`）。超過時は `error` イベントを発火して `CLOSED` へ遷移する。

#### 8.4.2 輻輳制御（RFC 5681 — Slow Start / Congestion Avoidance）

- 送信側はバイト単位の輻輳ウィンドウ `cwnd` とスロースタート閾値 `ssthresh` を維持する。
  - 初期値: `cwnd = min(maxWindowBytes, 4 * mss)`（既定 64 KiB）、`ssthresh = maxWindowBytes`（既定 1 MiB）。
- 新規バイトが確認応答されたとき（`newlyAckedBytes > 0`）:
  - **スロースタート**（`cwnd < ssthresh`）: `cwnd = min(maxWindowBytes, cwnd + min(newlyAckedBytes, mss))`
  - **輻輳回避（AIMD）**（`cwnd >= ssthresh`）: `cwnd = min(maxWindowBytes, cwnd + max(1, floor(mss * newlyAckedBytes / cwnd)))`
- 再送タイムアウト（RTO）発生時:
  - `ssthresh = max(2 * mss, floor(inFlightBytes / 2))`
  - `cwnd = mss`
  - Fast Recovery 状態を解除し、重複 ACK カウンタを 0 に戻す。

#### 8.4.3 Fast Retransmit / Fast Recovery（NewReno）

- 送信側は、未 ACK データが存在する状態で `ackNum == sndUna` かつデータ長 0 の重複 `ACK` を受信するたびに `dupAckCount` を加算する。
- **`dupAckCount == 3`** に達したとき（Fast Retransmit）:
  - RTO を待たず、SACK されていない最古の未 ACK セグメントを即座に再送する。
  - Fast Recovery へ移行する: `ssthresh = max(2 * mss, floor(inFlightBytes / 2))`, `cwnd = ssthresh + 3 * mss`, `recoverSeq = nextSendSeqNum`。
- Fast Recovery 中の追加の重複 `ACK`:
  - `cwnd = min(maxWindowBytes, cwnd + mss)` とし、ウィンドウに空きがあれば新規データまたは次の未 SACK セグメントを送出する。
- Fast Recovery 中の新規 `ACK`:
  - `ackNum >= recoverSeq`（Full ACK）なら `cwnd = ssthresh` として Fast Recovery を終了する。
  - `ackNum < recoverSeq`（Partial ACK）なら、SACK されていない最古の未 ACK セグメントを即座に再送し、`cwnd` を確認応答バイト数ぶん調整する。

#### 8.4.4 SACK（Selective Acknowledgment、RFC 2018 サブセット）

プロトコル v1 の 24 バイト固定ヘッダーを変更せず、純粋な `ACK` パケットの `payload` に SACK オプションを格納する。

- 順序外データが存在しない通常時、`ACK` の `payload` は空（0 バイト）である。
- 受信側に順序外セグメントが 1 つ以上ある場合、隣接・重複する順序外セグメントを最大 **4 ブロック** の連続区間 `[leftEdge, rightEdge)`（`rightEdge` は排他）へ統合し、次のビッグエンディアン形式で `ACK` の `payload` に載せて送信する (SHOULD):

| Offset | Size | Field | 説明 |
| ---: | ---: | :--- | :--- |
| 0 | 1 | `kind` | 固定値 `0x05`（SACK オプション種別） |
| 1 | 1 | `count` | SACK ブロック数（1–4） |
| 2 + 8i | 4 | `leftEdge` | i 番目ブロックの開始シーケンス番号（uint32） |
| 6 + 8i | 4 | `rightEdge` | i 番目ブロックの終了シーケンス番号（uint32、排他） |

- 送信側が SACK 付き `ACK` を受信したとき、いずれかの SACK ブロックに完全に包含される（`leftEdge <= seg.seq && seg.endSeq <= rightEdge`）再送キュー内セグメントに `sacked = true` を設定する。
- Fast Retransmit および RTO 再送では `sacked == true` のセグメントの再送をスキップする (SHOULD)（ただし最終的な信頼性保証のため、RTO タイムアウト時には SACK 情報をクリアして再評価してもよい）。
- SACK を解釈しない相手であっても累積 `ackNum` により正常に通信できる後方互換性を保つ。

### 8.5 タイムアウト

| 項目 | 既定値 |
| :--- | :--- |
| トランスポート接続確立 (`TransportLayer.connectTimeoutMs`) | 10 000 ms |
| WebRTC リンク確立 (`WebRTCChannel.connectTimeoutMs`) | 15 000 ms |
| 初期 RTO (`initialRtoMs`) | 1 000 ms |
| 最小 / 最大 RTO (`minRtoMs` / `maxRtoMs`) | 200 ms / 60 000 ms |
| `TIME_WAIT` 待機時間 (`timeWaitMs`) | 200 ms |
| セッション無通信タイムアウト (`sessionTimeoutMs`) | 300 000 ms |
| セッションクリーンアップ間隔 (`cleanupPeriodMs`) | 60 000 ms |
| HTTP クライアントのヘッダ待ち (`HTTPClient.timeoutMs`) | 30 000 ms |
| HTTP の `keep-alive` アイドル (`idleTimeoutMs`) | 30 000 ms |

## 9. リンク層

### 9.1 IChannel の契約

| メソッド/イベント | 契約 |
| :--- | :--- |
| `start()` | シグナリングの受信を開始する。完了後に解決。 |
| `connect(targetId)` | `targetId` とのデータチャネルを確立する。タイムアウトで reject。 |
| `send(targetId, data)` | 確立済みチャネルに 1 メッセージを送る。未確立なら reject。 |
| `disconnect(targetId)` | チャネルを閉じ、`connection-status(false)` を発火する。 |
| `close()` | 全チャネルを閉じる。 |
| `connectedPeers` | `NodeId -> boolean` の読み取り専用マップ。 |
| `data` イベント | 受信メッセージを `Uint8Array` で通知する。境界は保存される。 |
| `connection-status` イベント | 接続状態の変化を通知する。 |

`send` に渡すデータは 1 パケット分のシリアライズ済みバイト列である。`IChannel` は順序・再送・多重化の責務を持たない。

### 9.2 シグナリングメッセージ

```ts
interface SignalMessage {
  type: 'offer' | 'answer' | 'candidate' | 'public-key';
  content: unknown;      // RTCSessionDescriptionInit / RTCIceCandidateInit / PublicKeyPayload
  fromId: NodeId;
}
```

- `fromId` は送信側が設定し、アダプタは内容を改変してはならない (MUST NOT)。
- 候補（candidate）は remote description 設定前に到着する可能性があるため、受信側はキューに保持し、設定後にまとめて追加しなければならない (MUST)。

### 9.2.1 公開鍵の交換（`public-key`、プロトコル v2）

```ts
interface PublicKeyPayload {
  type: 'public-key';
  publicKey: string;   // 32 バイトの Ed25519 公開鍵（Base64url、パディングなし）
  nodeId?: NodeId;     // 送信側の NodeId（= 公開鍵の指紋）。省略時は fromId を使う
}
```

- DataChannel が開いた時点で、**双方が** `public-key` メッセージを相手へ送る (SHOULD)。
  これにより、`RT_UPDATE` の到着を待たずに初回パケットを検証できる。
- 受信側は `fromId` が公開鍵の指紋と一致することを確認しなければならない (MUST)。不一致は破棄。
- `nodeId` が付与されていて `fromId` と異なる場合も破棄する (MUST)。
- 公開鍵は公開情報であるため、シグナリングハブ（平文 HTTP）経由でも機密性の問題はない。
  ただし**指紋照合を必ず行う**ことにより、ハブが鍵をすり替えてもなりすましは成立しない。
- 同じノードから異なる公開鍵が届いた場合、既に登録済みの鍵を優先して保持する (MUST)。

### 9.3 ネゴシエーション・同時接続（Glare）・ICE 再起動

1. 接続を開始する側は `RTCPeerConnection` とデータチャネル（`ordered: true`）を作り、offer を送る。
2. 受信側は answer を返し、`ondatachannel` でチャネルを受け取る。
3. 双方は ICE candidate を逐次交換する。
4. データチャネルが `open` になった時点で `connection-status(true)` を発火する。
5. **同時接続（Glare）の解決**: 双方が同時に未確立の offer を送り合った場合、`localNodeId < remoteNodeId` を満たす側を **polite ピア**、他方を **impolite ピア** とする。impolite ピアは受信 offer を無視して自身の offer を維持し、polite ピアは自身の待機中 `connect()` Promise を引き継いだまま受信 offer へ応答する。
6. **インプレース再ネゴシエーション（ICE 再起動）**: 確立済みピアに対して新たな `offer` を受信した場合、既存のデータチャネルを破棄せず同じ `RTCPeerConnection` 上で `setRemoteDescription` → `createAnswer` を実行して ICE 経路を復旧する。

データチャネルのラベルは既定 `webtcp`。プロトコルは既定 `''`（SCTP に任せる）。

### 9.4 SignalingAdapterHub の HTTP 契約

`SignalingAdapterHub` は次の HTTP エンドポイントを利用する。

| メソッド | パス | リクエスト | レスポンス |
| :--- | :--- | :--- | :--- |
| POST | `/signal` | `{ "toId": NodeId, "fromId": NodeId, "message": SignalMessage }` | 202/204 |
| GET | `/messages?nodeId=<id>&after=<cursor>` | — | `{ "messages": [{ "id": number, "fromId": NodeId, "message": SignalMessage }] }` |

- クライアントは既定 1000 ms 間隔でポーリングする。
- `cursor` は最後に受信したメッセージの `id`。初回は 0。
- サーバーは配信済みメッセージを削除してよい (MAY)。未配信メッセージは 60 秒で失効することを推奨する。
- `sendMessage` は 2xx 以外で reject する。

### 9.5 EntranceSearcherAdapterHub と自動ブートストラップ

| メソッド | パス | レスポンス |
| :--- | :--- | :--- |
| GET | `/entrances?exclude=<NodeId>` | `{ "nodes": [NodeId, ...] }` |

- `exclude` は省略可能で、自分自身を候補から除くために使う。`EntranceSearcherAdapterHub` の `exclude` オプションで指定できる。
- サーバーは直近 60 秒以内にポーリングしたノードを返すことを推奨する。
- `WebTCPNetwork.bootstrap(searcher, options)` は `searcher.search()` から得た候補（自身と既接続ノードを除く）へ順に接続を試み、目標接続数（既定 1）に達するまで指数バックオフ付きでリトライする。

### 9.6 TURN / ICE 設定と NAT 越え

- `WebRTCChannelOptions.iceServers` は既定 `[]`（同一ホスト・同一 LAN 向け）。
- インターネット越し（NAT 越え）の通信では、STUN サーバー（例: `stun:stun.l.google.com:19302`）および対称型 NAT / ファイアウォール越えのための TURN サーバーを `iceServers` に設定する。
- **TURN 資格情報の動的取得フック**: `iceServersProvider?: () => RTCIceServer[] | Promise<RTCIceServer[]>` を指定すると、`RTCPeerConnection` 生成時および ICE 再起動時に都度呼ばれ、短期有効期限の TURN 資格情報（RFC 8489 / TURN REST API 相当）を安全に注入できる。
- **ICE 再起動**: `iceConnectionState` が `'failed'` に遷移したとき、または `'disconnected'` が `iceRestartDelayMs`（既定 3000 ms）継続したとき、`maxIceRestarts`（既定 2 回）を上限として自動的に ICE 再起動（`createOffer({ iceRestart: true })`）を試行する。`iceServersProvider` が設定されている場合は `setConfiguration({ iceServers })` で資格情報も再取得する。上限を超えた失敗時はピアを破棄し `connection-status(false)` を発火する。

## 10. セキュリティ（プロトコル v2 / Ed25519）

本章は M3（#28）で導入したセキュリティモデルを定義する。

### 10.1 脅威モデルと保証する範囲

| 脅威 | 対策 | 保証 |
| :--- | :--- | :--- |
| **なりすまし**（他人の NodeId を名乗る） | NodeId = 公開鍵指紋。`senderId` と署名検証鍵の指紋が一致しなければ破棄 | ✅ 防止 |
| **改ざん**（ヘッダー・ペイロードの書き換え） | 署名対象は署名フィールドを除くシリアライズ済みパケット全体 | ✅ 検知 |
| **偽造パケットの注入** | 隣接ノードは正規の Ed25519 署名なしにパケットを通せない | ✅ 防止 |
| **リプレイ** | トランスポートのシーケンス空間 + 再送キューで重複を排除（§10.6） | ⚠️ 部分的 |
| **盗聴** | WebRTC の DTLS（DataChannel）によるトランスポート暗号化 | ⚠️ ホップ間のみ |
| **中継ノードによる内容閲覧** | 中継ノードは署名検証はできるが、ペイロードは DTLS 終端で復号される | ❌ 未対応（E2E 暗号化は非目標） |
| **鍵の漏洩** | ブラウザは非抽出 CryptoKey（IndexedDB）、Node.js は PKCS#8 を利用者が保護 | ⚠️ 実装依存 |
| **DoS（署名計算の浪費）** | デシリアライズ段階で長さ・バージョン・`signatureLen` を検証してから署名検証に入る | ⚠️ 部分的 |
| **ドメイン名の乗っ取り**（他人の `domain.global` 名を自分が所有すると騙る） | 所有者の Ed25519 署名 + 指紋照合 + 台帳チェックポイント検証（§13.2 / §13.3）。検証器は既定で fail-closed | ✅ 検証可能な範囲で防止（実チェーン未検証の限界は §13.7） |
| **名前解決の偽応答**（NameServer へのうそ） | `.domain.global` は所有権レコード必須、それ以外のローカル名は信頼モデルのまま（§12.1 / §13.5） | ⚠️ ゾーン内のみ |

**保証しないもの**:

- アプリケーション層のペイロード機密性（DTLS 終端より上では平文。E2E 暗号化は M5 以降の課題）。
- 公開鍵の真正性そのもの（初回接触時の中間者。指紋の帯域外確認は利用者の責任）。
- ノードの可用性・レート制限。

### 10.2 署名の検証手順

受信側（`RoutingLayer.handleIncomingPacket`）は次の順で検証し、
いずれかに違反したパケットを**破棄しなければならない** (MUST)。

1. `packet.version == 2`（または署名が付与されている）ことを確認する。
2. `senderId` が `^[0-9a-f]{32}$` に一致することを確認する。
3. `signature` の長さが **64 バイト**であることを確認する。
4. `senderId` に対応する Ed25519 公開鍵を解決する（§10.4）。
   - 解決できない場合、既定では最大 **5 秒**（`keyWaitTimeoutMs`）まで鍵の到着を待つ。
   - それでも得られない場合は破棄する。
5. 公開鍵の指紋が `senderId` と一致することを確認する（§5.1）。不一致は破棄。
6. 署名対象バイト列（§10.3）に対して `Ed25519.verify(publicKey, signatureInput, signature)` を実行する。
   `false` なら破棄。

`version == 1`（署名なし）パケットは次のように扱う。

- `RoutingLayer` の `requiredSignatures`（`WebTCPNetwork` では `requireSignatures`）が
  **`false`（後方互換モード）** の場合のみ受理する。既定は次のとおり。
  - `keyManager` または `Ed25519PacketVerifier` を注入した場合: **`true`（署名必須）**
  - `NullPacketVerifier`（レガシー）の場合: **`false`**
- `true` のとき、v1 パケットは破棄する (MUST)。

### 10.3 署名対象（正規化）

署名対象は **「署名フィールドを除いた、シリアライズ済みパケット」** である。

```
signatureInput = magic | version | ttl(0 固定) | flags | sourcePort | destinationPort
               | seqNum | ackNum | senderIdLen | destIdLen | signatureLen(0 固定)
               | senderId | destinationId | payload
```

- `signatureLen` フィールドは **0** として書き込む（署名バイト列そのものは含めない）。
- **`ttl` は 0 に正規化する**。TTL は中継のたびに減算されるため、そのまま署名対象にすると
  中継ノードが再署名する必要が生じる。TTL 0 固定とすることで、
  「送信元が 1 度だけ署名し、以降は誰も再署名しない」モデルを実現する (MUST)。
- `version` は送信時のバージョン（v2 = `2`）を含める。
- 実装は `BinaryPacketSerializer.serializeForSigning(packet)`（送信側）と
  `signatureInputFromBytes(rawBytes)`（受信側、署名フィールドを除去）で提供する。
- 受信側は `signatureInputFromBytes()` の結果の TTL バイト（オフセット 2）を **0 に上書き**してから検証しなければならない (MUST)。送信側は署名前に TTL を 0 にして `serializeForSigning()` を呼ぶ。この正規化後、両経路は同一の結果を返さなければならない (MUST)。
- **署名対象を導出するシリアライザは、実際の送信に使うシリアライザと同一でなければならない (MUST)**。
  `WebTCPNetwork` は `serializer` を注入された場合、自動生成する `Ed25519PacketVerifier` へ同じインスタンスを渡す。
  `IPacketSerializer` が `serializeForSigning()` を実装しない場合、`Ed25519PacketVerifier` は**構築時に失敗しなければならない (MUST)**。
  署名対象を別経路で黙って近似生成してよいことにはならない（v1 ヘッダーで導出した署名対象は v2 の検証と一致しない）。

### 10.4 公開鍵の配布

採用方式は **「シグナリング時の交換」+「`RT_UPDATE` への同梱」** の併用である。
いずれの経路でも、受信側は **指紋一致（`nodeId == deriveNodeId(publicKey)`）を必ず検証** するため、
配布経路が信頼できなくてもなりすましは成立しない。

#### 10.4.1 シグナリング時の交換

DataChannel が開いた時点で双方が `public-key` メッセージ（§9.2.1）を交換する。
直接の隣接ノードとは、これにより `RT_UPDATE` を待たずに署名検証を開始できる。

#### 10.4.2 `RT_UPDATE` への同梱

`RT_UPDATE` のペイロード JSON に `publicKey`（Base64url）を含める。
`RT_UPDATE` 自体も署名されるため、受信側は「同梱された公開鍵で署名を検証し、
その公開鍵の指紋が `senderId` と一致すること」を確認できる（自己証明）。
また `entries[].publicKey` により、隣接が学習済みのリモートノードの公開鍵も経路情報と一緒に伝播する。受信側は各鍵の指紋一致を検証する。

#### 10.4.3 公開鍵ディレクトリと解決順序

`KeyDirectory`（`IPublicKeyResolver`）が `NodeId -> 公開鍵` を保持する。解決順序は次のとおり。

1. ディレクトリに登録済みの鍵（シグナリング交換・`RT_UPDATE`・手動登録・既学習キャッシュ）
2. 受信パケットに同梱された鍵（`RT_UPDATE` の `publicKey`）— 指紋一致が条件
3. 最大 `keyWaitTimeoutMs`（既定 5000 ms）待機して再試行

`IPublicKeyResolver` を実装すれば、IPFS 等の**分散ストレージ**から鍵を引く方式に差し替えられる
（M5 以降の課題。M4 では同梱インターフェースのみ提供）。

#### 10.4.4 鍵の衝突・すり替え

- 既に登録済みの NodeId に対して **異なる鍵** が提示された場合、既存の鍵を保持し、新しい鍵は破棄する (MUST)。
- 同一鍵の再提示は冪等に受理する (MAY)。

### 10.5 鍵管理（KeyManager）

| 実装 | 環境 | 秘密鍵の保存 | 署名・検証のプリミティブ |
| :--- | :--- | :--- | :--- |
| `BrowserKeyManager` | ブラウザ | **IndexedDB** に **非抽出 CryptoKey**（`extractable: false`）。公開鍵・NodeId は同一レコードに保存。復元時に指紋と署名チャレンジを検証 | Web Crypto API（`crypto.subtle`、Ed25519） |
| `NodeKeyManager` | Node.js | `create()` はメモリ。`open({ keyFile })` は PKCS#8 PEM を `0600` で永続化・再利用 | `node:crypto`（`generateKeyPairSync` / `webcrypto.subtle`） |

要件:

- 秘密鍵は**生バイトとしてエクスポートできない**ことが望ましい (SHOULD)。ブラウザ実装は `extractable: false` を既定とする。
- 署名（`sign`）・検証（`verify`）・指紋導出（`deriveNodeId`）を提供しなければならない (MUST)。
- `isBrowserEd25519Supported()` は同期の簡易プローブであり、アルゴリズム対応を保証しない。実際の可否は `BrowserKeyManager.open()` の成否で判定する。
- 全実装で `deriveNodeId` は同一結果を返さなければならない (MUST)。
- 利用可能な Ed25519 実装: Chrome 137+ / Firefox 129+ / Safari 17+ / Node.js 22+。
  非対応環境では v1（`NullPacketVerifier`）へフォールバックする。

### 10.6 リプレイ対策

- 仮想ストリーム内の `DATA` / `SYN` / `FIN` は**バイト単位のシーケンス空間**で重複排除される（§8.3）。
  既に受信済みの範囲は破棄され、アプリケーションへ二重に渡らない。
- `ackNum` は累積確認応答であるため、古い `ackNum` を持つリプレイは送信状態を巻き戻さない
  （`SND.UNA` より古い ACK は無視される）。
- `RT_UPDATE` は直接隣接からのみ受理し、距離ベクトルのコスト比較で経路を更新する。
  撤回（`withdrawals`）は現行のネクストホップが一致する場合に限り適用される。
  ただし署名付き `RT_UPDATE` のリプレイによる撤回・経路変動を完全に防ぐものではない。
- **限界**: 署名付きパケットそのものは有効期限を持たないため、リンク層の外で記録・再送された
  パケットを「新規」と誤認する余地がある。セッション Nonce とタイムスタンプによる明示的な
  再生検知は M5 以降の強化課題とする（`plan.md` §4.1）。

### 10.7 既知の制約

- アプリケーションデータの **E2E 暗号化は行わない**（WebRTC の DTLS によるホップ間暗号化のみ）。
- **鍵のローテーション**は NodeId の変更を意味する。同一ノード ID のままの鍵更新は未定義。
- 初回接触時の中間者（TOFU: Trust On First Use）。指紋の帯域外確認は未実装。
- 検証失敗パケットのレート制限・ブロックリストは未実装。

## 11. エラー・ログ・既定値

### 11.1 ログ

コアおよびアダプタは `console.*` を直接呼び出さず、`Logger` インターフェース（`debug` / `info` / `warn` / `error`）経由で出力しなければならない (MUST)。

- 既定ロガーは `ConsoleLogger`（レベル `warn` 以上）。
- `WebTCPNetwork` / `createBrowserNetwork` / 各アダプタのオプションでカスタム `logger` または `logLevel`（`'debug' | 'info' | 'warn' | 'error' | 'silent'`）を注入できる。

### 11.2 エラー挙動

| 状況 | 挙動 |
| :--- | :--- |
| 不正なパケット | 破棄し、`warn` ログ。例外を上位へ伝播させない。 |
| 署名検証失敗（v2） | 破棄し、`warn` ログ（`Dropping <FLAGS> from <senderId>: invalid signature`）。 |
| 署名欠落（`requireSignatures: true`） | 破棄し、`warn` ログ（`... : signature required (protocol v2)`）。 |
| 公開鍵が解決できない（v2） | `keyWaitTimeoutMs` まで待機し、解決できなければ `invalid signature` として破棄。 |
| 署名検証中の例外 | 破棄し、`warn` ログ（`... : signature verification threw: <message>`）。例外は上位へ伝播させない。 |
| 署名付与の失敗（送信時） | `warn` ログ（`Failed to sign <FLAGS> packet; sending unsigned.`）のうえ、v1 パケットとして送信（縮退動作）。 |
| 宛先不明 | 破棄し、`warn` ログ。 |
| 未リッスンポートへの SYN | RST を返す。 |
| 接続タイムアウト | `connect()` を reject。ストリームを破棄。 |
| 再送上限超過 | `error` イベント発火後 `CLOSED`。 |
| ストリーム `send()` が送信不可状態 | `Cannot send data. State is ...` で reject。 |
| 送信バッファ超過 | `Send buffer full` で reject。 |
| 名前解決の全体デッドライン超過 | `NameResolutionTimeoutError` で reject。**問い合わせ先が `connect()` 宙吊りでもデッドラインと `AbortSignal` を守る**（§12.2、#40）。 |
| 名前解決の明示的中断 | `WebTCP name resolution aborted` で reject（デッドライン到達とは区別する）。 |
| ドメイン所有権レコードの検証失敗 | `DomainOwnershipError`（`code` で理由を判別。§13.4）。解決は失敗し、結果はキャッシュしない。 |
| `domain.global` 名の不正なローカル登録 | `registerA` / `registerCNAME` が `throw`（§13.5）。 |
| 同一シリアルで内容の異なるレコードが並存 | `DomainOwnershipError(code: 'conflict')`。勝者を決めずに失敗する（fail-closed）。 |
| HTTP メッセージの不正（行長・ヘッダ・フレーミング） | §15.8 の表に従い `400` / `413` / `414` / `431` を返して接続を閉じる。 |
| HTTP クライアントのタイムアウト・切断・上限超過 | `HTTPTimeoutError` / `HTTPConnectionClosedError` / `HTTPResponseTooLargeError` で reject（§15.8）。 |

### 11.3 既定値

| パラメータ | 値 |
| :--- | :--- |
| TTL | 64 |
| 最大パケットペイロード | 60 KiB（61 440 B） |
| MSS（セグメントサイズ） | 16 KiB（16 384 B） |
| 初期輻輳ウィンドウ (`initialCwndBytes`) | 4 × MSS（64 KiB） |
| 最大ウィンドウ (`maxWindowBytes`) | 1 MiB |
| 送信バッファ上限 (`maxSendBufferBytes`) | 4 MiB |
| 初期 / 最小 / 最大 RTO | 1 000 ms / 200 ms / 60 000 ms |
| 再送上限 | 5 |
| `TIME_WAIT` | 200 ms |
| `allowHalfOpen` | `true` |
| トランスポート接続タイムアウト | 10 s |
| WebRTC 接続タイムアウト | 15 s |
| WebRTC 最大メッセージ長 (`maxMessageBytes`) | 65 536 B |
| ICE 再起動上限 / 猶予時間 | 2 回 / 3 000 ms |
| シグナリングポーリング | 1 s |
| RT_UPDATE 間隔 / 経路寿命 | 30 s / 60 s |
| 既定ログレベル | `warn` |
| プロトコルバージョン（署名あり / なし） | v2 / v1 |
| Ed25519 署名長 | 64 B |
| NodeId バイト長 | 16 B（`SHA-256` の先頭 16 バイト） |
| 公開鍵長 | 32 B |
| 公開鍵待機タイムアウト (`keyWaitTimeoutMs`) | 5 000 ms |
| NameServer 仮想ポート | 5300 |
| 名前レコード既定 TTL / 最大 TTL | 60 s / 86 400 s |
| 名前問い合わせタイムアウト / 解決全体タイムアウト | 2 s / 5 s |
| CNAME 最大連鎖 / キャッシュ最大件数 | 8 / 1024 |
| 問い合わせ既知ノード上限 / 並列数 | 16 / 4 |
| 署名必須化 (`requireSignatures`) | 鍵管理または `Ed25519PacketVerifier` 指定時 `true` |
| ゾーン | `domain.global`（唯一） |
| レコード形式バージョン | 1 |
| レコード最大寿命 | 365 日（`expiresAt - issuedAt`） |
| 時刻ずれ猶予 (`clockSkewMs`) | 300 000 ms |
| 台帳の木サイズ上限 / 1 名あたり保持レコード | 65 536 / 8 |
| 検証済みレコードキャッシュ TTL / 失敗キャッシュ TTL | 60 s / 5 s |
| ドメイン解決の全体タイムアウト (`DomainAuthority.resolveTimeoutMs`) | 5 000 ms |
| ドメイン収集元 1 件あたりの問い合わせタイムアウト (`DomainAuthority.queryTimeoutMs`) | 1 500 ms |
| HTTP トンネルの同時接続待ち上限 (`HTTPServer.maxConnections`) | 64 |
| HTTP ヘッダ数の上限 / ヘッダ行長の上限 / リクエストライン長の上限 | 100 / 8 KiB / 8 KiB |
| HTTP 応答本文のバッファ上限（非ストリーミング時、`HTTPClient`） | 8 MiB |
| HTTP の `keep-alive` アイドルタイムアウト | 30 000 ms |

## 12. 名前解決と WebTCP URL（M4 / #25）

### 12.1 名前とレコード

- 名前は ASCII の LDH ラベル（英数字とハイフン）をドットで区切る。各ラベル 1–63 文字、全体 253 文字以下。ラベルの先頭/末尾ハイフンは禁止。大文字は小文字へ正規化し、末尾のルートドットは除去する。
- 32 文字小文字 hex の名前は NodeId リテラルとして予約し、名前登録には使えない。
- **`domain.global` を末尾に持つ名前はゾーン予約語であり、`registerA()` / `registerCNAME()` では登録できない（MUST NOT）**。その名の解決は §13 の所有権レコードを通じて行う。CNAME の**到達先**がゾーン内に入ることは許すが、その場合は最終解決時に所有権検証が必須となる (MUST)。
- A レコード相当: `name -> NodeId`。CNAME レコード相当: `name -> canonical name`。
- レコードは TTL（ミリ秒）を持つ。既定 60 000 ms、最大 86 400 000 ms。ローカル登録は明示的に削除・更新するまで有効。リモート応答と解決結果は TTL 経過までキャッシュする。
- ローカル登録が常に優先する。リモート応答は「応答ノードがその名前をこう登録している」という情報であり、**グローバルな所有権証明ではない**。同一名前に複数の異なる応答がある場合は最初に受理した結果を TTL までキャッシュする。ゾーン内名前は例外（§13.5）。

### 12.2 NameServer

`NameServer` はアプリケーション層サービスであり、新しい L3/L4 フラグやワイヤーバージョンを追加しない。既存の `VirtualStream` 上で UTF-8 JSON の要求/応答を 1 ストリームにつき 1 往復交換する。既定ポートは **5300**（仮想ポート。利用者が必要なら変更可能）。

API:

```ts
const ns = new NameServer(network, {
  port?, defaultTtlMs?, queryTimeoutMs?, resolveTimeoutMs?, maxCnameDepth?, maxCacheEntries?,
  maxQueriedNodes?, queryConcurrency?, resolvers?, domains?, logger?,
})
ns.registerA(name, nodeId, ttlMs?): void
ns.registerCNAME(name, target, ttlMs?): void
ns.unregister(name): boolean
await ns.registerDomain(record, options?): Promise<DomainResolution>   // M5 / §13.5
ns.unregisterDomain(domain): boolean
ns.servedDomainRecords(): DomainOwnershipRecord[]
ns.listen(): void
ns.close(): void
await ns.resolve(name, { signal?, timeoutMs? }): Promise<NameResolution>
```

- `listen()` は `network` の仮想ポートを待ち受け、`close()` は自身が登録したハンドラを解除する。ネットワーク自体は閉じない。
- 解決順序は (1) ローカル登録、(2) 有効なキャッシュ、(3) 既知ノードへの問い合わせ。CNAME は最大 8 段まで辿り、訪問済み名前への再訪はループとして拒否する。
- 既知ノードは明示 `resolvers`、直接隣接、経路表の宛先から重複を除いて作る。自身は除外し、最大 16 ノードへ最大 4 並列で問い合わせる。問い合わせは `network.connect()` を用いるため、マルチホップ経路と v2 署名検証を利用する。
- サーバーは自分のローカル登録のみを権威データとして返す。再帰問い合わせはしない。クライアントが CNAME 連鎖を反復解決するため、ノード間の問い合わせループを作らない。
- 要求/応答は最大 16 KiB。応答は要求 ID と名前が一致しなければならない。不正・タイムアウト応答は無視する。
- **デッドラインと中断は絶対である (MUST)**。`resolveTimeoutMs`（既定 5 000 ms）と `AbortSignal` は、問い合わせ先列挙・`network.connect()` の宙吊り・応答待機の**いずれの局面でも**守られなければならない（#40）。単一ノードの停滞が `resolve()` 全体を遅らせてはならない (MUST NOT)。デッドライン到達は `NameResolutionTimeoutError`、呼び出し側の明示中断は区別可能なエラーで reject する。
- キャッシュは最大 1024 件で、期限切れ掃除後に最古エントリから退避する。検証に失敗したドメイン解決結果はキャッシュしてはならない (MUST NOT)（失敗は §13.5 の短 TTL 失敗キャッシュのみ）。
- `domains`（`DomainAuthority`、§13.5）を渡した場合、ゾーン内名前の解決と応答は権威へ移譲される。渡さない場合、ゾーン内名前の解決は `DomainResolutionUnavailableError` で失敗する (MUST)。
- 名前解決の結果は `NameResolution`（`name` / `nodeId` / `ttlMs` / `source` / `chain` / 任意の `record`・`proof`）である。`source` は `'local' | 'cache' | 'remote' | 'domain'`。

問い合わせプロトコル（JSON）:

```json
{ "protocol": 1, "type": "query", "id": "<ランダムhex>", "name": "my-service" }
```

```json
{ "protocol": 1, "type": "answer", "id": "<要求と同じ>", "name": "my-service", "record": { "type": "A", "name": "my-service", "target": "<NodeId>", "ttlMs": 60000 } }
```

不在時は `{"protocol":1,"type":"error","id":"…","name":"…","code":"NXDOMAIN"}`。不正要求は `INVALID`。`record.type` は `A` または `CNAME`。クライアントは要求を送って `end()` し、サーバーは EOF 後に応答して `end()` する（Half-Close）。

**所有権拡張（M5 / #25、`protocol` は 1 のまま）**。要求は `wantOwnership: true` を運べる (MAY)。ゾーン内名前への応答は `record` に加えて `ownership`（§13.2 の正規形式の配列）を 1 件以上添えなければならない (MUST)。受信側は未知のフィールドを無視してよい (MAY) ため、旧実装が返す素の `A` 応答もデコードできる。ただし**所有権レコードを伴わないゾーン内名前の応答は解決に使用してはならない** (MUST NOT)。

```json
{ "protocol": 1, "type": "answer", "id": "…", "name": "shop.domain.global",
  "record": { "type": "A", "name": "shop.domain.global", "target": "<NodeId>", "ttlMs": 60000 },
  "ownership": [ { "version": 1, "body": { "…": "…" }, "signature": "…", "anchor": { "…": "…" } } ] }
```

### 12.3 `webtcp://` URL

形式:

```
webtcp://<host>:<port><path>?<query>#<fragment>
```

- `host` は NodeId（32 文字小文字 hex）または §12.1 の名前。ホストの大文字は小文字へ正規化する。
- `port` は必須。1–65535 の整数。既定ポートは無い。
- `path` は省略時 `/`。`fragment` は保持するが、接続自体には送信しない（クライアント側の断片であり、リクエストへは含めない）。
- `query` は保持し、`HTTPClient` が `path` と連結してリクエストラインへ写す（§15.6）。**生の `VirtualStream` 接続（`connectURL()`）では従来どおりバイト列を送らない** — HTTP セマンティクスは「HTTP 層を使うかどうか」で決まり、L4 接続はトランスポートのままである。
- userinfo、IPv6 アドレス、ホスト内のパーセントエンコード、空白・制御文字、バックスラッシュ、空ホスト、不正ポートは拒否する。
- `parseWebTCPUrl()` は `WebTCPUrl`（`host`, `nodeId?`, `name?`, `zone?`, `port`, `path`, `search`, `hash`）を返す。`formatWebTCPUrl()` は正規形を返す。
- `host` が §13.1 のゾーン内名前である場合、`name` は正規化済みの完全名、`zone` はゾーン名（`domain.global`）になる。ゾーン外の名前は `zone` を持たない。URL 構文はゾーン内外で共通であり、`zone` は判定結果の提示であって新しい文法を導入しない (§13.1)。
- `network.connectURL(url, { nameServer?, localPort?, signal? })` は NodeId 指定なら直接接続し、名前指定なら `nameServer.resolve()` 経由で NodeId を得て接続する。名前指定で NameServer が無ければ reject する。戻り値は `VirtualStream`。パス等はアプリケーションが `parseWebTCPUrl()` の結果から利用する。
- **HTTP で接続する場合は `network.fetchURL(url, { nameServer })` を使う**（M6 / §15.6）。これは `connectURL()` と `HTTPClient` を組み合わせた薄いヘルパーで、`path` / `query` をリクエストラインへ写して 1 往復（または `keep-alive` セッション）を実行する。
- `webtcp://` はブラウザのナビゲーション可能スキームではない。ライブラリ API としてパース・接続する。

### 12.4 セキュリティ境界

- NameServer の応答は仮想ストリーム下層の v2 署名で保護されるが、名前解決自体にグローバルな所有権証明は無い。ローカル登録は利用者設定を信頼する。
- `domain.global` への登録、ブロックチェーンによる所有権証明、グローバルな名前衝突解決は **M5** の対象（`plan.md`）。
- 名前問い合わせは増幅を避けるため問い合わせ先数・並列数・メッセージサイズ・CNAME 深度・キャッシュ件数を制限する。

## 13. `domain.global` とドメイン所有権証明（M5 / #25）

本章は「名前でサービスを発見する」最終段階として、**グローバルに一意なドメイン名と、その所有権の検証可能性**を定義する。設計方針は 2 つである。

1. **ブラウザにブロックチェーンのフルクライアントを載せない。** 所有権の証明は「誰もが発行できる自己署名クレーム」+「検証可能な追記型台帳の包含証明」として定義し、実チェーンとの接続は**プラガブルな検証インターフェース**（`IChainAnchorVerifier`）に委ねる。
2. **既定で fail-closed。** レコード形式・署名・指紋・有効期間・台帳アンカーのうち 1 つでも検証できない場合、解決は失敗する。「検証できなかったが許容する」モードは利用者が明示的に選択する。

### 13.1 ゾーンと名前規則

- ゾーンは **`domain.global`** の 1 つだけとする (MUST)。将来の追加ゾーンは本書の対象外（§17）。
- 完全名は `<label>(.<label>)*.domain.global`。ラベルは §12.1 と同じ ASCII LDH（1–63 文字、先頭/末尾ハイフン不可）。ゾーン名を含む全体で 253 文字以下。
- 正規化は小文字化と末尾ルートドットの除去のみ。IDNA / Punycode・homoglyph 対策は**未実装**（`plan.md` §4.3、#43）。
- `isDomainGlobalName(name)` がゾーン内名前を判定する。ゾーン内名前は §12.1 のとおりローカル登録 reserved。

### 13.2 所有権レコード（`DomainOwnershipRecord`）

レコードは「ドメイン名 ↔ NodeId」の対応を、その NodeId を生む公開鍵の所有者が署名した**自己証明型クレーム**である。

```ts
interface DomainRecordBody {
  version: 1;
  domain: string;          // 正規化済み完全名（.domain.global を含む）
  nodeId: NodeId;          // 所有者の NodeId（= ownerPublicKey の指紋）
  ownerPublicKey: string;  // 32 バイト Ed25519 公開鍵（Base64url、パディングなし）
  serial: number;          // 1 以上、ドメインごとに単調増加（書換えの順序付け）
  issuedAt: number;        // epoch ms
  expiresAt: number;       // epoch ms。issuedAt < expiresAt かつ寿命は上限以下
  revoked?: false | true;  // 省略 = false。true で自発的失効（焼却）
  port?: VirtualPort;      // 推奨サービスポート。ヒントであり connectURL() は必須ポートを要求する
  txt?: string;            // 1 行の自由記述（255 文字以下）
}
interface DomainOwnershipRecord {
  version: 1;
  body: DomainRecordBody;
  signature: string;       // canonicalDomainRecordBodyBytes(body) に対する Ed25519 署名（Base64url、64 B）
  anchor?: DomainAnchor;   // §13.3 の台帳アンカー
}
```

- **canonical バイト列**: `body` を固定キー順（`version, domain, nodeId, ownerPublicKey, serial, issuedAt, expiresAt, revoked, port, txt`）で空白なし JSON にし、UTF-8 エンコードしたもの。未定義キーは拒否する (MUST)。`revoked` は常に書き出す（`false` でも省略しない）。`port` / `txt` は存在時のみ書く。
- 署名対象は canonical バイト列そのもの。**ハッシュ前処理は行わない**（Ed25519 が内部でハッシュするため）。
- `commitment = hex(SHA-256(canonical バイト列))` を台帳の葉として使う（§13.3）。
- 検証側は必ず**受信 JSON を canonical 形式へ再正規化してから**署名を検証しなければならない (MUST)。生バイト列に対する検証は、未知キー混入の余地を残すため禁止 (MUST NOT)。
- 生成: `createDomainOwnershipRecord({ domain, keyManager, serial, lifetimeMs?, port?, txt?, revoked? })`。`keyManager.nodeId` と `domain` の妥当性を検証する。
- 解析: `parseDomainOwnershipRecord(value)` は厳格検証（未知キー・型・長さ・Base64url・指紋）を行い、失敗時 `DomainRecordError` を投げる。ネットワーク経由の JSON は必ずこの関数を通す (MUST)。

### 13.3 台帳アンカー（`DomainAnchor`）とチェックポイント連鎖

台帳（registry / transparency log）は受領したレコードの `commitment` を**追記専用の Merkle 木**へ積上げ、木サイズ・ルート・時刻を**ログ鍵で署名**したチェックポイントを発行する。

```ts
interface DomainAnchor {
  leafIndex: number;              // 0 起始の葉番号
  proof: string[];                // 包含証明（兄弟ノードの Base64url SHA-256、葉から根へ）
  checkpoint: SignedDomainCheckpoint;
  chain?: {                        // 実チェーンへの追加コミットメント（任意、§13.4.2）
    network: string;               // 例 "namecoin"、"ethereum:11155111"
    txId?: string;
    blockHeight?: number;
    commitment?: string;           // チェックポイントハッシュ等のオンチェーン値
  };
}
interface DomainCheckpoint {
  logId: string;                   // 既定はログ鍵の NodeId（公開鍵指紋）
  treeSize: number;                // 葉数（1 以上）
  root: string;                    // Base64url SHA-256 ルート
  prevHash: string;                // 直前チェックポイントの canonical バイト列の SHA-256（ genesis は 32 バイトの 0）
  timestamp: number;               // epoch ms
}
interface SignedDomainCheckpoint extends DomainCheckpoint { signature: string }
```

- **葉ハッシュ** `H(0x00 || commitmentBytes)`、**内部ノード** `H(0x01 || left || right)`。接頭辞による領域分離を必須とする (MUST)（第二像攻撃の抑止）。ノード数が奇数の場合、末尾ノードは自分自身とペアにする（promote 規則）。
- **ルートは木サイズへバインドする**: `root = H(0x02 || uint64BE(treeSize) || top)`。バインドしないと、右端以外の葉に対する包含証明が**別サイズの木**でも成立してしまう（最上位の promote 有無だけが差分になるため）。`verifyDomainMerkleProof()` は各レベルのノード数を `treeSize` から再現し、promote 位置では兄弟が自分自身と一致することも要求する (MUST)。
- 台帳はチェックポイントを**追記のみ**で発行する（`append` と、最初の `buildAnchor()` 以外で新チェックポイントを作ってはならない MUST NOT）。読み出しのたびに再署名すると `prevHash` 連鎖が自己参照で壊れる。
- `verifyDomainMerkleProof({ commitment, leafIndex, treeSize, root, proof })` は `leafIndex < treeSize` と `proof` 長さ `= ceil(log2(treeSize))` を確認する。不一致は失敗 (MUST)。`commitment` は 32 バイトの hex（§13.2）で、葉の原料は hex を raw バイトへ戻したものである。
- `treeSize` は monotonic な履歴としてクライアントへ提示される。クライアントは**前回受理したチェックポイント**を記憶し (SHOULD)、それより小さい `treeSize` を拒否する (MUST)。
- `prevHash` により、チェックポイントは同一ログ内で**履歴を消せない連結**（append-only chain）を作る。`verifyDomainCheckpointChain({ pinned, target, between })` は `pinned` から `target` への連結を、区間のチェックポイントを受信して検証する (MAY)。台帳が区間を提供できない場合、検証は `unavailable` を返し、利用者の設定で拒否または続行を決める。
- チェックポイント署名対象は `canonicalDomainCheckpointBytes(checkpoint)`（固定キー順 `logId, treeSize, root, prevHash, timestamp` の空白なし JSON、UTF-8）。`signature` は含めない。

### 13.4 検証インターフェース

#### 13.4.1 `IDomainOwnershipVerifier`

```ts
interface IDomainOwnershipVerifier {
  verify(record: DomainOwnershipRecord, context?: DomainVerifyContext): Promise<DomainVerifyResult>;
}
interface DomainVerifyContext {
  nowMs?: number;
  expectedDomain?: string;   // 解決中の名前と record.body.domain の一致確認
  knownSerial?: number;      // 既に受理した最大 serial（これ未満のレコードは stale）
  clockSkewMs?: number;
  checkpointChain?: DomainCheckpointSource;   // §13.3 の連結検証に使う
}
interface DomainVerifyResult {
  ok: boolean;
  code: DomainProofCode;     // 'ok' | 'invalid-record' | 'zone-mismatch' | 'fingerprint-mismatch'
                             // | 'bad-signature' | 'expired' | 'not-yet-valid' | 'stale-serial'
                             // | 'revoked' | 'conflict' | 'anchor-missing' | 'anchor-bad-proof'
                             // | 'anchor-untrusted-log' | 'anchor-bad-checkpoint' | 'anchor-rollback'
                             // | 'chain-unverified' | 'resolution-unavailable'
  message?: string;
  anchorVerified?: boolean;
  chainVerified?: boolean | null;   // null = 検証手段なし（未確認）
}
```

既定実装 `createDomainOwnershipVerifier(options)` の検証順序（すべて MUST）:

1. `parseDomainOwnershipRecord()` による構造検証（未知キー拒否を含む）。失敗 → `invalid-record`。
2. `domain` の正規化とゾーン所属。`context.expectedDomain` と不一致 → `zone-mismatch`。
3. `ownerPublicKey`（32 B）から指紋を導出し `body.nodeId` と一致させる。不一致 → `fingerprint-mismatch`。
4. canonical バイト列に対する Ed25519 署名検証。失敗 → `bad-signature`。
5. 有効期間: `issuedAt - clockSkewMs <= now <= expiresAt`、`expiresAt - issuedAt <= maxLifetimeMs`。前者下 → `not-yet-valid`、上 → `expired`、後者超 → `invalid-record`。
6. リプレイ/ロールバック: `context.knownSerial` があれば `body.serial >= knownSerial` を要求し、未満は `stale-serial`。`revoked: true` は `revoked`。
7. アンカー方針: `requireAnchor` 時に `anchor` を要求（欠落は `anchor-missing`）。`anchor` がある場合、ログ鍵（`logKeys[logId]`）が既知でなければ `anchor-untrusted-log`、包含証明・チェックポイント署名・`treeSize` 整合のいずれか失敗で `anchor-bad-proof` / `anchor-bad-checkpoint` / `anchor-rollback` を返す。
8. `anchor.chain` がある場合 `IChainAnchorVerifier` を呼ぶ。未設定なら `chainVerified: null`（`requireChainAnchor: true` なら `chain-unverified`）、設定時は `verified: false` で `chain-unverified`。

- ログ鍵は `logKeys: Record<logId, publicKey>` の静的設定、または `resolveLogKey(logId)` による遅延解決（§10.4 の `KeyDirectory` を再利用できる）。**信任は TOFU に頼らず、設定済みの鍵のみ受け付ける** (MUST)。
- 検証器は例外を投げず、常に `DomainVerifyResult` を返す (MUST)。

#### 13.4.2 `IChainAnchorVerifier`（実チェーンへの差し替え点）

```ts
interface IChainAnchorVerifier {
  readonly name?: string;
  verify(input: { commitment: string; checkpointHash: string; chain: DomainAnchorChainRef }): Promise<{
    verified: boolean; finality?: number; detail?: string;
  }>;
}
```

本仕様は**参照実装を定義しない**（SPV ヘッダー検証、keccak-256 / RLP による EVM 証明、Namecoin の `name_firstupdate` 照会は #42 として切り出す）。実装側は未設定時に `chainVerified: null` を返すことをもって「オフライン検証範囲」と明示する。

#### 13.4.3 衝突解決

同一ドメインに対して**複数の有効レコード**が提示された場合（§13.5 の解決フロー）、勝者は

```
max(serial) で勝つ → 同 serial なら commitment が同一なら同一視、相違あれば conflict（fail-closed）
```

で決める。`anchor` がある場合は「より小さい `leafIndex`（＝先に台帳へ入った）」を決定的なタイブレークとする。人間による裁定・競売・マルチシグ承認は未定義（#43）。

### 13.5 解決フロー（`DomainAuthority`）

```ts
const domains = createDomainAuthority({
  verifier?, verifierOptions?, local?, sources?, peers?, checkpointChain?,
  cacheTtlMs?, negativeTtlMs?, maxCacheEntries?, resolveTimeoutMs?, queryTimeoutMs?,
  maxRecordsPerDomain?, pinCheckpoints?, logger?,
});
await domains.resolve(name, { signal?, timeoutMs?, skipCache?, }): Promise<DomainResolution>
await domains.settle(name, options): Promise<DomainResolution>   // 例外を投げない解決
await domains.settleCandidates(name, records): Promise<DomainResolution>  // 呼び出し側が得た候補だけを検証
await domains.register(record): Promise<DomainResolution>       // 検証 + ローカル保管
await domains.remember(record): Promise<DomainVerifyResult>     // ローカル信託（検証は必ず通す）
domains.forget(name): boolean
domains.close(): void
domains.createPublicKeyResolver(inner?): IPublicKeyResolver     // §10.4.3 への bridge

interface DomainResolution { /* 成功 */ ok: true; domain; nodeId; record; proof; pinnedCheckpoint?; port?; candidates; via }
                            /* 失敗 */ | { ok: false; domain; code: DomainProofCode; message; record?; proof? }
interface IDomainRecordSource {
  readonly name?: string;
  lookupByDomain(domain, context?: { signal?, deadline? }): Promise<DomainOwnershipRecord[] | DomainOwnershipRecord | null>;
  lookupByNodeId?(nodeId): Promise<DomainOwnershipRecord[]>;
}
```

- 収集元（`IDomainRecordSource`）は (1) ローカルストア `local`、(2) 明示 `sources`（HTTP レジストリ等）、(3) 既知ノードへの `wantOwnership` 問い合わせ（§12.2）である。**ストリーム I/O を `core/domain` は知らない** — (3) は `NameServer` が `settleCandidates()` へ候補を渡す形で供給する（`WebTCPNetwork.connect` を使うため、v2 署名検証とマルチホップ経路がそのまま効く）。収集は**並列・全体デッドライン付き**で、1 つの停滞が解決を止めてはならない (MUST NOT)。
- 各候補は §13.4 で検証し、**検証に成功したもののみ** §13.4.3 で勝者を決める。勝者の `body.nodeId` を解決結果とし、`NameResolution.source` は `'domain'`、`record` と `proof` を添える。
- 候補が 0 件のとき権威は `code: 'resolution-unavailable'` を返し、候補はあるが全滅（検証失敗）のときは最後の `code` を返す。`settle()` は例外を投げず `ok: false` を返す。
- `NameServer.resolve()` はこれを**名前不存在と検証失敗へ書き分ける** (MUST): 権威が `resolution-unavailable` を返し、かつ既知ノードの `wantOwnership` 応答にも候補が無かった場合は `NameNotFoundError`（誰もその名を知らない = NXDOMAIN 相当）、候補があったのに検証を通らなかった場合は `DomainOwnershipError`（`code` を伝播 = 裏付けはあるが受理できない）。`DomainResolutionUnavailableError` は権威 API（`resolve()` / `settle()` の例外系）と、権威自体が未設定のゾーン名解決で返る。収集元が 1 つも応答しなかった場合（通信障害）に「解決できた」ことにしてはならない (MUST NOT)。
- `resolve()` / `settle()` は成功を `cacheTtlMs`、失敗を `negativeTtlMs` で cache するため、`NameServer` は 2 段階（権威 → 既知ノード）の照会を 1 回に絞れる。キャッシュを避けたい診断は `skipCache: true` を使う。
- 成功結果は `cacheTtlMs`（既定 60 000 ms）で、失敗は `negativeTtlMs`（既定 5 000 ms、**成功より短くなければならない** MUST）でキャッシュする。キャッシュは `maxCacheEntries`（既定 256）上限。
- `pinCheckpoints: true`（既定 `true`）の場合、受理したチェックポイントをログ単位で記憶し、より古い `treeSize` を持つチェックポイントを `anchor-rollback` で拒否する。
- **ゾーン内名前の解決に `DomainAuthority` が無ければ失敗する**（§12.2）。`NameServer` はゾーン内名の `registerA` / `registerCNAME` を拒否し (MUST)、`registerDomain()` のみ受け付ける。
- `ns.registerDomain(record)` は (1) 検証、(2) ローカル A レコード登録（TTL はレコード残存期間と §12.1 上限の小さいほう）、(3) 応答用のレコード保管 の順で行い、検証に失敗したレコードは登録しない (MUST)。権威が未設定のときは組み込み検証器（`requireAnchor: false`）で自己署名・指紋・有効期間だけを確認する。
- ローカル登録済みのゾーン名を `resolve()` するときも、失効・焼却を見落とさないよう**毎回レコードを再検証**する (MUST)。

### 13.6 参照レジストリの HTTP 契約（オプショナル）

ライブラリ同梱のデモ実装（`examples/server.mjs`）と `HttpDomainRegistryClient` は次の契約を使う。**仕様として必須ではない**（`IDomainRecordSource` を実装すれば任意のバックエンドでよい）。

| メソッド | パス | リクエスト | レスポンス |
| :--- | :--- | :--- | :--- |
| `POST` | `/domain/record` | `{ "record": DomainOwnershipRecord }` | `200 { accepted, leafIndex, treeSize, checkpoint, anchor }` / `409 { accepted:false, error, code }` / `400 { error }` |
| `GET` | `/domain/record?name=<domain>` | — | `{ "records": [ … ] }`（アンカー込み。存在せず 1 件のみなら `200 records: []` ではなく `404` でもよい。クライアントは 404 を「候補 0 件」と解釈する） |
| `GET` | `/domain/record?nodeId=<NodeId>` | — | `{ "records": [ … ] }`（逆引き。鍵配布の bridge が使う） |
| `GET` | `/domain/checkpoint` | — | `{ "checkpoint": … }` |
| `GET` | `/domain/checkpoints?after=<treeSize>&to=<treeSize>` | — | `{ "checkpoints": [ … ] }` |
| `GET` | `/domain/log` | — | `{ "logId", "publicKey" }`（ログ鍵の TOFU ピン留め用） |

- レジストリはレコードの検証（§13.4 の 1〜6）に成功した場合のみ受理する。`serial` が既知の最大値以下なら `409 stale-serial` を返す (SHOULD)。
- 応答の上限は 1 名前あたり 8 件、1 レコードあたり 16 KiB、1 応答あたり 1 MiB。超過分は切り捨てず `413`（リクエスト側は `400` / `413`）を返す。
- クライアント実装 `HttpDomainRegistryClient`（`adapters/domain/`）は `IDomainRecordSource` と `DomainCheckpointSource` を同時に実装し、`checkpointChain` として注入できる。請求ごとに `timeoutMs` と `AbortSignal` を適用し、失敗は `DomainRegistryError`（`status` を運ぶ型）へ正規化する。
- レジストリは**信頼の根元ではない**。レコードの真正性は所有者署名と（設定時の）台帳検証で決まるため、レジストリが嘘を書いても解決は壊れない（§13.7）。

### 13.7 セキュリティ境界と未達

- 検証者が信頼するのは**設定されたログ鍵と所有者公開鍵だけ**。シグナリングハブ、中継ノード、HTTP レジストリは信頼不要（指紋照合が全てを自己証明化する）。
- **チェックポイントの信憑性はログ鍵の署名に依存する**。「その名の真の所有者が台帳へ提出した」までの保証であり、**台帳の公正性（二重記載しないこと）は検証しない**。単一ログの横書きは §13.3 の `prevHash` 連結で検出できるが、ログ全体を書換えた場合は検出できない。複数ログの M-of-N 合意は未実装（#43）。
- `anchor.chain` が無い／未設定の場合、**オンチェーン検証は行われない**（`chainVerified: null`）。ブラウザにフルクライアントを載せない設計上の帰結であり、実チェーン接続は #42。
- ドメイン名そのものの紛争裁定、失効回収の自動化、IDNA は未定義（#43）。
- 問い合わせは既知ノード全体へ平文（署名付き）で拡散する。問い合わせ秘匿（段階的開示・暗号化）は未実装。

## 14. 公開 API

### 14.1 WebTCPNetwork


```ts
new WebTCPNetwork({
  channel: IChannel,          // 必須
  signaling?: ISignalingAdapter,
  nodeId?: NodeId,            // 省略時: keyManager.nodeId → signaling → ランダム
  keyManager?: Ed25519KeyManager,   // ブラウザ: BrowserKeyManager / Node: NodeKeyManager
  keyDirectory?: KeyDirectory,      // 公開鍵ディレクトリ（省略時は鍵管理から生成）
  requireSignatures?: boolean,      // 既定: 鍵管理 / Ed25519PacketVerifier 指定時 true
  serializer?: IPacketSerializer,
  verifier?: IPacketVerifier,       // 省略時: 鍵管理があれば Ed25519PacketVerifier
  routingTableManager?: RoutingTableManagerOptions,
  transport?: TransportLayerOptions,
  defaultTtl?: number,
  logger?: Logger,
  logLevel?: LogLevel,
})

start(): Promise<void>
listen(port: VirtualPort, handler: (stream: VirtualStream) => void): void
connect(remoteId: NodeId, remotePort: VirtualPort, localPort?: VirtualPort): Promise<VirtualStream>
connectURL(url: string | WebTCPUrl, options?: ConnectURLOptions): Promise<VirtualStream>
connectToPeer(remoteId: NodeId): Promise<void>
bootstrap(searcher: IEntranceSearcher, options?: BootstrapOptions): Promise<BootstrapResult>
getNeighbors(): NodeId[]
getRoutingTable(): RoutingTable
close(): void
```

- `channel` は必須である。ブラウザでは `createBrowserNetwork({ signaling, keyManager?, iceServers?, iceServersProvider?, logger?, logLevel?, ... })` を使うと `BrowserWebRTCChannel` が自動で組み立てられる。
- `nodeId` の解決順は `options.nodeId` → `keyManager.nodeId` → `signaling.getLocalNodeId()`
  → ランダム生成（`generateNodeId()`）である。ただし `Ed25519PacketVerifier` を直接注入した場合は
  シグナリングの NodeId を使わない（署名鍵を持たないノード ID で署名することになるため）。
- 鍵管理を指定した場合、`nodeId` は必ず `keyManager.nodeId`（公開鍵の指紋）と一致しなければならない。
  不一致ならコンストラクタが例外を投げる（`nodeId ... does not match the Ed25519 key fingerprint ...`）。
- `keyManager` / `keyDirectory` / `requireSignatures` は M3（#28）で追加された。
  `keyManager` を渡すと自動的にプロトコル v2（署名必須）になり、`verifier` も `Ed25519PacketVerifier` が組まれる。
- `connect()` は必要に応じてリンクを確立してから仮想接続を開始する。
- `connectURL()` は M4 で追加。名前指定には `options.nameServer` が必要。`options.nameServer.domains` 設定時、ゾーン内名前は所有権検証を通る（§13.5）。
- `serializer` を注入した場合、自動生成される `Ed25519PacketVerifier` にも**同じインスタンス**が渡される（#41）。注入シリアライザが `serializeForSigning()` を実装しない場合、鍵管理併用は構築時に失敗する（§10.3）。
- `bootstrap()` はエントランス探索結果から候補へ順次接続を試み、失敗時は指数バックオフでリトライする。
- 起動完了時に `'ready'` イベントを発火する。

### 14.2 VirtualStream

```ts
send(data: Uint8Array | string): Promise<void>
read(maxBytes?: number): Uint8Array | null
readExact(bytes: number): Promise<Uint8Array>
pause(): this
resume(): this
end(): void
close(): void
destroy(): void
getStats(): VirtualStreamStats
readonly readableLength: number
readonly state: StreamState
on('connect' | 'data' | 'readable' | 'end' | 'close' | 'drain' | 'error', listener): this
```

- `send()` は 60 KiB 超のデータも自動分割し、輻輳制御に従って送信する。`ESTABLISHED` および `CLOSE_WAIT` で呼び出し可能。
- `data` イベントの引数は `Uint8Array`（フローイングモード）。
- `read()` / `readExact()` / `readable` はバイトストリームの部分読み取りを提供する。
- `end()` / `close()` は送信バッファをフラッシュしたうえで `FIN` を送信する（half-close）。
- `end` イベントは相手の `FIN` により受信側が EOF に達したとき一度だけ発火する。
- `drain` は送信バッファおよび未 ACK キューが空になったときに発火する。
- `close` は `CLOSED` 遷移時に一度だけ発火する。

### 14.3 セキュリティ API（M3 / #28）

```ts
// NodeId = Ed25519 公開鍵の指紋
deriveNodeId(publicKey: Uint8Array): Promise<NodeId>
nodeIdMatchesPublicKey(nodeId: NodeId, publicKey: Uint8Array): Promise<boolean>
isValidNodeId(value: unknown): value is NodeId

// 鍵管理
await NodeKeyManager.create({ privateKeyPem?, secretKeyHex?, nodeId?, keyDirectory? })
await NodeKeyManager.open({ keyFile, nodeId?, keyDirectory? })
await BrowserKeyManager.open({ databaseName?, expectedNodeId?, regenerate?, keyDirectory?, logger? })
keyManager.sign(data): Promise<Uint8Array>            // 64 バイト
keyManager.verify(publicKey, data, signature): Promise<boolean>
keyManager.deriveNodeId(publicKey): Promise<NodeId>
keyManager.nodeId / keyManager.publicKey

// 署名・検証
new Ed25519PacketVerifier({ keyManager, keyDirectory?, serializer?, keyWaitTimeoutMs? })
createEd25519Verifier({ keyManager, keyDirectory?, ... })
    // → { verifier, keyDirectory, publicKey, publicKeyEncoded, nodeId }

// 公開鍵ディレクトリ
new KeyDirectory({ logger? })
directory.addPublicKey(nodeId, publicKey | base64url): Promise<boolean>   // 指紋不一致は false
directory.getPublicKey(nodeId): Promise<Uint8Array | null>
directory.waitForPublicKey(nodeId, timeoutMs?): Promise<Uint8Array | null>
```

| API | 説明 |
| :--- | :--- |
| `deriveNodeId` / `nodeIdMatchesPublicKey` | 公開鍵指紋の導出・照合（§5.1） |
| `NodeKeyManager` | Node.js 用の Ed25519 鍵管理（`node:crypto`） |
| `BrowserKeyManager` | ブラウザ用の Ed25519 鍵管理（Web Crypto + IndexedDB / 非抽出 CryptoKey） |
| `Ed25519PacketVerifier` | `IPacketVerifier` 実装。署名付与と検証（§10.2 / §10.3） |
| `NullPacketVerifier` | 署名なしのレガシー検証器（v1 相互運用専用） |
| `KeyDirectory` | `NodeId -> 公開鍵`。指紋照合つき登録・待機・学習 |
| `NodeIdCollisionError` | 同一 NodeId に異なる鍵/身元が対応する衝突を表す型付きエラー |
| `IPublicKeyResolver` | 分散ストレージ等への差し替えポイント（§10.4.3） |

### 14.4 名前解決とドメイン所有権 API（M4 / M5・#25）

```ts
// 名前空間（§13.1）
DOMAIN_GLOBAL_ZONE: 'domain.global'
isDomainGlobalName(name): boolean
normalizeDomainName(input): string          // 失敗時 DomainRecordError
prepareDomainName / isValidDomainName / domainLabels / domainZone / domainNameInZone

// レコード（§13.2）
canonicalDomainRecordBodyBytes(body): Uint8Array
canonicalDomainCheckpointBytes(checkpoint): Uint8Array
await commitDomainRecord(body): Promise<string>          // hex SHA-256
domainCommitmentBytes(commitmentHex): Uint8Array
await parseDomainOwnershipRecord(value, { verifyFingerprint? }): DomainOwnershipRecord
parseDomainRecordBody(value): DomainRecordBody            // 未知キー拒否
domainRecordToJSON(record) / serializeDomainRecord(record)
await createDomainOwnershipRecord({ domain, keyManager, serial, lifetimeMs?, port?, txt?, revoked? })

// 台帳（§13.3）
sha256Domain(bytes) / defaultDomainHash / verifyDomainEd25519(publicKey, data, signature)
domainMerkleLeafHash(leafBytes) / domainMerkleNodeHash(left, right) / bindDomainMerkleRoot(top, treeSize)
computeDomainMerkleRoot(leafBytes) / buildDomainMerkleRoot(leafBytes): Promise<string>  // Base64url
buildDomainMerkleProof(leafBytes, index) / verifyDomainMerkleProof({ commitment, leafIndex, treeSize, root, proof })
await signDomainCheckpoint(checkpoint, keyManager)
verifyDomainCheckpoint(checkpoint, { logKeys } | { resolveLogKey, maxAgeMs?, clockSkewMs?, nowMs? })
verifyDomainCheckpointChain({ pinned, target, between }) / checkpointRollsBack(pinned, candidate)
parseDomainCheckpoint / parseDomainAnchor / normalizeDomainCheckpoint
createDomainLedger({ keyManager, logId?, requireOwnerSignature?, maxEntries?, hashFn?, logger? })
    // → DomainLedger: append / lookupByDomain / lookupByNodeId / buildAnchor / checkpoint /
    //                 checkpointsBetween / snapshot / root / clear

// 検証（§13.4）
createDomainOwnershipVerifier({ requireAnchor?, requireChainAnchor?, logKeys?, resolveLogKey?,
                                checkpointMaxAgeMs?, maxLifetimeMs?, clockSkewMs?, chainAnchorVerifier?,
                                verifySignature?, hashFn?, logger? })
createDomainProofCache({ maxEntries? })     // knownSerials / pinned checkpoints / commitments の保持
conflictVerdict(current, candidate)         // §13.4.3 の勝者判定（'identical' | 'candidate' | 'current' | 'conflict'）

// 解決（§13.5）
createDomainAuthority({ verifier?, verifierOptions?, local?, sources?, peers?, checkpointChain?,
                        cacheTtlMs?, negativeTtlMs?, maxCacheEntries?, resolveTimeoutMs?,
                        queryTimeoutMs?, maxRecordsPerDomain?, pinCheckpoints?, logger? })
memoryDomainRecordSource({ records?, logger? })   // テスト・ローカル信託用（put / remove / list つき）
chainDomainRecordSources(sources)
await new NameServer(network, { domains }).registerDomain(record)   // §12.2

// レジストリアダプタ（§13.6、adapters/domain/）
createHttpDomainRegistryClient({ baseUrl, fetchImpl?, timeoutMs?, tolerateNotFound?, logger? })
    // → lookupByDomain / lookupByNodeId / submit / checkpoint / checkpointsBetween / logInfo

// 型
DomainOwnershipRecord / DomainRecordBody / DomainAnchor / DomainAnchorChainRef
DomainCheckpoint / SignedDomainCheckpoint / DomainVerifyContext / DomainVerifyResult / DomainProofCode
IDomainOwnershipVerifier / IChainAnchorVerifier / IDomainRecordSource / DomainSourceContext
DomainCheckpointSource / DomainResolution / DomainResolution* (Success | Failure)
DomainRecordError / DomainOwnershipError / DomainConflictError / DomainResolutionUnavailableError
DomainLedgerAppendError / DomainRegistryError

- `NameServerOptions.domains` に `DomainAuthority` を渡すと、ゾーン内名の解決・応答が §13.5 に従って権威へ移譲される。
- `HttpDomainRegistryClient`（`adapters/domain/`、§13.6）は `IDomainRecordSource` と `DomainCheckpointSource` を同時に実装する。
- `core/domain` は `crypto.subtle`（Web Crypto）だけを使う。Ed25519 検証が使えない環境では `verifySignature` を差し替える。

### 14.5 HTTP トンネル API（M6 / #50）

```ts
// WebTCPNetwork（M6 で追加）
serveHTTP(port: VirtualPort, handler: HTTPHandler, options?: HTTPServerOptions): HTTPServer
fetchURL(url: string | WebTCPUrl, options?: FetchURLOptions): Promise<HTTPResponse>

// サーバー（§15.3）
new HTTPServer(network, port, handler, options?)
    // → port / connectionCount / close()
server.listen(): void                     // serveHTTP() はこれを行う
new HTTPRouter()                           // 補助（MAY）
router.add(method, pattern, handler)       // '/users/:id' 記法
router.handle: HTTPHandler

// クライアント（§15.4）
new HTTPClient(network, { nameServer?, timeoutMs?, maxResponseBytes?, keepAlive?, idleTimeoutMs?, logger? })
await client.fetch(url, { method?, headers?, body?, signal?, timeoutMs?, keepAlive? })
await client.request({ nodeId, port, method, path, headers?, body?, signal? })
client.close()

// 低レベル（§15.2）
new HTTPReader(stream, { maxHeaderBytes?, maxHeaderCount?, maxLineBytes?, strictLineEndings?, logger? })
    // → readRequest() / readResponse()
class HTTPWriter { writeRequest(...) / writeResponse(...) }
class HTTPRequest        // method / target / path / query / headers / remoteNodeId / body
class HTTPResponseWriter // statusCode / setHeader() / write() / end() / headersSent
class HTTPResponse       // status / statusText / headers / body / ok / text() / json() / arrayBuffer()

// 型・エラー
HTTPHandler / HTTPHeaders / HTTPBodyReader / HTTPServerOptions / HTTPClientOptions
HTTPError / HTTPParseError / HTTPTimeoutError / HTTPResponseTooLargeError
HTTPConnectionClosedError / HTTPBodyConsumedError
```

- `serveHTTP()` は `network.listen()` の薄いラッパーであり、待ち受けの解除は `server.close()` で行う。
- `fetchURL()` は `HTTPClient` を一時的に作って 1 リクエストを実行する。`keep-alive` を維持したい場合は `HTTPClient` を直接使う。
- HTTP 層は `core/http/` に置き、`core/network/` からは `serveHTTP` / `fetchURL` の 2 メソッドとして公開する。DOM API・`node:*`・`Buffer` に依存しない。

## 15. HTTP トンネル（アプリケーション層 / M6・#50）

本章は `VirtualStream` の上で HTTP/1.1 のメッセージを運ぶ**アプリケーションプロトコル**を定義する。ワイヤー（パケット）形式は一切変更しない。したがって L4 までの実装・v1/v2 の相互運用・既存の NameServer / ドメイン所有権とは独立に導入できる。

### 15.1 目的とスコープ

- `network.serveHTTP(port, handler)` でブラウザ上のサービスを **HTTP のまま**公開し、既存の Web 資産（`fetch` 相当の呼び出し、`Content-Type` による表現、ステータスコード、`Accept-Encoding` ではない単純なヘッダ交渉）をそのまま使えるようにする。
- `network.fetchURL('webtcp://name:port/path?q=1', { nameServer })` で、`webtcp://` URL の `path` / `query` を**実際に転送する**（§12.3 の改訂）。
- 対象は **HTTP/1.1 のサブセット**である。フル実装ではない。非目標は §15.9 に列挙する。

実装（`core/http/`）は次の 4 つで構成する。いずれも `VirtualStream` 以外に依存せず、`Buffer` / `node:*` / DOM API を使わない（design.md §1）。

| モジュール | 役割 |
| :--- | :--- |
| `HTTPReader` / `HTTPWriter` | ストリーム上の**バイト列 → メッセージ**、**メッセージ → バイト列**。バッファリングと分割耐性を担う。 |
| `HTTPParser` | リクエストライン / ステータスライン / ヘッダ / 本文（`Content-Length`・`chunked`）の逐次パース。 |
| `HTTPServer` | 仮想ポートの待ち受け、接続ごとのリクエストループ、`keep-alive`、`HTTPHandler` の呼び出し。 |
| `HTTPClient` | 接続（または `keep-alive` セッション）上のリクエスト送信とレスポンス受信。`fetch` 風 API。 |

### 15.2 メッセージ形式

HTTP/1.1（RFC 9112）の文法のうち、次を**そのまま**用いる。

```
request-line  = method SP request-target SP "HTTP/1.1" CRLF
status-line   = "HTTP/1.1" SP status-code SP [ reason-phrase ] CRLF
field-line    = field-name ":" OWS field-value OWS CRLF
```

- 行終端は **CRLF** とする。受信側は裸の `LF` を**受理してはならない** (MUST NOT)（曖昧なフレーミングを許さない）。ただし寛容さが必要な場合は `strictLineEndings: false` を明示する（既定 `true`）。
- メッセージの終端は空行（CRLF）1 つ。ヘッダ終端の空行の後に本文が続く。
- 文字コードは **バイト列**として扱い、ヘッダは ISO-8859-1（`0x00–0xFF`）で解釈する。ヘッダ名は小文字へ正規化して格納する。重複ヘッダは**到着順の配列**として保持し、`HTTPHeaders.get()` はカンマ連結した値を返す。
- `Host` ヘッダはクライアントが必ず付与しなければならない (MUST)。サーバーは `Host` 無しの HTTP/1.1 リクエストを `400 Bad Request` で拒否しなければならない (MUST)。値は `webtcp://` URL の `host`（NodeId または名前）と `:port` である。
- **`Transfer-Encoding: chunked`** と **`Content-Length`** をサポートする。両方が同時に存在するメッセージは `400` で拒否する (MUST)（リクエストスマグリングの回避）。
- 本文長の決定順序は (1) `Transfer-Encoding` が `chunked` なら chunked、(2) `Content-Length` があればその値、(3) どちらも無ければ **本文なし**（`0`）。`TRACE` 以外のリクエストで本文が無いことは正常である。

#### 15.2.1 制限値（既定）

| 項目 | 既定値 | 超過時 |
| :--- | ---: | :--- |
| リクエストライン長 | 8 KiB | `414 URI Too Long`（リクエスト）/ パースエラー（レスポンス） |
| ヘッダ 1 行の長さ | 8 KiB | `431 Request Header Fields Too Large` |
| ヘッダ数 | 100 | `431` |
| ヘッダ合計長 | 32 KiB | `431` |
| 1 メッセージの本文 | 無制限（ストリーミング）。バッファする API では 8 MiB | `413 Payload Too Large`（サーバー）/ `HTTPResponseTooLargeError`（クライアント） |
| `chunk-size` 行 | 1 KiB | `400` |
| 同時接続数（`HTTPServer`） | 64 | 新規接続を `503 Service Unavailable` で閉じる |

実装はこれらをオプションで変更できなければならない (MUST)。上限は**必ず**適用し、無制限のバッファ確保をしてはならない (MUST NOT)。

#### 15.2.2 `Expect: 100-continue`

- サーバーは `Expect: 100-continue` を受けた場合、本文を読み始める前に `HTTP/1.1 100 Continue\r\n\r\n` を送ってよい (MAY)。実装は**送らない**ことを既定とする（ブラウザ間で 1 往復増えるだけで利得が無いため）。`Expect` に他の値が含まれる場合は `417 Expectation Failed` を返す (MUST)。

### 15.3 `HTTPServer`

```ts
const server = network.serveHTTP(port, handler, options?)
server.close(): void
server.port: VirtualPort
server.connectionCount: number
```

- `serveHTTP(port, handler, options?)` は `network.listen(port, stream => ...)` を内部で使い、接続ごとに**リクエストループ**を回す。同じポートに二重に待ち受けることはできない（`TransportLayer.listen()` の契約に従う）。
- `handler(request, response)` は 1 リクエストにつき 1 回呼ばれる。`request` は `HTTPRequest`（メソッド・ターゲット・ヘッダ・本文リーダ）、`response` は `HTTPResponseWriter`（`statusCode` / `setHeader()` / `write()` / `end()`）である。
- ハンドラは **同期的にも非同期的にも**応答してよい。`handler` が reject した場合、まだ応答を開始していなければ `500 Internal Server Error` を返し、開始済みなら接続を切断する (MUST)。
- ハンドラが例外も応答も返さずに解決した場合、まだ応答していなければ `500`（本文空）を返す (MUST)（無応答でクライアントを待たせない）。
- **本文はストリーミング**である。`request.body` は `AsyncIterable<Uint8Array>` かつ `read()` / `text()` / `json()` / `arrayBuffer()` を持つ。ハンドラが本文を読み切らなかった場合、サーバーは残りを**破棄して読み切ってから**次のリクエストへ進む (MUST)（`keep-alive` のフレーミングを壊さないため）。
- `response.write()` を 1 度でも呼ぶか `Content-Length` を設定せずに `end()` した場合、応答は `Transfer-Encoding: chunked` で送る (MUST)。`Content-Length` が分かっている場合は `contentLength` オプションか `response.setHeader('content-length', n)` で指定する。
- **Half-Close との関係**: クライアントはリクエスト送信後に `FIN` を送ってよい（§15.4 の接続モデル）。サーバーは `end`（EOF）を受けても**応答を送る権利を失わない** — `CLOSE_WAIT` 状態で `send()` できる（§8.2）。応答完了後にサーバーが `end()` を呼ぶ。
- `Connection: close` を受けた、または応答ヘッダで `Connection: close` を返した場合、サーバーはその応答の後に接続を閉じなければならない (MUST)。
- `HEAD` / `OPTIONS` / 未知メソッド: `HEAD` は本文を送ってはならない (MUST)。`OPTIONS` はハンドラへ渡す。メソッドは**大文字小文字を区別**し、既知のトークン以外（`GET` / `HEAD` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` / `TRACE` / `CONNECT`）は `501 Not Implemented` を返す (MUST)。`CONNECT` は本プロトコルでは意味を持たないため `405` を返す (MUST)。

`HTTPHandler` の型:

```ts
type HTTPHandler = (request: HTTPRequest, response: HTTPResponseWriter) =>
    void | Promise<void>;
```

ハンドラの登録は `createHTTPRouter()`（`method + path` のパターン一致、`/users/:id` 記法）で補助できる（MAY）。

### 15.4 `HTTPClient`

```ts
const client = new HTTPClient(network, { nameServer?, timeoutMs?, maxResponseBytes?, keepAlive? });
await client.fetch(url: string | WebTCPUrl, init?): Promise<HTTPResponse>
await client.request({ method, path, headers?, body?, nodeId, port }): Promise<HTTPResponse>
client.close(): void
```

- `fetch(url, init)` は `parseWebTCPUrl()` でパースし、名前なら `nameServer.resolve()` で NodeId を得て `network.connect()` する。`path` と `search`（`?` を含む）を連結して request-target にする（§15.6）。
- `init` は `{ method?, headers?, body?, timeoutMs?, signal?, keepAlive? }`。`body` は `string | Uint8Array | AsyncIterable<Uint8Array>`。`AsyncIterable` を渡した場合は `Transfer-Encoding: chunked` で送る (MUST)。`string` は UTF-8 にエンコードし、`content-type` 未指定なら `text/plain; charset=utf-8` を付ける。
- `HTTPResponse` は `{ status, statusText, headers, body: HTTPBodyReader, ok, text(), json(), arrayBuffer() }`。`ok` は `200–299`。
- **ストリーミング**: `body` は `AsyncIterable<Uint8Array>` であり、`text()` / `json()` / `arrayBuffer()` は本文を**読み切って**返す。これらは 1 度しか呼べない（2 度目は `HTTPBodyConsumedError`）。
- `timeoutMs`（既定 30 000 ms）は**接続確立 + 最初の応答ヘッダ到着**までに適用する。ヘッダ到着後の本文受信には `signal` で中断できるが、自動タイムアウトは掛けない（大きなファイル転送を許すため）。`signal` は接続中の `AbortSignal` を尊重し、中断時はストリームを `destroy()` する (MUST)。
- `maxResponseBytes`（既定 8 MiB、`0` で無制限）を超える本文は `HTTPResponseTooLargeError` で reject する (MUST)。ストリーミングで読む場合は呼び出し側の責任とする。
- `keepAlive`（既定 `true`）の場合、`HTTPClient` は `(nodeId, port)` ごとに `VirtualStream` を再利用し、逐次リクエストを同じ接続で送る。**多重化はしない** — 同時リクエストは別接続になる（HTTP/1.1 の一般則。パイプラインは行わない）。

### 15.5 接続モデルと Half-Close

HTTP/1.1 の `keep-alive` と `VirtualStream` の Half-Close を衝突させないため、次の規則を置く。

1. **リクエスト/レスポンスは 1 接続上で逐次**に行う。パイプライン（応答を待たずに複数リクエストを送る）は行わない (MUST NOT)。
2. `keep-alive` を使う場合、`HTTPClient` はリクエストを送っても `FIN` を送らない。接続は `HTTPClient.close()` またはアイドルタイムアウトで `end()` する。
3. `Connection: close` を使う（または `keepAlive: false`）場合、クライアントはリクエスト送信後に `end()` を呼んでよい。サーバーは `CLOSE_WAIT` で応答を送り、`end()` する（「**FIN の後に応答する**」）。これは §8.2 の Half-Close の正規の使い方であり、L4 の変更を要しない。
4. サーバーは応答送信後に `Connection: close` を返した場合、`end()` する。クライアントは `end` を待たずに接続を破棄してよい。
5. アイドル接続（リクエストの途中でない接続）は `idleTimeoutMs`（既定 30 000 ms）で閉じる (SHOULD)。途中のリクエストは L4 のセッションタイムアウト（§8.5、300 000 ms）に委ねる。
6. 応答本文の受信中に接続が切れた場合、`HTTPClient` は `HTTPConnectionClosedError` を投げる。`Content-Length` が宣言されていて実際のバイト数が足りない場合も同様とする (MUST)。
7. **接続の終了は必ず `FIN`（`VirtualStream.end()`）で行う (MUST)。** `VirtualStream.destroy()` は `RST` も `FIN` も送らないため（§8.2）、これで閉じると相手側のストリームは `ESTABLISHED` のまま残り、L4 のセッションタイムアウト（300 000 ms）まで宙に浮く（#54）。HTTP 層の都合で接続を捨てるときも `end()` を使う。
8. `HTTPServer.close()` は待ち受けを解除し、保持している全接続に `FIN` を送る (MUST)。送信中の応答は打ち切ってよい（`Connection: close` を返した接続は 4 に従う）。
9. 読み取り途中のリクエスト本文がある状態で接続を閉じる場合、`HTTPServer` は本文の読み取りを `HTTPConnectionClosedError` で失敗させる (SHOULD)。これがないと、アプリケーションの `for await` が永久に待つ。

### 15.6 `webtcp://` URL との対応

| URL 要素 | HTTP メッセージへの写像 |
| :--- | :--- |
| `host` / `port` | 接続先（`nodeId` または名前解決の結果）と仮想ポート。`Host` ヘッダは `host:port` |
| `path` | request-target のパス部分。省略時 `/` |
| `search`（`?` を含む） | そのまま request-target に連結（`/a?x=1`）。**パーセントエンコードは行わない**（既にエンコード済みの文字列として扱う） |
| `hash` | **送らない**（クライアント側の断片） |

- `network.fetchURL(url, options)` は `HTTPClient` を作って 1 リクエストを実行する便宜 API である。`options` は `HTTPClient` のオプション + `fetch` の `init` を取る。
- NameServer / `domain.global` の解決結果（`NameResolution`）はそのまま接続先に使う。所有権検証の結果を HTTP 層で再解釈してはならない (MUST NOT)。

### 15.7 セキュリティ境界

- HTTP 層は**トランスポートの内側**で動く。したがってパケットの Ed25519 署名検証（§10）と RPF / TTL（§7）はそのまま適用される。HTTP 層独自の認証・認可は**定義しない**（アプリケーションの責務）。
- サーバーハンドラは**リモートの任意のピア**から呼ばれる。認可が無いハンドラは公開サービスになる。`HTTPServer` は接続元 `NodeId` を `request.remoteNodeId` として渡すため、アプリケーションは許可リスト等を実装できる。
- **ヘッダインジェクション防止**: ヘッダ名・値に `CR` / `LF` / `NUL` を含む書き込みは例外にする (MUST)。受信側はそのような行を `400` で拒否する (MUST)。
- **リクエストスマグリング防止**: `Content-Length` と `Transfer-Encoding` の同時指定、`Transfer-Encoding` の未知値（`chunked` 以外）、`chunked` の多重指定を拒否する (MUST)。
- **ヘッダ数・行長・本文サイズの上限**は必須（§15.2.1）。`Host` の欠落は `400`。
- `webtcp://` のポートは必須であり、HTTP 層も既定ポートを持たない。`webtcp://name/path` のような省略形を許してはならない (MUST NOT)。

### 15.8 エラーとログ

| 状況 | 挙動 |
| :--- | :--- |
| リクエスト行・ヘッダのパース失敗 | `400 Bad Request` を返して接続を閉じる。`warn` ログ。 |
| 行長・ヘッダ数超過 | `414` / `431` を返して閉じる。 |
| 本文長超過（バッファ API） | `413`。 |
| ハンドラの reject | 未応答なら `500`、応答開始済みなら切断 + `warn` ログ。 |
| ハンドラ未応答で解決 | `500`（本文なし）。 |
| 未知メソッド | `501 Not Implemented` / `CONNECT` は `405`。 |
| サーバー停止中の新規接続 | `503 Service Unavailable` を返して閉じる。 |
| クライアント: 接続失敗 | `network.connect()` の例外をそのまま伝播。 |
| クライアント: ヘッダまでにタイムアウト | `HTTPTimeoutError`。 |
| クライアント: 応答が上限超過 | `HTTPResponseTooLargeError`。 |
| クライアント: 接続が途中で閉じた | `HTTPConnectionClosedError`。 |
| クライアント: 本文を 2 度読んだ | `HTTPBodyConsumedError`。 |
| クライアント: `AbortSignal` | `AbortError`（`name === 'AbortError'`）で reject し、ストリームを破棄。 |

HTTP 層は `Logger` を注入でき、`console.*` を直接呼んではならない (MUST)。

### 15.9 非目標（M6 時点）

- HTTP/2・HTTP/3、プロトコルアップグレード（`Upgrade` / WebSocket ハンドシェイク）、`CONNECT` メソッド。
- パイプライン処理、HTTP/1.1 の `100-continue` の自動送信、`TE: trailers`、トレーラヘッダ。
- `multipart/form-data` の自動デコード、圧縮（`gzip` / `br`）、キャッシュ制御（`ETag` / `If-None-Match` の自動処理）、リダイレクトの自動追従（`301` / `302` はそのまま返す）。
- Cookie 管理（`Cookie` / `Set-Cookie` はヘッダとして素通しするが、ジャーは持たない）。
- 認証（Basic / Digest / Bearer の解釈）、TLS（DTLS は WebRTC が終端する）。
- 多重化（1 接続 1 リクエストの並行実行）。同時実行は複数接続で行う。

## 16. バージョニング

- パケットの `version` フィールドで判別する。未知バージョンは破棄する。
- **v1（M1–M2）**: `version = 1`。24 バイト固定ヘッダー、`signatureLen = 0`、NodeId はランダム hex。
  SACK は `ACK` ペイロード拡張として後方互換を保つ。
- **v2（M3 / #28、既定）**: `version = 2`。24 バイト固定ヘッダーは v1 と**完全に共通**で、
  `signature` に 64 バイトの Ed25519 署名が入る。NodeId は公開鍵の指紋でなければならない。
- 移行規則:
  - 送信側は `signature` の有無で v1 / v2 を選ぶ（§6.1）。鍵管理を渡すと常に v2 になる。
  - 受信側は v1 / v2 の両方を**デシリアライズできる** (MUST)。
  - v2 ノード（鍵管理 / Ed25519 検証器あり）は既定で `requireSignatures: true` のため v1 を破棄する。明示的に `requireSignatures: false` とした場合のみ後方互換で受理する。鍵管理なしの既定は v1。
  - ヘッダーレイアウトが共通のため、v1 と v2 のノードが同一リンク上で併存しても
    デシリアライズ段階では衝突しない（署名検証の可否だけが異なる）。

## 17. 非目標（M6 時点）

以下は本仕様の対象外であり、`plan.md` に将来課題として記録する。

- **実ブロックチェーンへの接続**（SPV ヘッダー検証、EVM の `eth_getProof` / keccak-256 + RLP、Namecoin RPC 照会）。本書が定義するのは「検証可能な所有権レコード + 追記型台帳 + プラガブル検証器」までで、`IChainAnchorVerifier` の参照実装は対象外（#42）。
- **ドメイン名のガバナンス**（紛争裁定、失効回収、複数ログの M-of-N 合意、IDNA / homoglyph 対策）（#43）。
- DNS 相互運用、権威サーバー階層、ゾーン委譲（`com.global` のような追加ゾーン）、名前予約のガバナンス。ゾーン外名前のグローバル衝突解決も対象外（§12.4）。
- 鍵のローテーション（NodeId を維持したままの鍵更新）と、マルチデバイス間の鍵同期（§10.7、#47）。
- アプリケーションデータの E2E 暗号化（DTLS 終端より上の機密性）。
- セッション Nonce / タイムスタンプによる明示的なリプレイ検知の強化（§10.6 の限界、#48）。
- `domain.global` 問い合わせの秘匿（段階的開示・暗号化）。
- HTTP/2・HTTP/3、`Upgrade` / WebSocket ハンドシェイク、`CONNECT`、パイプライン、圧縮、Cookie ジャー、認証、リダイレクト追従、TLS 終端（§15.9）。HTTP/1.1 のサブセット（§15）のみ実装する。
- ブラウザ外（Node.js）での WebRTC 実装の同梱。
- ブラウザ外の既存 TCP クライアント（curl 等）を HTTP トンネルへ入れるブリッジ（#52）。
- タブ停止・リロードをまたぐサービスの稼働維持（#51）。
