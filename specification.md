# WebTCP プロトコル仕様書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.1.0 |
| 対象実装 | `webtcp_jslib` (TypeScript) |
| プロトコルバージョン | 1 |
| ステータス | 実験的（破壊的変更あり） |
| 最終更新 | 2026-11-14 |

本書は WebTCP の**振る舞いの仕様**を定義する。実装内部の構造や技術選定の理由は `design.md`、作業計画と将来課題は `plan.md` を参照すること。

---

## 1. 目的

WebTCP は、WebRTC の信頼性のあるデータチャネル（SCTP）を土台として、アプリケーション層に**仮想的な TCP/HTTP トンネル**を構築する実験的プロトコルである。

最終的な目標は、ブラウザを「サーバーにアクセスするクライアント」ではなく「**他のデバイスから直接アクセスされる自己完結型のサーバー実行環境**」に変えることにある。そのために本プロトコルは次を提供する。

1. 単一の P2P データチャネル上での**複数仮想接続の多重化**（ポート + セッション）
2. パケットの**順序保証・再送・接続状態管理**（TCP に相当する L4 機能）
3. シグナリング手段を差し替え可能にする**リンク層の抽象化**
4. 将来のマルチホップルーティングおよび名前解決に耐える**L3 ヘッダー**

## 2. 用語

| 用語 | 定義 |
| :--- | :--- |
| ノード (Node) | WebTCP ネットワークに参加する 1 つの実行環境（通常は 1 ブラウザタブ）。`NodeId` で識別される。 |
| NodeId | ノードを一意に識別する文字列。M1 では 128 ビットのランダム hex（32 文字）。将来は公開鍵指紋に置き換える。 |
| 隣接ノード (Neighbor) | データチャネルが直接確立している相手ノード。 |
| 仮想ストリーム (VirtualStream) | 仮想 TCP セッション。`(remoteNodeId, localPort, remotePort)` で一意。 |
| 仮想ポート | アプリケーションを識別する 16 ビット整数（0–65535）。 |
| リンク層 | データチャネルとシグナリングの抽象化。`IChannel` / `ISignalingAdapter`。 |
| ルーティング層 | 宛先ノードへの転送、TTL、署名検証、ルーティング情報交換。 |
| トランスポート層 | ポート多重化、セッション、再送、状態機械。 |
| M1 | 本仕様が対象とする最初のマイルストーン（2 ブラウザ間の end-to-end 通信）。 |

## 3. 準拠のキーワード

本書の「しなければならない (MUST)」「してはならない (MUST NOT)」「すべきである (SHOULD)」「してもよい (MAY)」は RFC 2119 に準ずる。

## 4. アーキテクチャ

