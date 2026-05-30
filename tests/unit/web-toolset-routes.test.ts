import * as assert from 'node:assert/strict';
import { registerSubagentAndToolsetRoutes } from '../../src/web/server/web-server-subagent-toolset-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createHarness(
  options: {
    observeOnly?: boolean;
    arenaLocked?: boolean;
    subagentItems?: unknown[];
    createResult?: unknown;
    resumeResult?: unknown;
  } = {}
) {
  const routes = createRouteAppHarness();
  const defaultWorkspaceDir = 'D:\\default-workspace';
  const sessionWorkspaceDir = 'D:\\session-workspace';
  const explicitWorkspaceDir = 'D:\\explicit-workspace';
  const workspacePresetLookups: string[] = [];
  const setPresetInputs: unknown[] = [];
  const clearPresetInputs: unknown[] = [];
  const createSubagentInputs: unknown[] = [];
  const resumeSubagentInputs: unknown[] = [];

  registerSubagentAndToolsetRoutes({
    app: routes.app as any,
    agent: {
      getConfig: () => ({
        agent: {
          workspaceDir: defaultWorkspaceDir,
          defaultToolset: 'default-tools',
        },
      }),
      getContextNamespaceMeta: () =>
        options.arenaLocked
          ? {
              arenaLock: {
                arenaId: 'arena-locked',
                lockedAt: '2026-05-30T00:00:00.000Z',
                mode: 'implementation',
              },
            }
          : {},
      listToolsets: () => [{ name: 'default-tools' }],
      resolveToolsetName: (context: { namespace: string }) => `session-tools:${context.namespace}`,
      getToolsetPresetStore: () => ({
        getWorkspacePreset: (workspaceDir: string) => {
          workspacePresetLookups.push(workspaceDir);
          return { scope: 'workspace', workspaceDir, toolsetName: `preset:${workspaceDir}` };
        },
        getTeamPreset: () => ({ scope: 'team', toolsetName: 'team-tools' }),
      }),
      listToolsetPresets: () => ({ teamPresets: [] }),
      setToolsetPreset: (input: unknown) => {
        setPresetInputs.push(input);
        return { id: 'set-preset' };
      },
      clearToolsetPreset: (input: unknown) => {
        clearPresetInputs.push(input);
        return true;
      },
    },
    agentCatalogServices: {},
    contextServices: {
      getContextNamespaceMetaSafe: () =>
        options.arenaLocked
          ? {
              arenaLock: {
                arenaId: 'arena-locked',
                lockedAt: '2026-05-30T00:00:00.000Z',
                mode: 'implementation',
              },
            }
          : {},
      resolveWorkspaceDirForContext: (context: { namespace: string }) => {
        assert.match(context.namespace, /^sess-/);
        return sessionWorkspaceDir;
      },
      getInteractionStateForContext: () =>
        options.observeOnly
          ? { mode: 'observe_only', owner: 'cli', reason: 'cli_active_run' }
          : { mode: 'normal' },
      getActiveRunState: () => null,
      resolveAgentForContext: () => ({
        getSubAgentManager: () => ({
          list: () => options.subagentItems ?? [],
          cancel: () => null,
          create: (input: unknown) => {
            createSubagentInputs.push(input);
            return options.createResult ?? { ok: true, status: { subagentId: 'new-subagent', status: 'queued' } };
          },
          resume: (input: unknown) => {
            resumeSubagentInputs.push(input);
            return options.resumeResult ?? { ok: true, status: { subagentId: 'resumed-subagent', status: 'queued' } };
          },
        }),
      }),
    },
  } as any);

  return {
    routes,
    defaultWorkspaceDir,
    sessionWorkspaceDir,
    explicitWorkspaceDir,
    workspacePresetLookups,
    setPresetInputs,
    clearPresetInputs,
    createSubagentInputs,
    resumeSubagentInputs,
  };
}

