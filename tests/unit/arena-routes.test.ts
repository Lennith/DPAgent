import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerGovernanceRoutes } from '../../src/web/server/web-server-governance-routes.js';
import { registerArenaRoutes } from '../../src/web/server/web-server-arena-routes.js';
import { registerSessionRoutes } from '../../src/web/server/web-server-session-routes.js';
import { registerSubagentAndToolsetRoutes } from '../../src/web/server/web-server-subagent-toolset-routes.js';
import { ArenaStore } from '../../src/arena/index.js';
import type { ContextRef, ContextNamespaceMeta } from '../../src/types.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createMeta(id: string, patch: Partial<ContextNamespaceMeta> = {}) {
  return {
    scope: 'session' as const,
    namespace: id,
    name: id,
    createdAt: '2026-05-29T00:00:00.000Z',
    updatedAt: '2026-05-29T00:00:00.000Z',
    projection: { version: 1 },
    ...patch,
  };
}

function createSessionRouteHarness(options: { fullAccess?: boolean; canAccessSession?: boolean } = {}) {
  const routeHarness = createRouteAppHarness();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-arena-routes-'));
  const sourceWorkspaceDir = path.join(tempDir, 'source-workspace');
  fs.mkdirSync(sourceWorkspaceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceWorkspaceDir, 'README.md'), 'source', 'utf-8');
  const arenaStore = new ArenaStore(path.join(tempDir, 'arena'));
  const runCalls: Array<{
    context: ContextRef;
    prompt: string;
    additionalSystemPrompt?: string;
    agentRuntimeOverrides?: { toolsetName?: string };
  }> = [];
  const metaBySession = new Map<string, ReturnType<typeof createMeta>>([
    [
      'sess-open',
      createMeta('sess-open', {
        name: 'open',
        workspaceDir: sourceWorkspaceDir,
        llmSelection: {
          profileId: 'default',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      }),
    ],
    [
      'sess-source',
      createMeta('sess-source', {
        arenaLock: {
          arenaId: 'arena-1',
          lockedAt: '2026-05-29T00:00:00.000Z',
          mode: 'implementation',
        },
      }),
    ],
    [
      'sess-hidden-branch',
      createMeta('sess-hidden-branch', {
        arenaBranch: {
          arenaId: 'arena-1',
          branchId: 'branch-1',
          sourceSessionId: 'sess-source',
        },
      }),
    ],
    [
      'sess-promoted-branch',
      createMeta('sess-promoted-branch', {
        arenaBranch: {
          arenaId: 'arena-1',
          branchId: 'branch-2',
          sourceSessionId: 'sess-source',
          promoted: true,
        },
      }),
    ],
    [
      'sess-unpromoted-source',
      createMeta('sess-unpromoted-source', {
        arenaBranch: {
          arenaId: 'arena-1',
          branchId: 'branch-3',
          sourceSessionId: 'sess-source',
        },
        llmSelection: {
          profileId: 'default',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      }),
    ],
    [
      'sess-no-workspace',
      createMeta('sess-no-workspace', {
        llmSelection: {
          profileId: 'default',
          model: 'MiniMax-M2.5',
          reasoningPreset: 'off',
          updatedAt: '2026-05-29T00:00:00.000Z',
        },
      }),
    ],
  ]);
  const mutationCalls: string[] = [];
  const deps = {
    app: routeHarness.app as any,
    wss: { clients: new Set() } as any,
    agent: {
      getConfig: () => ({
        llmProfiles: {
          defaultProfileId: 'default',
          profiles: [
            {
              id: 'default',
              name: 'Default',
              provider: 'anthropic',
              apiKey: 'sk-test',
              apiBase: 'https://api.example.test',
              defaultModel: 'MiniMax-M2.5',
              maxOutputTokens: 4096,
              capabilities: {},
              updatedAt: '2026-05-29T00:00:00.000Z',
            },
          ],
        },
        agent: { runtimeDataDir: tempDir, workspaceDir: sourceWorkspaceDir },
      }),
      getArenaStore: () => arenaStore,
      getContextManager: () => ({
        listNamespaces: () => [...metaBySession.values()],
        forkSessionNamespace: (input: { targetNamespace: string; name?: string }) => {
          const meta = createMeta(input.targetNamespace, { name: input.name });
          metaBySession.set(input.targetNamespace, meta);
          mutationCalls.push('forkSessionNamespace');
          return meta;
        },
        updateNamespaceMeta: (ref: ContextRef, patch: Partial<ContextNamespaceMeta>) => {
          const current = metaBySession.get(ref.namespace) ?? createMeta(ref.namespace);
          const next = { ...current, ...patch };
          metaBySession.set(ref.namespace, next);
          mutationCalls.push('updateNamespaceMeta');
          return next;
        },
      }),
      getContextNamespaceMeta: (ref: ContextRef) => metaBySession.get(ref.namespace),
      forkSessionNamespace: () => {
        mutationCalls.push('forkSessionNamespace');
        return createMeta('forked');
      },
      hasInterruptedState: () => false,
      updateContextNamespaceMeta: (_ref: ContextRef, patch: Partial<ContextNamespaceMeta>) => {
        mutationCalls.push('updateContextNamespaceMeta');
        return patch;
      },
      deleteSessionContext: () => {
        mutationCalls.push('deleteSessionContext');
        return true;
      },
      resolveToolsetName: () => 'full-access',
      getContextMessages: () => [],
      getContextWebMessages: (ref: ContextRef) => [
        {
          role: 'user',
          content: `message for ${ref.namespace}`,
          createdAt: '2026-05-29T00:00:03.000Z',
        },
        {
          role: 'assistant',
          content: 'visible answer',
          createdAt: '2026-05-29T00:00:04.000Z',
          thinking: 'hidden thinking',
          toolCalls: [{ id: 'call-1', function: { name: 'secret_tool', arguments: { secret: true } } }],
        },
        {
          role: 'tool',
          name: 'secret_tool',
          content: 'secret tool result',
          createdAt: '2026-05-29T00:00:05.000Z',
        },
      ],
      getToolsetRegistry: () => ({ get: () => ({ name: 'windows-dev' }), list: () => [] }),
      getGovernanceAuditStore: () => ({ append: () => undefined }),
      getTodoStore: () => ({
        listTodos: () => [],
        getProtocolState: () => ({ hasUnfinished: false, unfinishedItems: [], items: [] }),
        dismissUnfinishedTodos: () => {
          mutationCalls.push('dismissUnfinishedTodos');
          return [];
        },
      }),
    },
    contextServices: {
      getContextNamespaceMetaSafe: (ref: ContextRef) => metaBySession.get(ref.namespace),
      getPendingPlanInputView: () => null,
      getActiveRunState: () => null,
      listActiveSessionRunStates: () => [
        {
          context: { scope: 'session', namespace: 'sess-hidden-branch' },
          runId: 'run-hidden',
          startedAt: '2026-05-29T00:00:01.000Z',
          lastActivityAt: '2026-05-29T00:00:02.000Z',
          origin: 'web',
          interactionState: { mode: 'normal' },
        },
      ],
      getInteractionStateForContext: () => ({ mode: 'normal' }),
      getInterruptedArtifact: () => null,
      updateContextNamespaceMetaSafe: (ref: ContextRef, patch: Partial<ContextNamespaceMeta>) => {
        const current = metaBySession.get(ref.namespace) ?? createMeta(ref.namespace);
        metaBySession.set(ref.namespace, { ...current, ...patch });
        mutationCalls.push('updateContextNamespaceMetaSafe');
      },
      resolveWorkspaceDirForContext: () => sourceWorkspaceDir,
      resolveAgentForContext: () => ({
        cancelContext: () => 0,
        run: async (input: {
          context: ContextRef;
          prompt: string;
          additionalSystemPrompt?: string;
          agentRuntimeOverrides?: { toolsetName?: string };
        }) => {
          runCalls.push({
            context: input.context,
            prompt: input.prompt,
            additionalSystemPrompt: input.additionalSystemPrompt,
            agentRuntimeOverrides: input.agentRuntimeOverrides,
          });
          return 'run started';
        },
        getSubAgentManager: () => ({
          list: () => [
            {
              subagentId: 'sub-1',
              prompt: 'retry me',
              status: 'failed',
              workspaceDir: 'D:\\repo',
            },
          ],
          cancel: () => {
            mutationCalls.push('cancelSubagent');
            return null;
          },
          create: () => {
            mutationCalls.push('createSubagent');
            return { ok: false, error: 'blocked', code: 'blocked' };
          },
          resume: () => {
            mutationCalls.push('resumeSubagent');
            return { ok: false, error: 'blocked', code: 'blocked' };
          },
        }),
      }),
      cleanupSessionRuntime: async () => {
        mutationCalls.push('cleanupSessionRuntime');
      },
    },
    todoServices: {
      ensureTodoDrivenAutoLoop: () => undefined,
      getSessionTodoProtocolState: () => ({ hasUnfinished: false, unfinishedItems: [], items: [] }),
    },
    automationRoutes: { register: () => undefined },
    configServices: {
      hasUsableApiKey: () => true,
      persistConfigFile: () => undefined,
      setBootMissingApiKey: () => undefined,
      refreshConfigDependentRuntimes: async () => undefined,
    },
    agentCatalogServices: {
      refreshGlobalAgentCatalog: () => undefined,
      getGlobalAgentProfiles: () => [],
    },
    llmServices: {
      discoverProfileModels: async () => ({}) as any,
    },
    governanceServices: {
      runWorkspaceSkillGovernance: async () => ({}) as any,
      getLatestWorkspaceSkillGovernanceReport: () => null,
    },
    authServices: {
      isLoopback: () => true,
      isAuthenticatedForRemoteAccess: () => true,
      handleLogin: () => ({ success: true }),
      handleLogout: () => '',
      getStatus: () => ({ required: false, authenticated: true, local: true, configured: false }),
    },
    accessServices: {
      getSharedAccessSessionId: () => null,
      canAccessSession: () => options.canAccessSession ?? true,
      hasFullAccess: () => options.fullAccess ?? true,
    },
    shareServices: {
      resolveShareToken: (token: string) => {
        if (token === 'hidden') {
          return {
            sessionId: 'sess-hidden-branch',
            expiresAt: '2026-05-30T00:00:00.000Z',
          };
        }
        return null;
      },
      getSessionShareStatus: () => ({ active: false }),
      createSessionShare: (sessionId: string) => ({
        token: `token-${sessionId}`,
        url: `/share/token-${sessionId}`,
        expiresAt: '2026-05-30T00:00:00.000Z',
      }),
      revokeSessionShare: () => ({ active: false }),
    },
  };
  registerArenaRoutes(deps as any);
  registerSessionRoutes(deps as any);
  registerGovernanceRoutes(deps as any);
  registerSubagentAndToolsetRoutes(deps as any);
  return {
    routeHarness,
    mutationCalls,
    runCalls,
    metaBySession,
    arenaStore,
    sourceWorkspaceDir,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

async function testSessionProjectionAndHiddenBranches(): Promise<void> {
  const { routeHarness, cleanup } = createSessionRouteHarness();
  try {
    const list = routeHarness.getRoutes.get('/api/sessions');
    assert.ok(list);
    const listRes = createResponseRecorder();
    await list({ query: {} }, listRes);
    const sessions = (listRes.payload as any).sessions as Array<{ id: string; arena?: unknown }>;
    assert.deepEqual(sessions.map((session) => session.id), [
      'sess-open',
      'sess-source',
      'sess-promoted-branch',
      'sess-no-workspace',
    ]);
    assert.deepEqual(sessions.find((session) => session.id === 'sess-source')?.arena, {
      locked: true,
      runId: 'arena-1',
      mode: 'implementation',
    });
    assert.deepEqual(sessions.find((session) => session.id === 'sess-promoted-branch')?.arena, {
      locked: false,
      runId: 'arena-1',
      branchId: 'branch-2',
      promoted: true,
    });

    const detail = routeHarness.getRoutes.get('/api/sessions/:id');
    assert.ok(detail);
    const detailRes = createResponseRecorder();
    await detail({ params: { id: 'sess-source' }, query: {} }, detailRes);
    assert.equal((detailRes.payload as any).arena.locked, true);

    const hiddenDetailRes = createResponseRecorder();
    await detail({ params: { id: 'sess-hidden-branch' }, query: {} }, hiddenDetailRes);
    assert.equal(hiddenDetailRes.statusCode, 404);

    const llmSelection = routeHarness.getRoutes.get('/api/sessions/:id/llm-selection');
    assert.ok(llmSelection);
    const hiddenLlmRes = createResponseRecorder();
    await llmSelection({ params: { id: 'sess-hidden-branch' }, query: {} }, hiddenLlmRes);
    assert.equal(hiddenLlmRes.statusCode, 404);

    const shareStatus = routeHarness.getRoutes.get('/api/sessions/:id/share');
    assert.ok(shareStatus);
    const hiddenShareStatusRes = createResponseRecorder();
    await shareStatus({ params: { id: 'sess-hidden-branch' }, query: {} }, hiddenShareStatusRes);
    assert.equal(hiddenShareStatusRes.statusCode, 404);

    const createShare = routeHarness.postRoutes.get('/api/sessions/:id/share');
    assert.ok(createShare);
    const hiddenCreateShareRes = createResponseRecorder();
    await createShare({ params: { id: 'sess-hidden-branch' }, body: {} }, hiddenCreateShareRes);
    assert.equal(hiddenCreateShareRes.statusCode, 404);

    const textHistory = routeHarness.getRoutes.get('/api/share/:token/text-history');
    assert.ok(textHistory);
    const hiddenTextHistoryRes = createResponseRecorder();
    await textHistory({ params: { token: 'hidden' }, query: {} }, hiddenTextHistoryRes);
    assert.equal(hiddenTextHistoryRes.statusCode, 404);
  } finally {
    cleanup();
  }
}

async function assertArenaLockedMutation(
  handler: NonNullable<ReturnType<typeof createSessionRouteHarness>['routeHarness']['putRoutes']['get']>,
  req: Record<string, unknown>,
  mutationCalls: string[]
): Promise<void> {
  const res = createResponseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal((res.payload as any).error, 'arena_locked');
  assert.deepEqual(mutationCalls, []);
}

async function testArenaLockRejectsSessionMutations(): Promise<void> {
  const { routeHarness, mutationCalls, cleanup } = createSessionRouteHarness();
  try {
    await assertArenaLockedMutation(
      routeHarness.putRoutes.get('/api/sessions/:id')!,
      { params: { id: 'sess-source' }, body: { name: 'renamed' } },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.patchRoutes.get('/api/sessions/:id/llm-selection')!,
      { params: { id: 'sess-source' }, body: { updatedAt: '2026-05-29T00:00:01.000Z' } },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/plan-draft/exit')!,
      { params: { id: 'sess-source' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/plan-execution/exit')!,
      { params: { id: 'sess-source' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.deleteRoutes.get('/api/sessions/:id')!,
      { params: { id: 'sess-source' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/fork')!,
      { params: { id: 'sess-source' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/dropped-files')!,
      { params: { id: 'sess-source' }, query: { filename: 'note.txt' }, body: Buffer.from('x') },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/toolset')!,
      { params: { id: 'sess-source' }, body: { toolsetName: 'windows-dev' } },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/subagents/:subagentId/cancel')!,
      { params: { id: 'sess-source', subagentId: 'sub-1' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/subagents/:subagentId/retry')!,
      { params: { id: 'sess-source', subagentId: 'sub-1' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/sessions/:id/subagents/:subagentId/resume')!,
      { params: { id: 'sess-source', subagentId: 'sub-1' }, body: {} },
      mutationCalls
    );
    await assertArenaLockedMutation(
      routeHarness.postRoutes.get('/api/todos')!,
      { body: { action: 'dismiss_unfinished', sessionId: 'sess-source', scope: 'session' } },
      mutationCalls
    );
  } finally {
    cleanup();
  }
}

async function testArenaCreateAndStateRoutes(): Promise<void> {
  const { routeHarness, metaBySession, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    assert.ok(create);
    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { mode: 'answer', prompt: 'Compare options' } }, createRes);
    assert.equal(createRes.statusCode, 200);
    const created = (createRes.payload as any).arena;
    assert.equal(created.status, 'draft');
    assert.equal(created.mode, 'implementation');
    assert.equal(metaBySession.get('sess-open')?.arenaLock?.arenaId, created.id);

    const get = routeHarness.getRoutes.get('/api/sessions/:id/arena');
    assert.ok(get);
    const getRes = createResponseRecorder();
    await get({ params: { id: 'sess-open' }, query: {} }, getRes);
    assert.equal((getRes.payload as any).arena.id, created.id);

    const promote = routeHarness.postRoutes.get('/api/arena/:arenaId/branches/:branchId/promote');
    assert.ok(promote);
    const promoteRes = createResponseRecorder();
    await promote({ params: { arenaId: created.id, branchId: 'branch-1' }, body: {} }, promoteRes);
    assert.equal(promoteRes.statusCode, 409);
    assert.equal((promoteRes.payload as any).error, 'branch_session_required');

    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    assert.ok(start);
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    assert.equal((startRes.payload as any).arena.status, 'running');

    const pause = routeHarness.postRoutes.get('/api/arena/:arenaId/pause');
    assert.ok(pause);
    const pauseRes = createResponseRecorder();
    await pause({ params: { arenaId: created.id }, body: {} }, pauseRes);
    assert.equal((pauseRes.payload as any).arena.status, 'paused');

    const resume = routeHarness.postRoutes.get('/api/arena/:arenaId/resume');
    assert.ok(resume);
    const resumeRes = createResponseRecorder();
    await resume({ params: { arenaId: created.id }, body: {} }, resumeRes);
    assert.equal((resumeRes.payload as any).arena.status, 'running');

    const judge = routeHarness.postRoutes.get('/api/arena/:arenaId/judge');
    assert.ok(judge);
    const judgeRes = createResponseRecorder();
    await judge({ params: { arenaId: created.id }, body: {} }, judgeRes);
    assert.equal(judgeRes.statusCode, 409);
    assert.equal((judgeRes.payload as any).error, 'branches_not_ready');

    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    assert.ok(winner);
    const winnerRes = createResponseRecorder();
    await winner({ params: { arenaId: created.id }, body: { branchId: 'branch-1' } }, winnerRes);
    assert.equal(winnerRes.statusCode, 409);
    assert.equal((winnerRes.payload as any).error, 'branch_not_selectable');

    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(apply);
    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: created.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 409);
    assert.equal((applyRes.payload as any).error, 'winner_required');

    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    assert.ok(proposal);
    const proposalRes = createResponseRecorder();
    await proposal({ params: { arenaId: created.id }, body: {} }, proposalRes);
    assert.equal(proposalRes.statusCode, 409);
    assert.equal((proposalRes.payload as any).error, 'winner_required');

    const reopen = routeHarness.postRoutes.get('/api/arena/:arenaId/branches/:branchId/reopen');
    assert.ok(reopen);
    const reopenRes = createResponseRecorder();
    await reopen({ params: { arenaId: created.id, branchId: 'branch-1' }, body: {} }, reopenRes);
    assert.equal(reopenRes.statusCode, 409);

    const close = routeHarness.postRoutes.get('/api/arena/:arenaId/close');
    assert.ok(close);
    const closeRes = createResponseRecorder();
    await close({ params: { arenaId: created.id }, body: {} }, closeRes);
    assert.equal((closeRes.payload as any).arena.status, 'closed');
    assert.equal(metaBySession.get('sess-open')?.arenaLock, undefined);

    const terminalWinnerRes = createResponseRecorder();
    await winner({ params: { arenaId: created.id }, body: { branchId: 'branch-1' } }, terminalWinnerRes);
    assert.equal(terminalWinnerRes.statusCode, 409);
    assert.equal((terminalWinnerRes.payload as any).error, 'arena_terminal');

    const terminalProposalRes = createResponseRecorder();
    await proposal({ params: { arenaId: created.id }, body: {} }, terminalProposalRes);
    assert.equal(terminalProposalRes.statusCode, 409);
    assert.equal((terminalProposalRes.payload as any).error, 'arena_terminal');
  } finally {
    cleanup();
  }
}

async function testArenaBranchDetailReadsHiddenBranchTranscript(): Promise<void> {
  const { routeHarness, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const branchDetail = routeHarness.getRoutes.get('/api/arena/:arenaId/branches/:branchId/detail');
    const sessionDetail = routeHarness.getRoutes.get('/api/sessions/:id');
    assert.ok(create && start && branchDetail && sessionDetail);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { prompt: 'inspect branch log' } }, createRes);
    const arenaId = (createRes.payload as any).arena.id;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId }, body: {} }, startRes);
    const branch = (startRes.payload as any).arena.branches[0];

    const hiddenSessionRes = createResponseRecorder();
    await sessionDetail({ params: { id: branch.sessionId }, query: {} }, hiddenSessionRes);
    assert.equal(hiddenSessionRes.statusCode, 404);

    const detailRes = createResponseRecorder();
    await branchDetail({ params: { arenaId, branchId: branch.id }, query: {} }, detailRes);
    assert.equal(detailRes.statusCode, 200);
    const detail = (detailRes.payload as any).detail;
    assert.equal(detail.branch.id, branch.id);
    assert.equal(detail.messages[0].content, `message for ${branch.sessionId}`);
    assert.equal(detail.messages[1].content, 'visible answer');
    assert.equal(detail.messages.some((message: any) => message.role === 'tool'), false);
    assert.equal(detail.messages.some((message: any) => message.thinking || message.toolCalls || message.toolCallId || message.name), false);
    assert.equal(JSON.stringify(detail.messages).includes('secret tool result'), false);
  } finally {
    cleanup();
  }
}

async function testArenaBranchDetailRequiresSourceAccess(): Promise<void> {
  const { routeHarness, arenaStore, cleanup } = createSessionRouteHarness({ canAccessSession: false });
  try {
    const branchDetail = routeHarness.getRoutes.get('/api/arena/:arenaId/branches/:branchId/detail');
    assert.ok(branchDetail);
    const run = arenaStore.createDraft({
      sourceSessionId: 'sess-open',
      sourceSessionName: 'open',
      sourceEventCount: 1,
      mode: 'implementation',
      entryType: 'normal',
      prompt: 'inspect',
      currentLlmSelection: {
        profileId: 'default',
        model: 'MiniMax-M2.5',
        reasoningPreset: 'off',
        updatedAt: '2026-05-29T00:00:00.000Z',
      },
    });
    const res = createResponseRecorder();
    await branchDetail({ params: { arenaId: run.id, branchId: run.branches[0].id }, query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal((res.payload as any).code, 'SHARE_SCOPE_FORBIDDEN');
  } finally {
    cleanup();
  }
}

async function testArenaJudgeStartsHiddenJudgeRunWithoutWinner(): Promise<void> {
  const { routeHarness, arenaStore, metaBySession, runCalls, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const judge = routeHarness.postRoutes.get('/api/arena/:arenaId/judge');
    const list = routeHarness.getRoutes.get('/api/sessions');
    assert.ok(create);
    assert.ok(start);
    assert.ok(judge);
    assert.ok(list);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { prompt: 'Compare two answers' } }, createRes);
    const created = (createRes.payload as any).arena;

    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    const run = arenaStore.getRun(created.id);
    assert.ok(run);
    assert.equal(run.branches.length, 2);
    for (const branch of run.branches) {
      arenaStore.submitBranchResult({
        arenaId: run.id,
        branchId: branch.id,
        submission: {
          status: 'complete',
          summary: `summary for ${branch.id}`,
          finalAnswer: `answer for ${branch.id}`,
          evidence: [`evidence for ${branch.id}`],
        },
      });
    }

    const judgeRes = createResponseRecorder();
    await judge({ params: { arenaId: created.id }, body: {} }, judgeRes);
    assert.equal(judgeRes.statusCode, 200);
    const judged = (judgeRes.payload as any).arena;
    assert.equal(judged.status, 'judging');
    assert.equal(judged.winner, undefined);
    assert.match(judged.judgeRunId, /^sess-/);

    const judgeMeta = metaBySession.get(judged.judgeRunId);
    assert.deepEqual(judgeMeta?.arenaJudge, {
      arenaId: created.id,
      sourceSessionId: 'sess-open',
    });
    assert.equal(
      runCalls.some((call) => call.context.namespace === judged.judgeRunId && call.additionalSystemPrompt?.includes('[ARENA_JUDGE]')),
      true
    );
    await new Promise((resolve) => setImmediate(resolve));
    const judgedFromStore = arenaStore.getRun(created.id);
    assert.equal(judgedFromStore?.winner, undefined);
    assert.equal(judgedFromStore?.judgeResult?.status, 'completed');
    assert.equal(judgedFromStore?.judgeResult?.rationale, 'run started');

    const listRes = createResponseRecorder();
    await list({ query: {} }, listRes);
    const sessionIds = ((listRes.payload as any).sessions as Array<{ id: string }>).map((session) => session.id);
    assert.equal(sessionIds.includes(judged.judgeRunId), false);

    const detail = routeHarness.getRoutes.get('/api/sessions/:id');
    assert.ok(detail);
    const detailRes = createResponseRecorder();
    await detail({ params: { id: judged.judgeRunId }, query: {} }, detailRes);
    assert.equal(detailRes.statusCode, 404);
  } finally {
    cleanup();
  }
}

async function testArenaRejectsNestedBranchSource(): Promise<void> {
  const { routeHarness, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    assert.ok(create);
    const res = createResponseRecorder();
    await create({ params: { id: 'sess-unpromoted-source' }, body: { mode: 'answer' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal((res.payload as any).error, 'arena_branch_source');
  } finally {
    cleanup();
  }
}

async function testImplementationArenaWithoutWorkspaceUsesSessionOnlyBranches(): Promise<void> {
  const { routeHarness, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    assert.ok(create);
    assert.ok(start);
    const res = createResponseRecorder();
    await create({ params: { id: 'sess-no-workspace' }, body: { mode: 'implementation' } }, res);
    assert.equal(res.statusCode, 200);
    const created = (res.payload as any).arena;
    assert.equal(created.workspaceSnapshot.strategy, 'session_only');
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    assert.equal(startRes.statusCode, 200);
    assert.equal((startRes.payload as any).arena.branches[0].workspaceSnapshot.strategy, 'session_only');
  } finally {
    cleanup();
  }
}

async function testImplementationProposalAndApply(): Promise<void> {
  const { routeHarness, arenaStore, sourceWorkspaceDir, metaBySession, runCalls, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create && start && winner && proposal && apply);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { prompt: 'change readme' } }, createRes);
    const created = (createRes.payload as any).arena;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    const started = (startRes.payload as any).arena;
    const branch = started.branches[0];
    assert.equal(branch.workspaceSnapshot.strategy, 'directory_copy');
    assert.equal(runCalls[0]?.agentRuntimeOverrides?.toolsetName, 'arena-implementation');
    assert.equal(metaBySession.get(branch.sessionId)?.toolsetName, 'arena-implementation');
    fs.writeFileSync(path.join(branch.workspaceDir, 'README.md'), 'winner', 'utf-8');
    fs.writeFileSync(path.join(branch.workspaceDir, 'winner.txt'), 'new file', 'utf-8');
    arenaStore.setBranchStatus(created.id, branch.id, 'submitted');

    const winnerRes = createResponseRecorder();
    await winner({ params: { arenaId: created.id }, body: { branchId: branch.id, reason: 'manual' } }, winnerRes);
    assert.equal(winnerRes.statusCode, 200);

    const proposalRes = createResponseRecorder();
    await proposal({ params: { arenaId: created.id }, body: {} }, proposalRes);
    assert.equal(proposalRes.statusCode, 200);
    assert.equal((proposalRes.payload as any).arena.proposal.status, 'ready');
    assert.deepEqual((proposalRes.payload as any).arena.proposal.changedFiles, ['README.md', 'winner.txt']);

    const nextWinnerRes = createResponseRecorder();
    const otherBranch = started.branches[1];
    arenaStore.setBranchStatus(created.id, otherBranch.id, 'submitted');
    await winner({ params: { arenaId: created.id }, body: { branchId: otherBranch.id } }, nextWinnerRes);
    assert.equal(nextWinnerRes.statusCode, 409);
    assert.equal((nextWinnerRes.payload as any).error, 'proposal_ready');

    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: created.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 200);
    assert.equal((applyRes.payload as any).arena.status, 'applied');
    assert.equal((applyRes.payload as any).arena.proposal.status, 'applied');
    assert.equal(fs.readFileSync(path.join(sourceWorkspaceDir, 'README.md'), 'utf-8'), 'winner');
    assert.equal(fs.readFileSync(path.join(sourceWorkspaceDir, 'winner.txt'), 'utf-8'), 'new file');
    assert.equal(metaBySession.get('sess-open')?.arenaLock, undefined);
  } finally {
    cleanup();
  }
}

async function testDuelWinnerApplyUpdatesSourceFrontendOnly(): Promise<void> {
  const { routeHarness, arenaStore, sourceWorkspaceDir, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create && start && winner && proposal && apply);

    const webSrcDir = path.join(sourceWorkspaceDir, 'apps', 'web', 'src');
    fs.mkdirSync(webSrcDir, { recursive: true });
    fs.writeFileSync(
      path.join(webSrcDir, 'App.tsx'),
      "export function App() {\n  return <main className=\"app-shell\">SoundNet</main>;\n}\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(webSrcDir, 'index.css'),
      ':root { color-scheme: light; }\n.app-shell { background: #ffffff; color: #111827; }\n',
      'utf-8',
    );

    const createRes = createResponseRecorder();
    await create(
      {
        params: { id: 'sess-open' },
        body: { prompt: 'duel: update the frontend to a dark visual style' },
      },
      createRes,
    );
    const arena = (createRes.payload as any).arena;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: arena.id }, body: {} }, startRes);
    const branches = (startRes.payload as any).arena.branches;
    assert.ok(branches.length >= 2);

    const winningBranch = branches[0];
    const losingBranch = branches[1];
    fs.writeFileSync(
      path.join(winningBranch.workspaceDir, 'apps', 'web', 'src', 'App.tsx'),
      "export function App() {\n  return <main className=\"app-shell theme-dark\">SoundNet Dark</main>;\n}\n",
      'utf-8',
    );
    fs.writeFileSync(
      path.join(winningBranch.workspaceDir, 'apps', 'web', 'src', 'index.css'),
      ':root { color-scheme: dark; }\n.app-shell.theme-dark { background: #060b16; color: #f8fafc; }\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(losingBranch.workspaceDir, 'apps', 'web', 'src', 'index.css'),
      ':root { color-scheme: light; }\n.app-shell { background: #fff7ed; color: #9a3412; }\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(losingBranch.workspaceDir, 'loser-only.txt'), 'do not apply', 'utf-8');

    arenaStore.submitBranchResult({
      arenaId: arena.id,
      branchId: winningBranch.id,
      submission: {
        status: 'complete',
        summary: 'Dark frontend style is implemented.',
        evidence: ['Updated apps/web/src/App.tsx', 'Updated apps/web/src/index.css'],
        changedFiles: ['apps/web/src/App.tsx', 'apps/web/src/index.css'],
      },
    });
    arenaStore.submitBranchResult({
      arenaId: arena.id,
      branchId: losingBranch.id,
      submission: {
        status: 'complete',
        summary: 'Alternate warm style.',
        evidence: ['Updated apps/web/src/index.css'],
        changedFiles: ['apps/web/src/index.css', 'loser-only.txt'],
      },
    });

    const winnerRes = createResponseRecorder();
    await winner({ params: { arenaId: arena.id }, body: { branchId: winningBranch.id } }, winnerRes);
    assert.equal(winnerRes.statusCode, 200);

    const proposalRes = createResponseRecorder();
    await proposal({ params: { arenaId: arena.id }, body: {} }, proposalRes);
    assert.equal(proposalRes.statusCode, 200);
    const changedFiles = (proposalRes.payload as any).arena.proposal.changedFiles as string[];
    assert.ok(changedFiles.includes('apps/web/src/App.tsx'));
    assert.ok(changedFiles.includes('apps/web/src/index.css'));
    assert.equal(changedFiles.includes('loser-only.txt'), false);

    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: arena.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 200);
    assert.equal((applyRes.payload as any).arena.status, 'applied');
    assert.match(fs.readFileSync(path.join(webSrcDir, 'App.tsx'), 'utf-8'), /theme-dark/);
    assert.match(fs.readFileSync(path.join(webSrcDir, 'index.css'), 'utf-8'), /color-scheme: dark/);
    assert.equal(fs.existsSync(path.join(sourceWorkspaceDir, 'loser-only.txt')), false);
  } finally {
    cleanup();
  }
}

async function testSessionOnlyArenaAppliesWithoutProposal(): Promise<void> {
  const { routeHarness, arenaStore, metaBySession, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create && start && winner && apply);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-no-workspace' }, body: { prompt: 'answer only' } }, createRes);
    const created = (createRes.payload as any).arena;
    assert.equal(created.mode, 'implementation');
    assert.equal(created.workspaceSnapshot.strategy, 'session_only');

    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    const branch = (startRes.payload as any).arena.branches[0];
    assert.equal(branch.workspaceSnapshot.strategy, 'session_only');
    assert.equal(metaBySession.get(branch.sessionId)?.toolsetName, 'windows-safe');
    arenaStore.submitBranchResult({
      arenaId: created.id,
      branchId: branch.id,
      submission: {
        status: 'complete',
        summary: 'answer summary',
        finalAnswer: 'answer body',
        evidence: ['reasoned from context'],
      },
    });

    await winner({ params: { arenaId: created.id }, body: { branchId: branch.id } }, createResponseRecorder());
    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: created.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 200);
    assert.equal((applyRes.payload as any).arena.status, 'applied');
    assert.equal((applyRes.payload as any).arena.proposal, undefined);
    assert.equal(metaBySession.get('sess-no-workspace')?.arenaLock, undefined);
  } finally {
    cleanup();
  }
}

