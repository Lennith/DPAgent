import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { ToolRegistry, createPlanModeTools } from '../../src/tools/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import type { ContextRef, Message, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';
import { createResolvedTestContextBudget } from './test-context-budget.js';

const PLAN_MODE_PROMPT_PREFIX = [
  '[PLAN_MODE_REQUIRED]',
  'You MUST execute this turn in Plan Mode and follow this protocol strictly:',
  '1) If requirements are ambiguous or choices are needed, call `request_user_input` before finalizing.',
  '2) Final output MUST be produced via `finalize_plan` with executable steps and detection standards.',
  '3) Do NOT skip directly to a normal free-form answer.',
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

  get callCount(): number {
    return this.index;
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

  async generatePreparedWithCallbacks(
    ...args: Parameters<FakeLLMClient['generateWithCallbacks']>
  ): ReturnType<FakeLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
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
      requestPlanApproval: async () => [
        {
          id: 'plan_execution_approval',
          selectedLabel: 'Approve execution',
          selectedIndex: 0,
        },
      ],
    });
    for (const tool of tools) {
      registry.register(tool);
    }

    const llm = new FakeLLMClient([
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
              steps: [
                {
                  work: 'Call request_user_input to confirm scope.',
                  detection_standard: 'The captured request contains the scope question and selected answer.',
                },
                {
                  work: 'Call finalize_plan with executable steps.',
                  detection_standard: 'Final markdown, snapshot, and final_plan_steps are persisted.',
                },
              ],
              test_plan: ['Assert question payload', 'Assert final markdown persistence'],
              assumptions: ['request_user_input callback available'],
            },
          },
        ],
      },
      {
        content: 'This same planning turn must not continue after approved finalize_plan.',
        finishReason: 'end_turn',
      },
    ]);

    const agent = new Agent({
      llmClient: llm as unknown as LLMClient,
      toolRegistry: registry,
      systemPrompt: 'You are a planner agent.',
      maxSteps: 10,
      tokenLimit: 80000,
      contextBudget: createResolvedTestContextBudget(),
      workspaceDir: harness.tempDir,
      callback: {
        onToolResult: (name, result) => {
          const payload = `${name}:${result.success ? result.content : result.error ?? ''}`;
          toolResults.push(payload);
          if (name === 'finalize_plan' && result.success) {
            capturedFinalizeMarkdown = JSON.parse(result.content).markdown;
          }
        },
      },
    });

    const injectedPrompt = `${PLAN_MODE_PROMPT_PREFIX}\n\n${USER_PROMPT}`;
    const result = await agent.runWithResult(injectedPrompt);

    assert.equal(result.content, 'Plan approved. Execution will continue in a new turn.');
    assert.equal(result.finishReason, 'end_turn');
    assert.equal(llm.callCount, 2);
    assert.ok(capturedRequest, 'request_user_input should be called');
    assert.equal(capturedRequest?.questions[0]?.id, 'scope');

    const projection = harness.contextManager.getProjection(harness.context);
    const finalMarkdown = projection.keyValues['plan_mode.final_plan_markdown'];
    const finalSnapshot = projection.keyValues['plan_mode.final_plan_snapshot'];
    const finalSteps = projection.keyValues['plan_mode.final_plan_steps'];

    assert.ok(finalMarkdown, 'final markdown should be persisted');
    assert.ok(finalSnapshot, 'final snapshot should be persisted');
    assert.ok(finalSteps, 'final plan steps should be persisted');
    assert.equal(capturedFinalizeMarkdown, finalMarkdown);
    assert.match(finalMarkdown, /### Plan Mode Agent Case/);
    assert.match(finalMarkdown, /### Test Plan/);
    assert.equal(JSON.parse(finalSteps)[0].planStepId, 'step-001');
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
      requestPlanApproval: async () => [],
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
      contextBudget: createResolvedTestContextBudget(),
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
