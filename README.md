# WebTCP

**P2P接続のための実験的なWebRTCトンネリングライブラリ**

## 概要

WebTCPは、ブラウザを単なるクライアントではなく、**自己完結型のサーバー実行環境**として再定義するための実験的なライブラリです。従来のWebアプリケーションは、外部のクラウドサーバーに依存しています。本ライブラリは、WebRTC（Web Real-Time Communication）の**信頼性の高いデータチャネル（SCTP）を基盤とし、アプリケーション層で仮想的なTCP/HTTPトンネル**を構築することで、このパラダイムに挑戦します。

これにより、**Webブラウザ内で動作するサービス**に対し、他のデバイスから**直接**、セキュアにアクセスできるP2P接続を確立します。これは、未来の\*\*分散型コンピューティング（Web3）\*\*において、サービスが中央集権的なインフラストラクチャから解放されるための、**新しいネットワークの抽象化**を目指すものです。

ブラウザの制限付きの`fetch`を使っているわけではないので、TCPレイヤーから自由に通信を操ることができます。

## 主な機能

1.  **SCTP上の多重化 (Multiplexing)**: WebRTCの単一のデータチャネル上で、複数の仮想的なTCP接続をセッションIDにより多重化します。
2.  **仮想HTTPトンネリング**: 低レイヤーなバイトストリームを抽象化し、仮想的なHTTPリクエスト/レスポンスの送受信APIを提供します。
3.  **シグナリング抽象化**: 接続に必要な情報（SDP Offer/Answer）の交換プロセスを抽象化し、シグナリングサーバー（または外部手段）との連携を容易にします。

## コアプロトコル仕様 (WebTCP Protocol)

WebRTCのデータチャネル上で効率的なルーティングを実現するため、すべてのペイロードは以下の構造化されたヘッダーを持ちます。

| フィールド | 型 | 説明 |
| :--- | :--- | :--- |
| `type` | `string` | メッセージ種別 (`CONNECT`, `DATA`, `CLOSE`)。 |
| `port` | `number` | 仮想的な宛先ポート（例: 3000）。 |
| `id` | `number` | **仮想TCPセッションID**。単一のデータチャネル上での多重化に使用されます。 |
| `payload` | `string`/`base64` | 実際のアプリケーションデータ（HTTPリクエスト/レスポンスなど）。 |

## インストール

```bash
npm install @sonneko/webtcp-tunneler
```

## 利用方法

利用するには公開しているシグナリングサーバーを何らかのホスティングサービスでホストする必要があります。

```typescript
import TCPTunnel from '@sonneko/webtcp-tunneler';

// シグナリング情報の交換を担当するアダプタ
const signaling = new SignalingAdapter("https://web2webtcp-adapter.your-domain.com");

const tunnel = new TCPTunnel(signaling);

try {
    await tunnel.connect();
    tunnel.on((req, res) => {
        /* ... */
    });
    tunnel.send(/* ... */);
} catch (err) {
    console.error(err);
}

```

## 仕組み

