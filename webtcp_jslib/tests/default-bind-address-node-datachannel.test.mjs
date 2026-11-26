/**
 * 実 `node-datachannel` の既定バインドで、2 ノードが接続できること（#61 / 設計 §3.40）。
 *
 * 非ループバックがリンクローカルのみのホストで、既定（自動バインド）のままでは候補が 0 件になり接続できない。
 * 修正後は、そのホストでリンクローカルのアドレスへバインドして接続できる。
 * 他のホスト（ルーティング可能なアドレスがある）は既定のままで、この変更の対象外（設計 §3.40 の限界）。
 * ネイティブの PC は子プロセスで実行する（node --test のプロセスに載せない）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(here, 'helpers', 'node-datachannel-default-bind-probe.mjs');

function runProbe() {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [probe], { timeout: 60_000 }, (error, stdout) => {
            if (error) return reject(error);
            const line = stdout.trim().split('\n').pop();
            resolve(JSON.parse(line));
        });
    });
}

const result = await runProbe();
const skip = result.skipped ? result.skipped : false;

test(`default bind (#61): two node-datachannel peers connect with the default bind${skip ? ' (skipped)' : ''}`, { skip, timeout: 90_000 }, () => {
    assert.equal(result.connected, true, `the default bind must connect (elapsed ${result.elapsedMs} ms): ${result.message}`);
});

test(`default bind (#61): the link-local default is applied only without a user bindAddress (precedence)${skip ? ' (skipped)' : ''}`, { skip }, () => {
    assert.equal(result.defaultAppliedWithoutOption, true, 'without peerConnectionOptions the link-local default must be applied');
    assert.equal(result.defaultAppliedWithUserBind, false, 'a user bindAddress must suppress the default');
});
