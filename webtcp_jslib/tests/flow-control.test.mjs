import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BinaryPacketSerializer,
    VirtualStream,
    WebTCPNetwork,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork, waitFor } from './helpers/loopback.mjs';

// 受信ウィンドウ（フロー制御、#56 / specification.md §8.3.4）のテスト。
// 検証は実行で行う: 実際のパケットを流し、受信バッファの量と配送の完了を確かめる。

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);
const KIB = 1024;
const MIB = 1024 * 1024;
const CAP = 256 * KIB;

function makePattern(size) {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
    return out;
}

/** 期限つきで待つ（失敗時に固まらないように）。 */
function within(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: not finished within ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function concat(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/**
 * ループバック上に 2 ノードを立てる。`streamOptions` は両ノードの VirtualStream 既定を上書きする。
 * `dropFromB(packet)` が true を返すパケットは B からの送信時に捨てる（窓更新の喪失を模す）。
 */
async function startPair({ streamA = {}, streamB = {}, dropFromA = null, dropFromB = null } = {}) {
    const loopback = new LoopbackNetwork();
    const wrap = (nodeId, drop) => {
        const base = loopback.createChannel(nodeId);
        if (!drop) return base;
        const serializer = new BinaryPacketSerializer();
        const origSend = base.send.bind(base);
        base.send = async (targetId, data) => {
            if (drop(serializer.deserialize(data))) return;
            return origSend(targetId, data);
        };
        return base;
    };
    const a = new WebTCPNetwork({
        channel: wrap(NODE_A, dropFromA),
        nodeId: NODE_A,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0, ...streamA } },
    });
    const b = new WebTCPNetwork({
        channel: wrap(NODE_B, dropFromB),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { stream: { timeWaitMs: 0, ...streamB } },
    });
    await Promise.all([a.start(), b.start()]);
    return { a, b };
}

/** 受信側: 指定バイト数になるまで読み続ける（読み取りは `readable` で駆動する）。 */
function readAllInto(stream, total, { onChunk } = {}) {
    const chunks = [];
    let received = 0;
    const done = new Promise((resolve) => {
        const pump = () => {
            let piece = stream.read();
            while (piece) {
                chunks.push(piece);
                received += piece.byteLength;
                if (onChunk) onChunk(piece);
                piece = stream.read();
            }
            if (received >= total) resolve(concat(chunks, received));
        };
        stream.on('readable', pump);
        pump();
    });
    return { done, received: () => received };
}

// ---------------------------------------------------------------------------
// 1. 再現: 読み手が止まっても受信バッファは上限を超えない（修正前は 2 MiB まで伸びる）
// ---------------------------------------------------------------------------

test('flow-control: a slow reader keeps the receive buffer within maxRecvBufferBytes and the sender is held back (#56 repro)', async () => {
    const { a, b } = await startPair({ streamB: { maxRecvBufferBytes: CAP } });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream; // 読み取りは行わない（読み手が止まっている状態）
        });

        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        const total = 2 * MIB;
        const payload = makePattern(total);
        void client.send(payload);

        // 送信が止まるまで待つ（窓が閉じると送信バッファに残りが溜まる）
        await waitFor(() => client.getStats().sendBufferBytes > 0, { timeoutMs: 5000 });
        // 初期 RTO（1000 ms）を超えて止める。窓を守る送信側は、受信側に捨てられるデータを送らないので再送は起きない。
        await new Promise((resolve) => setTimeout(resolve, 1600));

        assert.ok(
            serverStream.readableLength <= CAP,
            `receive buffer ${serverStream.readableLength} exceeds cap ${CAP}`,
        );
        assert.ok(
            client.getStats().sendBufferBytes > 0,
            'sender should still hold unsent bytes while the reader is stalled',
        );
        assert.equal(
            client.getStats().retransmissions,
            0,
            'a window-respecting sender never sends bytes the receiver must drop',
        );

        // 読み手が再開すると、全データが順序どおり届く
        const reader = readAllInto(serverStream, total);
        const received = await within(reader.done, 10000, 'slow reader resumed');
        assert.equal(received.byteLength, total);
        assert.deepEqual(received, payload);
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 2. 不正な相手（窓を無視して送る）: 受信側は上限を超えて格納しない（交渉の有無によらず）
// ---------------------------------------------------------------------------

