import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ConsoleLogger,
    WebTCPNetwork,
    createLogger,
    noopLogger,
} from '../dist/index.js';
import { LoopbackNetwork } from './helpers/loopback.mjs';

const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

function createMemorySink() {
    const entries = [];
    const sink = {
        debug: (message, ...args) => entries.push({ level: 'debug', message, args }),
        info: (message, ...args) => entries.push({ level: 'info', message, args }),
        warn: (message, ...args) => entries.push({ level: 'warn', message, args }),
        error: (message, ...args) => entries.push({ level: 'error', message, args }),
    };
    return { entries, sink };
}

test('logger: default level is warn (suppresses debug and info)', () => {
    const { entries, sink } = createMemorySink();
    const logger = new ConsoleLogger({ sink });

    assert.equal(logger.getLevel(), 'warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    assert.deepEqual(
        entries.map((entry) => `${entry.level}:${entry.message}`),
        ['warn:w', 'error:e'],
    );
});

test('logger: level filtering works for debug, info, error, silent, and setLevel()', () => {
    const { entries, sink } = createMemorySink();
    const logger = createLogger({ level: 'debug', prefix: '[app]', sink });

    logger.debug('d1');
    logger.info('i1');
    logger.setLevel('error');
    logger.warn('w2');
    logger.error('e2');
    logger.setLevel('silent');
    logger.error('e3');

    assert.deepEqual(
        entries.map((entry) => `${entry.level}:${entry.message}`),
        ['debug:[app] d1', 'info:[app] i1', 'error:[app] e2'],
    );
});

test('logger: injected custom logger captures logs across WebTCPNetwork layers (#26)', async () => {
    const { entries, sink } = createMemorySink();
    const logger = createLogger({ level: 'debug', sink });

    const loopback = new LoopbackNetwork();
    const a = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_A),
        nodeId: NODE_A,
        logger,
        transport: { connectTimeoutMs: 1000 },
    });
    const b = new WebTCPNetwork({
        channel: loopback.createChannel(NODE_B),
        nodeId: NODE_B,
        logger: noopLogger,
        transport: { connectTimeoutMs: 1000 },
    });

    await a.start();
    await b.start();

    try {
        // 未リッスンポートへの接続で警告ログやデバッグログが注入ロガーに流れる
        await assert.rejects(() => a.connect(NODE_B, 9999), /reset|RST|closed/i);

        assert.ok(entries.some((e) => e.level === 'info' && e.message.includes('[NET]')));
        assert.ok(entries.some((e) => e.level === 'info' && e.message.includes('[LM]')));
        assert.ok(entries.some((e) => e.level === 'debug' && e.message.includes('[RL]')));
    } finally {
        a.close();
        b.close();
    }
});
