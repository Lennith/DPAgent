import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import { createMemoryTool, createSkillTools } from '../../src/tools/index.js';

function createHarness(): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-tool-audit-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function parsePayload(result: { success: boolean; content: string; error?: string }): any {
  assert.equal(result.success, true, result.error ?? 'tool call failed');
  return JSON.parse(result.content);
}

async function runCase(): Promise<void> {
  const harness = createHarness();
  const sessionId = 'governance-tool-audit';
  try {
    const agent = new MiniMaxAgent({
      allowMissingApiKeyAtBoot: true,
      configPath: path.join(process.cwd(), 'config.yaml'),
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
    });
    agent.updateContextNamespaceMeta(
      {
        scope: 'session',
        namespace: sessionId,
      },
      {
        workspaceDir: harness.workspaceDir,
      }
    );

    const memoryTool = createMemoryTool({
      memoryStore: agent.getMemoryStore(),
      resolveWorkspaceDir: () => harness.workspaceDir,
      resolveSessionId: () => sessionId,
      mutateMemory: (input) => agent.mutateMemory(input),
    });

    const addedMemory = parsePayload(
      await memoryTool.execute({
        action: 'add',
        title: 'Windows release checklist',
        content: 'Run npm test before publish.',
      })
    );
    assert.equal(addedMemory.result.action, 'add');
    assert.equal(typeof addedMemory.result.entry?.id, 'string');

    const replacedMemory = parsePayload(
      await memoryTool.execute({
        action: 'replace',
        id: addedMemory.result.entry.id,
        title: 'Windows release checklist',
        content: 'Run npm run build:web before publish.',
      })
    );
    assert.equal(replacedMemory.result.action, 'replace');
    assert.equal(replacedMemory.result.entry.version, 2);

    const historyPayload = parsePayload(
      await memoryTool.execute({
        action: 'history',
        id: replacedMemory.result.entry.id,
      })
    );
    assert.equal(historyPayload.items.length, 2);

    const removedMemory = parsePayload(
      await memoryTool.execute({
        action: 'remove',
        id: replacedMemory.result.entry.id,
      })
    );
    assert.equal(removedMemory.result.action, 'remove');
    assert.equal(removedMemory.result.removed, true);

    const [, , confirmSkillTool] = createSkillTools({
      skillLoader: agent.getSkillLoader(),
      skillDraftStore: agent.getSkillDraftStore(),
      resolveWorkspaceDir: () => harness.workspaceDir,
      resolveSessionId: () => sessionId,
      resolveToolsetName: () => 'windows-dev',
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      writeMode: 'confirm',
      approveSkillDraft: (id) => agent.approveSkillDraft(id),
      rejectSkillDraft: (id, reviewNote) => agent.rejectSkillDraft(id, reviewNote),
    });
    const pendingSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'create',
        name: 'release-audit-skill',
        description: 'Release workflow',
        content: 'Always verify the package metadata before publish.',
      })
    );
    parsePayload(
      await confirmSkillTool.execute({
        action: 'approve',
        id: pendingSkill.record.id,
      })
    );
    const rejectedSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'create',
        name: 'release-audit-skill-2',
        description: 'Release workflow v2',
        content: 'Reject this pending draft.',
      })
    );
    parsePayload(
      await confirmSkillTool.execute({
        action: 'reject',
        id: rejectedSkill.record.id,
        review_note: 'not needed',
      })
    );

    const [, , autoSkillTool] = createSkillTools({
      skillLoader: agent.getSkillLoader(),
      skillDraftStore: agent.getSkillDraftStore(),
      resolveWorkspaceDir: () => harness.workspaceDir,
      resolveSessionId: () => sessionId,
      resolveToolsetName: () => 'windows-dev',
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      writeMode: 'auto',
      approveSkillDraft: (id) => agent.approveSkillDraft(id),
      rejectSkillDraft: (id, reviewNote) => agent.rejectSkillDraft(id, reviewNote),
    });
    const writtenSkill = parsePayload(
      await autoSkillTool.execute({
        action: 'create',
        name: 'release-audit-skill-auto',
        description: 'Auto approved skill',
        content: 'This skill should be auto-approved with audit.',
      })
    );
    assert.equal(writtenSkill.mode, 'written');

    const autoObservedDraft = agent.getSkillDraftStore().observeSuccessfulTurn({
      sessionId,
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable release verification workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish only after checks pass'].join('\n'),
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.equal(autoObservedDraft, null);
    const repeatedDraft = agent.getSkillDraftStore().observeSuccessfulTurn({
      sessionId,
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable release verification workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish only after checks pass'].join('\n'),
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.ok(repeatedDraft);
    agent.approveSkillDraft(String(repeatedDraft?.id));

    const autoPublishedPacks = agent.getSkillPackStore().listPacks({ workspaceDir: harness.workspaceDir });
    const generatedPack = autoPublishedPacks.find((item) => item.name === 'workspace-generated');
    assert.ok(generatedPack);
    assert.equal((generatedPack?.versions.length ?? 0) >= 1, true);
    assert.equal((generatedPack?.activeVersion ?? '').length > 0, true);

    const audit = agent.listGovernanceAudit({
      sessionId,
      workspaceDir: harness.workspaceDir,
      limit: 30,
    });
    assert.equal(audit.some((item) => item.kind === 'memory_written'), true);
    assert.equal(audit.some((item) => item.kind === 'memory_replaced'), true);
    assert.equal(audit.some((item) => item.kind === 'memory_removed'), true);
    assert.equal(audit.some((item) => item.kind === 'skill_approved'), true);
    assert.equal(audit.some((item) => item.kind === 'skill_rejected'), true);
    assert.equal(audit.some((item) => item.kind === 'skill_pack_published'), true);
  } finally {
    cleanup(harness.tempDir);
  }
}

runCase()
  .then(() => {
    console.log('governance-tool-audit tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