```
+-----------------------------------------------------------+
| L7  アプリケーション (HTTP 風 API / 任意のプロトコル)        |
+-----------------------------------------------------------+
| L4  TransportLayer : ポート多重化 / SessionManager          |
|     VirtualStream  : 状態機械 / Seq-Ack / 再送 / 順序制御    |
+-----------------------------------------------------------+
| L3  RoutingLayer   : 宛先判定 / 転送 / TTL / RPF / 検証     |
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

- 形式: `^[0-9a-f]{32}$`（M1）。実装は 16 バイトの乱数を hex 化する。
- ノードは自身の NodeId を 1 つだけ持つ。
- NodeId は**自己申告**であり、M1 では暗号学的な検証を行わない。M3 で公開鍵指紋に移行する（§11）。
- シグナリングアダプタは `getLocalNodeId()` で同一の値を返さなければならない (MUST)。

### 5.2 仮想ポート

- 16 ビット符号なし整数。
- 1024 未満は将来の予約（HTTP=80, HTTPS=443 相当）として扱い、アプリケーションが明示しない限り使用しないことが望ましい (SHOULD)。
- クライアント側のローカルポートは 49152–65535 から自動割り当てする (SHOULD)。

### 5.3 セッション識別

仮想ストリームは `(remoteNodeId, localPort, remotePort)` の三つ組で識別する。実装内部では文字列 `${remoteNodeId}:${localPort}:${remotePort}` をキーとしてよい。双方向で同一のキーになる必要があるため、送信側は `sourcePort = localPort`, `destinationPort = remotePort` を必ず設定しなければならない (MUST)。

## 6. パケット形式（プロトコルバージョン 1）

すべての WebTCP パケットは 1 つのバイナリメッセージとしてデータチャネルで送信される。データチャネルはメッセージ境界を保存するため、追加のフレーミングは行わない。

### 6.1 バイト配置

オフセットは先頭からのバイト数。マルチバイト整数は**ビッグエンディアン**。

| Offset | Size | Field | 型 | 説明 |
| ---: | ---: | :--- | :--- | :--- |
| 0 | 1 | `magic` | uint8 | 固定値 `0x57` (`'W'`)。不正値は破棄。 |
| 1 | 1 | `version` | uint8 | 固定値 `1`。未知バージョンは破棄。 |
| 2 | 1 | `ttl` | uint8 | 残ホップ数。初期値 64 を推奨。 |
| 3 | 1 | `flags` | uint8 | §6.3 のビットマスク。 |
| 4 | 2 | `sourcePort` | uint16 | 送信元仮想ポート。 |
| 6 | 2 | `destinationPort` | uint16 | 宛先仮想ポート。 |
| 8 | 4 | `seqNum` | uint32 | シーケンス番号（パケット単位、mod 2^32）。 |
| 12 | 4 | `ackNum` | uint32 | 次に期待する受信シーケンス番号。 |
| 16 | 1 | `senderIdLen` | uint8 | `senderId` の UTF-8 バイト長（≤ 255）。 |
| 17 | 1 | `destIdLen` | uint8 | `destinationId` の UTF-8 バイト長（≤ 255）。 |
| 18 | 2 | `signatureLen` | uint16 | `signature` のバイト長。M1 は 0。 |
| 20 | 4 | `payloadLen` | uint32 | `payload` のバイト長。 |
| 24 | var | `senderId` | UTF-8 | 送信元 NodeId。 |
| … | var | `destinationId` | UTF-8 | 最終宛先 NodeId。 |
| … | var | `signature` | bytes | 署名（M1 は空）。 |
| … | var | `payload` | bytes | アプリケーションデータ。 |

固定ヘッダー長は 24 バイト。合計長 = `24 + senderIdLen + destIdLen + signatureLen + payloadLen`。

### 6.2 受信時の検証

受信側は次を検証し、いずれかに違反したパケットを**破棄しなければならない** (MUST)。

1. バッファ長が 24 バイト以上である。
2. `magic == 0x57` かつ `version == 1`。
3. 宣言された各長の合計がバッファ長と一致する（または超過しない）。
4. `senderId`, `destinationId` が空でない。
5. `payloadLen` が実装の上限（既定 60 KiB）以下である。

### 6.3 フラグ

| ビット | 名称 | 意味 |
| ---: | :--- | :--- |
| 0 | `DATA` | アプリケーションデータを含む。 |
| 1 | `SYN` | 接続要求。 |
| 2 | `ACK` | 確認応答。 |
| 3 | `FIN` | 切断要求。 |
| 4 | `RST` | 強制切断。 |
| 5 | `SYN_ACK` | SYN + ACK の同時表現（M1 の互換用）。 |
| 6 | `RT_UPDATE` | ルーティング情報の交換用。ペイロードは §7.4 の JSON。 |
| 7 | 予約 | 送信時は 0。受信時は無視。 |

パケット種別の判定は**必ずフラグ**で行わなければならない (MUST)。ペイロードの内容で種別を推定してはならない (MUST NOT)。

`SYN_ACK` は `SYN|ACK` と等価に扱う。受信側は両表現を受け入れなければならない (MUST)。

## 7. ルーティング層

### 7.1 隣接ノード

- `IChannel` の `connection-status` イベントで隣接を管理する。
- 隣接が確立した時点で、ルーティングテーブルに `cost = 1, nextHop = 隣接` を登録する。
- 隣接が切断した時点で、そのノードを nextHop とする全エントリを削除する。

### 7.2 転送

`RoutingLayer.sendPacket(packet)` は次を行う。

1. 署名付与（M1 は Null 検証器により何もしない）。
2. `destinationId == localNodeId` ならトランスポート層へ渡して終了。
3. ルーティングテーブルから宛先エントリを取得。存在しなければ、宛先が**直接の隣接**であれば `cost=1` とみなす。それ以外は破棄し警告する。
4. `ttl` を 1 減らす。0 になった場合は破棄。
5. `nextHop` へ `IChannel.send()` でシリアライズ済みバイト列を送る。

### 7.3 受信と RPF

受信側は次を行う。

1. デシリアライズ（失敗時は破棄）。
2. 署名検証（§11）。
3. **RPF (Reverse Path Forwarding)** チェック: 送信元への経路の nextHop が、実際に受信した隣接と一致することを確認する。ただし経路が未学習で、かつ受信元が直接の隣接である場合は許可する（M1 の縮退動作）。それ以外は破棄。
4. TTL 減算。`destinationId == localNodeId` ならトランスポート層へ、そうでなければ転送。

### 7.4 ルーティング情報パケット（RT_UPDATE）

`RT_UPDATE` フラグのパケットのペイロードは UTF-8 の JSON であり、次の形をとる。

```json
{
  "senderId": "0123456789abcdef0123456789abcdef",
  "entries": [
    { "destinationId": "fedcba9876543210fedcba9876543210", "cost": 1 }
  ],
  "withdrawals": ["00112233445566778899aabbccddeeff"]
}
```

- `entries` には自分自身のエントリを含めてはならない (MUST NOT)。
- 受信側は各エントリについて `cost + 1` を計算し、距離ベクトル方式で経路を更新する。
- `withdrawals` は到達不能になった宛先のリストである。受信側は、その宛先の現在の
  ネクストホップが送信元と一致する場合に限りエントリを削除する (MUST)。省略可能。
- 隣接が切断された場合、そのノードをネクストホップとする経路を削除し、`withdrawals`
  として全隣接へ通知する (MUST)。
- 更新が発生した場合、全隣接ノードへ現在のテーブルを再送する。
- 30 秒ごとにメンテナンスを行い、60 秒以上更新のない `cost > 0` のエントリを削除する。
  削除したエントリは `withdrawals` として通知する。
- ルーティング情報パケットはトランスポート層へ渡してはならない (MUST NOT)。

### 7.5 TTL

- 初期値は 64。
- 転送のたびに 1 減算する。
- 宛先に到着する前に 0 になったパケットは破棄する。

## 8. トランスポート層

### 8.1 多重化

`TransportLayer` は受信パケットを `(senderId, destinationPort, sourcePort)` で既存ストリームに振り分ける。

- 既存ストリームがある場合はそのまま渡す。
- ない場合、`SYN` なら新規ストリームを作り、そのポートを `listen` しているアプリケーションハンドラに引き渡す。
- `SYN` 以外なら `RST` を返して破棄する。

### 8.2 状態機械

```
                 SYN (active)                 SYN_ACK / ACK
   CLOSED -------------------> SYN_SENT -------------------> ESTABLISHED
      |                            ^                              |
      | SYN (passive)              | ACK                          | FIN
      v                            |                              v
   SYN_RCVD ------------------------+                        FIN_WAIT_1
                                                                 |
                                             ACK                 | FIN
                                              +--> FIN_WAIT_2 ---+--> CLOSED
                                              |
                                              +--> CLOSING ----------> CLOSED
