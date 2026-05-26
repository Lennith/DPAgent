/**
 * E2E: schedule_task — create, query, cancel lifecycle.
 *
 * Tests the full lifecycle of the schedule_task tool without a real LLM.
 * Uses an in-memory AutomationStore backed by a temp directory.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScheduleTaskTool } from '../../src/tools/ScheduleTaskTool.js';
import { AutomationStore } from '../../src/automation/AutomationStore.js';

const SESSION_A = 'e2e-session-a';
const SESSION_B = 'e2e-session-b';

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-task-e2e-'));
  const store = new AutomationStore(path.join(tmpDir, 'automations'));

  function makeTool(sessionId: string) {
    return new ScheduleTaskTool({
      getSessionId: () => sessionId,
      getDefaultWorkspaceDir: () => tmpDir,
      store,
    });
  }

  return { tmpDir, store, makeTool };
}

// ── Tests ─────────────────────────────────────────────────────

async function testCreateInterval(): Promise<void> {
  const { makeTool } = setup();
  const tool = makeTool(SESSION_A);

  const result = await tool.execute({
    action: 'create',
    name: 'remind-me-every-minute',
    prompt: 'Check inbox',
    interval_seconds: 60,
  });

  assert.ok(result.success, `create should succeed: ${result.error ?? ''}`);
  assert.ok(result.content.includes('remind-me-every-minute'), 'should include task name');
  assert.ok(result.content.includes('interval'), 'should mention interval type');
  assert.ok(result.content.includes('60s'), 'should include interval seconds');
}

async function testRejectsCronSchema(): Promise<void> {
  const { makeTool } = setup();
  const tool = makeTool(SESSION_A);

  const result = await tool.execute({
    action: 'create',
    name: 'daily-report',
    prompt: 'Generate report',
    type: 'cron',
    schedule: { frequency: 'daily', minute: 30, hour: 9 },
  });

  assert.equal(result.success, false, 'cron create should be hidden from schedule_task');
  assert.match(result.error ?? '', /interval_seconds/);
}

async function testQuery(): Promise<void> {
  const { makeTool } = setup();
  const tool = makeTool(SESSION_A);

  // Create two tasks
  await tool.execute({ action: 'create', name: 't1', prompt: 'p1', interval_seconds: 10 });
  await tool.execute({ action: 'create', name: 't2', prompt: 'p2', interval_seconds: 20 });

  // Query
  const result = await tool.execute({ action: 'query' });
  assert.ok(result.success, `query should succeed: ${result.error ?? ''}`);

  const items = JSON.parse(result.content);
  const names = items.map((i: { name: string }) => i.name).sort();
  assert.equal(names.length, 2, 'should return 2 active tasks');
  assert.ok(names.includes('t1'));
  assert.ok(names.includes('t2'));
  assert.deepEqual(items.map((i: { type: string }) => i.type).sort(), ['interval', 'interval']);
}

async function testQuerySessionIsolation(): Promise<void> {
  const { makeTool } = setup();
  const toolA = makeTool(SESSION_A);
  const toolB = makeTool(SESSION_B);

  // Create in session A
  await toolA.execute({ action: 'create', name: 'a-task', prompt: 'x', interval_seconds: 10 });

  // Query from session B — should be empty
  const resultB = await toolB.execute({ action: 'query' });
  assert.ok(resultB.content.includes('No active'), 'session B should see no tasks');
}

async function testQueryOnlyEnabled(): Promise<void> {
  const { store, makeTool } = setup();
  const tool = makeTool(SESSION_A);

  // Create a task, then disable it
  await tool.execute({ action: 'create', name: 'will-disable', prompt: 'x', interval_seconds: 10 });

  // Find the job and disable it
  const jobs = store.listJobs().filter((j) => j.sessionId === SESSION_A);
  assert.equal(jobs.length, 1);
  store.updateJob(jobs[0].id, { enabled: false });

  // Query — should be empty (disabled tasks hidden)
  const result = await tool.execute({ action: 'query' });
  assert.ok(result.content.includes('No active'), 'disabled task should not appear in query');
}

async function testCancel(): Promise<void> {
  const { makeTool, store } = setup();
  const tool = makeTool(SESSION_A);

  // Create a task
  const createRes = await tool.execute({ action: 'create', name: 'to-cancel', prompt: 'x', interval_seconds: 10 });
  assert.ok(createRes.success);

  // Extract job id from response
  const idMatch = createRes.content.match(/id:\s*(\S+)\)/);
  assert.ok(idMatch, 'should contain job id in response');
  const jobId = idMatch[1];

  // Verify it exists
  assert.ok(store.getJob(jobId), 'job should exist before cancel');

  // Cancel
  const cancelRes = await tool.execute({ action: 'cancel', jobId });
  assert.ok(cancelRes.success, `cancel should succeed: ${cancelRes.error ?? ''}`);
  assert.ok(cancelRes.content.includes('Cancelled'), 'should confirm cancellation');

  // Verify it's gone
  assert.equal(store.getJob(jobId), undefined, 'job should be deleted after cancel');

  // Query should be empty now
  const queryRes = await tool.execute({ action: 'query' });
  assert.ok(queryRes.content.includes('No active'), 'query should be empty after cancel');
}

async function testCancelNonExistent(): Promise<void> {
  const { makeTool } = setup();
  const tool = makeTool(SESSION_A);

  const result = await tool.execute({ action: 'cancel', jobId: 'nonexistent-999' });
  assert.equal(result.success, false, 'cancel non-existent should fail');
  assert.ok(result.error?.includes('not found'), 'should say not found');
}

async function testCancelWrongSession(): Promise<void> {
  const { makeTool } = setup();
  const toolA = makeTool(SESSION_A);
  const toolB = makeTool(SESSION_B);

  // Create in session A
  const createRes = await toolA.execute({ action: 'create', name: 'mine', prompt: 'x', interval_seconds: 10 });
  const idMatch = createRes.content.match(/id:\s*(\S+)\)/);
  const jobId = idMatch![1];

  // Try to cancel from session B
  const result = await toolB.execute({ action: 'cancel', jobId });
  assert.equal(result.success, false, 'cancel from wrong session should fail');
  assert.ok(result.error?.includes('does not belong'), 'should say wrong session');
}

async function testActionDefaultsToCreate(): Promise<void> {
  const { makeTool } = setup();
  const tool = makeTool(SESSION_A);

  // Omit action — should default to create
  const result = await tool.execute({
    name: 'default-create',
    prompt: 'test',
    interval_seconds: 10,
  });
  assert.ok(result.success, `default action should be create: ${result.error ?? ''}`);
}

// ── Run ───────────────────────────────────────────────────────

void (async () => {
  await testCreateInterval();
  await testRejectsCronSchema();
  await testQuery();
  await testQuerySessionIsolation();
  await testQueryOnlyEnabled();
  await testCancel();
  await testCancelNonExistent();
  await testCancelWrongSession();
  await testActionDefaultsToCreate();
  console.log('schedule-task-cancel e2e passed');
})();
