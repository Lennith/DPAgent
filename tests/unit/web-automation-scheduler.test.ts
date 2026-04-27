import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutomationStore } from '../../src/automation/AutomationStore.js';
import { AutomationScheduler } from '../../src/automation/AutomationScheduler.js';
import { normalizeAutomationSchedule } from '../../src/automation/schedule.js';

async function testSchedulerSkipsStaleAndOverlap(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-scheduler-'));
  try {
    const store = new AutomationStore(storeDir);
    let executeCount = 0;
    const scheduler = new AutomationScheduler(
      {
        store,
        executeJob: async () => {
          executeCount += 1;
        },
        logger: { warn: () => undefined },
      },
      { staleThresholdMs: 90_000 }
    );

    const job = store.createJob({
      name: 'Scheduler job',
      prompt: 'do something',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({
        frequency: 'hourly',
        minute: new Date().getUTCMinutes(),
      }),
      timezone: 'UTC',
      enabled: true,
    });

    // stale: due too long ago should not backfill
    store.updateJob(job.id, {
      nextRunAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await scheduler.runTick(new Date());
    assert.equal(executeCount, 0);
    assert.equal(store.listRuns(job.id).length, 0);

    // overlap: due now but already running should append skipped record
    const runningSet = (scheduler as unknown as { runningJobIds: Set<string> }).runningJobIds;
    runningSet.add(job.id);
    store.updateJob(job.id, {
      nextRunAt: new Date(Date.now()).toISOString(),
    });
    await scheduler.runTick(new Date());
    const overlapRuns = store.listRuns(job.id);
    assert.equal(overlapRuns.length, 1);
    assert.equal(overlapRuns[0]?.status, 'skipped');
    assert.equal(overlapRuns[0]?.skippedReason, 'overlap_running');
    assert.equal(executeCount, 0);

    // normal due run: dispatch executeAutomationJob
    runningSet.delete(job.id);
    store.updateJob(job.id, {
      nextRunAt: new Date(Date.now()).toISOString(),
    });
    await scheduler.runTick(new Date());
    assert.equal(executeCount, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testSchedulerJobIsolation(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-scheduler-isolation-'));
  try {
    const store = new AutomationStore(storeDir);
    let executeCount = 0;
    const scheduler = new AutomationScheduler({
      store,
      executeJob: async () => {
        executeCount += 1;
      },
      logger: { warn: () => undefined },
    });

    const brokenJob = store.createJob({
      name: 'Broken job',
      prompt: 'broken',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({ frequency: 'hourly', minute: 0 }),
      timezone: 'UTC',
      enabled: true,
    });
    const healthyJob = store.createJob({
      name: 'Healthy job',
      prompt: 'healthy',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({ frequency: 'hourly', minute: 0 }),
      timezone: 'UTC',
      enabled: true,
    });

    store.updateJob(brokenJob.id, {
      nextRunAt: new Date(Date.now()).toISOString(),
    });
    store.updateJob(healthyJob.id, {
      nextRunAt: new Date(Date.now()).toISOString(),
    });

    const originalUpdateJob = store.updateJob.bind(store);
    (store as unknown as { updateJob: typeof store.updateJob }).updateJob = (id, patch) => {
      if (id === brokenJob.id) {
        throw new Error('simulated scheduler patch failure');
      }
      return originalUpdateJob(id, patch);
    };

    await scheduler.runTick(new Date());
    assert.equal(executeCount, 1);
    assert.equal(store.listRuns(healthyJob.id).length, 0);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testSchedulerSkipsStaleAndOverlap();
  await testSchedulerJobIsolation();
  console.log('web-automation-scheduler tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
