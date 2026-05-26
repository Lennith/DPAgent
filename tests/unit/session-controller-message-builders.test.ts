import * as assert from 'node:assert/strict';
import {
  buildCancelRunMessage,
  buildChatMessage,
  buildPlanInputResponseMessage,
  buildRunningInputCancelMessage,
  buildRunningInputEnqueueMessage,
  buildRunningInputInsertMessage,
  createRunningInputClientRequestId,
} from '../../src/web/client/hooks/session-controller-message-builders.js';
import type { SessionLlmSelectionView } from '../../src/web/client/app-shell-types.js';

function testRunningInputRequestIdIsStableForInjectedEntropy(): void {
  assert.equal(createRunningInputClientRequestId(123456, 0.5), 'rin-client-2n9c-8');
}

function testRunningInputEnqueueShapePreservesOptionalFields(): void {
  assert.deepEqual(
    buildRunningInputEnqueueMessage({
      sessionId: 'sess-1',
      prompt: 'continue',
      clientRequestId: 'client-1',
      selectedAgentName: 'assistant',
      fileReferences: ['D:\\repo\\README.md'],
    }),
    {
      type: 'running_input_enqueue',
      data: {
        prompt: 'continue',
        clientRequestId: 'client-1',
        selectedAgentName: 'assistant',
        fileReferences: ['D:\\repo\\README.md'],
        context: { scope: 'session', namespace: 'sess-1' },
        sessionId: 'sess-1',
      },
    }
  );
}

function testChatMessageShapeOmitsEmptyOptionalCollections(): void {
  const selection: SessionLlmSelectionView = {
    profileId: 'openai-alt',
    model: 'gpt-4.1-mini',
    reasoningPreset: 'low',
    updatedAt: '2026-05-17T00:00:00.000Z',
  };
  assert.deepEqual(
    buildChatMessage({
      sessionId: 'sess-1',
      prompt: 'hello',
      clientMessageId: 'msg-1',
      workspaceDir: 'D:\\repo',
      selectedAgentName: 'assistant',
      planningAction: 'enter_drafting',
      fileReferences: [],
      llmSelection: selection,
    }),
    {
      type: 'chat',
      data: {
        clientKind: 'web',
        prompt: 'hello',
        clientMessageId: 'msg-1',
        selectedAgentName: 'assistant',
        planningAction: 'enter_drafting',
        llmSelection: selection,
        workspaceDir: 'D:\\repo',
        context: { scope: 'session', namespace: 'sess-1' },
      },
    }
  );
}

function testControlMessageShapes(): void {
  assert.deepEqual(buildCancelRunMessage('sess-1', 'run-1'), {
    type: 'cancel',
    data: {
      runId: 'run-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });
  assert.deepEqual(buildRunningInputInsertMessage({ sessionId: 'sess-1', runId: 'run-1', itemId: 'rin-1' }), {
    type: 'running_input_insert',
    data: {
      itemId: 'rin-1',
      runId: 'run-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });
  assert.deepEqual(buildRunningInputCancelMessage('sess-1', 'rin-1'), {
    type: 'running_input_cancel',
    data: {
      itemId: 'rin-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });
  assert.deepEqual(
    buildPlanInputResponseMessage({
      runId: 'run-1',
      context: { scope: 'session', namespace: 'sess-1' },
      requestId: 'req-1',
      answers: [{ id: 'q1', selectedLabel: 'Yes', selectedIndex: 0 }],
    }),
    {
      type: 'plan_input_response',
      data: {
        runId: 'run-1',
        context: { scope: 'session', namespace: 'sess-1' },
        requestId: 'req-1',
        answers: [{ id: 'q1', selectedLabel: 'Yes', selectedIndex: 0 }],
      },
    }
  );
}

testRunningInputRequestIdIsStableForInjectedEntropy();
testRunningInputEnqueueShapePreservesOptionalFields();
testChatMessageShapeOmitsEmptyOptionalCollections();
testControlMessageShapes();

console.log('session-controller-message-builders tests passed');
