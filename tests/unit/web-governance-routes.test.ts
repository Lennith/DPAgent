import * as assert from 'node:assert/strict';
import { registerGovernanceRoutes } from '../../src/web/server/web-server-governance-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createHarness(options: { observeOnly?: boolean; throwOnWorkspaceResolve?: boolean } = {}) {
  const routes = createRouteAppHarness();
  const defaultWorkspaceDir = 'D:\\default-governance-workspace';
  const sessionWorkspaceDir = 'D:\\session-governance-workspace';
  const memoryListInputs: unknown[] = [];
  const auditInputs: unknown[] = [];
  const listTodoInputs: unknown[] = [];
  const createTodoInputs: unknown[] = [];
  const updateTodoInputs: unknown[] = [];
  const dismissTodoInputs: unknown[] = [];
  const organizeMemoryInputs: unknown[] = [];
  const ensureTodoLoopInputs: unknown[] = [];
  const workspaceResolutionCalls: unknown[] = [];

  registerGovernanceRoutes({
    app: routes.app as any,
    agent: {
      getConfig: () => ({ agent: { workspaceDir: defaultWorkspaceDir } }),
      getMemoryStore: () => ({
        listEntries: (input: unknown) => {
          memoryListInputs.push(input);
          return [{ id: 'mem-1' }];
        },
      }),
      getMemoryPromotionState: (sessionId: string) => ({ sessionId }),
      getContextNamespaceMeta: (context: { namespace: string }) =>
        context.namespace === 'missing-session' ? undefined : {},
      organizeSessionMemory: async (input: unknown) => {
        organizeMemoryInputs.push(input);
        return { status: 'ok' };
      },
      listGovernanceAudit: (input: unknown) => {
        auditInputs.push(input);
        return [{ id: 'audit-1' }];
      },
      getTodoStore: () => ({
        listTodos: (input: unknown) => {
          listTodoInputs.push(input);
          return [{ id: 'todo-1' }];
        },
        getProtocolState: () => ({ items: [] }),
        clearCompletedTodos: () => 0,
        setTodoPlan: () => [],
        createTodo: (input: unknown) => {
          createTodoInputs.push(input);
          return { id: 'todo-created' };
        },
        deleteTodo: () => true,
        dismissTodo: (id: string, input: unknown) => {
          dismissTodoInputs.push({ id, input });
          return { id };
        },
        resumeTodo: () => ({ id: 'todo-resumed' }),
        updateTodo: (id: string, input: unknown) => {
          updateTodoInputs.push({ id, input });
          return { id };
        },
      }),
    },
    contextServices: {
      resolveWorkspaceDirForContext: (context: unknown) => {
        workspaceResolutionCalls.push(context);
        if (options.throwOnWorkspaceResolve) {
          throw new Error('workspace should not resolve');
        }
        return sessionWorkspaceDir;
      },
      getInteractionStateForContext: () =>
        options.observeOnly
          ? { mode: 'observe_only', owner: 'cli', reason: 'cli_active_run' }
          : { mode: 'normal' },
      getActiveRunState: () => null,
    },
    todoServices: {
      ensureTodoDrivenAutoLoop: (sessionId: string, workspaceDir?: string) => {
        ensureTodoLoopInputs.push({ sessionId, workspaceDir });
      },
    },
  } as any);

  return {
    routes,
    defaultWorkspaceDir,
    sessionWorkspaceDir,
    memoryListInputs,
    auditInputs,
    listTodoInputs,
    createTodoInputs,
    updateTodoInputs,
    dismissTodoInputs,
    organizeMemoryInputs,
    ensureTodoLoopInputs,
    workspaceResolutionCalls,
  };
}

async function testReadRoutesResolveSessionWorkspace(): Promise<void> {
  const harness = createHarness();
  const memoryHandler = harness.routes.getRoutes.get('/api/memory');
  const auditHandler = harness.routes.getRoutes.get('/api/audit');
  const todosHandler = harness.routes.getRoutes.get('/api/todos');
  assert.ok(memoryHandler);
  assert.ok(auditHandler);
  assert.ok(todosHandler);

  const memoryRes = createResponseRecorder();
  await memoryHandler({ query: { sessionId: ' sess-1 ' } }, memoryRes);
  assert.equal(memoryRes.statusCode, 200);
  assert.deepEqual(harness.memoryListInputs, [
    { workspaceDir: harness.sessionWorkspaceDir, includeUser: true },
  ]);

  const auditRes = createResponseRecorder();
  await auditHandler({ query: { sessionId: ' sess-1 ', limit: '12' } }, auditRes);
  assert.equal(auditRes.statusCode, 200);
  assert.deepEqual(harness.auditInputs, [
    { sessionId: 'sess-1', workspaceDir: harness.sessionWorkspaceDir, limit: 12 },
  ]);

  const todosRes = createResponseRecorder();
  await todosHandler({ query: { sessionId: ' sess-1 ', include_completed: 'true' } }, todosRes);
  assert.equal(todosRes.statusCode, 200);
  assert.deepEqual(harness.listTodoInputs, [
    {
      scope: 'session',
      sessionId: 'sess-1',
      workspaceDir: harness.sessionWorkspaceDir,
      includeCompleted: true,
    },
  ]);
}