```

| 状態 | 説明 |
| :--- | :--- |
| `CLOSED` | 初期状態。 |
| `SYN_SENT` | 能動オープンで SYN 送信済み、SYN_ACK 待ち。 |
| `SYN_RCVD` | 受動オープンで SYN 受信済み、SYN_ACK 送信済み、ACK 待ち。 |
| `ESTABLISHED` | データ送受信可能。 |
| `FIN_WAIT_1` | ローカルから FIN 送信済み、ACK 待ち。 |
| `FIN_WAIT_2` | FIN が ACK され、相手の FIN 待ち。 |
| `CLOSING` | 同時クローズ（FIN を送信し、相手の FIN も受信済み）。 |
| `CLOSED` | 終了。 |

状態遷移の条件:

- 能動側は `SYN_ACK` 受信時、`ackNum == nextSendSeqNum` なら `ESTABLISHED` へ遷移し `connect` イベントを発火する。
- 受動側は `ACK` 受信時、`ackNum >= nextSendSeqNum` なら `ESTABLISHED` へ遷移し `connect` イベントを発火する。
- `ESTABLISHED` で FIN を受信したら ACK を返し、自身も FIN を送って `CLOSING` へ遷移する。
- `FIN_WAIT_1` で ACK を受けたら `FIN_WAIT_2`、その状態で FIN を受けたら `CLOSED`。
- `FIN_WAIT_1` で FIN を受けたら `CLOSING`、ACK を受けたら `CLOSED`。
- `RST` 受信、または再送上限超過で `CLOSED` へ遷移し `close`（RST の場合は `error` も）を発火する。

`CLOSED` へ遷移したとき、`close` イベントを**一度だけ**発火しなければならない (MUST)。

### 8.3 シーケンス番号

- シーケンス番号は**パケット単位**で 1 ずつ増える（バイト単位ではない）。M1 の制約であり、M2 でバイトストリーム化する。
- `SYN`, `DATA`, `FIN` はシーケンス番号を 1 消費する。
- `ACK`, `SYN_ACK` は消費しない。`SYN_ACK` は SYN の分だけ消費する。
- 初期シーケンス番号は 0 とする（M1）。M2 でランダム化する。
- `ackNum` は「次に期待する受信シーケンス番号」である。

### 8.4 再送とフロー制御

- 未 ACK パケットは再送キューに保持する。
- RTO は既定 1000 ms（M1 は固定値）。
- 再送は最大 5 回。超過したら接続を異常終了する。
- 送信ウィンドウは 10 パケット（未 ACK 数）。超過時は `send()` が `Send window full` エラーを返す。
- 受信側は順序外パケットをバッファし、順序が揃った時点で上位層に渡す。
- 重複 ACK による高速再送は M1 では行わない。

### 8.5 タイムアウト

| 項目 | 既定値 |
| :--- | :--- |
| 接続確立 (connect) | 10 000 ms |
| RTO | 1 000 ms |
| セッション無通信タイムアウト | 300 000 ms |
| セッションクリーンアップ間隔 | 60 000 ms |

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
  type: 'offer' | 'answer' | 'candidate';
  content: unknown;      // RTCSessionDescriptionInit / RTCIceCandidateInit
  fromId: NodeId;
}
```

