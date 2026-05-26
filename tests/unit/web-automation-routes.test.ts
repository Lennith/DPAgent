import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutomationExecutionService } from '../../src/automation/AutomationExecutionService.js';
import { AutomationRoutes } from '../../src/automation/AutomationRoutes.js';
import { AutomationStore } from '../../src/automation/AutomationStore.js';
import { normalizeAutomationSchedule } from '../../src/automation/schedule.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createHarness(): {
  routes: ReturnType<typeof createRouteAppHarness>;
  storeDir: string;
  store: AutomationStore;
  mutateMemoryCalls: Array<Record<string, unknown>>;
} {
  const routes = createRouteAppHarness();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-automation-routes-'));
  const store = new AutomationStore(storeDir);
  const mutateMemoryCalls: Array<Record<string, unknown>> = [];
  const server = createWebServerDouble();
  server.app = routes.app;
  server.wss = { clients: new Set() };
  server.bootMissingApiKey = false;
  server.activeRunContexts = new Map();
  server.activeRunStatesByContext = new Map();
  server.cancelingRunIds = new Set();
  server.automationStore = store;
  server.automationExecutionService = new AutomationExecutionService({
    store,
    ensureSessionRuntime: async () => ({
      agent: {
        updateContextNamespaceMeta: () => ({}) as any,
        runWithResult: async () => ({ content: 'manual automation run ok' }),
      },
      reused: false,
    }),
    cleanupSessionRuntime: async () => undefined,
    updateContextNamespaceMetaSafe: () => null,
    getDefaultWorkspaceDir: () => 'D:\\default-workspace',
    getContextMessages: () => [
      { role: 'user', content: 'Please tighten validation for edge cases.' },
      { role: 'assistant', content: 'I updated it but missed two boundary checks.' },
    ],
    mutateWorkspaceMemory: async (input: Record<string, unknown>) => {
      mutateMemoryCalls.push(input);
      return { entry: { id: 'mem-1' } };
    },
    executeSystemTask: async ({ job, runId }) => ({
      status: 'succeeded',
      summary: 'governed 3 auto-generated skills; archived 1',
      report: {
        kind: 'auto_generated_skill_governance',
        jobId: job.id,
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
  server.automationRoutes = new AutomationRoutes({
    store,
    executionService: server.automationExecutionService,
    getDefaultWorkspaceDir: () => 'D:\\default-workspace',
    getConfig: () => server.agent.getConfig(),
  });
  server.agent = {
    getConfig: () => ({
      api: {
        apiKey: 'sk-test-01234567890123456789',
        apiBase: 'https://api.minimax.test',
        model: 'MiniMax-M2.7',
        provider: 'anthropic',
        maxOutputTokens: 32768,
      },
      llmProfiles: {
        defaultProfileId: 'minimax',
        profiles: [
          {
            id: 'minimax',
            name: 'MiniMax',
            provider: 'anthropic',
            apiKey: 'sk-test-01234567890123456789',
            apiBase: 'https://api.minimax.test',
            defaultModel: 'MiniMax-M2.7',
            availableModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
            maxOutputTokens: 32768,
            enabled: true,
          },
          {
            id: 'deepseek',
            name: 'DeepSeek',
            provider: 'anthropic',
            apiKey: 'sk-test-01234567890123456789',
            apiBase: 'https://api.deepseek.test',
            defaultModel: 'deepseek-v4',
            maxOutputTokens: 32768,
            enabled: true,
          },
        ],
      },
      agent: { workspaceDir: 'D:\\default-workspace' },
    }),
    getContextManager: () => ({
      listNamespaces: () => [
        {
          namespace: 'sess-1',
          name: 'Session 1',
          workspaceDir: 'D:\\repo',
          createdAt: '2026-04-19T00:00:00.000Z',
          updatedAt: '2026-04-19T00:00:01.000Z',
          projection: { version: 1 },
          memoryPromotionState: null,
          automationRun: undefined,
        },
        {
          namespace: 'auto-sess-1',
          name: 'Automation Session',
          workspaceDir: 'D:\\repo',
          createdAt: '2026-04-19T00:01:00.000Z',
          updatedAt: '2026-04-19T00:01:01.000Z',
          projection: { version: 2 },
          memoryPromotionState: null,
          automationRun: {
            jobId: 'automation-1',
            runId: 'run-1',
            triggerAt: '2026-04-19T00:01:00.000Z',
            status: 'succeeded',
            scheduledBy: 'automation',
          },
        },
      ],
    }),
    getContextNamespaceMeta: () => ({
      name: 'Session',
      workspaceDir: 'D:\\repo',
      toolsetName: 'full-access',
    }),
    resolveToolsetName: () => 'full-access',
  };
  server.setupRoutes();
  return { routes, storeDir, store, mutateMemoryCalls };
}

async function testSessionsRouteFiltersAutomationByDefault(): Promise<void> {
  const harness = createHarness();
  try {
    const handler = harness.routes.getRoutes.get('/api/sessions');
    assert.ok(handler);

    const defaultRes = createResponseRecorder();
    await handler?.({ query: {} }, defaultRes);
    assert.equal(defaultRes.statusCode, 200);
    assert.equal((defaultRes.payload as { sessions: unknown[] }).sessions.length, 1);

    const includeRes = createResponseRecorder();
    await handler?.({ query: { includeAutomation: 'true' } }, includeRes);
    assert.equal(includeRes.statusCode, 200);
    assert.equal((includeRes.payload as { sessions: unknown[] }).sessions.length, 2);
  } finally {
    fs.rmSync(harness.storeDir, { recursive: true, force: true });
  }
}

async function testAutomationCrudAndManualMemoryWrite(): Promise<void> {
  const harness = createHarness();
  try {
    const createHandler = harness.routes.postRoutes.get('/api/automations');
    const listHandler = harness.routes.getRoutes.get('/api/automations');
    const updateHandler = harness.routes.putRoutes.get('/api/automations/:id');
    const toggleHandler = harness.routes.postRoutes.get('/api/automations/:id/toggle');
    const deleteHandler = harness.routes.deleteRoutes.get('/api/automations/:id');
    const runsHandler = harness.routes.getRoutes.get('/api/automations/:id/runs');
    const runHandler = harness.routes.postRoutes.get('/api/automations/:id/run');
    const memoryHandler = harness.routes.postRoutes.get('/api/automations/:id/memory/from-session');
    assert.ok(createHandler);
    assert.ok(listHandler);
    assert.ok(updateHandler);
    assert.ok(toggleHandler);
    assert.ok(deleteHandler);
    assert.ok(runsHandler);
    assert.ok(runHandler);
    assert.ok(memoryHandler);

    const createRes = createResponseRecorder();
    await createHandler?.(
      {
        body: {
          name: 'Daily Report',
          prompt: 'Summarize yesterday changes',
          workspaceDir: 'D:\\repo',
          skills: ['checks'],
          agentName: 'browser',
          llmSelection: {
            profileId: 'deepseek',
            model: 'deepseek-v4',
            reasoningPreset: 'low',
            updatedAt: '2026-04-20T00:00:00.000Z',
          },
          schedule: { frequency: 'daily', hour: 9, minute: 30 },
          timezone: 'UTC',
          enabled: true,
        },
      },
      createRes
    );
    assert.equal(createRes.statusCode, 200);
    const createdItem = (createRes.payload as {
      item: { id: string; enabled: boolean; llmSelection?: { profileId: string; model: string } };
    }).item;
    assert.ok(createdItem.id);
    assert.equal(createdItem.enabled, true);
    assert.equal(createdItem.llmSelection?.profileId, 'deepseek');
    assert.equal(createdItem.llmSelection?.model, 'deepseek-v4');

    const listRes = createResponseRecorder();
    await listHandler?.({}, listRes);
    assert.equal(listRes.statusCode, 200);
    const listed = (listRes.payload as { items: Array<{ id: string; readOnly?: boolean }> }).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, createdItem.id);
    assert.equal(listed[0]?.readOnly, false);

    const toggleRes = createResponseRecorder();
    await toggleHandler?.({ params: { id: createdItem.id }, body: { enabled: false } }, toggleRes);
    assert.equal(toggleRes.statusCode, 200);
    const toggled = (toggleRes.payload as { item: { enabled: boolean; nextRunAt?: string } }).item;
    assert.equal(toggled.enabled, false);
    assert.equal(toggled.nextRunAt, undefined);

    const updateRes = createResponseRecorder();
    await updateHandler?.(
      {
        params: { id: createdItem.id },
        body: {
          name: 'Daily Report Renamed',
          prompt: 'Summarize yesterday changes quickly',
          workspaceDir: 'D:\\repo',
          skills: ['checks'],
          llmSelection: {
            profileId: 'minimax',
            model: 'MiniMax-M2.7-highspeed',
            reasoningPreset: 'off',
            updatedAt: '2026-04-20T00:00:01.000Z',
          },
          schedule: { frequency: 'daily', hour: 10, minute: 0 },
          timezone: 'UTC',
        },
      },
      updateRes
    );
    assert.equal(updateRes.statusCode, 200);
    const updated = (updateRes.payload as {
      item: {
        enabled: boolean;
        name: string;
        skills: string[];
        agentName?: string;
        llmSelection?: { profileId: string; model: string };
      };
    }).item;
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, 'Daily Report Renamed');
    assert.equal(updated.agentName, 'browser');
    assert.deepEqual(updated.skills, ['checks']);
    assert.equal(updated.llmSelection?.profileId, 'minimax');
    assert.equal(updated.llmSelection?.model, 'MiniMax-M2.7-highspeed');

    const clearAgentRes = createResponseRecorder();
    await updateHandler?.(
      {
        params: { id: createdItem.id },
        body: {
          agentName: null,
        },
      },
      clearAgentRes
    );
    assert.equal(clearAgentRes.statusCode, 200);
    const clearedAgent = (clearAgentRes.payload as { item: { agentName?: string; skills: string[] } }).item;
    assert.equal(clearedAgent.agentName, undefined);
    assert.deepEqual(clearedAgent.skills, ['checks']);

    const manualRunRes = createResponseRecorder();
    await runHandler?.({ params: { id: createdItem.id } }, manualRunRes);
    assert.equal(manualRunRes.statusCode, 200);
    const manualRun = (manualRunRes.payload as { run: { triggerSource: string; status: string } }).run;
    assert.equal(manualRun.triggerSource, 'manual');
    assert.equal(manualRun.status, 'succeeded');

    const memoryRes = createResponseRecorder();
    await memoryHandler?.(
      {
        params: { id: createdItem.id },
        body: {
          sessionId: 'sess-manual-fix',
          note: 'Need stricter boundary checks for zero-length input.',
        },
      },
      memoryRes
    );
    assert.equal(memoryRes.statusCode, 200);
    const memoryPayload = memoryRes.payload as {
      template?: { template: string; version: number };
      memoryEntryId?: string;
    };
    assert.equal(memoryPayload.memoryEntryId, 'mem-1');
    assert.match(String(memoryPayload.template?.template ?? ''), /stricter boundary checks/);
    const lastMemoryCall = harness.mutateMemoryCalls[harness.mutateMemoryCalls.length - 1] as {
      reason?: string;
    };
    assert.equal(lastMemoryCall?.reason, 'automation_manual_correction');

    const runsRes = createResponseRecorder();
    await runsHandler?.({ params: { id: createdItem.id } }, runsRes);
    assert.equal(runsRes.statusCode, 200);
    const runsPayload = runsRes.payload as { items: unknown[]; template: { version: number } | null };
    assert.equal(runsPayload.items.length, 1);
    assert.equal(runsPayload.template?.version, 2);

    const deleteRes = createResponseRecorder();
    await deleteHandler?.({ params: { id: createdItem.id } }, deleteRes);
    assert.equal(deleteRes.statusCode, 200);
    assert.equal((deleteRes.payload as { success: boolean }).success, true);
    assert.equal(harness.store.getJob(createdItem.id), undefined);
    assert.equal(harness.store.listRuns(createdItem.id).length, 0);
  } finally {
    fs.rmSync(harness.storeDir, { recursive: true, force: true });
  }
}

async function testAutomationIntervalScheduleCrud(): Promise<void> {
  const harness = createHarness();
  try {
    const createHandler = harness.routes.postRoutes.get('/api/automations');
    const updateHandler = harness.routes.putRoutes.get('/api/automations/:id');
    const toggleHandler = harness.routes.postRoutes.get('/api/automations/:id/toggle');
    assert.ok(createHandler);
    assert.ok(updateHandler);
    assert.ok(toggleHandler);

    const createRes = createResponseRecorder();
    await createHandler?.(
      {
        body: {
          name: 'Interval Check',
          prompt: 'Check status',
          workspaceDir: 'D:\\repo',
          schedule: { frequency: 'interval', intervalSeconds: 45 },
          timezone: 'UTC',
          enabled: true,
        },
      },
      createRes
    );
    assert.equal(createRes.statusCode, 200);
    const created = (createRes.payload as {
      item: { id: string; schedule: { frequency: string; intervalSeconds: number }; nextRunAt?: string };
    }).item;
    assert.equal(created.schedule.frequency, 'interval');
    assert.equal(created.schedule.intervalSeconds, 45);
    assert.ok(created.nextRunAt);

    const updateRes = createResponseRecorder();
    await updateHandler?.(
      {
        params: { id: created.id },
        body: {
          schedule: { frequency: 'daily', hour: 10, minute: 5 },
          timezone: 'UTC',
        },
      },
      updateRes
    );
    assert.equal(updateRes.statusCode, 200);
    const updated = (updateRes.payload as {
      item: { schedule: { frequency: string; intervalSeconds?: number; hour?: number; minute?: number } };
    }).item;
    assert.deepEqual(updated.schedule, { frequency: 'daily', minute: 5, hour: 10 });

    const updateBackRes = createResponseRecorder();
    await updateHandler?.(
      {
        params: { id: created.id },
        body: {
          schedule: { frequency: 'interval', intervalSeconds: 120 },
          timezone: 'UTC',
        },
      },
      updateBackRes
    );
    assert.equal(updateBackRes.statusCode, 200);
    const intervalAgain = (updateBackRes.payload as {
      item: { schedule: { frequency: string; intervalSeconds?: number } };
    }).item;
    assert.deepEqual(intervalAgain.schedule, { frequency: 'interval', intervalSeconds: 120 });

    const toggleRes = createResponseRecorder();
    await toggleHandler?.({ params: { id: created.id }, body: { enabled: true } }, toggleRes);
    assert.equal(toggleRes.statusCode, 200);
    const toggled = (toggleRes.payload as { item: { enabled: boolean; nextRunAt?: string } }).item;
    assert.equal(toggled.enabled, true);
    assert.ok(toggled.nextRunAt);
  } finally {
    fs.rmSync(harness.storeDir, { recursive: true, force: true });
  }
}

async function testDeprecatedSystemAutomationIsHiddenAndNotRunnable(): Promise<void> {
  const harness = createHarness();
  try {
    const systemJob = harness.store.upsertSystemJob({
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

    const listHandler = harness.routes.getRoutes.get('/api/automations');
    const updateHandler = harness.routes.putRoutes.get('/api/automations/:id');
    const toggleHandler = harness.routes.postRoutes.get('/api/automations/:id/toggle');
    const deleteHandler = harness.routes.deleteRoutes.get('/api/automations/:id');
    const runHandler = harness.routes.postRoutes.get('/api/automations/:id/run');
    assert.ok(listHandler);
    assert.ok(updateHandler);
    assert.ok(toggleHandler);
    assert.ok(deleteHandler);
    assert.ok(runHandler);

    const listRes = createResponseRecorder();
    await listHandler?.({}, listRes);
    assert.equal(listRes.statusCode, 200);
    const items = (listRes.payload as {
      items: Array<{ id: string; readOnly?: boolean; jobSource?: string; systemTask?: string }>;
    }).items;
    assert.equal(items.length, 0);

    const updateRes = createResponseRecorder();
    await updateHandler?.(
      {
        params: { id: systemJob.id },
        body: { name: 'Should Fail' },
      },
      updateRes
    );
    assert.equal(updateRes.statusCode, 403);

    const toggleRes = createResponseRecorder();
    await toggleHandler?.({ params: { id: systemJob.id }, body: { enabled: false } }, toggleRes);
    assert.equal(toggleRes.statusCode, 403);

    const deleteRes = createResponseRecorder();
    await deleteHandler?.({ params: { id: systemJob.id } }, deleteRes);
    assert.equal(deleteRes.statusCode, 403);

    const manualRunRes = createResponseRecorder();
    await runHandler?.({ params: { id: systemJob.id } }, manualRunRes);
    assert.equal(manualRunRes.statusCode, 404);
  } finally {
    fs.rmSync(harness.storeDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testSessionsRouteFiltersAutomationByDefault();
  await testAutomationCrudAndManualMemoryWrite();
  await testAutomationIntervalScheduleCrud();
  await testDeprecatedSystemAutomationIsHiddenAndNotRunnable();
  console.log('web-automation-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
