import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { ToolRegistry, createPlanModeTools } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type { ContextRef, Message, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';

const PLAN_MODE_PROMPT_PREFIX = [
  '[PLAN_MODE_REQUIRED]',
  'You MUST execute this turn in Plan Mode and follow this protocol strictly:',
  '1) First tool call MUST be `update_plan` with an actionable step list.',
  '2) If requirements are ambiguous or choices are needed, call `request_user_input` before implementation.',
  '3) Keep plan status updated with `update_plan` while executing.',
  '4) Final output MUST be produced via `finalize_plan` (Markdown only).',
  '5) Do NOT skip directly to a normal free-form answer.',
  'If any step cannot be completed, explain why in the finalized plan.',
  '[/PLAN_MODE_REQUIRED]',
].join('\n');

const USER_PROMPT = 'Please create a concrete implementation plan for adding an auto-loop exit tool.';

type FakeToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type FakeStep = {
  content: string;
  thinking?: string;
  finishReason: string;
  toolCalls?: FakeToolCall[];
};

class FakeLLMClient {
  private readonly steps: FakeStep[];
  private index = 0;

  constructor(steps: FakeStep[]) {
    this.steps = steps;
  }

  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onThinking?: (thinking: string) => void;
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    }
  ): Promise<{
    content: string;
    thinking?: string;
    toolCalls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, unknown> };
    }>;
    finishReason: string;
  }> {
    const step = this.steps[this.index];
    if (!step) {
      throw new Error(`FakeLLMClient out of scripted steps at index ${this.index}`);
    }
    this.index += 1;

    if (step.thinking) {
      callbacks.onThinking?.(step.thinking);
    }
    if (step.content) {
      callbacks.onText?.(step.content);
    }
    for (const call of step.toolCalls ?? []) {
      callbacks.onToolUse?.(call.id, call.name, call.input);
    }
    callbacks.onComplete?.(step);

    return {
      content: step.content,
      thinking: step.thinking,
      finishReason: step.finishReason,
      toolCalls: (step.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: {
          name: call.name,
          arguments: call.input,
        },
      })),
    };
  }
}

