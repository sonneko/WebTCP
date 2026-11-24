// Characterization of the upstream node-datachannel/polyfill ICE event timing (#67).
//
// These tests pin the behaviour of a third-party polyfill, not of WebTCP code. If upstream
// changes (for example, it starts replaying candidate events or dispatches the end-of-candidates
// event), these fail and spec §19.8 / design §3.31 must be revisited.
//
// Each scenario runs in a child process (tests/helpers/node-datachannel-probe.mjs) because the
// native peer connection keeps the event loop alive and the child must exit explicitly.
// Skipped unless `node-datachannel` is installed (npm install --no-save node-datachannel).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('./helpers/node-datachannel-probe.mjs', import.meta.url));

function runScenario(scenario) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [probe, scenario], { timeout: 60_000 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`probe ${scenario} failed: ${error.message}\n${stderr}`));
            const line = stdout.trim().split('\n').pop();
            resolve(JSON.parse(line));
        });
    });
}

// Probe once up front so the whole file is skipped when the package is absent.
const availability = await runScenario('early');
const skip = availability.skipped ? availability.skipped : false;

test('characterization #67 (a): listeners registered right after construction receive every candidate, by both mechanisms', { skip }, async (t) => {
    const result = availability;
    t.diagnostic(
        `(a) sdpCandidateLines=${result.sdpCandidateLines} addEventListener.candidate=${result.addEventListener.candidate} onicecandidate.candidate=${result.onicecandidate.candidate}`,
    );
    assert.equal(result.gathering, 'complete');
    assert.ok(result.sdpCandidateLines >= 1, 'the SDP must contain at least one candidate');
    assert.equal(result.addEventListener.candidate, result.sdpCandidateLines);
    assert.equal(result.onicecandidate.candidate, result.sdpCandidateLines);
});

test('characterization #67 (b): listeners registered hundreds of ms late receive none of the candidates, by either mechanism', { skip }, async (t) => {
    const result = await runScenario('late');
    t.diagnostic(
        `(b) sdpCandidateLines=${result.sdpCandidateLines} late addEventListener.candidate=${result.addEventListener.candidate} late onicecandidate.candidate=${result.onicecandidate.candidate} gatheringBeforeAttach=${result.gatheringBeforeAttach}`,
    );
    assert.equal(result.gatheringBeforeAttach, 'complete', 'gathering completes before the late registration');
    assert.ok(result.sdpCandidateLines >= 1, 'the SDP still contains the candidate, so the loss is not an empty gathering');
    assert.equal(result.addEventListener.candidate, 0);
    assert.equal(result.onicecandidate.candidate, 0);
});

test('characterization #67 (c): the end-of-candidates event (candidate === null) is never dispatched', { skip }, async (t) => {
    const result = await runScenario('null-check');
    t.diagnostic(
        `(c) gathering=${result.gathering} null events: addEventListener=${result.addEventListener.null} onicecandidate=${result.onicecandidate.null}`,
    );
    assert.equal(result.gathering, 'complete');
    assert.equal(result.addEventListener.null, 0, 'no end-of-candidates event on addEventListener');
    assert.equal(result.onicecandidate.null, 0, 'no end-of-candidates event on onicecandidate');
});