- `fromId` は送信側が設定し、アダプタは内容を改変してはならない (MUST NOT)。
- 候補（candidate）は remote description 設定前に到着する可能性があるため、受信側はキューに保持し、設定後にまとめて追加しなければならない (MUST)。

### 9.3 ネゴシエーション

1. 接続を開始する側は `RTCPeerConnection` とデータチャネル（`ordered: true`）を作り、offer を送る。
2. 受信側は answer を返し、`ondatachannel` でチャネルを受け取る。
3. 双方は ICE candidate を逐次交換する。
4. データチャネルが `open` になった時点で `connection-status(true)` を発火する。

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

### 9.5 EntranceSearcherAdapterHub の HTTP 契約

| メソッド | パス | レスポンス |
| :--- | :--- | :--- |
| GET | `/entrances?exclude=<NodeId>` | `{ "nodes": [NodeId, ...] }` |

- `exclude` は省略可能で、自分自身を候補から除くために使う。
- サーバーは直近 60 秒以内にポーリングしたノードを返すことを推奨する。
- クライアントは得られた NodeId に対して `IChannel.connect()` を試みる。`search()` は空配列を返してもよい。

## 10. セキュリティ

M1 では次を**保証しない**。これは既知の制約であり、M3 で解消する。

- NodeId の真正性（なりすまし可能）
- パケットの改ざん検知（`signature` は常に空）
- ペイロードの機密性（DTLS によるトランスポート暗号化のみ）

