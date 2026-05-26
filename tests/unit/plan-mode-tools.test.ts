import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import {
  createPlanModeTools,
  FinalizePlanTool,
  RequestUserInputTool,
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

async function testCreatePlanModeToolsOmitsUpdatePlan(): Promise<void> {
  const harness = createHarness();
  try {
    const tools = createPlanModeTools({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
    });
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(names, ['request_user_input', 'finalize_plan']);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testRequestUserInputValidationAndCallback(): Promise<void> {
  const harness = createHarness();
  try {
    const capturedRequests: Array<{ requestId: string; turnId?: string }> = [];
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
      resolveActiveTurnId: () => 'turn-plan-input',
      requestUserInput: async (request) => {
        capturedRequests.push({ requestId: request.requestId, turnId: request.turnId });
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
    assert.equal(capturedRequests[0]?.turnId, 'turn-plan-input');
    const payload = JSON.parse(valid.content);
    assert.equal(payload.answers.length, 1);
    assert.equal(payload.answers[0].selectedLabel, 'Full');
    assert.equal(payload.executionContinuation, undefined);
    assert.match(payload.systemHint, /continue asking/i);
    assert.match(payload.systemHint, /contradict/i);
    assert.match(payload.systemHint, /request_user_input/i);

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
    const approvalRequests: Array<{
      requestId: string;
      source?: string;
      turnId?: string;
      planPreview?: unknown;
    }> = [];
    const tool = new FinalizePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
      requestPlanApproval: async (request) => {
        approvalRequests.push({
          requestId: request.requestId,
          source: request.source,
          turnId: request.turnId,
          planPreview: (request as { planPreview?: unknown }).planPreview,
        });
        return [
          {
            id: 'plan_execution_approval',
            selectedLabel: 'Approve execution',
            selectedIndex: 0,
          },
        ];
      },
    });

    const result = await tool.execute({
      title: 'Plan Mode Rollout',
      summary: 'Implement full plan mode toolchain and interaction flow.',
      steps: [
        {
          work: 'Replace plan-step update tool with final plan freezing.',
          detection_standard: 'Tool registry exposes finalize_plan and request_user_input only while drafting.',
          priority: 'high',
          tags: ['plan-mode'],
        },
        {
          work: 'Convert approved plan steps into session todos.',
          detection_standard: 'Approved session has todos bound to plan_step_id and planId.',
        },
      ],
      test_plan: ['Unit test tools', 'Integration test websocket flow'],
      assumptions: ['Default enabled', 'Main agent only'],
    });

    assert.equal(result.success, true);
    assert.equal(approvalRequests.length, 1);
    assert.equal(approvalRequests[0]?.source, 'finalize_plan_approval');
    const output = JSON.parse(result.content);
    assert.equal(output.ok, true);
    assert.equal(output.decision, 'approved');
    assert.equal(output.executionContinuation, 'approved_new_turn');
    assert.match(output.message, /end the current planning turn/i);
    assert.match(output.markdown, /### Plan Mode Rollout/);
    assert.match(output.markdown, /### Summary/);
    assert.match(output.markdown, /### Implementation Steps/);
    assert.match(output.markdown, /detection_standard/i);
    assert.match(output.markdown, /### Test Plan/);

    const projection = harness.contextManager.getProjection(harness.context);
    assert.equal(projection.keyValues['plan_mode.final_plan_markdown'], output.markdown);
    const finalSnapshotRaw = projection.keyValues['plan_mode.final_plan_snapshot'];
    assert.ok(finalSnapshotRaw);
    const finalSnapshot = JSON.parse(finalSnapshotRaw);
    assert.match(finalSnapshot.planId, /^plan-/);
    assert.equal(typeof finalSnapshot.updatedAt, 'string');
    assert.equal(finalSnapshot.title, 'Plan Mode Rollout');
    assert.equal(finalSnapshot.markdown, output.markdown);
    const planPreview = approvalRequests[0]?.planPreview as { title?: string; markdown?: string; steps?: unknown[] } | undefined;
    assert.ok(planPreview);
    assert.equal(planPreview.title, finalSnapshot.title);
    assert.equal(planPreview.markdown, finalSnapshot.markdown);
    assert.deepEqual(planPreview.steps, finalSnapshot.steps);
    assert.equal(finalSnapshot.steps.length, 2);
    assert.equal(finalSnapshot.steps[0].planStepId, 'step-001');
    assert.equal(finalSnapshot.steps[0].detectionStandard, 'Tool registry exposes finalize_plan and request_user_input only while drafting.');
    assert.equal(finalSnapshot.steps[0].priority, 'high');
    assert.deepEqual(finalSnapshot.steps[0].tags, ['plan-mode']);
    assert.equal(projection.keyValues['plan_mode.pending_plan_id'], finalSnapshot.planId);
    assert.deepEqual(JSON.parse(projection.keyValues['plan_mode.final_plan_steps']), finalSnapshot.steps);
    assert.equal(
      JSON.parse(projection.keyValues[`plan_mode.plans.${finalSnapshot.planId}`]).markdown,
      output.markdown
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testFinalizePlanReviseKeepsDraftingContract(): Promise<void> {
  const harness = createHarness();
  try {
    const tool = new FinalizePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => 'turn-revise',
      requestPlanApproval: async () => [
        {
          id: 'plan_execution_approval',
          selectedLabel: 'Request changes',
          selectedIndex: 1,
          freeText: 'Add a rollback step before execution.',
        },
      ],
    });

    const result = await tool.execute({
      title: 'Needs Revision',
      steps: [
        {
          work: 'Implement first pass.',
          detection_standard: 'First pass can be verified.',
        },
      ],
    });

    assert.equal(result.success, true);
    const output = JSON.parse(result.content);
    assert.equal(output.decision, 'revise');
    assert.equal(output.executionContinuation, undefined);
    assert.match(output.feedback, /rollback step/i);
    assert.match(output.message, /revise the plan/i);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testFinalizePlanRequiresStructuredSteps(): Promise<void> {
  const harness = createHarness();
  try {
    const tool = new FinalizePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => null,
    });

    const missingSteps = await tool.execute({
      title: 'Invalid',
      summary: 'Missing steps.',
    });
    assert.equal(missingSteps.success, false);
    assert.match(missingSteps.error ?? '', /steps must be a non-empty array/i);

    const missingWork = await tool.execute({
      title: 'Invalid',
      steps: [{ detection_standard: 'Verify something.' }],
    });
    assert.equal(missingWork.success, false);
    assert.match(missingWork.error ?? '', /steps\[0\]\.work is required/i);

    const missingDetectionStandard = await tool.execute({
      title: 'Invalid',
      steps: [{ work: 'Do something.' }],
    });
    assert.equal(missingDetectionStandard.success, false);
    assert.match(missingDetectionStandard.error ?? '', /steps\[0\]\.detection_standard is required/i);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testFinalizePlanKeepsLatestPendingPlanAuthoritative(): Promise<void> {
  const harness = createHarness();
  try {
    const turn = harness.contextManager.beginTurn(harness.context, 'draft plan in active turn');
    const tool = new FinalizePlanTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.context,
      resolveActiveTurnId: () => turn.turnId,
      requestPlanApproval: async () => [
        {
          id: 'plan_execution_approval',
          selectedLabel: 'Request changes',
          selectedIndex: 1,
          freeText: 'Continue drafting.',
        },
      ],
    });

    const first = await tool.execute({
      title: 'Initial Plan',
      summary: 'First candidate plan.',
      steps: [
        {
          work: 'Prepare draft',
          detection_standard: 'Draft has been reviewed.',
        },
      ],
      test_plan: ['Review draft'],
    });
    const firstSnapshot = JSON.parse(
      String(
        harness.contextManager.inspectKey(harness.context, 'plan_mode.final_plan_snapshot', {
          turnId: turn.turnId,
          includePending: true,
        }).value
      )
    );
    const second = await tool.execute({
      title: 'Revised Plan',
      summary: 'Second candidate plan.',
      steps: [
        {
          work: 'Prepare revised draft',
          detection_standard: 'Revised draft has been reviewed.',
        },
      ],
      test_plan: ['Review revised draft'],
    });
    const finalSnapshotState = harness.contextManager.inspectKey(harness.context, 'plan_mode.final_plan_snapshot', {
      turnId: turn.turnId,
      includePending: true,
    });
    const secondSnapshot = JSON.parse(String(finalSnapshotState.value));

    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.notEqual(firstSnapshot.planId, secondSnapshot.planId);
    assert.equal(finalSnapshotState.sourceStatus, 'pending_override');
    assert.equal(
      harness.contextManager.inspectKey(harness.context, 'plan_mode.pending_plan_id', {
        turnId: turn.turnId,
        includePending: true,
      }).sourceStatus,
      'pending_override'
    );
    assert.equal(
      harness.contextManager.inspectKey(harness.context, 'plan_mode.pending_plan_id', {
        turnId: turn.turnId,
        includePending: true,
      }).value,
      secondSnapshot.planId
    );
    assert.equal(
      JSON.parse(
        String(
          harness.contextManager.inspectKey(harness.context, 'plan_mode.final_plan_steps', {
            turnId: turn.turnId,
            includePending: true,
          }).value
        )
      )[0].work,
      'Prepare revised draft'
    );
    assert.equal(
      JSON.parse(
        String(
          harness.contextManager.inspectKey(harness.context, `plan_mode.plans.${firstSnapshot.planId}`, {
            turnId: turn.turnId,
            includePending: true,
          }).value
        )
      ).markdown,
      JSON.parse(first.content).markdown
    );
    assert.equal(
      JSON.parse(
        String(
          harness.contextManager.inspectKey(harness.context, `plan_mode.plans.${secondSnapshot.planId}`, {
            turnId: turn.turnId,
            includePending: true,
          }).value
        )
      ).markdown,
      JSON.parse(second.content).markdown
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testCreatePlanModeToolsOmitsUpdatePlan();
  await testRequestUserInputValidationAndCallback();
  await testFinalizePlanRequiresStructuredSteps();
  await testFinalizePlanOutputAndPersistence();
  await testFinalizePlanReviseKeepsDraftingContract();
  await testFinalizePlanKeepsLatestPendingPlanAuthoritative();
  console.log('plan-mode-tools tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
