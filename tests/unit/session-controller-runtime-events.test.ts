import * as assert from 'node:assert/strict';
import { createRuntimeState, type SessionRuntimeState } from '../../src/web/client/app-shell-types.js';
import {
  applyAssistantMessageDeltaRuntimeEvent,
  applyMemoryTriggerRuntimeEvent,
  applySkillTriggerRuntimeEvent,
  applyStepRuntimeEvent,
  applyThinkingRuntimeEvent,
  applyToolCallRuntimeEvent,
  applyToolResultRuntimeEvent,
} from '../../src/web/client/hooks/session-controller-runtime-events.js';

function activeRuntime(overrides: Partial<SessionRuntimeState> = {}): SessionRuntimeState {
  return {
    ...createRuntimeState(),
    runId: 'run-1',
    isRunning: true,
    runStartedAt: 100,
    lastActivityAt: 100,
    ...overrides,
  };
}

function testStepEventUpdatesProgressAndPreservesStaleRun(): void {
  const runtime = activeRuntime();
  const next = applyStepRuntimeEvent({
    runtime,
    runId: 'run-1',
    step: 2,
    maxSteps: 5,
    now: 200,
    processingTitle: 'Processing',
    stepTitle: 'Step 2/5',
    modelTitle: 'Using model-a',
    createEventId: () => 'evt-step',
  });

  assert.equal(next.currentStep, 2);
  assert.equal(next.maxSteps, 5);
  assert.deepEqual(next.liveEvents, [
    {
      id: 'evt-step',
      type: 'run_status',
      title: 'Step 2/5',
      summary: 'Using model-a',
      timestamp: 200,
    },
  ]);
  assert.equal(
    applyStepRuntimeEvent({
      runtime,
      runId: 'run-stale',
      now: 300,
      processingTitle: 'Processing',
      stepTitle: 'Step',
      createEventId: () => 'evt-stale',
    }),
    runtime
  );
}

function testThinkingEventAppendsThenCoalescesStreamingDelta(): void {
  const first = applyThinkingRuntimeEvent({
    runtime: activeRuntime(),
    runId: 'run-1',
    thinking: 'plan',
    timestamp: 200,
    createEventId: () => 'evt-thinking',
  });
  const second = applyThinkingRuntimeEvent({
    runtime: first,
    runId: 'run-1',
    thinking: ' next',
    timestamp: 250,
    createEventId: () => 'evt-new',
  });

  assert.deepEqual(second.liveEvents, [
    {
      id: 'evt-thinking',
      type: 'thinking',
      thinking: 'plan next',
      isStreaming: true,
      timestamp: 250,
    },
  ]);
  assert.equal(second.lastActivityAt, 250);
}

function testToolCallAndResultUpdateAccumulators(): void {
  const afterCall = applyToolCallRuntimeEvent({
    runtime: activeRuntime({
      liveEvents: [
        {
          id: 'evt-thinking',
          type: 'thinking',
          thinking: 'checking',
          isStreaming: true,
          timestamp: 100,
        },
      ],
    }),
    runId: 'run-1',
    name: 'read_file',
    args: { path: 'README.md' },
    toolCallId: 'call-1',
    timestamp: 200,
    createEventId: () => 'evt-call',
  });

  assert.deepEqual(afterCall.toolCallsAccumulator, [
    {
      toolCallId: 'call-1',
      name: 'read_file',
      args: { path: 'README.md' },
    },
  ]);
  assert.equal(afterCall.liveEvents[0]?.type, 'thinking');
  assert.equal(afterCall.liveEvents[0]?.isStreaming, false);
  assert.deepEqual(afterCall.liveEvents[1], {
    id: 'evt-call',
    type: 'tool_call',
    toolCallId: 'call-1',
    name: 'read_file',
    args: { path: 'README.md' },
    timestamp: 200,
  });

  const afterResult = applyToolResultRuntimeEvent({
    runtime: afterCall,
    runId: 'run-1',
    name: 'read_file',
    result: { success: true, content: 'ok' },
    timestamp: 300,
    createEventId: () => 'evt-result',
  });
  assert.deepEqual(afterResult.toolResultsAccumulator, [
    {
      name: 'read_file',
      result: { success: true, content: 'ok' },
    },
  ]);
  assert.deepEqual(afterResult.liveEvents.at(-1), {
    id: 'evt-result',
    type: 'tool_result',
    name: 'read_file',
    result: { success: true, content: 'ok' },
    timestamp: 300,
  });

  const hiddenSendFileResult = applyToolResultRuntimeEvent({
    runtime: afterResult,
    runId: 'run-1',
    name: 'send_file_to_user',
    result: { success: true, content: 'download' },
    timestamp: 400,
    createEventId: () => 'evt-hidden',
  });
  assert.equal(hiddenSendFileResult.liveEvents.some((event) => event.id === 'evt-hidden'), false);
  assert.equal(hiddenSendFileResult.toolResultsAccumulator.length, 2);
}

