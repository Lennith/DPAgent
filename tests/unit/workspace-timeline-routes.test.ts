import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceTimelineStore } from '../../src/workspace-timeline/index.js';
import { registerWorkspaceTimelineRoutes } from '../../src/web/server/web-server-workspace-timeline-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-workspace-timeline-routes-'));
}

function createStore(root: string): WorkspaceTimelineStore {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: true,
      captureMode: 'advisory',
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  });
}

function createDisabledStore(root: string): WorkspaceTimelineStore {
  return new WorkspaceTimelineStore({
    runtimeDataDir: path.join(root, 'runtime'),
    config: {
      enabled: false,
      captureMode: 'advisory',
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  });
}

function createCommittedDelta(
  store: WorkspaceTimelineStore,
  workspace: string,
  sessionId: string,
  scope: 'session' | 'workspace' = 'session'
) {
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'before', 'utf-8');
  const handle = store.beginTurn({
    context: { scope, namespace: sessionId },
    turnId: 'turn-1',
    workspaceDir: workspace,
  });
  assert.ok(handle);
  fs.writeFileSync(path.join(workspace, 'file.txt'), 'after', 'utf-8');
  const prepared = store.prepareTurnDelta(handle);
  store.markCommitted(prepared.delta.id);
  return prepared;
}

function createDeps(root: string, store: WorkspaceTimelineStore, options: {
  fullAccess?: boolean;
  canAccessSession?: boolean;
  activeRun?: boolean;
  pendingInput?: boolean;
  interrupted?: boolean;
  arenaLocked?: boolean;
  hiddenArenaBranch?: boolean;
} = {}) {
  const routeHarness = createRouteAppHarness();
  const rollbackRecords: unknown[] = [];
  return {
    routeHarness,
    rollbackRecords,
    deps: {
      app: routeHarness.app,
      wss: { clients: new Set() },
      agent: {
        getWorkspaceTimelineStore: () => store,
        getContextManager: () => ({
          recordWorkspaceRollback: (input: unknown) => {
            rollbackRecords.push(input);
          },
        }),
      },
      contextServices: {
        getContextNamespaceMetaSafe: () => {
          if (options.hiddenArenaBranch) {
            return {
              scope: 'session',
              namespace: 'sess-a',
              name: 'sess-a',
              createdAt: '2026-05-31T00:00:00.000Z',
              updatedAt: '2026-05-31T00:00:00.000Z',
              arenaBranch: {
                arenaId: 'arena-1',
                branchId: 'branch-1',
                sourceSessionId: 'source-sess',
              },
            };
          }
          if (options.arenaLocked) {
            return {
              scope: 'session',
              namespace: 'sess-a',
              name: 'sess-a',
              createdAt: '2026-05-31T00:00:00.000Z',
              updatedAt: '2026-05-31T00:00:00.000Z',
              arenaLock: { arenaId: 'arena-1', lockedAt: '2026-05-31T00:00:00.000Z', mode: 'implementation' },
            };
          }
          return undefined;
        },
        getPendingPlanInputView: () => options.pendingInput ? ({ kind: 'plan_approval' }) : null,
        getActiveRunState: () => options.activeRun ? ({ runId: 'run-1' }) : null,
        getInteractionStateForContext: () => ({ mode: 'normal' }),
        getInterruptedArtifact: () => options.interrupted ? ({ status: 'interrupted' }) : null,
      },
      accessServices: {
        canAccessSession: () => options.canAccessSession ?? true,
        hasFullAccess: () => options.fullAccess ?? true,
      },
      configServices: {},
      agentCatalogServices: {},
      llmServices: {},
      governanceServices: {},
      todoServices: {},
      authServices: {},
      automationRoutes: {},
    } as any,
    root,
  };
}

