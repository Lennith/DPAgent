import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerWorkspaceGovernanceRoutes } from '../../src/web/server/web-server-workspace-governance-routes.js';
import { createResponseRecorder, createRouteAppHarness, type RouteHandler } from './helpers/web-route-harness.js';

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-workspace-governance-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const workspaceSkillPath = path.join(workspaceDir, 'skills', 'workflow-one', 'SKILL.md');
  const globalSkillPath = path.join(tempDir, 'global-skills', 'workflow-global', 'SKILL.md');
  const packSkillPath = path.join(tempDir, 'pack-skills', 'workflow-pack', 'SKILL.md');
  fs.mkdirSync(path.dirname(workspaceSkillPath), { recursive: true });
  fs.mkdirSync(path.dirname(globalSkillPath), { recursive: true });
  fs.mkdirSync(path.dirname(packSkillPath), { recursive: true });
  fs.writeFileSync(workspaceSkillPath, '---\nname: workflow-one\n---\nworkspace body\n', 'utf-8');
  fs.writeFileSync(globalSkillPath, '---\nname: workflow-global\n---\nglobal body\n', 'utf-8');
  fs.writeFileSync(packSkillPath, '---\nname: workflow-pack\n---\npack body\n', 'utf-8');

  const routes = createRouteAppHarness();
  const app = {
    get: routes.app.get,
    post: routes.app.post,
    patch: routes.app.patch,
  };
  const auditEvents: unknown[] = [];
  const memoryUpdates: unknown[] = [];
  const skillUpdates: unknown[] = [];
  const report = {
    kind: 'workspace_skill_governance' as const,
    runId: 'run-governance',
    workspaceDir,
    generatedAt: '2026-05-05T00:00:00.000Z',
    fallback: false,
    summary: {
      scannedSkills: 1,
      exactDuplicates: 0,
      candidateDuplicates: 0,
      autoArchived: 0,
      reportOnly: 0,
      boundaryFixed: 0,
      conflicts: 0,
    },
    items: [],
  };
  registerWorkspaceGovernanceRoutes({
    app: app as any,
    agent: {
      getConfig: () => ({ agent: { workspaceDir } }),
      getMemoryStore: () => ({
        listEntries: (input: { includeUser?: boolean } = {}) => {
          const entries = [
            {
              id: 'mem-1',
              scope: 'workspace',
              title: 'Workflow memory',
              content: 'memory body',
              version: 1,
              status: 'active',
              updatedAt: '2026-05-05T00:00:00.000Z',
            },
          ];
          if (input.includeUser !== false) {
            entries.push({
              id: 'mem-user',
              scope: 'user',
              title: 'User memory',
              content: 'user body',
              version: 1,
              status: 'active',
              updatedAt: '2026-05-05T00:00:00.000Z',
            });
          }
          return entries;
        },
      }),
      getSkillLoader: () => ({
        getSkillCatalog: () => [
          {
            name: 'workflow-one',
            description: 'Workspace workflow',
            path: workspaceSkillPath,
            source: 'workspace',
            content: 'workspace body',
            tags: [],
            triggers: [],
            platforms: [],
            toolsets: [],
            metadata: { generatedBy: 'auto-observe-turn' },
          },
          {
            name: 'workflow-global',
            description: 'Global workflow',
            path: globalSkillPath,
            source: 'global',
            content: 'global body',
            tags: [],
            triggers: [],
            platforms: [],
            toolsets: [],
            metadata: { generatedBy: 'auto-observe-turn' },
          },
          {
            name: 'workflow-pack',
            description: 'Pack workflow',
            path: packSkillPath,
            source: 'workspace_pack',
            content: 'pack body',
            tags: [],
            triggers: [],
            platforms: [],
            toolsets: [],
            metadata: { generatedBy: 'auto-observe-turn' },
          },
        ],
      }),
      listGovernanceAudit: () => [{ id: 'audit-1', kind: 'skill_edited', title: 'edited', status: 'success', createdAt: '2026-05-05T00:00:00.000Z' }],
      getGovernanceAuditStore: () => ({ append: (event: unknown) => auditEvents.push(event) }),
      updateMemoryEntry: (input: unknown) => {
        memoryUpdates.push(input);
        return { id: 'mem-2', title: 'Workflow memory', content: 'updated', version: 2 };
      },
      updateWorkspaceSkillContent: (input: unknown) => {
        skillUpdates.push(input);
        return { name: 'workflow-one', targetPath: workspaceSkillPath, workspaceDir, changed: true };
      },
    },
    contextServices: {
      resolveWorkspaceDirForContext: () => workspaceDir,
      getInteractionStateForContext: (context: { namespace: string }) =>
        context.namespace === 'sess-observe'
          ? { mode: 'observe_only', owner: 'cli', reason: 'cli_active_run' }
          : { mode: 'normal' },
      getActiveRunState: () => null,
    },
    governanceServices: {
      runWorkspaceSkillGovernance: async () => report,
      getLatestWorkspaceSkillGovernanceReport: () => null,
    },
  } as any);

  return {
    routes,
    tempDir,
    workspaceDir,
    auditEvents,
    memoryUpdates,
    skillUpdates,
  };
}

