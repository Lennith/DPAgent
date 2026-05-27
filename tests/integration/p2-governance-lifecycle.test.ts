import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import { readSkillVersion } from '../../src/skills/skill-markdown.js';
import type { ContextRef, LLMResponse, Message } from '../../src/types.js';
import type { LLMClient } from '../../src/llm/index.js';
import { cleanupIntegrationHarness, createIntegrationHarness } from './helpers/integration-harness.js';

class ScriptedLLMClient {
  private callbackIndex = 0;
  private classifyIndex = 0;

  constructor(
    private readonly responses: string[],
    private readonly classifications: Array<{
      title: string;
      content: string;
      reason: string;
      conflictHints?: string[];
    }>
  ) {}

  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onComplete?: (result: LLMResponse) => void;
    }
  ): Promise<LLMResponse> {
    const content = this.responses[this.callbackIndex];
    if (!content) {
      throw new Error(`Missing scripted response at index=${this.callbackIndex}`);
    }
    this.callbackIndex += 1;
    callbacks.onText?.(content);
    const response: LLMResponse = {
      content,
    finishReason: 'end_turn',
    };
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }

  async generate(messages: Message[]): Promise<LLMResponse> {
    const prompt = String(messages[0]?.content ?? '');
    const turnIds = Array.from(prompt.matchAll(/"turnId":\s*"([^"]+)"/g)).map((match) => match[1]);
    const items = turnIds.map((turnId) => {
      const next = this.classifications[this.classifyIndex];
      if (!next) {
        throw new Error(`Missing classification at index=${this.classifyIndex}`);
      }
      this.classifyIndex += 1;
      return {
        turnId,
        decision: 'memory_candidate',
        scope: 'workspace',
        title: next.title,
        content: next.content,
        reason: next.reason,
        stability: 'stable',
        conflictHints: next.conflictHints ?? [],
      };
    });
    return {
      content: JSON.stringify({ items }),
    finishReason: 'end_turn',
    };
  }
}