test('flow-control: a peer that ignores the window cannot grow the receive buffer past maxRecvBufferBytes', () => {
    const sent = [];
    const context = {
        localNodeId: NODE_A,
        sendPacket: async (packet) => {
            sent.push(packet);
        },
        deregisterStream: () => {},
    };
    const stream = new VirtualStream(context, NODE_B, 1001, 80, false, {
        initialSeqNum: 20,
        logger: noopLogger,
        timeWaitMs: 0,
        maxRecvBufferBytes: CAP,
    });
    try {
        stream.handleIncomingPacket({ flags: 'SYN', seqNum: 200, ackNum: 0, payload: new Uint8Array(0) });
        stream.handleIncomingPacket({ flags: 'ACK', seqNum: 201, ackNum: 21, payload: new Uint8Array(0) });

        // 16 KiB ずつ 64 セグメント（計 1 MiB）を読まずに送り込む
        const seg = 16 * KIB;
        const body = makePattern(seg);
        for (let i = 0; i < 64; i += 1) {
            stream.handleIncomingPacket({
                flags: 'DATA',
                seqNum: (201 + i * seg) >>> 0,
                ackNum: 21,
                payload: body,
            });
        }
        assert.equal(stream.readableLength, CAP, 'only the first 256 KiB may be stored');
        assert.equal(stream.getStats().readableBytes, CAP);
    } finally {
        stream.destroy();
    }
});

// ---------------------------------------------------------------------------
// 3. シリアライザ: WIN（ビット 7）の往復。交渉しないパケットはビットを立てない
// ---------------------------------------------------------------------------

