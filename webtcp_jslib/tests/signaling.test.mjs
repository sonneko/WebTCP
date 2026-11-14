import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EntranceSearcherAdapterHub,
    SignalingAdapterHub,
} from '../dist/index.js';
import { startHub } from './helpers/hub.mjs';

const A = '1'.repeat(32);
const B = '2'.repeat(32);

test('signaling: messages are delivered between two adapters', async () => {
    const hub = await startHub();
    const url = hub.url;

    const a = new SignalingAdapterHub({ url, nodeId: A, pollIntervalMs: 20 });
    const b = new SignalingAdapterHub({ url, nodeId: B, pollIntervalMs: 20 });

    try {
        await a.listen(() => {});

        const received = [];
        await b.listen((fromId, message) => {
            received.push({ fromId, message });
        });

        await a.sendMessage(B, {
            type: 'offer',
            content: { sdp: 'v=0' },
            fromId: A,
        });

        await waitUntil(() => received.length === 1);
        assert.equal(received[0].fromId, A);
        assert.equal(received[0].message.type, 'offer');
        assert.deepEqual(received[0].message.content, { sdp: 'v=0' });
    } finally {
        a.close();
        b.close();
        await hub.close();
    }
});

test('signaling: the entrance searcher discovers active nodes', async () => {
    const hub = await startHub();
    const url = hub.url;

    const a = new SignalingAdapterHub({ url, nodeId: A, pollIntervalMs: 20 });
    const searcher = new EntranceSearcherAdapterHub({ url });

    try {
        await a.listen(() => {});
        const nodes = await searcher.search();
        assert.deepEqual(nodes, [A]);
    } finally {
        a.close();
        await hub.close();
    }
});

test('signaling: a failed send rejects', async () => {
    const adapter = new SignalingAdapterHub({
        url: 'http://127.0.0.1:1',
        nodeId: A,
    });

    await assert.rejects(
        adapter.sendMessage(B, { type: 'offer', content: {}, fromId: A }),
        /Failed to send|fetch failed|ECONNREFUSED/i,
    );
});

async function waitUntil(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitUntil: condition was not met');
}
