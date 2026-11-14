import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
    WebTCPNetwork,
    noopLogger,
} from '../dist/index.js';
import { startHub } from './helpers/hub.mjs';
import { LoopbackNetwork } from './helpers/loopback.mjs';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const DEAD = 'd'.repeat(32);

test('bootstrap: tries candidates sequentially and falls back to working peer (#27)', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({ channel: loopback.createChannel(A), nodeId: A, logger: noopLogger });
    const b = new WebTCPNetwork({ channel: loopback.createChannel(B), nodeId: B, logger: noopLogger });
    await b.start();

    const searcher = {
        async search() {
            // 自身と存在しないノードの後に稼働中ノード B が来る
            return [A, DEAD, B];
        },
    };

    try {
        const result = await a.bootstrap(searcher, { maxRetries: 2, initialBackoffMs: 10 });
        assert.deepEqual(result.connected, [B]);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].nodeId, DEAD);
        assert.equal(result.attempts, 1);
        assert.deepEqual(a.getNeighbors(), [B]);
    } finally {
        a.close();
        b.close();
    }
});

test('bootstrap: retries with exponential backoff until a candidate succeeds (#27)', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({ channel: loopback.createChannel(A), nodeId: A, logger: noopLogger });
    const b = new WebTCPNetwork({ channel: loopback.createChannel(B), nodeId: B, logger: noopLogger });
    await a.start();
    await b.start();

    let searchCalls = 0;
    const searcher = {
        async search() {
            searchCalls += 1;
            if (searchCalls === 1) return [];
            if (searchCalls === 2) return [DEAD];
            return [B];
        },
    };

    const recordedDelays = [];

    try {
        const result = await a.bootstrap(searcher, {
            maxRetries: 4,
            initialBackoffMs: 100,
            backoffFactor: 2,
            maxBackoffMs: 500,
            sleep: async (ms) => {
                recordedDelays.push(ms);
            },
        });

        assert.deepEqual(result.connected, [B]);
        assert.equal(result.attempts, 3);
        assert.deepEqual(recordedDelays, [100, 200]);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].nodeId, DEAD);
    } finally {
        a.close();
        b.close();
    }
});

test('bootstrap: supports targetConnections > 1 and AbortSignal (#27)', async () => {
    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({ channel: loopback.createChannel(A), nodeId: A, logger: noopLogger });
    const b = new WebTCPNetwork({ channel: loopback.createChannel(B), nodeId: B, logger: noopLogger });
    const c = new WebTCPNetwork({ channel: loopback.createChannel(C), nodeId: C, logger: noopLogger });
    await Promise.all([a.start(), b.start(), c.start()]);

    try {
        const result = await a.bootstrap(
            { search: async () => [B, C] },
            { targetConnections: 2, maxRetries: 1 },
        );
        assert.deepEqual(result.connected, [B, C]);
        assert.equal(result.attempts, 1);

        // AbortSignal で即座に中断できる
        const controller = new AbortController();
        const emptySearcher = { search: async () => [] };
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(
            () =>
                a.bootstrap(emptySearcher, {
                    maxRetries: 5,
                    initialBackoffMs: 5000,
                    signal: controller.signal,
                }),
            /aborted/i,
        );
    } finally {
        a.close();
        b.close();
        c.close();
    }
});

test('entrance searcher: exclude option omits self from /entrances (#32)', async () => {
    const hub = await startHub();
    const sA = new SignalingAdapterHub({ url: hub.url, nodeId: A, pollIntervalMs: 50, logger: noopLogger });
    const sB = new SignalingAdapterHub({ url: hub.url, nodeId: B, pollIntervalMs: 50, logger: noopLogger });

    try {
        await sA.listen(() => {});
        await sB.listen(() => {});

        const searcher = new EntranceSearcherAdapterHub({ url: hub.url, exclude: A });
        const nodes = await searcher.search();
        assert.deepEqual(nodes, [B]);
    } finally {
        sA.close();
        sB.close();
        await hub.close();
    }
});
