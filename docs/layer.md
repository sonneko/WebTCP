# layer



```ts
import { WebTCPNetwork } from "@sonneko/webtcp";
import { HTTPRes } from "@sonneko/webtcp/http";
// localhost:8080でサーバーを起動しそれにアクセスする
const network = new WebTCPNetwork();

const connection = await network.connect();

connection.on(8080, (packet) => {
    console.log(packet.payload.message);
    return new HTTPRes(`<h1>Hello World</h1>`);
})

connection.send("webtcp://localhost:8080", {
    payload: JSON.stringify({
        message: "Hello World",
        status: "ok",
    }),
});
```

```ts
// WebTCPドメインを利用する
import { WebTCPNetwork, generateIp } from "@sonneko/webtcp";
import { BrowserWebRTCChannel } from "@sonneko/webtcp/channel";
import { HTTP2WebTCPAdapter } from "@sonneko/webtcp/adapter";
import { NameServer } from "@sonneko/webtcp/namesever";

const network = new WebTCPNetwork(
    new BrowserWebRTCChannel(),/* WebRTCを利用して通信をするためのチャンネル */
    new HTTP2WebTCPAdapter(),/* シグナリングを含むHTTPからWebTCPにアップグレードするためのクラス */
);

// ipはWebTCPにおけるIPアドレス。それぞれでランダムに生成する。
let ip = localStorage.getItem("WEBTCP_ip");
if (!ip) {
    ip = generateIp();
    localStrage.setItem("WEBTCP_ip", ip);
}
try {
    const connection = await network.connect(ip);
} catch (err) {
    // ipが他の人と被ったか、WebRTCを使った接続に失敗した。
    console.error(err);
}

// globalトップドメインはブロックチェーンを利用して実行される分散アプリケーションに使われる
// グローバル実行されるdomainサービスに対してドメインの新規登録を要請する
// ネームサーバーをこのデバイスの3000で実行していると報告する
connection.send("webtcp://domain.global/add/my-domain", {
    payload: `${ip}:3000`
});

// @はApexドメインを意味する
// NameServerを立てる
const ns = new NameServer([
    "CNAME @ -> www.my-domain.com",
    `A www.my-domain.com -> ${ip}:8080`,
]);
connection.on(3000, ns.on);

// 8080でwww.my-domain.comで動作するアプリケーションを動作させる必要がある
```