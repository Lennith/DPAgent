import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent/index.js';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import type { LLMClient } from '../../src/llm/index.js';
import { TodoStore } from '../../src/todo/TodoStore.js';
import { createPlanModeTools, ToolRegistry } from '../../src/tools/index.js';
import type { ContextNamespaceMeta, ContextRef, Message, PlanInputAnswer, PlanInputRequest } from '../../src/types.js';
import { WebServer } from '../../src/web/server/WebServer.js';
import { createResolvedTestContextBudget } from '../unit/test-context-budget.js';

type FakeToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type FakeStep = {
  content: string;
  finishReason: string;
  toolCalls?: FakeToolCall[];
};

class FakeLLMClient {
  private index = 0;

  constructor(private readonly steps: FakeStep[]) {}

  get callCount(): number {
    return this.index;
  }

  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    }
  ) {
    const step = this.steps[this.index];
    if (!step) {
      throw new Error(`FakeLLMClient out of scripted steps at index ${this.index}`);
    }
    this.index += 1;
    if (step.content) {
      callbacks.onText?.(step.content);
    }
    for (const call of step.toolCalls ?? []) {
      callbacks.onToolUse?.(call.id, call.name, call.input);
    }
    callbacks.onComplete?.(step);
    return {
      content: step.content,
      finishReason: step.finishReason,
      toolCalls: (step.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.input },
      })),
    };
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<FakeLLMClient['generateWithCallbacks']>
  ): ReturnType<FakeLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

function createTempHarness(): {
  tempDir: string;
  workspaceDir: string;
  context: ContextRef;
  contextManager: ContextManager;
  todoStore: TodoStore;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-mode-lifecycle-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
  const todoStore = new TodoStore(path.join(tempDir, 'todos'));
  return {
    tempDir,
    workspaceDir,
    context: { scope: 'session', namespace: 'release-plan-session' },
    contextManager,
    todoStore,
  };
}

