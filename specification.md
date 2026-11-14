# WebTCP プロトコル仕様書

| 項目 | 内容 |
| :--- | :--- |
| 文書バージョン | 0.2.0 |
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
2. バイトストリーム指向の**順序保証・自動分割・再送・輻輳制御・半閉鎖**（TCP に相当する L4 機能）
3. シグナリング手段や STUN/TURN 設定を差し替え可能にする**リンク層の抽象化**
4. 将来のマルチホップルーティングおよび名前解決に耐える**L3 ヘッダー**

## 2. 用語

| 用語 | 定義 |
| :--- | :--- |
| ノード (Node) | WebTCP ネットワークに参加する 1 つの実行環境（通常は 1 ブラウザタブ）。`NodeId` で識別される。 |
| NodeId | ノードを一意に識別する文字列。M1–M2 では 128 ビットのランダム hex（32 文字）。M3 で公開鍵指紋に置き換える。 |
| 隣接ノード (Neighbor) | データチャネルが直接確立している相手ノード。 |
| 仮想ストリーム (VirtualStream) | 仮想 TCP セッション。`(remoteNodeId, localPort, remotePort)` で一意。 |
| 仮想ポート | アプリケーションを識別する 16 ビット整数（有効範囲 1–65535、0 は制御用予約）。 |
| リンク層 | データチャネルとシグナリングの抽象化。`IChannel` / `ISignalingAdapter`。 |
| ルーティング層 | 宛先ノードへの転送、TTL、署名検証、ルーティング情報交換。 |
| トランスポート層 | ポート多重化、セッション、バイトストリーム、再送、輻輳制御、状態機械。 |
| MSS | Maximum Segment Size。1 つの `DATA` パケットに載せる最大アプリケーションデータ長（既定 16 KiB、上限 60 KiB）。 |
| SACK | Selective Acknowledgment。順序外で受信済みのバイト範囲を送信側へ通知する拡張。 |

## 3. 準拠のキーワード

本書の「しなければならない (MUST)」「してはならない (MUST NOT)」「すべきである (SHOULD)」「してもよい (MAY)」は RFC 2119 に準ずる。

## 4. アーキテクチャ