async function testImplementationApplyRejectsStaleSource(): Promise<void> {
  const { routeHarness, arenaStore, sourceWorkspaceDir, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create && start && winner && proposal && apply);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { mode: 'implementation' } }, createRes);
    const created = (createRes.payload as any).arena;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    const branch = (startRes.payload as any).arena.branches[0];
    fs.writeFileSync(path.join(branch.workspaceDir, 'README.md'), 'winner', 'utf-8');
    arenaStore.setBranchStatus(created.id, branch.id, 'submitted');

    await winner({ params: { arenaId: created.id }, body: { branchId: branch.id } }, createResponseRecorder());
    await proposal({ params: { arenaId: created.id }, body: {} }, createResponseRecorder());
    fs.writeFileSync(path.join(sourceWorkspaceDir, 'stale.txt'), 'source changed', 'utf-8');

    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: created.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 409);
    assert.match((applyRes.payload as any).message, /changed since proposal/i);
  } finally {
    cleanup();
  }
}

async function testZeroDiffProposalRejectsLateBranchChange(): Promise<void> {
  const { routeHarness, arenaStore, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create && start && winner && proposal && apply);

    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { prompt: 'answer without edits' } }, createRes);
    const created = (createRes.payload as any).arena;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: created.id }, body: {} }, startRes);
    const branch = (startRes.payload as any).arena.branches[0];
    arenaStore.submitBranchResult({
      arenaId: created.id,
      branchId: branch.id,
      submission: {
        status: 'complete',
        summary: 'no file edits',
        finalAnswer: 'answer',
        evidence: ['no changed files'],
      },
    });

    await winner({ params: { arenaId: created.id }, body: { branchId: branch.id } }, createResponseRecorder());
    const proposalRes = createResponseRecorder();
    await proposal({ params: { arenaId: created.id }, body: {} }, proposalRes);
    assert.equal(proposalRes.statusCode, 200);
    assert.deepEqual((proposalRes.payload as any).arena.proposal.changedFiles, []);
    fs.writeFileSync(path.join(branch.workspaceDir, 'late.txt'), 'late branch change', 'utf-8');

    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId: created.id }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 409);
    assert.equal((applyRes.payload as any).error, 'stale_branch');
  } finally {
    cleanup();
  }
}

