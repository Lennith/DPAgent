import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import { createMemoryTool, createSkillTools } from '../../src/tools/index.js';
import { readSkillVersion } from '../../src/skills/skill-markdown.js';

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
    const agent = new DPAgent({
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
      writeSkill: (payload) => agent.writeSkill(payload),
      resolveWorkspaceDir: () => harness.workspaceDir,
      resolveSessionId: () => sessionId,
      resolveToolsetName: () => 'windows-dev',
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
    });
    const appliedSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'create',
        name: 'release-audit-skill',
        description: 'Release workflow',
        content: 'Always verify the package metadata before publish.',
      })
    );
    assert.equal(appliedSkill.mode, 'applied');
    assert.equal(appliedSkill.record.status, 'applied');
    assert.equal(fs.existsSync(appliedSkill.record.targetPath), true);
    assert.equal(readSkillVersion(fs.readFileSync(appliedSkill.record.targetPath, 'utf-8')), '1');
    const updatedSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'update',
        name: 'release-audit-skill',
        description: 'Release workflow',
        content: 'Always verify the package metadata and changelog before publish.',
      })
    );
    assert.equal(updatedSkill.mode, 'applied');
    assert.equal(updatedSkill.record.action, 'update');
    assert.equal(updatedSkill.record.baseVersion, '1');
    assert.equal(updatedSkill.record.nextVersion, '2');
    assert.equal(readSkillVersion(fs.readFileSync(updatedSkill.record.targetPath, 'utf-8')), '2');
    const createExistingSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'create',
        name: 'release-audit-skill',
        description: 'Release workflow',
        content: 'Always verify package metadata, changelog, and generated release notes before publish.',
      })
    );
    assert.equal(createExistingSkill.action, 'update');
    assert.equal(createExistingSkill.requestedAction, 'create');
    assert.equal(createExistingSkill.record.action, 'update');
    assert.equal(createExistingSkill.record.baseVersion, '2');
    assert.equal(createExistingSkill.record.nextVersion, '3');
    assert.equal(readSkillVersion(fs.readFileSync(createExistingSkill.record.targetPath, 'utf-8')), '3');
    const updateMissingSkill = parsePayload(
      await confirmSkillTool.execute({
        action: 'update',
        name: 'new-release-audit-skill',
        description: 'New release workflow',
        content: 'Verify newly created release workflow before publish.',
      })
    );
    assert.equal(updateMissingSkill.action, 'create');
    assert.equal(updateMissingSkill.requestedAction, 'update');
    assert.equal(updateMissingSkill.record.action, 'create');
    assert.equal(updateMissingSkill.record.nextVersion, '1');
    assert.equal(readSkillVersion(fs.readFileSync(updateMissingSkill.record.targetPath, 'utf-8')), '1');
    const unsupportedRuntimeApproval = await confirmSkillTool.execute({
      action: 'approve',
      id: appliedSkill.record.id,
    });
    assert.equal(unsupportedRuntimeApproval.success, false);
    assert.match(String(unsupportedRuntimeApproval.error ?? ''), /unknown action/i);

    const autoObservedDraft = agent.getSkillWriteStore().observeSuccessfulTurn({
      sessionId,
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable release verification workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish only after checks pass'].join('\n'),
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.equal(autoObservedDraft, null);
    const repeatedDraft = agent.getSkillWriteStore().observeSuccessfulTurn({
      sessionId,
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable release verification workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish only after checks pass'].join('\n'),
      globalSkillsDir: path.join(harness.tempDir, 'global-skills'),
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.ok(repeatedDraft);
    agent.reloadSkills();
    agent.republishAutoGeneratedWorkspaceSkills(harness.workspaceDir, sessionId);

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
    assert.equal(audit.some((item) => item.kind === 'skill_written'), true);
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