```
+-----------------------------------------------------------+
| L7  アプリケーション (HTTP 風 API / 任意のプロトコル)        |
+-----------------------------------------------------------+
| L4  TransportLayer : ポート多重化 / SessionManager          |
|     VirtualStream  : 状態機械 / バイト単位 Seq-Ack / 分割    |
|                      動的 RTO / 輻輳制御 / Fast Retransmit  |
|                      SACK / Half-Close / 部分読み取り       |
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

- 形式: `^[0-9a-f]{32}$`（M1–M2）。実装は 16 バイトの乱数を hex 化する。
- ノードは自身の NodeId を 1 つだけ持つ。
- NodeId は**自己申告**であり、M1–M2 では暗号学的な検証を行わない。M3 で公開鍵指紋に移行する（§10）。
- シグナリングアダプタは `getLocalNodeId()` で同一の値を返さなければならない (MUST)。

### 5.2 仮想ポート

- 16 ビット符号なし整数。アプリケーションが `listen()` / `connect()` で指定できる有効範囲は `1–65535` とする（`0` は `RT_UPDATE` 等の制御パケット用に予約され、`listen()` / `connect()` では拒否しなければならない (MUST)）。
- 1024 未満は将来の予約（HTTP=80, HTTPS=443 相当）として扱い、アプリケーションが明示しない限り使用しないことが望ましい (SHOULD)。
- クライアント側のローカルポートは 49152–65535 から自動割り当てし、既存のアクティブセッションと衝突しないポートを選択する (SHOULD)。

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
| 8 | 4 | `seqNum` | uint32 | シーケンス番号（バイト単位、mod 2^32、§8.3）。 |
| 12 | 4 | `ackNum` | uint32 | 次に期待する受信シーケンス番号（バイト単位、mod 2^32）。 |
| 16 | 1 | `senderIdLen` | uint8 | `senderId` の UTF-8 バイト長（1–255）。 |
| 17 | 1 | `destIdLen` | uint8 | `destinationId` の UTF-8 バイト長（1–255）。 |
| 18 | 2 | `signatureLen` | uint16 | `signature` のバイト長。M1–M2 は 0。 |
| 20 | 4 | `payloadLen` | uint32 | `payload` のバイト長。 |
| 24 | var | `senderId` | UTF-8 | 送信元 NodeId。 |
| … | var | `destinationId` | UTF-8 | 最終宛先 NodeId。 |
| … | var | `signature` | bytes | 署名（M1–M2 は空）。 |
| … | var | `payload` | bytes | アプリケーションデータまたは制御ペイロード（`RT_UPDATE` JSON、`ACK` の SACK オプション）。 |

固定ヘッダー長は 24 バイト。合計長 = `24 + senderIdLen + destIdLen + signatureLen + payloadLen`。

### 6.2 受信時の検証

受信側は次を検証し、いずれかに違反したパケットを**破棄しなければならない** (MUST)。

1. バッファ長が 24 バイト以上である。
2. `magic == 0x57` かつ `version == 1`。
3. 宣言された各長の合計がバッファ長と**厳密に一致する**。
4. `senderId`, `destinationId` が空でない。
5. `payloadLen` が実装の上限（既定 60 KiB）以下である。
6. `flags` の下位 7 ビット（ビット 0–6）に既知のフラグが 1 つ以上立っている。

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

1. 署名付与（M1–M2 は Null 検証器により何もしない）。
2. `destinationId == localNodeId` ならトランスポート層へ渡して終了。
3. `ttl <= 0` のパケットは破棄する。
4. ルーティングテーブルから宛先エントリを取得。存在しなければ、宛先が**直接の隣接**であれば `cost=1` とみなす。それ以外は破棄し警告する。
5. `nextHop` へ `IChannel.send()` でシリアライズ済みバイト列を送る。

### 7.3 受信と RPF

受信側は次を行う。

1. デシリアライズ（失敗時は破棄）。
2. 署名検証（§10）。
3. `RT_UPDATE` パケットは `RoutingTableManager` へ渡し、トランスポート層へは渡さない。
4. **RPF (Reverse Path Forwarding)** チェック: 送信元への経路の nextHop が、実際に受信した隣接と一致することを確認する。ただし経路が未学習で、かつ受信元が直接の隣接である場合は許可する（M1–M2 の縮退動作）。それ以外は破棄。
5. `destinationId == localNodeId` ならトランスポート層へ渡して終了。
6. そうでなければ中継転送する: `ttl` を 1 減算し、`ttl <= 0` になった場合は破棄する (MUST)。残っていれば経路表の `nextHop` へ送信する。

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
- 受信側は送信元隣接ノード（`senderId`）の直接経路（`cost = 1`）の `lastSeen` を更新しなければならない (MUST)。
- 受信側は各エントリについて `cost + 1` を計算し、距離ベクトル方式で経路を更新する。現在のネクストホップが送信元と一致し、コストが同一である場合も `lastSeen` を更新しなければならない (MUST)（経路変化は発生しないため再ブロードキャストは行わない）。
- `withdrawals` は到達不能になった宛先のリストである。受信側は、その宛先の現在のネクストホップが送信元と一致する場合に限りエントリを削除する (MUST)。省略可能。
- 隣接が切断された場合、そのノードをネクストホップとする経路を削除し、`withdrawals` として全隣接へ通知する (MUST)。
- 経路表に実質的な変化（追加・削除・コスト変更）が発生した場合、全隣接ノードへ現在のテーブルを再送する。
- 30 秒ごとにメンテナンスを行い、60 秒以上更新のない `cost > 0` のエントリを削除する。削除したエントリは `withdrawals` として通知する。
- ルーティング情報パケットはトランスポート層へ渡してはならない (MUST NOT)。

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
- `destroy()` は `FIN` や `TIME_WAIT` を待たず即座に `CLOSED` へ遷移する。

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

## 10. セキュリティ

M1–M2 では次を**保証しない**。これは既知の制約であり、M3（#28）で解消する。

- NodeId の真正性（なりすまし可能）
- パケットの改ざん検知（`signature` は常に空）
- ペイロードの機密性（DTLS によるトランスポート暗号化のみ）

M3 の要件（予定）:

- NodeId = Ed25519 公開鍵の指紋。
- 送信時にヘッダーとペイロード（署名フィールドを除く）へ署名。
- 受信時に公開鍵を取得して検証。`KeyManager` インターフェース経由で鍵を解決する。
- 検証に失敗したパケットは破棄する。

## 11. エラー・ログ・既定値

### 11.1 ログ

コアおよびアダプタは `console.*` を直接呼び出さず、`Logger` インターフェース（`debug` / `info` / `warn` / `error`）経由で出力しなければならない (MUST)。

- 既定ロガーは `ConsoleLogger`（レベル `warn` 以上）。
- `WebTCPNetwork` / `createBrowserNetwork` / 各アダプタのオプションでカスタム `logger` または `logLevel`（`'debug' | 'info' | 'warn' | 'error' | 'silent'`）を注入できる。

### 11.2 エラー挙動

| 状況 | 挙動 |
| :--- | :--- |
| 不正なパケット | 破棄し、`warn` ログ。例外を上位へ伝播させない。 |
| 宛先不明 | 破棄し、`warn` ログ。 |
| 未リッスンポートへの SYN | RST を返す。 |
| 接続タイムアウト | `connect()` を reject。ストリームを破棄。 |
| 再送上限超過 | `error` イベント発火後 `CLOSED`。 |
| ストリーム `send()` が送信不可状態 | `Cannot send data. State is ...` で reject。 |
| 送信バッファ超過 | `Send buffer full` で reject。 |

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

## 12. 公開 API

### 12.1 WebTCPNetwork

```ts
new WebTCPNetwork({
  channel: IChannel,          // 必須
  signaling?: ISignalingAdapter,
  nodeId?: NodeId,
  serializer?: IPacketSerializer,
  verifier?: IPacketVerifier,
  routingTableManager?: RoutingTableManagerOptions,
  transport?: TransportLayerOptions,
  defaultTtl?: number,
  logger?: Logger,
  logLevel?: LogLevel,
})

