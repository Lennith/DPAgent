import * as assert from 'node:assert/strict';
import {
  applySubAgentHeartbeat,
  applySubAgentRunningTransition,
  applySubAgentTerminalTransition,
  isTerminalSubAgentStatus,
} from '../../src/subagent/SubAgentLifecycleReducer.js';
import type { SubAgentRecord } from '../../src/subagent/types.js';
import type { SubAgentResult } from '../../src/types.js';

function createRecord(): SubAgentRecord {
  return {
    id: 'suba-1',
    parentContext: { scope: 'session', namespace: 'parent' },
    parentKey: 'session:parent',
    context: { scope: 'global', namespace: 'sub:parent:suba-1' },
    status: 'queued',
    runSeq: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    providerId: 'local-default',
    queuePosition: 1,
  };
}

function createResult(status: SubAgentResult['status']): SubAgentResult {
  return {
    subagentId: 'suba-1',
    runSeq: 1,
    status,
    summary: 'done',
    artifacts: { files: [], commands: [], notes: [] },
    completedAt: '2026-01-01T00:00:03.000Z',
  };
}

function testRunningAndHeartbeatTransitions(): void {
  const record = createRecord();
  applySubAgentRunningTransition(record, '2026-01-01T00:00:01.000Z');
  assert.equal(record.status, 'running');
  assert.equal(record.queuePosition, undefined);
  assert.equal(record.lastHeartbeatAt, '2026-01-01T00:00:01.000Z');

  applySubAgentHeartbeat(record, '2026-01-01T00:00:02.000Z');
  assert.equal(record.updatedAt, '2026-01-01T00:00:02.000Z');
}

function testTerminalTransitionFreezesHeartbeat(): void {
  const record = createRecord();
  const result = createResult('failed');
  applySubAgentTerminalTransition(record, {
    status: 'failed',
    nowIso: '2026-01-01T00:00:03.000Z',
    error: 'boom',
    result,
  });
  assert.equal(record.status, 'failed');
  assert.equal(record.lastError, 'boom');
  assert.equal(record.latestResult, result);

  applySubAgentHeartbeat(record, '2026-01-01T00:00:04.000Z');
  assert.equal(record.updatedAt, '2026-01-01T00:00:03.000Z');
}

function runAll(): void {
  assert.equal(isTerminalSubAgentStatus('succeeded'), true);
  assert.equal(isTerminalSubAgentStatus('running'), false);
  testRunningAndHeartbeatTransitions();
  testTerminalTransitionFreezesHeartbeat();
  console.log('subagent-lifecycle-reducer tests passed');
}

runAll();
