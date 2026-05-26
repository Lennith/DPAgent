import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutomationExecutionService } from '../../src/automation/AutomationExecutionService.js';
import { AutomationStore } from '../../src/automation/AutomationStore.js';
import { normalizeAutomationSchedule } from '../../src/automation/schedule.js';
import type { ContextRef } from '../../src/types.js';

async function testAutomationExecutionInjectsTemplateAndPersistsMemory(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Nightly check',
      prompt: 'run nightly check and summarize',
      workspaceDir: 'D:\\repo',
      skills: ['checks'],
      llmSelection: {
        profileId: 'deepseek',
        model: 'deepseek-v4',
        reasoningPreset: 'medium',
        updatedAt: '2026-04-19T00:00:00.000Z',
      },
      schedule: normalizeAutomationSchedule({
        frequency: 'daily',
        hour: 2,
        minute: 0,
      }),
      timezone: 'UTC',
      enabled: true,
    });
    store.updateMemoryTemplate({
      jobId: job.id,
      template: '## Automation Memory\n- prefer deterministic checks',
    });

    const contextMetaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
    let runWithResultArgs: Record<string, unknown> | null = null;
    let cleanupCount = 0;
    const mutateMemoryCalls: Array<Record<string, unknown>> = [];
    const activeRuns = new Map<string, ContextRef>();

    const runAgent = {
      updateContextNamespaceMeta: (context: ContextRef, patch: Record<string, unknown>) => {
        contextMetaUpdates.push({ context, patch });
      },
      runWithResult: async (args: Record<string, unknown>) => {
        runWithResultArgs = args;
        assert.equal(activeRuns.size, 1);
        assert.equal([...activeRuns.values()][0]?.scope, 'session');
        return { content: 'nightly check completed successfully' };
      },
    };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async (_sessionId: string, _workspaceDir: string) => ({
        agent: runAgent as any,
        reused: false,
      }),
      cleanupSessionRuntime: async () => {
        cleanupCount += 1;
      },
      trackActiveRun: (runId, context) => {
        activeRuns.set(runId, context);
        return () => {
          activeRuns.delete(runId);
        };
      },
      updateContextNamespaceMetaSafe: (_context, _patch) => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async (input: Record<string, unknown>) => {
        mutateMemoryCalls.push(input);
        return { entry: { id: 'memory-1' } };
      },
      logger: { warn: () => undefined },
    });

    const triggerAt = '2026-04-19T02:00:00.000Z';
    await service.executeJob(job, triggerAt, { triggerSource: 'manual' });

    assert.equal(activeRuns.size, 0);
    assert.equal(cleanupCount, 1);
    assert.notEqual(runWithResultArgs, null);
    assert.equal(runWithResultArgs?.prompt, job.prompt);
    assert.equal(runWithResultArgs?.workspaceDir, job.workspaceDir);
    assert.equal(
      (contextMetaUpdates[0]?.patch as { llmSelection?: { profileId?: string } })?.llmSelection?.profileId,
      'deepseek'
    );
    assert.match(String(runWithResultArgs?.additionalSystemPrompt ?? ''), /\[AUTOMATION_RUN\]/);
    assert.match(
      String(runWithResultArgs?.additionalSystemPrompt ?? ''),
      /prefer deterministic checks/
    );

    const runs = store.listRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');
    assert.equal(runs[0]?.triggerSource, 'manual');
    assert.equal(runs[0]?.memorySyncStatus, 'succeeded');
    assert.match(String(runs[0]?.sessionId ?? ''), /^auto-/);

    const template = store.getMemoryTemplate(job.id);
    assert.ok(template);
    assert.ok((template?.version ?? 0) >= 2);
    assert.match(String(template?.template ?? ''), /Run succeeded/);

    assert.equal(mutateMemoryCalls.length, 1);
    assert.equal((mutateMemoryCalls[0] as { reason?: string }).reason, 'automation_completion');
    assert.equal((mutateMemoryCalls[0] as { workspaceDir?: string }).workspaceDir, job.workspaceDir);
    assert.equal(contextMetaUpdates.length >= 2, true);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testSessionOwnedScheduledTaskRunsInIsolatedAutomationSession(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-session-owned-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Visible session follow-up',
      prompt: 'check the visible session task',
      workspaceDir: 'D:\\repo',
      skills: [],
      schedule: normalizeAutomationSchedule({
        frequency: 'interval',
        intervalSeconds: 60,
      }),
      timezone: 'UTC',
      enabled: true,
      sessionId: 'visible-session',
    });

    const contextMetaUpdates: Array<{ context: ContextRef; patch: Record<string, unknown> }> = [];
    const ensuredSessionIds: string[] = [];
    const runAgent = {
      updateContextNamespaceMeta: (context: ContextRef, patch: Record<string, unknown>) => {
        contextMetaUpdates.push({ context, patch });
      },
      runWithResult: async () => ({ content: 'session-owned task completed' }),
    };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async (sessionId: string) => {
        ensuredSessionIds.push(sessionId);
        return {
          agent: runAgent as any,
          reused: false,
        };
      },
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: (context, patch) => {
        contextMetaUpdates.push({ context, patch: patch as Record<string, unknown> });
        return null;
      },
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => ({ entry: { id: 'memory-1' } }),
      logger: { warn: () => undefined },
    });

    await service.executeJob(job, '2026-04-19T04:00:00.000Z');

    const run = store.listRuns(job.id)[0];
    assert.ok(run);
    assert.equal(run.status, 'succeeded');
    assert.notEqual(run.sessionId, 'visible-session');
    assert.match(run.sessionId, /^auto-/);
    assert.deepEqual(ensuredSessionIds, [run.sessionId]);
    assert.equal(store.getJob(job.id)?.sessionId, 'visible-session');
    assert.equal(
      contextMetaUpdates.some((item) => item.context.namespace === 'visible-session'),
      false
    );
    assert.equal(
      contextMetaUpdates.some((item) => item.context.namespace === run.sessionId && item.patch.automationRun),
      true
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testExecutionSuccessNotDowngradedByMemoryFailure(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-memory-failure-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Memory failure',
      prompt: 'complete task',
      workspaceDir: 'D:\\repo',
      skills: [],
      schedule: normalizeAutomationSchedule({
        frequency: 'daily',
        hour: 3,
        minute: 0,
      }),
      timezone: 'UTC',
      enabled: true,
    });

    const runAgent = {
      updateContextNamespaceMeta: () => undefined,
      runWithResult: async () => ({ content: 'task finished' }),
    };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async () => ({
        agent: runAgent as any,
        reused: false,
      }),
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: () => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => {
        throw new Error('memory backend unavailable');
      },
      logger: { warn: () => undefined },
    });

    await service.executeJob(job, '2026-04-19T03:00:00.000Z');

    const runs = store.listRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');
    assert.equal(runs[0]?.memorySyncStatus, 'failed');
    assert.match(String(runs[0]?.memorySyncError ?? ''), /memory backend unavailable/);
    assert.equal(runs[0]?.error, undefined);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testExternalAgentUsesAgentRuntimeAndIgnoresAutomationSkills(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-agent-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Agent run',
      prompt: 'complete task',
      workspaceDir: 'D:\\repo',
      skills: ['checks'],
      agentName: 'browser',
      schedule: normalizeAutomationSchedule({
        frequency: 'daily',
        hour: 3,
        minute: 30,
      }),
      timezone: 'UTC',
      enabled: true,
    });

    let runWithResultArgs: Record<string, unknown> | null = null;
    let ensuredProfileId = '';
    const runAgent = {
      updateContextNamespaceMeta: () => undefined,
      runWithResult: async (args: Record<string, unknown>) => {
        runWithResultArgs = args;
        return { content: 'agent task finished' };
      },
    };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async (_sessionId, _workspaceDir, _llmRuntime, llmSelection) => {
        ensuredProfileId = String(llmSelection?.profileId ?? '');
        return {
          agent: runAgent as any,
          reused: false,
        };
      },
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: () => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => ({ entry: { id: 'mem-1' } }),
      resolveAutomationAgentRuntime: () => ({
        agentName: 'browser',
        effectiveAgentName: 'browser',
        llmSelection: {
          profileId: 'agent-profile',
          model: 'agent-model',
          reasoningPreset: 'medium',
          updatedAt: '2026-04-19T00:00:00.000Z',
        },
        agentRuntimeOverrides: {
          agentProfile: {
            source: 'global',
            name: 'browser',
            path: 'D:\\agents\\browser\\AGENTS.md',
          },
          loadGlobalSkills: false,
        },
      }),
      logger: { warn: () => undefined },
    });

    await service.executeJob(job, '2026-04-19T03:30:00.000Z');

    assert.equal(ensuredProfileId, 'agent-profile');
    assert.deepEqual(
      (runWithResultArgs?.agentRuntimeOverrides as { agentProfile?: { name?: string }; loadGlobalSkills?: boolean })?.agentProfile?.name,
      'browser'
    );
    assert.equal(
      (runWithResultArgs?.agentRuntimeOverrides as { loadGlobalSkills?: boolean })?.loadGlobalSkills,
      false
    );
    assert.doesNotMatch(String(runWithResultArgs?.additionalSystemPrompt ?? ''), /Preferred skills/);
    const run = store.listRuns(job.id)[0];
    assert.equal(run?.agentName, 'browser');
    assert.equal(run?.effectiveAgentName, 'browser');
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testMissingExternalAgentFallsBackToDefaultWithDiagnostic(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-agent-fallback-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Fallback run',
      prompt: 'complete task',
      workspaceDir: 'D:\\repo',
      skills: ['checks'],
      agentName: 'deleted-agent',
      schedule: normalizeAutomationSchedule({
        frequency: 'daily',
        hour: 4,
        minute: 30,
      }),
      timezone: 'UTC',
      enabled: true,
    });

    let runWithResultArgs: Record<string, unknown> | null = null;
    const warnings: string[] = [];
    const runAgent = {
      updateContextNamespaceMeta: () => undefined,
      runWithResult: async (args: Record<string, unknown>) => {
        runWithResultArgs = args;
        return { content: 'fallback task finished' };
      },
    };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async () => ({
        agent: runAgent as any,
        reused: false,
      }),
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: () => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => ({ entry: { id: 'mem-1' } }),
      resolveAutomationAgentRuntime: () => ({
        agentName: 'deleted-agent',
        effectiveAgentName: 'default',
        fallbackReason: 'agent_not_found:deleted-agent',
      }),
      logger: { warn: (message) => warnings.push(message) },
    });

    await service.executeJob(job, '2026-04-19T04:30:00.000Z');

    assert.equal(runWithResultArgs?.agentRuntimeOverrides, undefined);
    assert.match(String(runWithResultArgs?.additionalSystemPrompt ?? ''), /Preferred skills: checks/);
    assert.match(warnings.join('\n'), /agent_not_found:deleted-agent/);
    const run = store.listRuns(job.id)[0];
    assert.equal(run?.agentName, 'deleted-agent');
    assert.equal(run?.effectiveAgentName, 'default');
    assert.equal(run?.agentFallbackReason, 'agent_not_found:deleted-agent');
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testExecutionSuccessNotDowngradedWhenTemplateWriteFails(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-template-failure-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.createJob({
      name: 'Template failure',
      prompt: 'complete task',
      workspaceDir: 'D:\\repo',
      skills: [],
      schedule: normalizeAutomationSchedule({
        frequency: 'daily',
        hour: 4,
        minute: 0,
      }),
      timezone: 'UTC',
      enabled: true,
    });

    const runAgent = {
      updateContextNamespaceMeta: () => undefined,
      runWithResult: async () => ({ content: 'task finished' }),
    };
    let mutateCallCount = 0;
    const originalUpdateMemoryTemplate = store.updateMemoryTemplate.bind(store);
    (store as unknown as { updateMemoryTemplate: typeof store.updateMemoryTemplate }).updateMemoryTemplate =
      () => {
        throw new Error('template store unavailable');
      };

    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async () => ({
        agent: runAgent as any,
        reused: false,
      }),
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: () => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => {
        mutateCallCount += 1;
        return { entry: { id: 'mem-1' } };
      },
      logger: { warn: () => undefined },
    });

    await service.executeJob(job, '2026-04-19T04:00:00.000Z');

    const runs = store.listRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');
    assert.equal(runs[0]?.memorySyncStatus, 'failed');
    assert.match(String(runs[0]?.memorySyncError ?? ''), /template store unavailable/);
    assert.equal(mutateCallCount, 0);

    (store as unknown as { updateMemoryTemplate: typeof store.updateMemoryTemplate }).updateMemoryTemplate =
      originalUpdateMemoryTemplate;
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function testSystemTaskWritesRunReport(): Promise<void> {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-execution-system-task-'));
  try {
    const store = new AutomationStore(storeDir);
    const job = store.upsertSystemJob({
      systemTask: 'auto_generated_skill_governance',
      name: 'Auto-Generated Skill Governance',
      prompt: 'govern skills',
      workspaceDir: 'D:\\repo',
      schedule: normalizeAutomationSchedule({
        frequency: 'weekly',
        weekday: 1,
        hour: 3,
        minute: 0,
      }),
      timezone: 'UTC',
    });
    const service = new AutomationExecutionService({
      store,
      ensureSessionRuntime: async () => {
        throw new Error('not used');
      },
      cleanupSessionRuntime: async () => undefined,
      updateContextNamespaceMetaSafe: () => null,
      getDefaultWorkspaceDir: () => 'D:\\default',
      getContextMessages: () => [],
      mutateWorkspaceMemory: async () => {
        throw new Error('not used');
      },
      executeSystemTask: async ({ job: runJob, runId }) => ({
        status: 'succeeded',
        summary: 'governed 3 auto-generated skills; archived 1',
        report: {
          kind: 'auto_generated_skill_governance',
          jobId: runJob.id,
          runId,
          generatedAt: '2026-04-20T00:00:00.000Z',
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
        },
      }),
      logger: { warn: () => undefined },
    });

    await service.executeJob(job, '2026-04-20T00:00:00.000Z', { triggerSource: 'manual' });

    const runs = store.listRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'succeeded');
    assert.equal(runs[0]?.triggerSource, 'manual');
    assert.equal(runs[0]?.reportPath, `${job.id}:${runs[0]?.id}`);
    const report = store.getRunReport(job.id, String(runs[0]?.id));
    assert.equal(report?.summary.autoArchived, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testAutomationExecutionInjectsTemplateAndPersistsMemory();
  await testSessionOwnedScheduledTaskRunsInIsolatedAutomationSession();
  await testExecutionSuccessNotDowngradedByMemoryFailure();
  await testExternalAgentUsesAgentRuntimeAndIgnoresAutomationSkills();
  await testMissingExternalAgentFallsBackToDefaultWithDiagnostic();
  await testExecutionSuccessNotDowngradedWhenTemplateWriteFails();
  await testSystemTaskWritesRunReport();
  console.log('web-automation-execution tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