function testAssistantDeltaAppendsTextAndRuntime(): void {
  const first = applyAssistantMessageDeltaRuntimeEvent({
    runtime: activeRuntime(),
    runId: 'run-1',
    content: 'Hel',
    timestamp: 200,
    llmRuntime: { providerProfileId: 'p1', provider: 'openai', model: 'gpt-x' },
    createEventId: () => 'evt-text',
  });
  const second = applyAssistantMessageDeltaRuntimeEvent({
    runtime: first,
    runId: 'run-1',
    content: 'lo',
    timestamp: 250,
    createEventId: () => 'evt-text-2',
  });

  assert.equal(second.contentAccumulator, 'Hello');
  assert.deepEqual(second.currentLlmRuntime, { providerProfileId: 'p1', provider: 'openai', model: 'gpt-x' });
  assert.deepEqual(second.liveEvents, [
    {
      id: 'evt-text',
      type: 'text',
      content: 'Hello',
      llmRuntime: { providerProfileId: 'p1', provider: 'openai', model: 'gpt-x' },
      timestamp: 250,
    },
  ]);
}

function testMemoryAndSkillTriggersCloseThinkingAndSummarize(): void {
  const runtime = activeRuntime({
    liveEvents: [
      {
        id: 'evt-thinking',
        type: 'thinking',
        thinking: 'working',
        isStreaming: true,
        timestamp: 100,
      },
    ],
  });
  const memory = applyMemoryTriggerRuntimeEvent({
    runtime,
    runId: 'run-1',
    title: 'Project',
    content: 'important note',
    liveTitle: 'Memory',
    timestamp: 200,
    createEventId: () => 'evt-memory',
  });
  assert.equal(memory.liveEvents[0]?.type, 'thinking');
  assert.equal(memory.liveEvents[0]?.isStreaming, false);
  assert.deepEqual(memory.liveEvents[1], {
    id: 'evt-memory',
    type: 'memory_trigger',
    title: 'Memory',
    summary: 'Project: important note',
    timestamp: 200,
  });

  const skill = applySkillTriggerRuntimeEvent({
    runtime: memory,
    runId: 'run-1',
    name: 'writer',
    action: 'update',
    version: '2',
    liveTitle: 'Skill',
    timestamp: 250,
    createEventId: () => 'evt-skill',
  });
  assert.deepEqual(skill.liveEvents.at(-1), {
    id: 'evt-skill',
    type: 'skill_trigger',
    title: 'Skill',
    summary: 'update writer: v2',
    timestamp: 250,
  });
}

testStepEventUpdatesProgressAndPreservesStaleRun();
testThinkingEventAppendsThenCoalescesStreamingDelta();
testToolCallAndResultUpdateAccumulators();
testAssistantDeltaAppendsTextAndRuntime();
testMemoryAndSkillTriggersCloseThinkingAndSummarize();

console.log('session-controller-runtime-events tests passed');
