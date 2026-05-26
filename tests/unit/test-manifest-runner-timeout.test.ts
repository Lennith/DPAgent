import * as assert from 'node:assert/strict';
import { DEFAULT_TEST_MANIFEST_ENTRY_TIMEOUT_MS, resolveEntryTimeoutMs, runEntry } from '../../scripts/lib/test-manifest-runner.js';
import { DEFAULT_RELEASE_E2E_CASE_TIMEOUT_MS, buildAggregate, resolveReleaseCaseTimeoutMs, runCase } from '../../scripts/lib/release-e2e-gate-core.js';
import type { TestManifestEntry } from '../test-manifest.js';

function createSlowEntry(id: string, timeoutMs: number): TestManifestEntry {
  return {
    id,
    suite: 'unit',
    command: 'node -e "setTimeout(() => {}, 1000)"',
    files: ['tests/unit/test-manifest-runner-timeout.test.ts'],
    tags: ['timeout-test'],
    timeoutMs,
  };
}

function run(): void {
  assert.equal(resolveEntryTimeoutMs({ timeoutMs: 1234 }), 1234);
  assert.equal(resolveEntryTimeoutMs({ timeoutMs: 0 }), DEFAULT_TEST_MANIFEST_ENTRY_TIMEOUT_MS);
  assert.equal(resolveReleaseCaseTimeoutMs({ timeoutMs: 4321 }), 4321);
  assert.equal(resolveReleaseCaseTimeoutMs({ timeoutMs: -1 }), DEFAULT_RELEASE_E2E_CASE_TIMEOUT_MS);

  const aggregate = buildAggregate({
    generatedAt: '2026-05-16T00:00:00.000Z',
    sourceCommitSha: 'abc123',
    requiredCases: ['e2e:timeout'],
    cases: [
      {
        id: 'e2e:timeout',
        command: 'node slow-test.js',
        files: ['tests/e2e/slow-test.e2e.ts'],
        tags: ['release-gate'],
        status: 'failed',
        durationMs: 100,
        timeoutMs: 50,
        timedOut: true,
        exitCode: null,
        signal: 'SIGTERM',
        errorMessage: 'spawnSync ETIMEDOUT',
      },
    ],
  });
  assert.equal(aggregate.gatePassed, false);
  assert.equal(aggregate.cases[0]?.timedOut, true);
  assert.equal(aggregate.cases[0]?.timeoutMs, 50);

  assert.throws(
    () => runEntry(createSlowEntry('unit:timeout', 50)),
    /timed out after 50ms/
  );

  const releaseResult = runCase(createSlowEntry('e2e:timeout-real', 50));
  assert.equal(releaseResult.status, 'failed');
  assert.equal(releaseResult.timedOut, true);
  assert.equal(releaseResult.timeoutMs, 50);
  assert.match(releaseResult.errorMessage ?? '', /timed out|ETIMEDOUT/i);
}

run();
console.log('test manifest runner timeout tests passed');
