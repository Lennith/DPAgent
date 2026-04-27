import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import {
  FinalizePlanTool,
  RequestUserInputTool,
  UpdatePlanTool,
} from '../../src/tools/PlanModeTools.js';
import type { ContextRef, PlanInputAnswer } from '../../src/types.js';

function createHarness(): {
  tempDir: string;
  context: ContextRef;
  contextManager: ContextManager;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-mode-tools-test-'));
  const eventStore = new ContextEventStore(path.join(tempDir, 'contexts'));
  const contextManager = new ContextManager(eventStore);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'plan-mode-test',
  };
  return { tempDir, context, contextManager };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function testUpdatePlanValidationAndPersistence(): Promise<void> {
  const harness = createHarness();
  try {
    const tool = new UpdatePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
    });

    const emptyPlan = await tool.execute({ plan: [] });
    assert.equal(emptyPlan.success, false);
    assert.match(emptyPlan.error ?? '', /at least one step/i);

    const multiInProgress = await tool.execute({
      plan: [
        { step: 'a', status: 'in_progress' },
        { step: 'b', status: 'in_progress' },
      ],
    });
    assert.equal(multiInProgress.success, false);
    assert.match(multiInProgress.error ?? '', /at most one in_progress/i);

    const valid = await tool.execute({
      explanation: 'initial planning',
      plan: [
        { step: 'scope work', status: 'completed' },
        { step: 'implement tools', status: 'in_progress' },
      ],
    });
    assert.equal(valid.success, true);
    const projection = harness.contextManager.getProjection(harness.context);
    const currentPlanRaw = projection.keyValues['plan_mode.current_plan'];
    assert.ok(currentPlanRaw);
    const currentPlan = JSON.parse(currentPlanRaw);
    assert.equal(currentPlan.plan.length, 2);
    assert.equal(currentPlan.explanation, 'initial planning');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testRequestUserInputValidationAndCallback(): Promise<void> {
  const harness = createHarness();
  try {
    const capturedRequests: string[] = [];
    const expectedAnswers: PlanInputAnswer[] = [
      {
        id: 'depth',
        selectedLabel: 'Full',
        selectedIndex: 0,
        freeText: 'Need complete UX flow',
      },
    ];
    const tool = new RequestUserInputTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
      requestUserInput: async (request) => {
        capturedRequests.push(request.requestId);
        const firstQuestion = request.questions[0];
        if ((firstQuestion?.options.length ?? 0) === 0) {
          return [
            {
              id: firstQuestion.id,
              selectedLabel: '',
              selectedIndex: -1,
              freeText: 'Free-text only answer',
            },
          ];
        }
        return expectedAnswers;
      },
    });

    const invalid = await tool.execute({ questions: [] });
    assert.equal(invalid.success, false);
    assert.match(invalid.error ?? '', /1 to 3/i);

    const valid = await tool.execute({
      questions: [
        {
          header: 'Depth',
          id: 'depth',
          question: 'Which depth should we implement?',
          options: [
            { label: 'Full', description: 'Complete implementation' },
            { label: 'Lite', description: 'Only backend tool stubs' },
          ],
        },
      ],
    });
    assert.equal(valid.success, true);
    assert.equal(capturedRequests.length, 1);
    const payload = JSON.parse(valid.content);
    assert.equal(payload.answers.length, 1);
    assert.equal(payload.answers[0].selectedLabel, 'Full');

    const singleOption = await tool.execute({
      questions: [
        {
          header: 'Depth',
          id: 'depth',
          question: 'Pick one option or write your own answer',
          options: [{ label: 'Full', description: 'Complete implementation' }],
        },
      ],
    });
    assert.equal(singleOption.success, true);

    const zeroOption = await tool.execute({
      questions: [
        {
          header: 'Depth',
          id: 'depth_free_text',
          question: 'Describe implementation depth in your own words',
          options: [],
        },
      ],
    });
    assert.equal(zeroOption.success, true);
    const freeTextPayload = JSON.parse(zeroOption.content);
    assert.equal(freeTextPayload.answers.length, 1);
    assert.equal(freeTextPayload.answers[0].selectedIndex, -1);
    assert.equal(freeTextPayload.answers[0].selectedLabel, '');
    assert.equal(freeTextPayload.answers[0].freeText, 'Free-text only answer');
    assert.equal(capturedRequests.length, 3);

    const noCallbackTool = new RequestUserInputTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
    });
    const noCallback = await noCallbackTool.execute({
      questions: [
        {
          header: 'Depth',
          id: 'depth',
          question: 'Which depth should we implement?',
          options: [
            { label: 'Full', description: 'Complete implementation' },
            { label: 'Lite', description: 'Only backend tool stubs' },
          ],
        },
      ],
    });
    assert.equal(noCallback.success, false);
    assert.match(noCallback.error ?? '', /callback is not available/i);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testFinalizePlanOutputAndPersistence(): Promise<void> {
  const harness = createHarness();
  try {
    const tool = new FinalizePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
    });

    const result = await tool.execute({
      title: 'Plan Mode Rollout',
      summary: 'Implement full plan mode toolchain and interaction flow.',
      key_changes: ['Add three plan mode tools', 'Wire websocket request/response loop'],
      test_plan: ['Unit test tools', 'Integration test websocket flow'],
      assumptions: ['Default enabled', 'Main agent only'],
    });

    assert.equal(result.success, true);
    assert.match(result.content, /### Plan Mode Rollout/);
    assert.match(result.content, /### Summary/);
    assert.match(result.content, /### Test Plan/);

    const projection = harness.contextManager.getProjection(harness.context);
    assert.equal(projection.keyValues['plan_mode.final_plan_markdown'], result.content);
    const finalSnapshotRaw = projection.keyValues['plan_mode.final_plan_snapshot'];
    assert.ok(finalSnapshotRaw);
    const finalSnapshot = JSON.parse(finalSnapshotRaw);
    assert.equal(finalSnapshot.title, 'Plan Mode Rollout');
    assert.equal(finalSnapshot.markdown, result.content);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testUpdatePlanValidationAndPersistence();
  await testRequestUserInputValidationAndCallback();
  await testFinalizePlanOutputAndPersistence();
  console.log('plan-mode-tools tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