test('flow-control: the WIN flag (bit 7) round-trips and is absent from ordinary packets', () => {
    const serializer = new BinaryPacketSerializer();
    const base = {
        senderId: NODE_A,
        destinationId: NODE_B,
        ttl: 64,
        signature: new Uint8Array(0),
        sourcePort: 1001,
        destinationPort: 80,
        flags: 'ACK',
        seqNum: 5,
        ackNum: 9,
        payload: new Uint8Array([1, 2, 3, 4]),
    };

    const plain = serializer.serialize(base);
    assert.equal(plain[3] & 0x80, 0, 'ordinary packets must not set bit 7');
    assert.equal('windowFlag' in serializer.deserialize(plain), false);

    const win = serializer.serialize({ ...base, windowFlag: true });
    assert.equal(win[3], plain[3] | 0x80);
    const decoded = serializer.deserialize(win);
    assert.equal(decoded.windowFlag, true);
    assert.equal(decoded.flags, 'ACK');
    assert.deepEqual([...decoded.payload], [1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// 4. 交渉: 両側が対応していれば窓付きで通信し、統計に反映される
// ---------------------------------------------------------------------------

test('flow-control: both sides negotiate the window and report it in getStats()', async () => {
    const { a, b } = await startPair({ streamB: { maxRecvBufferBytes: CAP } });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
        });
        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);
        await client.send('hello');
        await waitFor(() => serverStream.readableLength === 5);

        const clientStats = client.getStats();
        const serverStats = serverStream.getStats();
        assert.equal(clientStats.windowNegotiated, true);
        assert.equal(serverStats.windowNegotiated, true);
        assert.equal(serverStats.maxRecvBufferBytes, CAP);
        assert.equal(serverStats.recvWindowBytes, CAP - 5);
        assert.equal(clientStats.peerWindowBytes > 0, true);
        client.end();
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 5. 窓更新の喪失: 読み手が再開した時の窓更新 ACK を捨てても、問い合わせで送信が進む
// ---------------------------------------------------------------------------

test('flow-control: a lost window update does not stall the sender (window probe recovers it)', async () => {
    let dropping = false;
    const { a, b } = await startPair({
        streamA: { initialRtoMs: 200, minRtoMs: 200 },
        streamB: { maxRecvBufferBytes: CAP, initialRtoMs: 200, minRtoMs: 200 },
        // B からの純粋な ACK（窓更新・応答・問い合わせへの返事）をすべて捨てる期間を作る
        dropFromB: (packet) => dropping && packet.flags === 'ACK',
    });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
        });
        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        const total = 1 * MIB;
        const payload = makePattern(total);
        void client.send(payload);
        await waitFor(() => serverStream.readableLength === CAP, { timeoutMs: 5000 });

        // 読み取りを始め、その間に B からの ACK をすべて捨てる（窓更新は届かない）
        dropping = true;
        const reader = readAllInto(serverStream, total);
        await new Promise((resolve) => setTimeout(resolve, 400));
        dropping = false;

        const received = await within(reader.done, 8000, 'lost window update');
        assert.equal(received.byteLength, total);
        assert.deepEqual(received, payload);
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 6. 旧実装との互換（フォールバック）: 片側が窓を交渉しなくても通信できる
// ---------------------------------------------------------------------------

test('flow-control: a peer that does not negotiate the window still transfers data both ways (fallback)', async () => {
    const { a, b } = await startPair({
        streamA: { windowNegotiation: false },
        streamB: { maxRecvBufferBytes: CAP },
    });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
            stream.on('data', (chunk) => stream.send(chunk)); // エコー
        });
        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        const payload = makePattern(512 * KIB);
        const echoed = [];
        let echoedBytes = 0;
        client.on('data', (chunk) => {
            echoed.push(chunk);
            echoedBytes += chunk.byteLength;
        });
        await client.send(payload);
        await waitFor(() => echoedBytes === payload.byteLength, { timeoutMs: 10000 });
        assert.deepEqual(concat(echoed, echoedBytes), payload);

        assert.equal(client.getStats().windowNegotiated, false);
        assert.equal(serverStream.getStats().windowNegotiated, false);
        assert.equal(client.getStats().peerWindowBytes, null);
        client.end();
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 7. readExact(bytes) は受信バッファに収まらない量を拒否する（待ち続けて固まらないように）
// ---------------------------------------------------------------------------

test('flow-control: readExact larger than maxRecvBufferBytes is rejected with RangeError', async () => {
    const context = { localNodeId: NODE_A, sendPacket: async () => {}, deregisterStream: () => {} };
    const stream = new VirtualStream(context, NODE_B, 1001, 80, false, {
        initialSeqNum: 20,
        logger: noopLogger,
        timeWaitMs: 0,
        maxRecvBufferBytes: CAP,
    });
    // 修正前は reject せず待ち続けるため、期限で失敗させる（ハングさせない）
    const outcome = await Promise.race([
        stream.readExact(CAP + 1).then(
            () => 'resolved',
            (error) => (error instanceof RangeError ? 'RangeError' : `other: ${error.message}`),
        ),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 1000)),
    ]);
    stream.destroy();
    assert.equal(outcome, 'RangeError');
});

// ---------------------------------------------------------------------------
// 8. 窓更新の即時性: 読み手が読み続けるとき、窓更新 ACK で送信側が RTO を待たずに再開する
// ---------------------------------------------------------------------------

test('flow-control: window updates resume a bursty reader without waiting for the window probe interval', async () => {
    // 問い合わせの間隔（≥ minRtoMs）を 2 秒にする。窓更新が無ければ、窓が開くたびに最大 2 秒待つ。
    const rto = { initialRtoMs: 2000, minRtoMs: 2000 };
    const { a, b } = await startPair({
        streamA: rto,
        streamB: { maxRecvBufferBytes: CAP, ...rto },
    });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
        });
        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        const total = 1 * MIB;
        const payload = makePattern(total);
        const started = Date.now();
        void client.send(payload);

        // 読み手は窓が閉じるまで待ってから一気に読む（4 回の開閉）
        const chunks = [];
        let received = 0;
        while (received < total) {
            await waitFor(
                () => serverStream.readableLength >= CAP || received + serverStream.readableLength >= total,
                { timeoutMs: 10000 },
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            let piece = serverStream.read();
            while (piece) {
                chunks.push(piece);
                received += piece.byteLength;
                piece = serverStream.read();
            }
        }
        const elapsed = Date.now() - started;
        assert.deepEqual(concat(chunks, received), payload);
        // 窓更新があれば、読み取りのたびに送信側がすぐ再開する（約 1 秒未満）。無ければ窓の開閉ごとに 2 秒の問い合わせを待つ。
        assert.ok(elapsed < 3000, `transfer took ${elapsed} ms; window updates should resume the sender promptly`);
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 9. 損失 + 遅い読み手: 先頭の欠損があっても、順序外データで受信バッファが埋まって止まらない
//    （相互運用試験で見つかった欠陥の回帰テスト。修正前は、欠損セグメントが空きに入らず永久に止まった）
// ---------------------------------------------------------------------------

test('flow-control: a lost DATA segment with a slow reader does not stall the transfer (head-of-line gap is admitted)', async () => {
    let dataCount = 0;
    let dropped = false;
    const { a, b } = await startPair({
        streamB: { maxRecvBufferBytes: CAP },
        dropFromA: (packet) => {
            if (packet.flags !== 'DATA' || dropped) return false;
            dataCount += 1;
            if (dataCount === 3) {
                dropped = true; // 3 番目の DATA を 1 回だけ捨てる（以降は順序外になる）
                return true;
            }
            return false;
        },
    });
    try {
        let serverStream = null;
        b.listen(8080, (stream) => {
            serverStream = stream;
        });
        const client = await a.connect(NODE_B, 8080);
        await waitFor(() => serverStream !== null);

        const total = 1 * MIB;
        const payload = makePattern(total);
        void client.send(payload);

        // 読み手は少し待ってから読む（その間に順序外データが受信バッファを埋める）
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const reader = readAllInto(serverStream, total);
        const received = await within(reader.done, 10000, 'head-of-line gap');

        assert.equal(dropped, true, 'the test must actually lose a segment');
        assert.equal(received.byteLength, total);
        assert.deepEqual(received, payload);
        client.end();
    } finally {
        a.close();
        b.close();
    }
});

// ---------------------------------------------------------------------------
// 10. 決定的な回帰テスト（相互運用で見つかった欠陥）: 順序外データが受信バッファを満杯にし、
//     その後に先頭の欠損セグメントが届く。欠損は格納されなければならず、保持量は上限を超えない。
//     （修正前は欠損が「空きなし」で破棄され、順序外データが解放されず永久に止まった）
// ---------------------------------------------------------------------------

test('flow-control: a head-of-line gap arriving after out-of-order data fills the buffer is admitted within the cap', () => {
    const sent = [];
    const context = {
        localNodeId: NODE_A,
        sendPacket: async (packet) => {
            sent.push(packet);
        },
        deregisterStream: () => {},
    };
    const stream = new VirtualStream(context, NODE_B, 1001, 80, false, {
        initialSeqNum: 20,
        logger: noopLogger,
        timeWaitMs: 0,
        maxRecvBufferBytes: CAP,
    });
    try {
        stream.handleIncomingPacket({ flags: 'SYN', seqNum: 200, ackNum: 0, payload: new Uint8Array(0) });
        stream.handleIncomingPacket({ flags: 'ACK', seqNum: 201, ackNum: 21, payload: new Uint8Array(0) });

        const seg = 16 * KIB;
        // 先頭（index 0）は欠損。index 1..16 の順序外 16 セグメントで受信バッファがちょうど満杯になり、
        // 先頭の欠損には 16 KiB の空きが必要になる（押し出しが無いと格納量が上限を超えるか拒否される）。
        const count = CAP / seg + 1;
        const full = makePattern(count * seg);
        const chunk = (i) => full.subarray(i * seg, (i + 1) * seg);
        const seqOf = (i) => (201 + i * seg) >>> 0;

        for (let i = 1; i < count; i += 1) {
            stream.handleIncomingPacket({ flags: 'DATA', seqNum: seqOf(i), ackNum: 21, payload: chunk(i) });
        }
        assert.equal(stream.readableLength, 0, 'nothing is deliverable before the head gap is filled');

        // 先頭の欠損が届く（受信バッファは順序外データで満杯）
        stream.handleIncomingPacket({ flags: 'DATA', seqNum: seqOf(0), ackNum: 21, payload: chunk(0) });
        assert.ok(
            stream.readableLength <= CAP,
            `stored bytes must stay within maxRecvBufferBytes (got ${stream.readableLength})`,
        );
        assert.ok(stream.readableLength > 0, 'the head gap must be admitted, so that the stream makes progress');

        // 押し出された末尾は送信側の再送で届く。最後まで順序通りに読める。
        const chunks = [];
        const drain = () => {
            let p = stream.read();
            while (p) {
                chunks.push(p);
                p = stream.read();
            }
        };
        drain();
        stream.handleIncomingPacket({ flags: 'DATA', seqNum: seqOf(count - 1), ackNum: 21, payload: chunk(count - 1) });
        drain();

        const out = new Uint8Array(full.byteLength);
        let o = 0;
        for (const c of chunks) {
            out.set(c, o);
            o += c.byteLength;
        }
        assert.equal(o, full.byteLength, 'every byte must be delivered');
        assert.deepEqual(out, full);
    } finally {
        stream.destroy();
    }
});

