---
title: NAT 越えと STUN / TURN 設定
description: iceServers の設定、TURN 資格情報の動的取得フック（iceServersProvider）、自動 ICE 再起動の仕組みと NAT 越えの指針。
---

## 既定の挙動

`BrowserWebRTCChannel` / `createBrowserNetwork` の `iceServers` 既定値は **`[]`（空配列）** です。
同一ホスト・同一 LAN 内のテストでは追加設定なしで動作しますが、インターネット越しの P2P 接続では STUN / TURN サーバーの設定が必要です。

## NAT タイプ別の推奨構成

| 環境 | 必要な ICE サーバー | 備考 |
| :--- | :--- | :--- |
| 同一ホスト・同一 LAN | なし（`iceServers: []`） | ホスト候補（mDNS / ローカル IP）で直接接続 |
| 一般的な家庭用ルーター（Full/Restricted Cone NAT） | **STUN** | パブリック IP・ポートの発見に利用 |
| 企業ファイアウォール / モバイル回線（Symmetric NAT） | **STUN + TURN** | 直接接続できない場合にリレー経由で通信 |

## 静的 `iceServers` の指定

```ts
import {
  EXAMPLE_STUN_ICE_SERVERS,
  SignalingAdapterHub,
  createBrowserNetwork,
} from '@sonneko/webtcp-tunneler';

const signaling = new SignalingAdapterHub({ url: 'https://hub.example.com' });
const network = createBrowserNetwork({
  signaling,
  iceServers: [
    ...EXAMPLE_STUN_ICE_SERVERS,
    {
      urls: 'turns:turn.example.com:5349',
      username: 'static-user',
      credential: 'static-password',
    },
  ],
});
```

## TURN 資格情報の動的取得フック（`iceServersProvider`）

本番運用では、静的パスワードをクライアントへ埋め込むのではなく、HMAC 署名付きの短期有効期限資格情報（coturn の `--use-auth-secret` 等）を API から都度発行する構成が推奨されます。

`iceServersProvider` を指定すると、**新規 `RTCPeerConnection` 生成時**および**ICE 再起動時**に自動的に呼び出されます。

```ts
const network = createBrowserNetwork({
  signaling,
  iceServersProvider: async () => {
    const res = await fetch('https://api.example.com/turn-credentials', {
      credentials: 'include',
    });
    const { iceServers } = await res.json();
    return iceServers;
  },
  maxIceRestarts: 2,
  iceRestartDelayMs: 3000,
});
```

## 接続失敗時の自動 ICE 再起動

`WebRTCChannel` は `iceConnectionState` と `connectionState` を監視します。

1. `iceConnectionState === 'failed'` を検知、または `'disconnected'` が `iceRestartDelayMs`（既定 3000 ms）継続すると、自動的に ICE 再起動を開始します。
2. `iceServersProvider` が設定されている場合、最新の TURN 資格情報を再取得して `RTCPeerConnection.setConfiguration({ iceServers })` を適用します。
3. `createOffer({ iceRestart: true })` で再ネゴシエーションを行い、受信側も既存の `RTCPeerConnection` 上でそのまま `Answer` を返します（**既存の DataChannel と `VirtualStream` を維持したまま経路を復旧**できます）。
4. `maxIceRestarts`（既定 2 回、`0` で無効）を超過して失敗した場合はピアを破棄し、`connection-status(false)` を発火します。

また、`WebRTCChannel.restartIce(peerId)` でアプリケーション側から明示的に ICE 再起動を実行することもできます。