M3 の要件（予定）:

- NodeId = Ed25519 公開鍵の指紋。
- 送信時にヘッダーとペイロード（署名フィールドを除く）へ署名。
- 受信時に公開鍵を取得して検証。`KeyManager` インターフェース経由で鍵を解決する。
- 検証に失敗したパケットは破棄する。

## 11. エラーと既定値

| 状況 | 挙動 |
| :--- | :--- |
| 不正なパケット | 破棄し、警告ログ。例外を上位へ伝播させない。 |
| 宛先不明 | 破棄し、警告ログ。 |
| 未リッスンポートへの SYN | RST を返す。 |
| 接続タイムアウト | `connect()` を reject。ストリームを破棄。 |
| 再送上限超過 | `error` イベント発火後 `CLOSED`。 |
| ストリーム `send()` が未確立 | `Cannot send data. State is ...` で reject。 |

既定値:

| パラメータ | 値 |
| :--- | :--- |
| TTL | 64 |
| 最大ペイロード | 60 KiB |
| 送信ウィンドウ | 10 パケット |
| 再送上限 | 5 |
| 接続タイムアウト | 10 s |
| シグナリングポーリング | 1 s |
| RT_UPDATE 間隔 | 30 s |
| 経路エントリの寿命 | 60 s |

## 12. 公開 API

### 12.1 WebTCPNetwork

```ts
new WebTCPNetwork({
  channel: IChannel,          // 必須
  signaling?: ISignalingAdapter,
  nodeId?: NodeId,
  serializer?: IPacketSerializer,
  verifier?: IPacketVerifier,
})

start(): Promise<void>
listen(port: VirtualPort, handler: (stream: VirtualStream) => void): void
connect(remoteId: NodeId, remotePort: VirtualPort, localPort?: VirtualPort): Promise<VirtualStream>
connectToPeer(remoteId: NodeId): Promise<void>
getNeighbors(): NodeId[]
getRoutingTable(): RoutingTable
close(): void
```

- `channel` は必須である。ブラウザでは `createBrowserNetwork({ signaling })` を使うと
  `BrowserWebRTCChannel` が自動で組み立てられる。
- `nodeId` を省略した場合、`signaling.getLocalNodeId()`、それも無ければランダム生成を使う。
- `connect()` は必要に応じてリンクを確立してから仮想接続を開始する。
- 同一セッションが既にある場合は既存ストリームを返す。
- 接続は既定 10 秒でタイムアウトし、Promise を reject する。

### 12.2 VirtualStream

```ts
send(data: Uint8Array | string): Promise<void>
close(): void
on('connect' | 'data' | 'close' | 'drain' | 'error', listener): this
```

- `data` イベントの引数は `Uint8Array`。
- `drain` は未 ACK キューが空になったときに発火する。
- `close` は一度だけ発火する。

### 12.3 VirtualStream の制約

- パケット指向であり、バイトストリームではない。アプリケーションはメッセージ境界を自分で扱う必要がある。
- 1 メッセージが最大ペイロードを超える場合、アプリケーションが分割しなければならない (MUST)。M2 で自動分割を実装する。

## 13. バージョニング

- パケットの `version` フィールドで判別する。未知バージョンは破棄する。
- M1 は `version = 1`。破壊的変更はバージョンを上げる。
- NodeId の形式変更（公開鍵指紋化）はプロトコルバージョン 2 とする予定。

## 14. 非目標（M1 時点）

以下は本仕様の対象外であり、`plan.md` に将来課題として記録する。

- NameServer による名前解決、`webtcp://` URL スキーム、`domain.global`
- ブロックチェーンを用いたドメイン登録
- マルチホップ経路の最適化・輻輳制御
- HTTP/1.1・HTTP/2 の完全な実装
- ブラウザ外（Node.js）での WebRTC 実装の同梱
