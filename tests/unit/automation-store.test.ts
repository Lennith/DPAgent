import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutomationStore } from '../../src/automation/AutomationStore.js';
import { normalizeAutomationSchedule } from '../../src/automation/schedule.js';
import type { AutomationRunRecord, AutomationRunReport } from '../../src/automation/types.js';

function makeRunRecord(jobId: string, index: number): AutomationRunRecord {
  const triggerAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
  return {
    id: `run-${index}`,
    jobId,
    sessionId: `session-${index}`,
    status: 'succeeded',
    triggerAt,
    startedAt: triggerAt,
    completedAt: triggerAt,
    resultSummary: `ok-${index}`,
  };
}

async function runStoreSuite(): Promise<void> {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-store-test-'));
  try {
    const store = new AutomationStore(baseDir, 3);
    const schedule = normalizeAutomationSchedule({ frequency: 'hourly', minute: 5 });

    const created = store.createJob({
      name: 'Hourly Sync',
      prompt: 'sync workspace',
      workspaceDir: 'D:\\repo',
      skills: ['checks', 'checks', 'lint'],
      agentName: 'browser',
      llmSelection: {
        profileId: 'minimax',
        model: 'MiniMax-M2.7',
        reasoningPreset: 'off',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      schedule,
      timezone: 'UTC',
      enabled: true,
    });

    assert.ok(created.id);
    assert.equal(created.name, 'Hourly Sync');
    assert.equal(created.workspaceDir, 'D:\\repo');
    assert.deepEqual(created.skills, ['checks', 'lint']);
    assert.equal(created.agentName, 'browser');
    assert.equal(created.llmSelection?.profileId, 'minimax');
    assert.equal(created.llmSelection?.model, 'MiniMax-M2.7');
    assert.equal(created.enabled, true);
    assert.ok(created.nextRunAt);

    const paused = store.updateJob(created.id, {
      enabled: false,
      agentName: '',
      llmSelection: {
        profileId: 'deepseek',
        model: 'deepseek-v4',
        reasoningPreset: 'medium',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    });
    assert.equal(paused.enabled, false);
    assert.equal(paused.agentName, undefined);
    assert.equal(paused.llmSelection?.profileId, 'deepseek');
    assert.equal(paused.llmSelection?.reasoningPreset, 'medium');
    assert.equal(paused.nextRunAt, undefined);

    const resumed = store.updateJob(created.id, { enabled: true });
    assert.equal(resumed.enabled, true);
    assert.ok(resumed.nextRunAt);

    for (let index = 0; index < 5; index += 1) {
      store.appendRun(created.id, makeRunRecord(created.id, index));
    }
    const runs = store.listRuns(created.id);
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((item) => item.id),
      ['run-4', 'run-3', 'run-2']
    );

    const updatedRun = store.updateRun(created.id, 'run-4', {
      resultSummary: '  success with extra spaces  ',
      error: '   ',
    });
    assert.equal(updatedRun?.resultSummary, 'success with extra spaces');
    assert.equal(updatedRun?.error, '');

    const claimed = store.claimRun({
      jobId: created.id,
      triggerAt: '2026-01-01T01:00:00.000Z',
      triggerSource: 'schedule',
      nextRunAt: '2026-01-01T02:00:00.000Z',
      runId: 'claimed-run',
      sessionId: 'claimed-session',
      now: new Date('2026-01-01T01:00:00.000Z'),
    });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.record.status, 'running');
    assert.equal(claimed.record.id, 'claimed-run');
    assert.equal(claimed.record.sessionId, 'claimed-session');
    assert.equal(store.getJob(created.id)?.nextRunAt, '2026-01-01T02:00:00.000Z');

    const overlapClaim = store.claimRun({
      jobId: created.id,
      triggerAt: '2026-01-01T01:30:00.000Z',
      triggerSource: 'manual',
      now: new Date('2026-01-01T01:30:00.000Z'),
    });
    assert.equal(overlapClaim.claimed, false);
    assert.equal(overlapClaim.record.status, 'skipped');
    assert.equal(overlapClaim.record.skippedReason, 'overlap_running');
    store.updateRun(created.id, 'claimed-run', {
      status: 'succeeded',
      completedAt: '2026-01-01T01:05:00.000Z',
      resultSummary: 'done',
    });

    const templateV1 = store.updateMemoryTemplate({
      jobId: created.id,
      template: '## Automation Memory\n- first',
      sourceSessionId: 'session-4',
    });
    assert.equal(templateV1.version, 1);
    const templateV2 = store.updateMemoryTemplate({
      jobId: created.id,
      template: `${templateV1.template}\n- second`,
    });
    assert.equal(templateV2.version, 2);
    assert.equal(templateV2.sourceSessionId, undefined);

    const loadedTemplate = store.getMemoryTemplate(created.id);
    assert.equal(loadedTemplate?.version, 2);
    assert.match(String(loadedTemplate?.template ?? ''), /second/);

    const report: AutomationRunReport = {
      kind: 'auto_generated_skill_governance',
      jobId: created.id,
      runId: 'run-4',
      generatedAt: '2026-01-01T00:00:00.000Z',
      fallback: false,
      summary: {
        scannedSkills: 3,
        exactDuplicates: 1,
        candidateDuplicates: 2,
        autoArchived: 1,
        reportOnly: 0,
        boundaryFixed: 1,
        conflicts: 0,
      },
      items: [],
    };
    store.updateRunReport(created.id, 'run-4', report);
    assert.equal(store.getRunReport(created.id, 'run-4')?.summary.autoArchived, 1);

    const systemJob = store.upsertSystemJob({
      systemTask: 'auto_generated_skill_governance',
      name: 'Auto-Generated Skill Governance',
      prompt: 'govern skills',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({ frequency: 'weekly', weekday: 1, hour: 3, minute: 0 }),
      timezone: 'UTC',
    });
    assert.equal(systemJob.jobSource, 'system');
    assert.equal(systemJob.readOnly, true);
    assert.equal(store.findSystemJob('auto_generated_skill_governance')?.id, systemJob.id);

    const scheduledFromSession = store.createJob({
      name: 'Session-owned follow-up',
      prompt: 'follow up in the owning session',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({ frequency: 'interval', intervalSeconds: 60 }),
      timezone: 'UTC',
      enabled: true,
      sessionId: 'visible-session',
    });
    const scheduledClaim = store.claimRun({
      jobId: scheduledFromSession.id,
      triggerAt: '2026-01-01T03:00:00.000Z',
      triggerSource: 'schedule',
      now: new Date('2026-01-01T03:00:00.000Z'),
    });
    assert.equal(scheduledClaim.claimed, true);
    assert.notEqual(scheduledClaim.record.sessionId, 'visible-session');
    assert.match(scheduledClaim.record.sessionId, /^auto-/);
    assert.equal(store.getJob(scheduledFromSession.id)?.sessionId, 'visible-session');

    assert.equal(store.deleteJob(created.id), true);
    assert.equal(store.getRunReport(created.id, 'run-4'), undefined);
    assert.equal(store.listRuns(created.id).length, 0);
    assert.equal(store.getMemoryTemplate(created.id), undefined);
    assert.equal(store.deleteJob(created.id), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

runStoreSuite()
  .then(() => {
    console.log('automation-store tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