function testTimelineAndDeltaRoutes(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const store = createStore(root);
    const prepared = createCommittedDelta(store, workspace, 'sess-a');
    const { routeHarness, deps } = createDeps(root, store);
    registerWorkspaceTimelineRoutes(deps);

    const timelineRes = createResponseRecorder();
    routeHarness.getRoutes.get('/api/sessions/:id/workspace-timeline')?.({ params: { id: 'sess-a' } }, timelineRes);
    assert.equal(timelineRes.statusCode, 200);
    const timelinePayload = timelineRes.payload as { success: boolean; timeline: { deltas: Array<{ id: string }> } };
    assert.equal(timelinePayload.success, true);
    assert.equal(timelinePayload.timeline.deltas[0]?.id, prepared.delta.id);

    const deltaRes = createResponseRecorder();
    routeHarness.getRoutes.get('/api/sessions/:id/workspace-deltas/:deltaId')?.({
      params: { id: 'sess-a', deltaId: prepared.delta.id },
    }, deltaRes);
    assert.equal(deltaRes.statusCode, 200);

    const wrongSessionRes = createResponseRecorder();
    routeHarness.getRoutes.get('/api/sessions/:id/workspace-deltas/:deltaId')?.({
      params: { id: 'sess-b', deltaId: prepared.delta.id },
    }, wrongSessionRes);
    assert.equal(wrongSessionRes.statusCode, 404);

    const hidden = createDeps(root, store, { hiddenArenaBranch: true });
    registerWorkspaceTimelineRoutes(hidden.deps);
    const hiddenRes = createResponseRecorder();
    hidden.routeHarness.getRoutes.get('/api/sessions/:id/workspace-timeline')?.({ params: { id: 'sess-a' } }, hiddenRes);
    assert.equal(hiddenRes.statusCode, 404);

    const disabledStore = createDisabledStore(root);
    const disabled = createDeps(root, disabledStore);
    registerWorkspaceTimelineRoutes(disabled.deps);
    const disabledGetRes = createResponseRecorder();
    disabled.routeHarness.getRoutes.get('/api/sessions/:id/workspace-timeline')?.({ params: { id: 'sess-a' } }, disabledGetRes);
    assert.equal(disabledGetRes.statusCode, 404);
    assert.equal((disabledGetRes.payload as { error: string }).error, 'workspace_timeline_not_found');
    const disabledPostRes = createResponseRecorder();
    disabled.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: prepared.resultRevision.id },
    }, disabledPostRes);
    assert.equal(disabledPostRes.statusCode, 404);
    assert.equal((disabledPostRes.payload as { error: string }).error, 'workspace_timeline_not_found');
    const disabledMissingTargetRes = createResponseRecorder();
    disabled.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: {},
    }, disabledMissingTargetRes);
    assert.equal(disabledMissingTargetRes.statusCode, 404);
    assert.equal((disabledMissingTargetRes.payload as { error: string }).error, 'workspace_timeline_not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRouteAccessAndRollbackBoundary(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const store = createStore(root);
    const prepared = createCommittedDelta(store, workspace, 'sess-a');

    const denied = createDeps(root, store, { canAccessSession: false });
    registerWorkspaceTimelineRoutes(denied.deps);
    const deniedRes = createResponseRecorder();
    denied.routeHarness.getRoutes.get('/api/sessions/:id/workspace-timeline')?.({ params: { id: 'sess-a' } }, deniedRes);
    assert.equal(deniedRes.statusCode, 403);

    const observeOnly = createDeps(root, store, { fullAccess: false });
    registerWorkspaceTimelineRoutes(observeOnly.deps);
    const observeOnlyRes = createResponseRecorder();
    observeOnly.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: prepared.resultRevision.id },
    }, observeOnlyRes);
    assert.equal(observeOnlyRes.statusCode, 403);

    const active = createDeps(root, store, { activeRun: true });
    registerWorkspaceTimelineRoutes(active.deps);
    const activeRes = createResponseRecorder();
    active.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: prepared.resultRevision.id },
    }, activeRes);
    assert.equal(activeRes.statusCode, 409);
    assert.equal((activeRes.payload as { error: string }).error, 'active_run');

    const ready = createDeps(root, store);
    registerWorkspaceTimelineRoutes(ready.deps);
    const rollbackRes = createResponseRecorder();
    ready.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: prepared.resultRevision.id, reason: 'stability-test' },
    }, rollbackRes);
    assert.equal(rollbackRes.statusCode, 200);
    assert.equal((rollbackRes.payload as { applied: boolean }).applied, true);
    const auditPath = path.join(root, 'runtime', 'workspace-timeline', 'rollback-audit.jsonl');
    assert.equal(fs.existsSync(auditPath), true);
    assert.match(fs.readFileSync(auditPath, 'utf-8'), /stability-test/);
    assert.equal(ready.rollbackRecords.length, 1);
    assert.deepEqual((ready.rollbackRecords[0] as { context: { namespace: string }; targetRevisionId: string }).context.namespace, 'sess-a');
    assert.deepEqual((ready.rollbackRecords[0] as { targetRevisionId: string }).targetRevisionId, prepared.resultRevision.id);

    const workspaceScoped = createCommittedDelta(store, workspace, 'sess-a', 'workspace');
    const wrongScopeRes = createResponseRecorder();
    ready.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: workspaceScoped.resultRevision.id },
    }, wrongScopeRes);
    assert.equal(wrongScopeRes.statusCode, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRollbackRejectsUnsafeStatesAndBadTargets(): void {
  const root = tempRoot();
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const store = createStore(root);
    const prepared = createCommittedDelta(store, workspace, 'sess-a');
    const cases: Array<{ name: string; options: Parameters<typeof createDeps>[2]; error: string }> = [
      { name: 'pending', options: { pendingInput: true }, error: 'pending_input' },
      { name: 'interrupted', options: { interrupted: true }, error: 'interrupted_state' },
      { name: 'arena', options: { arenaLocked: true }, error: 'arena_locked' },
    ];

    for (const item of cases) {
      const harness = createDeps(root, store, item.options);
      registerWorkspaceTimelineRoutes(harness.deps);
      const res = createResponseRecorder();
      harness.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
        params: { id: 'sess-a' },
        body: { targetRevisionId: prepared.resultRevision.id },
      }, res);
      assert.equal(res.statusCode, 409, item.name);
      assert.equal((res.payload as { error: string }).error, item.error, item.name);
    }

    const ready = createDeps(root, store);
    registerWorkspaceTimelineRoutes(ready.deps);
    const missingTargetRes = createResponseRecorder();
    ready.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: {},
    }, missingTargetRes);
    assert.equal(missingTargetRes.statusCode, 400);
    assert.equal((missingTargetRes.payload as { error: string }).error, 'target_revision_required');

    const unknownRevisionRes = createResponseRecorder();
    ready.routeHarness.postRoutes.get('/api/sessions/:id/workspace-rollback')?.({
      params: { id: 'sess-a' },
      body: { targetRevisionId: 'rev-missing' },
    }, unknownRevisionRes);
    assert.equal(unknownRevisionRes.statusCode, 404);
    assert.equal((unknownRevisionRes.payload as { error: string }).error, 'workspace_revision_not_found');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(): void {
  testTimelineAndDeltaRoutes();
  testRouteAccessAndRollbackBoundary();
  testRollbackRejectsUnsafeStatesAndBadTargets();
  console.log('workspace-timeline route tests passed');
}

run();
