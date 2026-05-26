import * as assert from 'node:assert/strict';
import { registerSkillRoutes } from '../../src/web/server/web-server-skill-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function createHarness() {
  const routes = createRouteAppHarness();
  const defaultWorkspaceDir = 'D:\\default-workspace';
  const sessionWorkspaceDir = 'D:\\session-workspace';
  const skillCatalogInputs: unknown[] = [];
  const publishedPacks: unknown[] = [];

  registerSkillRoutes({
    app: routes.app as any,
    agent: {
      getConfig: () => ({
        agent: {
          workspaceDir: defaultWorkspaceDir,
          defaultToolset: 'default-tools',
        },
      }),
      resolveToolsetName: (context: { namespace: string }) => `session-tools:${context.namespace}`,
      getSkillLoader: () => ({
        getSkillCatalog: (input: unknown) => {
          skillCatalogInputs.push(input);
          return [
            {
              name: 'skill-one',
              description: 'Skill one',
              source: 'workspace',
              path: 'D:\\skills\\skill-one\\SKILL.md',
            },
          ];
        },
      }),
      listSkillHistory: () => [],
      rollbackSkill: () => ({}),
      getSkillPackStore: () => ({ listPacks: () => [] }),
      publishSkillPack: (input: unknown) => {
        publishedPacks.push(input);
        return { name: 'pack-one' };
      },
      activateSkillPack: () => ({}),
      rollbackSkillPack: () => ({}),
      reloadSkills: () => undefined,
    },
    contextServices: {
      resolveWorkspaceDirForContext: (context: { namespace: string }) => {
        assert.match(context.namespace, /^sess-/);
        return sessionWorkspaceDir;
      },
    },
  } as any);

  return {
    routes,
    defaultWorkspaceDir,
    sessionWorkspaceDir,
    skillCatalogInputs,
    publishedPacks,
  };
}

function testSkillsRouteResolvesDefaultAndSessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.getRoutes.get('/api/skills');
  assert.ok(handler);

  const defaultRes = createResponseRecorder();
  handler({ query: {} }, defaultRes);
  assert.equal(defaultRes.statusCode, 200);
  assert.equal((defaultRes.payload as { workspaceDir: string }).workspaceDir, harness.defaultWorkspaceDir);
  assert.equal((defaultRes.payload as { toolsetName: string }).toolsetName, 'default-tools');

  const sessionRes = createResponseRecorder();
  handler({ query: { sessionId: 'sess-skill' } }, sessionRes);
  assert.equal(sessionRes.statusCode, 200);
  assert.equal((sessionRes.payload as { workspaceDir: string }).workspaceDir, harness.sessionWorkspaceDir);
  assert.equal((sessionRes.payload as { toolsetName: string }).toolsetName, 'session-tools:sess-skill');

  assert.deepEqual(harness.skillCatalogInputs, [
    { workspaceDir: harness.defaultWorkspaceDir, toolsetName: 'default-tools' },
    { workspaceDir: harness.sessionWorkspaceDir, toolsetName: 'session-tools:sess-skill' },
  ]);
}

function testPublishPackResolvesBodySessionWorkspace(): void {
  const harness = createHarness();
  const handler = harness.routes.postRoutes.get('/api/skills/packs');
  assert.ok(handler);

  const res = createResponseRecorder();
  handler(
    {
      body: {
        sessionId: 'sess-pack',
        name: 'pack-one',
        version: '1.2.3',
        scope: 'workspace',
        description: ' publish me ',
        skillNames: ['skill-one'],
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.publishedPacks, [
    {
      name: 'pack-one',
      version: '1.2.3',
      scope: 'workspace',
      workspaceDir: harness.sessionWorkspaceDir,
      description: 'publish me',
      skillNames: ['skill-one'],
      sessionId: 'sess-pack',
    },
  ]);
}

function runAll(): void {
  testSkillsRouteResolvesDefaultAndSessionWorkspace();
  testPublishPackResolvesBodySessionWorkspace();
  console.log('web-skill-routes tests passed');
}

runAll();