function createHarness(): {
  tempDir: string;
  context: ContextRef;
  contextManager: ContextManager;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-agent-case-'));
  const eventStore = new ContextEventStore(path.join(tempDir, 'contexts'));
  const contextManager = new ContextManager(eventStore);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'plan-mode-agent-case',
  };
  return { tempDir, context, contextManager };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function runCase(): Promise<void> {
  const harness = createHarness();
  try {
    let capturedRequest: PlanInputRequest | null = null;
    let capturedFinalizeMarkdown = '';
    const toolResults: string[] = [];

    const answers: PlanInputAnswer[] = [
      {
        id: 'scope',
        selectedLabel: 'Full implementation',
        selectedIndex: 0,
        freeText: 'Include backend and websocket loop behavior',
      },
    ];

    const registry = new ToolRegistry();
    const tools = createPlanModeTools({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
      requestUserInput: async (request) => {
        capturedRequest = request;
        return answers;
      },
    });
    for (const tool of tools) {
      registry.register(tool);
    }

    const llm = new FakeLLMClient([
      {
        content: 'Initialize plan.',
        thinking: 'need update_plan',
        finishReason: 'tool_use',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'update_plan',
            input: {
              explanation: 'seed plan state',
              plan: [
                { step: 'confirm constraints', status: 'completed' },
                { step: 'implement loop exit tool', status: 'in_progress' },
                { step: 'test and verify', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        content: 'Need scope confirmation.',
        thinking: 'need request_user_input',
        finishReason: 'tool_use',
        toolCalls: [
          {
            id: 'tool-2',
            name: 'request_user_input',
            input: {
              questions: [
                {
                  header: 'Scope',
                  id: 'scope',
                  question: 'Choose the implementation scope',
                  options: [
                    { label: 'Full implementation', description: 'Backend + websocket + tests' },
                    { label: 'Backend only', description: 'Only server-side tool and state' },
                  ],
                },
              ],
            },
          },
        ],
      },
      {
        content: 'Finalize markdown plan.',
        thinking: 'need finalize_plan',
        finishReason: 'tool_use',
        toolCalls: [
          {
            id: 'tool-3',
            name: 'finalize_plan',
            input: {
              title: 'Plan Mode Agent Case',
              summary: 'Validate that an agent can complete the full plan-mode toolchain.',
              key_changes: ['Call update_plan', 'Call request_user_input', 'Call finalize_plan'],
              test_plan: ['Assert question payload', 'Assert final markdown persistence'],
              assumptions: ['request_user_input callback available'],
            },
          },
        ],
      },
      {
        content: 'Plan mode flow completed.',
        finishReason: 'end_turn',
      },
    ]);

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a planner agent.',
      maxSteps: 10,
      tokenLimit: 80000,
      workspaceDir: harness.tempDir,
      callback: {
        onToolResult: (name, result) => {
          const payload = `${name}:${result.success ? result.content : result.error ?? ''}`;
          toolResults.push(payload);
          if (name === 'finalize_plan' && result.success) {
            capturedFinalizeMarkdown = result.content;
          }
        },
      },
    });

    const injectedPrompt = `${PLAN_MODE_PROMPT_PREFIX}\n\n${USER_PROMPT}`;
    const result = await agent.runWithResult(injectedPrompt);

    assert.equal(result.content, 'Plan mode flow completed.');
    assert.ok(capturedRequest, 'request_user_input should be called');
    assert.equal(capturedRequest?.questions[0]?.id, 'scope');

    const projection = harness.contextManager.getProjection(harness.context);
    const currentPlan = projection.keyValues['plan_mode.current_plan'];
    const finalMarkdown = projection.keyValues['plan_mode.final_plan_markdown'];
    const finalSnapshot = projection.keyValues['plan_mode.final_plan_snapshot'];

    assert.ok(currentPlan, 'current plan should be persisted');
    assert.ok(finalMarkdown, 'final markdown should be persisted');
    assert.ok(finalSnapshot, 'final snapshot should be persisted');
    assert.equal(capturedFinalizeMarkdown, finalMarkdown);
    assert.match(finalMarkdown, /### Plan Mode Agent Case/);
    assert.match(finalMarkdown, /### Test Plan/);
    assert.equal(toolResults.some((item) => item.startsWith('update_plan:')), true);
    assert.equal(toolResults.some((item) => item.startsWith('request_user_input:')), true);
    assert.equal(toolResults.some((item) => item.startsWith('finalize_plan:')), true);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runRequestUserInputToolErrorCase(): Promise<void> {
  const harness = createHarness();
  try {
    const toolResults: string[] = [];

    const registry = new ToolRegistry();
    const tools = createPlanModeTools({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
      requestUserInput: async (_request) => [],
    });
    for (const tool of tools) {
      registry.register(tool);
    }

    const llm = new FakeLLMClient([
      {
        content: 'Try request_user_input with malformed options.',
        finishReason: 'tool_use',
        toolCalls: [
          {
            id: 'tool-bad-1',
            name: 'request_user_input',
            input: {
              questions: [
                {
                  header: 'Scope',
                  id: 'scope',
                  question: 'Choose implementation scope',
                  options: 'not-an-array',
                },
              ],
            },
          },
        ],
      },
      {
        content: 'Recovered after request_user_input tool error.',
        finishReason: 'end_turn',
      },
    ]);

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a planner agent.',
      maxSteps: 10,
      tokenLimit: 80000,
      workspaceDir: harness.tempDir,
      callback: {
        onToolResult: (name, result) => {
          const payload = `${name}:${result.success ? result.content : result.error ?? ''}`;
          toolResults.push(payload);
        },
      },
    });

    const injectedPrompt = `${PLAN_MODE_PROMPT_PREFIX}\n\n${USER_PROMPT}`;
    const result = await agent.runWithResult(injectedPrompt);
    assert.equal(result.content, 'Recovered after request_user_input tool error.');
    assert.equal(toolResults.some((item) => item.startsWith('request_user_input:')), true);
    assert.equal(toolResults.some((item) => item.includes('options must be an array')), true);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await runCase();
  await runRequestUserInputToolErrorCase();
}

runAll()
  .then(() => {
    console.log('plan-mode-agent-case test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