start(): Promise<void>
listen(port: VirtualPort, handler: (stream: VirtualStream) => void): void
connect(remoteId: NodeId, remotePort: VirtualPort, localPort?: VirtualPort): Promise<VirtualStream>
connectToPeer(remoteId: NodeId): Promise<void>
bootstrap(searcher: IEntranceSearcher, options?: BootstrapOptions): Promise<BootstrapResult>
getNeighbors(): NodeId[]
getRoutingTable(): RoutingTable
close(): void
```

- `channel` は必須である。ブラウザでは `createBrowserNetwork({ signaling, iceServers?, iceServersProvider?, logger?, logLevel?, ... })` を使うと `BrowserWebRTCChannel` が自動で組み立てられる。
- `nodeId` を省略した場合、`signaling.getLocalNodeId()`、それも無ければランダム生成を使う。
- `connect()` は必要に応じてリンクを確立してから仮想接続を開始する。
- `bootstrap()` はエントランス探索結果から候補へ順次接続を試み、失敗時は指数バックオフでリトライする。
- 起動完了時に `'ready'` イベントを発火する。

### 12.2 VirtualStream

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

## 13. バージョニング

- パケットの `version` フィールドで判別する。未知バージョンは破棄する。
- M1–M2 は `version = 1`（24 バイト固定ヘッダーを維持し、SACK は `ACK` ペイロード拡張で後方互換を保つ）。
- NodeId の形式変更（公開鍵指紋化）および署名必須化はプロトコルバージョン 2 とする予定（M3）。

## 14. 非目標（M2 時点）

以下は本仕様の対象外であり、`plan.md` に将来課題として記録する。

- Ed25519 署名と NodeId の鍵指紋化（M3 / #28）
- NameServer による名前解決、`webtcp://` URL スキーム、`domain.global`、ブロックチェーン連携（M4–M5 / #25）
- HTTP/1.1・HTTP/2 の完全な実装
- ブラウザ外（Node.js）での WebRTC 実装の同梱
