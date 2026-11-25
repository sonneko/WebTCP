/**
 * 実 `node-datachannel/polyfill` での `icecandidate` の橋渡し（#67 / 設計 §3.38）。
 *
 * 各シナリオは子プロセス（tests/helpers/icecandidate-bridge-probe.mjs）で実行する。
 * ネイティブの PC がイベントループを保持するため、子で実行して `process.exit` で終わらせる。
 * `raw` は橋渡しを入れない修正前の経路（上流の挙動）、`bridged` は `createNodeNetwork()` と同じ橋渡し。
 * パッケージが無い環境では skip する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('./helpers/icecandidate-bridge-probe.mjs', import.meta.url));

function runProbe(mode, bind) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [probe, mode, bind], { timeout: 90_000 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`probe ${mode}/${bind} failed: ${error.message}\n${stderr}`));
            resolve(JSON.parse(stdout.trim().split('\n').pop()));
        });
    });
}

test('icecandidate bridge (node-datachannel): raw (before) late listeners get nothing; bridged (after) get every candidate and one end marker', { timeout: 150_000 }, async (t) => {
    const before = await runProbe('raw', 'loopback');
    if (before.skipped) return t.skip(before.skipped);
    const after = await runProbe('bridged', 'loopback');
    t.diagnostic(`before (raw): ${JSON.stringify(before)}`);
    t.diagnostic(`after (bridged): ${JSON.stringify(after)}`);

    assert.ok(before.sdpCandidates >= 1, 'loopback bind gathers at least one candidate');
    // before: upstream behaviour (pinned by tests/node-datachannel-polyfill.characterization.test.mjs)
    assert.equal(before.early.candidate, before.sdpCandidates);
    assert.equal(before.late.candidate, 0);
    assert.equal(before.lateProperty.candidate, 0);

    // after: the bridge delivers the candidates to every listener, and the end marker once
    for (const key of ['early', 'late', 'lateProperty']) {
        assert.equal(after[key].candidate, after.sdpCandidates, `${key} candidate count`);
        assert.equal(after[key].null, 1, `${key} end marker count`);
    }
    assert.equal(after.endAfterCandidates, true);
});

test('icecandidate bridge (node-datachannel): with zero candidates (auto-bind on a link-local-only host), the end marker still arrives once', { timeout: 150_000 }, async (t) => {
    const after = await runProbe('bridged', 'auto');
    if (after.skipped) return t.skip(after.skipped);
    t.diagnostic(`auto-bind (bridged): ${JSON.stringify(after)}`);
    for (const key of ['early', 'late', 'lateProperty']) {
        assert.equal(after[key].candidate, after.sdpCandidates, `${key} candidate count equals the SDP count`);
        assert.equal(after[key].null, 1, `${key} end marker count`);
    }
    assert.equal(after.endAfterCandidates, true);
});