async function testReadRoutesUseDefaultWorkspaceWithoutSession(): Promise<void> {
  const harness = createHarness();
  const handler = harness.routes.getRoutes.get('/api/todos');
  assert.ok(handler);

  const res = createResponseRecorder();
  await handler({ query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.workspaceResolutionCalls, []);
  assert.deepEqual(harness.listTodoInputs, [
    {
      scope: 'workspace',
      sessionId: undefined,
      workspaceDir: harness.defaultWorkspaceDir,
      includeCompleted: false,
    },
  ]);
}

async function testObserveOnlyWritesRejectBeforeWorkspaceResolution(): Promise<void> {
  const harness = createHarness({ observeOnly: true, throwOnWorkspaceResolve: true });
  const addHandler = harness.routes.postRoutes.get('/api/todos');
  const updateHandler = harness.routes.postRoutes.get('/api/todos/:id');
  const deleteHandler = harness.routes.deleteRoutes.get('/api/todos/:id');
  const organizeHandler = harness.routes.postRoutes.get('/api/memory/organize');
  assert.ok(addHandler);
  assert.ok(updateHandler);
  assert.ok(deleteHandler);
  assert.ok(organizeHandler);

  const addRes = createResponseRecorder();
  await addHandler({ body: { action: 'add', sessionId: 'sess-observe', work: 'blocked' } }, addRes);
  assert.equal(addRes.statusCode, 409);

  const updateRes = createResponseRecorder();
  await updateHandler(
    { params: { id: 'todo-1' }, body: { action: 'dismiss', sessionId: 'sess-observe' } },
    updateRes
  );
  assert.equal(updateRes.statusCode, 409);

  const deleteRes = createResponseRecorder();
  await deleteHandler(
    { params: { id: 'todo-1' }, query: { sessionId: 'sess-observe' } },
    deleteRes
  );
  assert.equal(deleteRes.statusCode, 409);

  const organizeRes = createResponseRecorder();
  await organizeHandler({ body: { sessionId: 'sess-observe' }, query: {} }, organizeRes);
  assert.equal(organizeRes.statusCode, 409);

  assert.deepEqual(harness.workspaceResolutionCalls, []);
  assert.deepEqual(harness.createTodoInputs, []);
  assert.deepEqual(harness.dismissTodoInputs, []);
  assert.deepEqual(harness.organizeMemoryInputs, []);
}

async function testTodoWritesUseSessionWorkspaceAfterObserveGate(): Promise<void> {
  const harness = createHarness();
  const addHandler = harness.routes.postRoutes.get('/api/todos');
  const updateHandler = harness.routes.postRoutes.get('/api/todos/:id');
  assert.ok(addHandler);
  assert.ok(updateHandler);

  const addRes = createResponseRecorder();
  await addHandler(
    {
      body: {
        action: 'add',
        sessionId: ' sess-1 ',
        work: 'Write audit',
        detection_standard: 'Audit exists',
      },
    },
    addRes
  );
  assert.equal(addRes.statusCode, 200);
  assert.deepEqual(harness.createTodoInputs, [
    {
      scope: 'session',
      sessionId: 'sess-1',
      workspaceDir: harness.sessionWorkspaceDir,
      work: 'Write audit',
      detectionStandard: 'Audit exists',
      priority: undefined,
      tags: undefined,
      sourceSessionId: 'sess-1',
    },
  ]);

  const updateRes = createResponseRecorder();
  await updateHandler(
    { params: { id: 'todo-1' }, body: { action: 'set_status', sessionId: ' sess-1 ', status: 'completed' } },
    updateRes
  );
  assert.equal(updateRes.statusCode, 200);
  assert.deepEqual(harness.updateTodoInputs[0], {
    id: 'todo-1',
    input: {
      scope: 'session',
      sessionId: 'sess-1',
      workspaceDir: harness.sessionWorkspaceDir,
      work: undefined,
      detectionStandard: undefined,
      priority: undefined,
      tags: undefined,
      status: 'completed',
      completionTaskId: 'todo-1',
      evidence: undefined,
      blockedReason: undefined,
    },
  });
  assert.deepEqual(harness.ensureTodoLoopInputs, [
    { sessionId: 'sess-1', workspaceDir: harness.sessionWorkspaceDir },
    { sessionId: 'sess-1', workspaceDir: harness.sessionWorkspaceDir },
  ]);
}

async function runAll(): Promise<void> {
  await testReadRoutesResolveSessionWorkspace();
  await testReadRoutesUseDefaultWorkspaceWithoutSession();
  await testObserveOnlyWritesRejectBeforeWorkspaceResolution();
  await testTodoWritesUseSessionWorkspaceAfterObserveGate();
  console.log('web-governance-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