function testRetrySubagentReusesOriginalPromptAndMetadata(): void {
  const harness = createHarness({
    subagentItems: [
      {
        subagentId: 'sub-1',
        status: 'failed',
        prompt: '  retry this  ',
        providerId: 'provider-a',
        agent: { name: 'agent-a' },
        allowedTools: ['Read'],
        workspaceDir: 'D:\\retry-workspace',
      },
    ],
  });
  const handler = harness.routes.postRoutes.get('/api/sessions/:id/subagents/:subagentId/retry');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ params: { id: 'sess-subagent', subagentId: 'sub-1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    success: true,
    status: { subagentId: 'new-subagent', status: 'queued' },
  });
  assert.deepEqual(harness.createSubagentInputs, [
    {
      parentContext: { scope: 'session', namespace: 'sess-subagent' },
      prompt: 'retry this',
      providerId: 'provider-a',
      agentName: 'agent-a',
      allowedTools: ['Read'],
      workspaceDir: 'D:\\retry-workspace',
    },
  ]);
}

function testRetrySubagentRejectsUnsupportedStatusWithoutCreate(): void {
  const harness = createHarness({
    subagentItems: [
      {
        subagentId: 'sub-1',
        status: 'running',
        prompt: 'retry this',
      },
    ],
  });
  const handler = harness.routes.postRoutes.get('/api/sessions/:id/subagents/:subagentId/retry');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ params: { id: 'sess-subagent', subagentId: 'sub-1' } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Cannot retry subagent with status: running' });
  assert.deepEqual(harness.createSubagentInputs, []);
}

function testRetryMissingSubagentReturnsSharedNotFound(): void {
  const harness = createHarness();
  const handler = harness.routes.postRoutes.get('/api/sessions/:id/subagents/:subagentId/retry');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ params: { id: 'sess-subagent', subagentId: 'missing-subagent' } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.payload, { error: 'Subagent not found' });
  assert.deepEqual(harness.createSubagentInputs, []);
}

function testResumeSubagentReusesOriginalPromptAndMetadata(): void {
  const harness = createHarness({
    subagentItems: [
      {
        subagentId: 'sub-1',
        status: 'canceled',
        prompt: '  resume this  ',
        providerId: 'provider-a',
        agent: { name: 'agent-a' },
        allowedTools: ['Read'],
        workspaceDir: 'D:\\resume-workspace',
      },
    ],
  });
  const handler = harness.routes.postRoutes.get('/api/sessions/:id/subagents/:subagentId/resume');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ params: { id: 'sess-subagent', subagentId: 'sub-1' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    success: true,
    status: { subagentId: 'resumed-subagent', status: 'queued' },
  });
  assert.deepEqual(harness.resumeSubagentInputs, [
    {
      parentContext: { scope: 'session', namespace: 'sess-subagent' },
      subagentId: 'sub-1',
      prompt: 'resume this',
      providerId: 'provider-a',
      agentName: 'agent-a',
      allowedTools: ['Read'],
      workspaceDir: 'D:\\resume-workspace',
    },
  ]);
}

function testResumeSubagentRejectsBlankPromptWithoutResume(): void {
  const harness = createHarness({
    subagentItems: [
      {
        subagentId: 'sub-1',
        status: 'canceled',
        prompt: '   ',
      },
    ],
  });
  const handler = harness.routes.postRoutes.get('/api/sessions/:id/subagents/:subagentId/resume');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ params: { id: 'sess-subagent', subagentId: 'sub-1' } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Cannot resume subagent: original prompt is unavailable' });
  assert.deepEqual(harness.resumeSubagentInputs, []);
}

function testToolsetsRouteResolvesDefaultAndSessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.getRoutes.get('/api/toolsets');
  assert.ok(handler);

  const defaultRes = createResponseRecorder();
  handler({ query: {} }, defaultRes);
  assert.equal(defaultRes.statusCode, 200);
  assert.equal((defaultRes.payload as { workspaceDir: string }).workspaceDir, harness.defaultWorkspaceDir);
  assert.equal((defaultRes.payload as { activeToolset: string }).activeToolset, 'default-tools');

  const sessionRes = createResponseRecorder();
  handler({ query: { sessionId: 'sess-toolset' } }, sessionRes);
  assert.equal(sessionRes.statusCode, 200);
  assert.equal((sessionRes.payload as { workspaceDir: string }).workspaceDir, harness.sessionWorkspaceDir);
  assert.equal((sessionRes.payload as { activeToolset: string }).activeToolset, 'session-tools:sess-toolset');

  assert.deepEqual(harness.workspacePresetLookups.slice(0, 2), [
    harness.defaultWorkspaceDir,
    harness.sessionWorkspaceDir,
  ]);
}

function testPresetListUsesExplicitWorkspaceBeforeSessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.getRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    { query: { sessionId: 'sess-preset', workspaceDir: ` ${harness.explicitWorkspaceDir} ` } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(harness.workspacePresetLookups.at(-1), harness.explicitWorkspaceDir);
}

