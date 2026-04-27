import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { SubAgentManager } from '../../src/subagent/SubAgentManager.js';
import { SubAgentManageTool } from '../../src/tools/SubAgentManageTool.js';
import type { ContextRef, SubAgentProviderConfig } from '../../src/types.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask } from '../../src/subagent/types.js';
import type { SubAgentTurnRunner } from '../../src/subagent/SubAgentTurnRunner.js';

class ImmediateRunner {
  async runTask(_task: SubAgentQueuedTask): Promise<SubAgentExecutionOutput> {
    return {
      status: 'succeeded',
      summary: 'done',
      artifacts: { files: [], commands: [], notes: [] },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  cancelTask(_taskId: string): boolean {
    return false;
  }
}

function createHarness(): {
  tempDir: string;
  context: ContextRef;
  manager: SubAgentManager;
  tool: SubAgentManageTool;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-manage-tool-test-'));
  const contextDir = path.join(tempDir, 'contexts');
  const eventStore = new ContextEventStore(contextDir);
  const contextManager = new ContextManager(eventStore);
  const globalAgentsDir = path.join(tempDir, 'agents');
  const workspaceDir = tempDir;

  fs.mkdirSync(path.join(globalAgentsDir, 'Coder'), { recursive: true });
  fs.writeFileSync(path.join(globalAgentsDir, 'Coder', 'AGENTS.md'), '# Coder\nCoding specialist.', 'utf-8');
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\nWorkspace agent.', 'utf-8');

  const providers: SubAgentProviderConfig[] = [
    { id: 'local-default', type: 'local', enabled: true },
  ];
  const manager = new SubAgentManager({
    contextManager,
    turnRunner: new ImmediateRunner() as unknown as SubAgentTurnRunner,
    registryFilePath: path.join(tempDir, 'subagent_registry.json'),
    getDefaultWorkspaceDir: () => workspaceDir,
    getProviderConfigs: () => providers,
    getGlobalAgentsDir: () => globalAgentsDir,
    getMaxParallelPerParent: () => 4,
    getGlobalMaxParallel: () => 10,
  });

  const context: ContextRef = { scope: 'session', namespace: 's1' };
  const tool = new SubAgentManageTool({
    manager,
    resolveActiveContext: () => context,
    resolveDefaultWorkspaceDir: () => workspaceDir,
    resolveAllowedTools: () => ['read_file', 'shell_execute', 'memory_manage', 'subagent_manage'],
  });
  return { tempDir, context, manager, tool };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function testListAgents(): Promise<void> {
  const harness = createHarness();
  try {
    const result = await harness.tool.execute({ action: 'list_agents' });
    assert.equal(result.success, true);
    const payload = JSON.parse(result.content);
    assert.equal(Array.isArray(payload.agents), true);
    assert.equal(payload.agents.some((item: { name: string; source: string }) => item.name === 'Coder' && item.source === 'global'), true);
    assert.equal(payload.agents.some((item: { name: string; source: string }) => item.name === 'workspace' && item.source === 'workspace'), true);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testCreateWithAgentAndFallback(): Promise<void> {
  const harness = createHarness();
  try {
    const bad = await harness.tool.execute({
      action: 'create',
      prompt: 'work',
      agent_name: 'missing-agent',
    });
    assert.equal(bad.success, false);
    assert.equal(bad.error, 'agent_not_found: missing-agent');

    const okWithAgent = await harness.tool.execute({
      action: 'create',
      prompt: 'work',
      agent_name: 'coder',
    });
    assert.equal(okWithAgent.success, true);
    const withAgentPayload = JSON.parse(okWithAgent.content);
    assert.equal(withAgentPayload.status.agent.name, 'Coder');
    assert.deepEqual(withAgentPayload.status.allowedTools, ['read_file', 'shell_execute', 'memory_manage']);

    const okFallback = await harness.tool.execute({
      action: 'create',
      prompt: 'fallback',
    });
    assert.equal(okFallback.success, true);
    const fallbackPayload = JSON.parse(okFallback.content);
    assert.equal(fallbackPayload.status.agent ?? null, null);
    assert.deepEqual(fallbackPayload.status.allowedTools, ['read_file', 'shell_execute', 'memory_manage']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testAllowedToolsMustStayWithinCurrentTurn(): Promise<void> {
  const harness = createHarness();
  try {
    const narrowed = await harness.tool.execute({
      action: 'create',
      prompt: 'work',
      allowed_tools: ['shell_execute', 'web_search'],
    });
    assert.equal(narrowed.success, true);
    const narrowedPayload = JSON.parse(narrowed.content);
    assert.deepEqual(narrowedPayload.status.allowedTools, ['shell_execute']);

    const rejected = await harness.tool.execute({
      action: 'create',
      prompt: 'work',
      allowed_tools: ['web_search'],
    });
    assert.equal(rejected.success, false);
    assert.equal(rejected.error, 'allowed_tools must stay within the current toolset');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testAgentNotFoundShouldReturnToolErrorWithoutThrowing(): Promise<void> {
  const harness = createHarness();
  try {
    const created = await harness.tool.execute({
      action: 'create',
      prompt: 'prepare',
      agent_name: 'coder',
    });
    assert.equal(created.success, true);
    const createdPayload = JSON.parse(created.content);
    const resumeResult = await harness.tool.execute({
      action: 'resume',
      subagent_id: createdPayload.status.subagentId,
      prompt: 'retry',
      agent_name: 'bug-triage',
    });
    assert.equal(resumeResult.success, false);
    assert.equal(resumeResult.error, 'agent_not_found: bug-triage');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testDeprecatedArgs(): Promise<void> {
  const harness = createHarness();
  try {
    const withPreset = await harness.tool.execute({
      action: 'create',
      prompt: 'work',
      preset: 'coding',
    });
    assert.equal(withPreset.success, false);
    assert.match(withPreset.error ?? '', /deprecated/i);

    const withSystemPrompt = await harness.tool.execute({
      action: 'resume',
      subagent_id: 'x',
      prompt: 'work',
      system_prompt: 'legacy',
    });
    assert.equal(withSystemPrompt.success, false);
    assert.match(withSystemPrompt.error ?? '', /deprecated/i);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testListAgents();
  await testCreateWithAgentAndFallback();
  await testAllowedToolsMustStayWithinCurrentTurn();
  await testDeprecatedArgs();
  await testAgentNotFoundShouldReturnToolErrorWithoutThrowing();
  console.log('subagent-manage-tool tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