async function testWorkspaceStateOnlyReturnsWorkspaceSkills(): Promise<void> {
  const harness = createHarness();
  try {
    const handler = harness.routes.getRoutes.get('/api/governance/workspace');
    assert.ok(handler);
    const res = createResponseRecorder();
    await handler?.({ query: { sessionId: 'sess-1' } }, res);
    assert.equal(res.statusCode, 200);
    const payload = res.payload as {
      skillItems: Array<{ name: string; content: string }>;
      memoryItems: Array<{ id: string }>;
    };
    assert.deepEqual(payload.skillItems.map((item) => item.name), ['workflow-one']);
    assert.equal(payload.skillItems[0]?.content.includes('workspace body'), true);
    assert.deepEqual(payload.memoryItems.map((item) => item.id), ['mem-1']);
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function testManualRunAndEditors(): Promise<void> {
  const harness = createHarness();
  try {
    const runHandler = harness.routes.postRoutes.get('/api/governance/skills/run');
    const memoryHandler = harness.routes.patchRoutes.get('/api/memory/:id');
    const skillHandler = harness.routes.patchRoutes.get('/api/skills/workspace/:skillName');
    assert.ok(runHandler);
    assert.ok(memoryHandler);
    assert.ok(skillHandler);

    const runRes = createResponseRecorder();
    await runHandler?.({ body: { sessionId: 'sess-1' }, query: {} }, runRes);
    assert.equal(runRes.statusCode, 200);
    assert.equal((runRes.payload as { report: { runId: string } }).report.runId, 'run-governance');
    assert.equal(harness.auditEvents.length, 1);

    const memoryRes = createResponseRecorder();
    await memoryHandler?.({ params: { id: 'mem-1' }, body: { sessionId: 'sess-1', title: 'Edited', content: 'Updated memory' }, query: {} }, memoryRes);
    assert.equal(memoryRes.statusCode, 200);
    assert.deepEqual(harness.memoryUpdates[0], {
      id: 'mem-1',
      title: 'Edited',
      content: 'Updated memory',
      workspaceDir: harness.workspaceDir,
      sessionId: 'sess-1',
    });

    const skillRes = createResponseRecorder();
    await skillHandler?.({ params: { skillName: 'workflow-one' }, body: { sessionId: 'sess-1', content: 'Updated skill' }, query: {} }, skillRes);
    assert.equal(skillRes.statusCode, 200);
    assert.deepEqual(harness.skillUpdates[0], {
      name: 'workflow-one',
      workspaceDir: harness.workspaceDir,
      content: 'Updated skill',
      sessionId: 'sess-1',
    });
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function testObserveOnlyRejectsWrites(): Promise<void> {
  const harness = createHarness();
  try {
    const runHandler = harness.routes.postRoutes.get('/api/governance/skills/run');
    const memoryHandler = harness.routes.patchRoutes.get('/api/memory/:id');
    const skillHandler = harness.routes.patchRoutes.get('/api/skills/workspace/:skillName');
    assert.ok(runHandler);
    assert.ok(memoryHandler);
    assert.ok(skillHandler);

    for (const [handler, req] of [
      [runHandler, { body: { sessionId: 'sess-observe' }, query: {} }],
      [memoryHandler, { params: { id: 'mem-1' }, body: { sessionId: 'sess-observe', content: 'blocked' }, query: {} }],
      [skillHandler, { params: { skillName: 'workflow-one' }, body: { sessionId: 'sess-observe', content: 'blocked' }, query: {} }],
    ] as Array<[RouteHandler | undefined, any]>) {
      const res = createResponseRecorder();
      await handler?.(req, res);
      assert.equal(res.statusCode, 409);
      assert.equal((res.payload as { error: string }).error, 'observe_only');
    }
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testWorkspaceStateOnlyReturnsWorkspaceSkills();
  await testManualRunAndEditors();
  await testObserveOnlyRejectsWrites();
  console.log('web-workspace-governance-routes tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
