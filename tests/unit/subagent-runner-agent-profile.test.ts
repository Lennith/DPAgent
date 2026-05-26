import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { createDefaultContextBudgetConfig } from '../../src/runtime/context-window-budget.js';
import { SubAgentTurnRunner } from '../../src/subagent/SubAgentTurnRunner.js';
import { Tool, ToolRegistry } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type { Message, SubAgentProviderConfig } from '../../src/types.js';
import type { SubAgentQueuedTask } from '../../src/subagent/types.js';

class CaptureLLMClient {
  public lastSystemPrompt = '';
  public lastToolNames: string[] = [];
  constructor(private readonly delayMs = 0) {}

  async generateWithCallbacks(
    _messages: Message[],
    _callbacks: Record<string, unknown>,
    tools: Array<Record<string, unknown>>,
    systemPrompt?: string
  ): Promise<{
    content: string;
    finishReason: string;
    toolCalls?: never[];
  }> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.lastSystemPrompt = String(systemPrompt ?? '');
    this.lastToolNames = tools.map((tool) => String(tool.name ?? ''));
    return {
      content: 'done',
      finishReason: 'end_turn',
      toolCalls: [],
    };
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<CaptureLLMClient['generateWithCallbacks']>
  ): ReturnType<CaptureLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

class ControlledLLMClient extends CaptureLLMClient {
  private resolveResponse: (() => void) | null = null;
  public readonly responseStarted = new Promise<void>((resolve) => {
    this.resolveResponse = resolve;
  });

  async generateWithCallbacks(
    _messages: Message[],
    _callbacks: Record<string, unknown>,
    tools: Array<Record<string, unknown>>,
    systemPrompt?: string
  ): Promise<{
    content: string;
    finishReason: string;
    toolCalls?: never[];
  }> {
    await this.responseStarted;
    this.lastSystemPrompt = String(systemPrompt ?? '');
    this.lastToolNames = tools.map((tool) => String(tool.name ?? ''));
    return {
      content: 'done',
      finishReason: 'end_turn',
      toolCalls: [],
    };
  }

  release(): void {
    this.resolveResponse?.();
  }
}

class DummyTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return `dummy ${this.toolName}`;
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute() {
    return { success: true, content: 'ok' };
  }
}

function createTask(overrides?: Partial<SubAgentQueuedTask>): SubAgentQueuedTask {
  return {
    taskId: 'task-1',
    subagentId: 'sub-1',
    parentKey: 'session:s1',
    parentContext: { scope: 'session', namespace: 's1' },
    subagentContext: { scope: 'global', namespace: 'sub:s1:sub-1' },
    operation: 'create',
    prompt: 'do work',
    providerId: 'local-default',
    timeoutMs: 60000,
    workspaceDir: process.cwd(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createTestConfig(workspaceDir: string) {
  return {
    agent: { workspaceDir },
    contextBudget: createDefaultContextBudgetConfig(),
  } as any;
}

async function testRunnerInjectsSelectedAgentProfile(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-profile-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    const llm = new CaptureLLMClient();
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true }];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
    });

    const result = await runner.runTask(
      createTask({
        workspaceDir: tempDir,
        agentName: 'Coder',
        agentProfile: {
          name: 'Coder',
          source: 'global',
          description: 'Coding agent',
          path: path.join(tempDir, 'agents', 'Coder', 'AGENTS.md'),
          mtime: new Date().toISOString(),
          content: '# Coder\nFocus on code quality.',
          config: {
            promptAppend: 'Prefer focused patches.',
          },
        },
        agentConfig: {
          promptAppend: 'Prefer focused patches.',
        },
      })
    );
    assert.equal(result.status, 'succeeded');
    assert.match(llm.lastSystemPrompt, /\[AGENT_PROFILE_BEGIN source=global name=Coder/);
    assert.match(llm.lastSystemPrompt, /Focus on code quality/);
    assert.match(llm.lastSystemPrompt, /Prefer focused patches/);
    assert.match(llm.lastSystemPrompt, /Do not create or manage the parent session todo protocol/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRunnerUsesDefaultRoleWithoutAgentProfile(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-default-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    const llm = new CaptureLLMClient();
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true }];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
    });

    await runner.runTask(createTask({ workspaceDir: tempDir }));
    assert.match(llm.lastSystemPrompt, /Default Sub-Agent Role/);
    assert.doesNotMatch(llm.lastSystemPrompt, /\[AGENT_PROFILE_BEGIN/);
    assert.match(llm.lastSystemPrompt, /Return results, verification evidence, and blockers so the parent can update todos/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRunnerUsesTaskScopedToolRegistryWhenProvided(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-tools-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    mainRegistry.register(new DummyTool('read_file'));
    const llm = new CaptureLLMClient();
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true }];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getTaskToolRegistry: () => {
        const registry = new ToolRegistry();
        registry.register(new DummyTool('memory_manage'));
        registry.register(new DummyTool('todo'));
        registry.register(new DummyTool('context_manage'));
        registry.register(new DummyTool('subagent_manage'));
        return registry;
      },
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
    });

    await runner.runTask(
      createTask({
        workspaceDir: tempDir,
        allowedTools: ['todo', 'memory_manage', 'context_manage', 'subagent_manage'],
      })
    );

    assert.deepEqual(llm.lastToolNames.sort(), ['memory_manage']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRunnerUsesTaskTimeoutInsteadOfProviderTimeout(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-timeout-source-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    const llm = new CaptureLLMClient(20);
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true, timeoutMs: 1 }];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
    });

    const result = await runner.runTask(createTask({ workspaceDir: tempDir, timeoutMs: 100 }));
    assert.equal(result.status, 'succeeded');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRunnerWarnsButContinuesAtTaskDeadline(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-task-timeout-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    const llm = new CaptureLLMClient(50);
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true, timeoutMs: 1000 }];
    const warnings: string[] = [];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
      onProgress: (update) => {
        if (update.type === 'timeout_warning' && update.timeoutWarning?.threshold === 1) {
          warnings.push(update.timeoutWarning.message);
        }
      },
    });

    const result = await runner.runTask(createTask({ workspaceDir: tempDir, timeoutMs: 5 }));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(result.error, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /remains running/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testRunnerKeepsTaskPendingUntilLongRunSettles(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-runner-timeout-settle-'));
  try {
    const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const mainRegistry = new ToolRegistry();
    const llm = new ControlledLLMClient();
    const providers: SubAgentProviderConfig[] = [{ id: 'local-default', type: 'local', enabled: true, timeoutMs: 1000 }];
    const runner = new SubAgentTurnRunner({
      getLLMClient: () => llm as unknown as LLMClient,
      contextManager,
      getMainToolRegistry: () => mainRegistry,
      getBaseSystemPrompt: () => 'BASE_SYSTEM',
      getMcpToolDescriptions: () => '',
      getMaxSteps: () => 3,
      getTokenLimit: () => 80000,
      getConfig: () => createTestConfig(tempDir),
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => providers,
    });

    let settled = false;
    const runPromise = runner.runTask(createTask({ workspaceDir: tempDir, timeoutMs: 5 })).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false);
    llm.release();
    const result = await runPromise;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.error, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testRunnerInjectsSelectedAgentProfile();
  await testRunnerUsesDefaultRoleWithoutAgentProfile();
  await testRunnerUsesTaskScopedToolRegistryWhenProvided();
  await testRunnerUsesTaskTimeoutInsteadOfProviderTimeout();
  await testRunnerWarnsButContinuesAtTaskDeadline();
  await testRunnerKeepsTaskPendingUntilLongRunSettles();
  console.log('subagent-runner-agent-profile tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