async function testImplementationApplyRejectsStaleBranch(): Promise<void> {
  const { routeHarness, arenaStore, sourceWorkspaceDir, cleanup } = createSessionRouteHarness();
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    const winner = routeHarness.postRoutes.get('/api/arena/:arenaId/winner');
    const proposal = routeHarness.postRoutes.get('/api/arena/:arenaId/proposal');
    const apply = routeHarness.postRoutes.get('/api/arena/:arenaId/apply');
    assert.ok(create);
    assert.ok(start);
    assert.ok(winner);
    assert.ok(proposal);
    assert.ok(apply);

    fs.writeFileSync(path.join(sourceWorkspaceDir, 'impl.txt'), 'before', 'utf-8');
    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { mode: 'implementation', prompt: 'edit' } }, createRes);
    const arenaId = (createRes.payload as any).arena.id as string;
    const startRes = createResponseRecorder();
    await start({ params: { arenaId }, body: {} }, startRes);
    const run = arenaStore.getRun(arenaId);
    assert.ok(run);
    const branch = run.branches[0];
    assert.ok(branch.workspaceDir);
    fs.writeFileSync(path.join(branch.workspaceDir, 'impl.txt'), 'after', 'utf-8');
    arenaStore.submitBranchResult({
      arenaId,
      branchId: branch.id,
      submission: {
        status: 'complete',
        summary: 'done',
        evidence: ['modified impl.txt'],
        changedFiles: ['impl.txt'],
      },
    });
    const winnerRes = createResponseRecorder();
    await winner({ params: { arenaId }, body: { branchId: branch.id } }, winnerRes);
    const proposalRes = createResponseRecorder();
    await proposal({ params: { arenaId }, body: {} }, proposalRes);
    fs.writeFileSync(path.join(branch.workspaceDir, 'late.txt'), 'late branch change', 'utf-8');
    const applyRes = createResponseRecorder();
    await apply({ params: { arenaId }, body: {} }, applyRes);
    assert.equal(applyRes.statusCode, 409);
    assert.equal((applyRes.payload as any).error, 'stale_branch');
  } finally {
    cleanup();
  }
}