async function draftAndApprovePlan(input: {
  context: ContextRef;
  contextManager: ContextManager;
  workspaceDir: string;
}): Promise<{ capturedRequests: PlanInputRequest[]; llm: FakeLLMClient }> {
  const capturedRequests: PlanInputRequest[] = [];
  const registry = new ToolRegistry();
  const tools = createPlanModeTools({
    contextManager: input.contextManager,
    resolveActiveContext: () => input.context,
    resolveActiveTurnId: () => 'turn-release-plan',
    requestUserInput: async (request) => {
      capturedRequests.push(request);
      return [
        {
          id: 'scope',
          selectedLabel: 'Full release gate',
          selectedIndex: 0,
          freeText: 'Include lifecycle, UX, and CLI release checks.',
        },
      ];
    },
    requestPlanApproval: async (request) => {
      capturedRequests.push(request);
      return [
        {
          id: 'plan_execution_approval',
          selectedLabel: 'Approve execution',
          selectedIndex: 0,
        },
      ];
    },
  });
  for (const tool of tools) {
    registry.register(tool);
  }

  const llm = new FakeLLMClient([
    {
      content: 'Need release-gate scope confirmation.',
      finishReason: 'tool_use',
      toolCalls: [
        {
          id: 'tool-request-scope',
          name: 'request_user_input',
          input: {
            questions: [
              {
                header: 'Scope',
                id: 'scope',
                question: 'Which release gate scope should be executed?',
                options: [
                  { label: 'Full release gate', description: 'Lifecycle, UX, CLI, and long-session coverage.' },
                  { label: 'Tool protocol only', description: 'Only the existing protocol regression gate.' },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      content: 'Finalize the release-gate plan.',
      finishReason: 'tool_use',
      toolCalls: [
        {
          id: 'tool-finalize-release-plan',
          name: 'finalize_plan',
          input: {
            title: 'Release Gate Strengthening',
            summary: 'Add release E2E coverage for Plan Mode, CLI isolation, and long conversations.',
            steps: [
              {
                work: 'Validate Plan Mode draft, approval, and execution activation.',
                detection_standard: 'Approved finalized plan creates plan-bound todos and enters plan_executing.',
                priority: 'high',
                tags: ['plan-mode', 'release'],
              },
              {
                work: 'Validate todo-constrained execution completion.',
                detection_standard: 'Plan execution returns to normal only after all plan-bound todos are completed.',
                priority: 'high',
                tags: ['todo-loop', 'release'],
              },
            ],
            test_plan: ['Plan lifecycle E2E', 'CLI and UX release E2E'],
            assumptions: ['CLI interface remains wire-compatible'],
          },
        },
      ],
    },
    {
      content: 'This step must not run after approval.',
      finishReason: 'end_turn',
    },
  ]);

  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: registry,
    systemPrompt: 'You are validating release Plan Mode behavior.',
    maxSteps: 10,
    tokenLimit: 80000,
    contextBudget: createResolvedTestContextBudget(),
    workspaceDir: input.workspaceDir,
  });

  const result = await agent.runWithResult(
    'Release plan lifecycle E2E: draft a plan, ask for scope, finalize it, then wait for execution approval.',
    input.context.namespace
  );

  assert.equal(result.content, 'Plan approved. Execution will continue in a new turn.');
  assert.equal(result.finishReason, 'end_turn');
  assert.equal(llm.callCount, 2, 'approved finalize_plan must end the drafting turn');
  assert.equal(capturedRequests[0]?.source, 'request_user_input');
  assert.equal(capturedRequests[1]?.source, 'finalize_plan_approval');
  return { capturedRequests, llm };
}

function createActivationServer(input: {
  context: ContextRef;
  contextManager: ContextManager;
  workspaceDir: string;
  todoStore: TodoStore;
}): { server: any; getMeta: () => ContextNamespaceMeta } {
  let meta: ContextNamespaceMeta = {
    workspaceDir: input.workspaceDir,
    planningState: {
      state: 'plan_drafting',
      updatedAt: '2026-05-03T00:00:00.000Z',
    } as ContextNamespaceMeta['planningState'],
  };
  const projection = input.contextManager.getProjection(input.context);
  const fakeContextManager = {
    inspectKey: (_context: ContextRef, key: string) => ({
      found: key in projection.keyValues,
      value: projection.keyValues[key],
      sourceStatus: 'pending_override',
    }),
    getProjection: () => projection,
  };
  const fakeAgent = {
    getConfig: () => ({
      agent: {
        workspaceDir: input.workspaceDir,
        globalAgentsDir: path.join(input.workspaceDir, 'agents'),
      },
    }),
    getContextManager: () => fakeContextManager,
    getContextNamespaceMeta: () => meta,
    updateContextNamespaceMeta: (_context: ContextRef, patch: Partial<ContextNamespaceMeta>) => {
      meta = {
        ...meta,
        ...patch,
      };
    },
    getTodoStore: () => input.todoStore,
  };
  const server = Object.create(WebServer.prototype) as any;
  server.agent = fakeAgent;
  server.sessionRuntimes = new Map();
  return { server, getMeta: () => meta };
}

function approveAndExecutePlan(input: {
  server: any;
  context: ContextRef;
  request: PlanInputRequest;
  todoStore: TodoStore;
  workspaceDir: string;
  getMeta: () => ContextNamespaceMeta;
}): void {
  const revision = input.server.activatePendingPlanIfApprovalSelected(input.context, input.request, [
    {
      id: 'plan_execution_approval',
      selectedLabel: 'Request changes',
      selectedIndex: 1,
      freeText: 'Add CLI isolation evidence.',
    },
  ] as PlanInputAnswer[]);
  assert.deepEqual(revision, {
    approved: false,
    activated: false,
    reason: 'approval_option_not_selected',
  });
  assert.equal(input.getMeta().planningState?.state, 'plan_drafting');

  const approval = input.server.activatePendingPlanIfApprovalSelected(input.context, input.request, [
    {
      id: 'plan_execution_approval',
      selectedLabel: 'Approve execution',
      selectedIndex: 0,
    },
  ] as PlanInputAnswer[]);
  assert.equal(approval.approved, true);
  assert.equal(approval.activated, true);
  assert.ok(approval.planId);
  assert.equal(input.getMeta().planningState?.state, 'plan_executing');
  assert.equal(input.getMeta().planningState?.activeExecutionPlanId, approval.planId);

  input.server.ensureTodoDrivenAutoLoop(input.context.namespace, input.workspaceDir);
  let protocol = input.todoStore.getProtocolState({
    sessionId: input.context.namespace,
    workspaceDir: input.workspaceDir,
  });
  assert.equal(protocol.items.length, 2);
  assert.equal(protocol.hasUnfinished, true);
  assert.equal(input.getMeta().autoLoopConfig?.mode, 'todo');
  assert.equal(input.getMeta().autoLoopConfig?.enabled, true);

  const exitWhileUnfinished = input.server.requestAutoLoopExitFromCallback(
    input.context.namespace,
    input.context,
    'run-release-plan',
    'release-test'
  );
  assert.equal(exitWhileUnfinished.accepted, false);
  assert.match(exitWhileUnfinished.message, /todos remain unfinished/);

  for (const item of protocol.items) {
    const completed = input.todoStore.updateTodo(item.id, {
      sessionId: input.context.namespace,
      workspaceDir: input.workspaceDir,
      status: 'completed',
      completionTaskId: `release-e2e-${item.planStepId}`,
      evidence: [`${item.planStepId} completed under release lifecycle E2E`],
    });
    assert.equal(completed?.status, 'completed');
  }
  protocol = input.todoStore.getProtocolState({
    sessionId: input.context.namespace,
    workspaceDir: input.workspaceDir,
  });
  assert.equal(protocol.hasUnfinished, false);
  assert.equal(protocol.allCompleted, true);

  input.server.ensureTodoDrivenAutoLoop(input.context.namespace, input.workspaceDir);
  assert.equal(input.getMeta().planningState?.state, 'normal');
  assert.equal(input.getMeta().planningState?.activeExecutionPlanId, undefined);
  assert.equal(input.getMeta().lastPlanExecutionExit?.unfinishedTodoCount, 0);
}

async function main(): Promise<void> {
  const harness = createTempHarness();
  try {
    const { capturedRequests } = await draftAndApprovePlan(harness);
    const approvalRequest = capturedRequests.find((request) => request.source === 'finalize_plan_approval');
    assert.ok(approvalRequest, 'finalize_plan approval request should be captured');
    const projection = harness.contextManager.getProjection(harness.context);
    assert.ok(projection.keyValues['plan_mode.pending_plan_id']);
    assert.ok(projection.keyValues['plan_mode.final_plan_steps']);
    assert.ok(projection.keyValues['plan_mode.final_plan_markdown']);

    const activation = createActivationServer(harness);
    approveAndExecutePlan({
      server: activation.server,
      context: harness.context,
      request: approvalRequest,
      todoStore: harness.todoStore,
      workspaceDir: harness.workspaceDir,
      getMeta: activation.getMeta,
    });

    console.log('release-plan-mode-lifecycle e2e passed');
  } finally {
    fs.rmSync(harness.tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