async function runCase(): Promise<void> {
  const harness = createIntegrationHarness('p2-governance-', {
    extraDirs: { otherWorkspaceDir: 'other-workspace' },
  });
  const otherWorkspaceDir = harness.extraDirs.otherWorkspaceDir;
  const context: ContextRef = {
    scope: 'session',
    namespace: 'p2-governance',
  };
  const otherContext: ContextRef = {
    scope: 'session',
    namespace: 'p2-team-preset',
  };
  try {
    const agent = new DPAgent({
      allowMissingApiKeyAtBoot: true,
      configPath: path.join(process.cwd(), 'config.example.yaml'),
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
    });
    const asAny = agent as unknown as {
      llmClient: LLMClient;
      toolRegistry: ToolRegistry;
      fullSystemPrompt: string;
    };
    asAny.llmClient = new ScriptedLLMClient(
      [
        [
          'Remember this Windows release checklist.',
          '1. `npm run build:web`',
          '2. `npm test`',
          '3. Publish to the internal registry',
        ].join('\n'),
        [
          'Remember this Windows release checklist.',
          '1. `npm run build:web`',
          '2. `npm test`',
          '3. Publish to the internal registry',
        ].join('\n'),
        [
          'Remember this Windows release checklist.',
          '1. `npm run build:web`',
          '2. `npm test`',
          '3. Publish to the internal registry',
          '4. Verify package metadata before publish',
        ].join('\n'),
      ],
      [
        {
          title: 'Windows release checklist',
          content: 'Use npm run build:web, then npm test, before publish.',
          reason: 'stable workspace release checklist',
        },
        {
          title: 'Windows release checklist',
          content: 'Use npm run build:web, then npm test, before publish.',
          reason: 'stable workspace release checklist duplicate',
        },
        {
          title: 'Windows release checklist',
          content: 'Use npm run build:web, npm test, and verify package metadata before publish.',
          reason: 'updated workspace release checklist',
        },
      ]
    ) as unknown as LLMClient;
    asAny.toolRegistry = new ToolRegistry();
    asAny.fullSystemPrompt = 'You are a unit-test assistant.';
    agent.updateConfig({
      agent: {
        defaultToolset: 'full-access',
      },
    });

    agent.updateContextNamespaceMeta(context, {
      workspaceDir: harness.workspaceDir,
    });
    agent.updateContextNamespaceMeta(otherContext, {
      workspaceDir: otherWorkspaceDir,
    });

    agent.setToolsetPreset({
      scope: 'team',
      toolsetName: 'research',
      sessionId: context.namespace,
    });
    assert.equal(agent.resolveToolsetName(otherContext), 'full-access');
    assert.equal(agent.getToolsetPresetStore().getWorkspacePreset(otherWorkspaceDir)?.toolsetName, 'full-access');

    agent.setToolsetPreset({
      scope: 'workspace',
      toolsetName: 'windows-safe',
      workspaceDir: harness.workspaceDir,
      sessionId: context.namespace,
    });
    assert.equal(agent.resolveToolsetName(context), 'windows-safe');

    agent.updateContextNamespaceMeta(context, {
      toolsetName: 'windows-dev',
    });
    assert.equal(agent.resolveToolsetName(context), 'windows-dev');

    await agent.runWithResult({
      prompt: 'Remember the Windows release checklist for this workspace.',
      context,
      workspaceDir: harness.workspaceDir,
    });
    const firstOrganize = await agent.organizeSessionMemory({
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(firstOrganize.appliedCount, 1);

    const firstMemory = agent.getMemoryStore().listEntries({
      workspaceDir: harness.workspaceDir,
      includeUser: true,
    });
    assert.equal(firstMemory.length, 1);
    assert.match(firstMemory[0].content, /npm run build:web/);

    await agent.runWithResult({
      prompt: 'Remember the Windows release checklist for this workspace.',
      context,
      workspaceDir: harness.workspaceDir,
    });
    await agent.organizeSessionMemory({
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    const afterDuplicate = agent.getMemoryStore().listEntries({
      workspaceDir: harness.workspaceDir,
      includeUser: true,
    });
    assert.equal(afterDuplicate.length, 1);
    assert.equal(afterDuplicate[0].version, 1);

    const appliedCreateRecords = agent.getSkillWriteStore().listWriteRecords({
      status: 'applied',
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(appliedCreateRecords.some((item) => item.action === 'create'), true);
    const approvedCreate = agent
      .getSkillLoader()
      .getSkillCatalog({ workspaceDir: harness.workspaceDir })
      .find((item) => item.source === 'workspace');
    assert.ok(approvedCreate);
    assert.equal(readSkillVersion(fs.readFileSync(approvedCreate?.path ?? '', 'utf-8')), '1');
    const generatedPack = agent
      .getSkillPackStore()
      .listPacks({ workspaceDir: harness.workspaceDir })
      .find((item) => item.name === 'workspace-generated');
    assert.ok(generatedPack);

    const packV1 = agent.publishSkillPack({
      name: 'release-pack',
      version: '1',
      scope: 'team',
      workspaceDir: harness.workspaceDir,
      skillNames: approvedCreate?.name ? [approvedCreate.name] : undefined,
      sessionId: context.namespace,
    });
    assert.equal(packV1.activeVersion, '1');
    const teamCatalogV1 = agent.getSkillLoader().getSkillCatalog();
    const packedSkillV1 = teamCatalogV1.find((item) => item.packName === 'release-pack');
    assert.equal(packedSkillV1?.source, 'team_pack');
    assert.equal(packedSkillV1?.packVersion, '1');

    await agent.runWithResult({
      prompt: 'Remember the Windows release checklist for this workspace.',
      context,
      workspaceDir: harness.workspaceDir,
    });
    const thirdOrganize = await agent.organizeSessionMemory({
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(thirdOrganize.appliedCount, 1);

    const appliedUpdateRecords = agent.getSkillWriteStore().listWriteRecords({
      status: 'applied',
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(appliedUpdateRecords.some((item) => item.action === 'update'), true);
    const approvedUpdate = agent.getSkillLoader().getSkillByName(approvedCreate?.name ?? '', {
      workspaceDir: harness.workspaceDir,
    });
    assert.ok(approvedUpdate);
    assert.equal(readSkillVersion(fs.readFileSync(approvedUpdate?.path ?? '', 'utf-8')), '2');

    const updatedMemory = agent.getMemoryStore().listEntries({
      workspaceDir: harness.workspaceDir,
      includeUser: true,
    });
    assert.equal(updatedMemory.length, 1);
    assert.equal(updatedMemory[0].version, 2);
    assert.match(updatedMemory[0].content, /package metadata/);

    const packV2 = agent.publishSkillPack({
      name: 'release-pack',
      version: '2',
      scope: 'team',
      workspaceDir: harness.workspaceDir,
      skillNames: approvedUpdate?.name ? [approvedUpdate.name] : undefined,
      sessionId: context.namespace,
    });
    assert.equal(packV2.activeVersion, '2');
    const teamCatalogV2 = agent.getSkillLoader().getSkillCatalog();
    const packedSkillV2 = teamCatalogV2.find((item) => item.packName === 'release-pack');
    assert.equal(packedSkillV2?.packVersion, '2');

    const rolledPack = agent.rollbackSkillPack({
      name: 'release-pack',
      scope: 'team',
      sessionId: context.namespace,
    });
    assert.ok(rolledPack);
    assert.equal(rolledPack?.activeVersion, '1');
    const teamCatalogRolledBack = agent.getSkillLoader().getSkillCatalog();
    const packedSkillRolledBack = teamCatalogRolledBack.find((item) => item.packName === 'release-pack');
    assert.equal(packedSkillRolledBack?.packVersion, '1');

    const history = agent.listSkillHistory({
      name: approvedUpdate?.name ?? '',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(history.length >= 1, true);
    assert.equal(history.some((item) => item.version === '1'), true);

    const rollbackResult = agent.rollbackSkill({
      name: approvedUpdate?.name ?? '',
      workspaceDir: harness.workspaceDir,
      version: '1',
      sessionId: context.namespace,
    });
    assert.ok(rollbackResult);
    assert.equal(readSkillVersion(fs.readFileSync(approvedUpdate?.path ?? '', 'utf-8')), '1');

    const audit = agent.listGovernanceAudit({
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
      limit: 40,
    });
    assert.equal(audit.some((item) => item.kind === 'memory_organized'), true);
    assert.equal(audit.some((item) => item.kind === 'memory_written'), true);
    assert.equal(
      audit.some((item) => item.kind === 'skill_triggered' && String(item.metadata?.action ?? '') === 'update'),
      true
    );
    assert.equal(audit.some((item) => item.kind === 'skill_rolled_back'), true);
    assert.equal(audit.some((item) => item.kind === 'skill_pack_published'), true);
    assert.equal(audit.some((item) => item.kind === 'skill_pack_rolled_back'), true);
    assert.equal(audit.some((item) => item.kind === 'toolset_preset_updated'), true);

    console.log('p2-governance-lifecycle integration test passed');
  } finally {
    cleanupIntegrationHarness(harness);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