function testPresetListWithoutWorkspaceDoesNotUseDefaultWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.getRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.workspacePresetLookups, []);
  assert.equal((res.payload as { workspacePreset?: unknown }).workspacePreset, undefined);
}

function testPresetMutationResolvesBodySessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.postRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    {
      body: {
        sessionId: 'sess-preset',
        scope: 'workspace',
        toolsetName: 'safe-tools',
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.setPresetInputs, [
    {
      scope: 'workspace',
      toolsetName: 'safe-tools',
      workspaceDir: harness.sessionWorkspaceDir,
      sessionId: 'sess-preset',
    },
  ]);
}

function testPresetMutationUsesExplicitWorkspaceBeforeSessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.postRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    {
      body: {
        sessionId: 'sess-preset',
        workspaceDir: ` ${harness.explicitWorkspaceDir} `,
        scope: 'workspace',
        toolsetName: 'safe-tools',
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.setPresetInputs, [
    {
      scope: 'workspace',
      toolsetName: 'safe-tools',
      workspaceDir: harness.explicitWorkspaceDir,
      sessionId: 'sess-preset',
    },
  ]);
}

function testPresetMutationObserveOnlyDoesNotSetPreset(): void {
  const harness = createHarness({ observeOnly: true });
  const handler = harness.routes.postRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    {
      body: {
        sessionId: 'sess-preset',
        scope: 'workspace',
        toolsetName: 'safe-tools',
      },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as { error: string }).error, 'observe_only');
  assert.deepEqual(harness.setPresetInputs, []);
}

function testPresetMutationArenaLockedDoesNotSetPreset(): void {
  const harness = createHarness({ arenaLocked: true });
  const handler = harness.routes.postRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    {
      body: {
        sessionId: 'sess-preset',
        scope: 'workspace',
        toolsetName: 'safe-tools',
      },
    },
    res
  );

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as { error: string }).error, 'arena_locked');
  assert.deepEqual(harness.setPresetInputs, []);
}

function testPresetDeleteUsesExplicitQueryWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.deleteRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    { query: { scope: 'workspace', workspaceDir: ` ${harness.explicitWorkspaceDir} ` } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.clearPresetInputs, [
    {
      scope: 'workspace',
      workspaceDir: harness.explicitWorkspaceDir,
      sessionId: undefined,
    },
  ]);
}

function testPresetDeleteObserveOnlyDoesNotClearPreset(): void {
  const harness = createHarness({ observeOnly: true });
  const handler = harness.routes.deleteRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ query: { sessionId: 'sess-preset', scope: 'workspace' } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as { error: string }).error, 'observe_only');
  assert.deepEqual(harness.clearPresetInputs, []);
}

function testPresetDeleteArenaLockedDoesNotClearPreset(): void {
  const harness = createHarness({ arenaLocked: true });
  const handler = harness.routes.deleteRoutes.get('/api/toolsets/presets');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler({ query: { sessionId: 'sess-preset', scope: 'workspace' } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as { error: string }).error, 'arena_locked');
  assert.deepEqual(harness.clearPresetInputs, []);
}

function runAll(): void {
  testRetrySubagentReusesOriginalPromptAndMetadata();
  testRetrySubagentRejectsUnsupportedStatusWithoutCreate();
  testRetryMissingSubagentReturnsSharedNotFound();
  testResumeSubagentReusesOriginalPromptAndMetadata();
  testResumeSubagentRejectsBlankPromptWithoutResume();
  testToolsetsRouteResolvesDefaultAndSessionWorkspace();
  testPresetListUsesExplicitWorkspaceBeforeSessionWorkspace();
  testPresetListWithoutWorkspaceDoesNotUseDefaultWorkspace();
  testPresetMutationResolvesBodySessionWorkspace();
  testPresetMutationUsesExplicitWorkspaceBeforeSessionWorkspace();
  testPresetMutationObserveOnlyDoesNotSetPreset();
  testPresetMutationArenaLockedDoesNotSetPreset();
  testPresetDeleteUsesExplicitQueryWorkspace();
  testPresetDeleteObserveOnlyDoesNotClearPreset();
  testPresetDeleteArenaLockedDoesNotClearPreset();
  console.log('web-toolset-routes tests passed');
}

runAll();
