import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import type { ContextRef } from '../../src/types.js';
import { registerSessionRoutes } from '../../src/web/server/web-server-session-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createHarness(): { tempDir: string; manager: ContextManager; source: ContextRef } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-session-fork-'));
  const manager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
  return {
    tempDir,
    manager,
    source: { scope: 'session', namespace: 'sess-source' },
  };
}

function seedStableSource(manager: ContextManager, source: ContextRef): void {
  const turn = manager.beginTurn(source, 'hello', '/tmp/workspace');
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    finalOutputText: 'hi',
    finishReason: 'completed',
  });
  manager.updateNamespaceMeta(source, {
    name: 'aaa',
    workspaceDir: '/tmp/workspace',
    toolsetName: 'full-access',
    origin: 'web',
    llmSelection: {
      profileId: 'profile-a',
      model: 'model-a',
      reasoningPreset: 'high',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    sessionShare: {
      tokenHash: 'hash',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      version: 1,
    },
    runtimeAttachment: {
      updatedAt: '2026-01-01T00:00:00.000Z',
      externalMcpServers: [],
    },
    pendingPlanInput: {
      requestId: 'request-a',
      runId: 'run-a',
      requestedAt: '2026-01-01T00:00:00.000Z',
      questions: [
        {
          header: 'Pick',
          id: 'pick',
          question: 'pick one',
          options: [{ label: 'A', description: 'A' }],
        },
      ],
    },
    runtimeErrors: [
      {
        id: 'error-a',
        runId: 'run-a',
        message: 'boom',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  manager.updateNamespaceMeta(source, {
    pendingPlanInput: undefined,
  });
  const materialized = manager.materializeToolResultArtifact(source, {
    toolCallId: 'tool-a',
    toolName: 'shell',
    content: 'x'.repeat(5000),
    thresholdChars: 100,
  });
  assert.ok(materialized.artifact);
}

function testForkCopiesCommittedContextAndStableMeta(): void {
  const { tempDir, manager, source } = createHarness();
  try {
    seedStableSource(manager, source);

    const forked = manager.forkSessionNamespace({
      sourceNamespace: source.namespace,
      targetNamespace: 'sess-child',
      origin: 'web',
    });

    assert.equal(forked.name, 'aaa-fork');
    assert.equal(forked.namespace, 'sess-child');
    assert.equal(forked.workspaceDir, '/tmp/workspace');
    assert.equal(forked.toolsetName, 'full-access');
    assert.equal(forked.llmSelection?.model, 'model-a');
    assert.equal(forked.forkedFrom?.namespace, 'sess-source');
    assert.equal(forked.forkedFrom?.sourceEventCount, manager.getEventStore().readEvents('session', source.namespace).length);
    assert.equal(forked.sessionShare, undefined);
    assert.equal(forked.runtimeAttachment, undefined);
    assert.equal(forked.pendingPlanInput, undefined);
    assert.equal(forked.runtimeErrors, undefined);

    const childMessages = manager.getConversationMessages({ scope: 'session', namespace: 'sess-child' });
    assert.deepEqual(childMessages.map((message) => message.content), ['hello', 'hi']);

    const childPath = manager.getEventStore().getNamespacePath({ scope: 'session', namespace: 'sess-child' });
    assert.equal(fs.existsSync(path.join(childPath, 'tool-results')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testForkRejectsInterruptedState(): void {
  const { tempDir, manager, source } = createHarness();
  try {
    seedStableSource(manager, source);
    manager.beginTurn(source, 'draft', '/tmp/workspace', {
      draftId: 'draft-a',
      runId: 'run-a',
      runFamilyId: 'family-a',
      maxSteps: 10,
    });

    assert.equal(manager.hasInterruptedState(source), true);
    assert.throws(
      () =>
        manager.forkSessionNamespace({
          sourceNamespace: source.namespace,
          targetNamespace: 'sess-child',
          origin: 'web',
        }),
      /not stable enough/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testForkRouteCreatesNamedSession(): Promise<void> {
  const { tempDir, manager, source } = createHarness();
  try {
    seedStableSource(manager, source);
    const routeHarness = createRouteAppHarness();
    registerSessionRoutes({
      app: routeHarness.app as any,
      wss: { clients: new Set() } as any,
      agent: {
        getConfig: () => ({ llmProfiles: { defaultProfileId: '', profiles: [] } }),
        getContextManager: () => manager,
        getContextNamespaceMeta: (ref: ContextRef) => manager.getEventStore().loadMeta(ref.scope, ref.namespace),
        resolveToolsetName: () => 'full-access',
        getContextMessages: () => [],
        getContextWebMessages: () => [],
      } as any,
      automationRoutes: { register: () => undefined } as any,
      configServices: {
        hasUsableApiKey: () => false,
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
      contextServices: {
        getContextNamespaceMetaSafe: (ref: ContextRef) => manager.getEventStore().loadMeta(ref.scope, ref.namespace),
        getPendingPlanInputView: () => null,
        getActiveRunState: () => null,
        listActiveSessionRunStates: () => [],
        getInteractionStateForContext: () => ({ mode: 'normal' }),
        getInterruptedArtifact: () => null,
        updateContextNamespaceMetaSafe: (ref: ContextRef, patch: Record<string, unknown>) =>
          manager.updateNamespaceMeta(ref, patch as any),
        resolveWorkspaceDirForContext: () => '/tmp/workspace',
        resolveAgentForContext: () => ({ getContextManager: () => manager }) as any,
        cleanupSessionRuntime: async () => undefined,
      },
      todoServices: {
        ensureTodoDrivenAutoLoop: () => undefined,
        getSessionTodoProtocolState: () => ({}) as any,
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
        canAccessSession: () => true,
        hasFullAccess: () => true,
      },
    } as any);

    const handler = routeHarness.postRoutes.get('/api/sessions/:id/fork');
    assert.ok(handler);
    const res = createResponseRecorder();
    await handler({ params: { id: source.namespace }, body: {} }, res);

    assert.equal(res.statusCode, 200);
    const payload = res.payload as { session?: { id: string; name: string }; meta?: { forkedFrom?: { namespace: string } } };
    assert.equal(payload.session?.name, 'aaa-fork');
    assert.equal(payload.meta?.forkedFrom?.namespace, source.namespace);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testForkCopiesCommittedContextAndStableMeta();
testForkRejectsInterruptedState();
testForkRouteCreatesNamedSession()
  .then(() => {
    console.log('session-fork tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