async function testArenaMutationsRequireFullAccess(): Promise<void> {
  const { routeHarness, cleanup } = createSessionRouteHarness({ fullAccess: false });
  try {
    const create = routeHarness.postRoutes.get('/api/sessions/:id/arena');
    assert.ok(create);
    const createRes = createResponseRecorder();
    await create({ params: { id: 'sess-open' }, body: { mode: 'answer' } }, createRes);
    assert.equal(createRes.statusCode, 403);
    assert.equal((createRes.payload as any).code, 'SHARE_SCOPE_FORBIDDEN');

    const start = routeHarness.postRoutes.get('/api/arena/:arenaId/start');
    assert.ok(start);
    const startRes = createResponseRecorder();
    await start({ params: { arenaId: 'arena-1' }, body: {} }, startRes);
    assert.equal(startRes.statusCode, 403);
    assert.equal((startRes.payload as any).code, 'SHARE_SCOPE_FORBIDDEN');
  } finally {
    cleanup();
  }
}

async function run(): Promise<void> {
  await testSessionProjectionAndHiddenBranches();
  await testArenaLockRejectsSessionMutations();
  await testArenaCreateAndStateRoutes();
  await testArenaBranchDetailReadsHiddenBranchTranscript();
  await testArenaBranchDetailRequiresSourceAccess();
  await testArenaJudgeStartsHiddenJudgeRunWithoutWinner();
  await testArenaRejectsNestedBranchSource();
  await testImplementationArenaWithoutWorkspaceUsesSessionOnlyBranches();
  await testImplementationProposalAndApply();
  await testDuelWinnerApplyUpdatesSourceFrontendOnly();
  await testSessionOnlyArenaAppliesWithoutProposal();
  await testImplementationApplyRejectsStaleSource();
  await testZeroDiffProposalRejectsLateBranchChange();
  await testImplementationApplyRejectsStaleBranch();
  await testArenaMutationsRequireFullAccess();
  console.log('arena-routes tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
