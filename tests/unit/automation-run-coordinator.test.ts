import * as assert from 'node:assert/strict';
import { AutomationRunCoordinator } from '../../src/automation/AutomationRunCoordinator.js';
import type { AutomationRunRecord } from '../../src/types.js';

function testFindActiveRun(): void {
  const runs: AutomationRunRecord[] = [
    {
      id: 'done',
      jobId: 'job-1',
      sessionId: '',
      status: 'succeeded',
      triggerAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
    },
    {
      id: 'active',
      jobId: 'job-1',
      sessionId: '',
      status: 'running',
      triggerAt: '2026-01-01T00:01:00.000Z',
      startedAt: '2026-01-01T00:01:00.000Z',
    },
  ];
  assert.equal(AutomationRunCoordinator.findActiveRun(runs)?.id, 'active');
}

function testOverlapSkipRecordShape(): void {
  const skipped = AutomationRunCoordinator.createOverlapSkipRecord({
    jobId: 'job-1',
    triggerAt: '2026-01-01T00:00:00.000Z',
    triggerSource: 'manual',
    now: new Date('2026-01-01T00:00:02.000Z'),
  });
  assert.match(skipped.id, /^run-\d+-[a-f0-9]{8}$/);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.triggerSource, 'manual');
  assert.equal(skipped.skippedReason, 'overlap_running');
  assert.equal(skipped.startedAt, skipped.completedAt);
}

function runAll(): void {
  testFindActiveRun();
  testOverlapSkipRecordShape();
  console.log('automation-run-coordinator tests passed');
}

runAll();
