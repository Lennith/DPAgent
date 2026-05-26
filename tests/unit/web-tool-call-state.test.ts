import * as assert from 'node:assert/strict';
import {
  contextUtilizationFromPrecompressPayload,
  upsertToolCallState,
} from '../../src/web/client/app-shell-types.js';

function testUpgradesMatchingPlaceholderWhenNotLast(): void {
  const result = upsertToolCallState(
    [
      {
        id: 'evt-thinking',
        type: 'thinking',
        thinking: 'planning',
        timestamp: 1,
      },
      {
        id: 'evt-tool-1',
        type: 'tool_call',
        toolCallId: 'call_1',
        name: 'read_file',
        args: {},
        timestamp: 2,
      },
      {
        id: 'evt-tool-2',
        type: 'tool_call',
        toolCallId: 'call_2',
        name: 'list_directory',
        args: {},
        timestamp: 3,
      },
    ],
    [
      { toolCallId: 'call_1', name: 'read_file', args: {} },
      { toolCallId: 'call_2', name: 'list_directory', args: {} },
    ],
    {
      toolCallId: 'call_1',
      name: 'read_file',
      args: { path: '/tmp/a.txt' },
      timestamp: 9,
      createEventId: () => 'evt-new',
    }
  );

  assert.equal(result.liveEvents.length, 3);
  assert.equal(result.liveEvents.some((event) => event.id === 'evt-new'), false);
  assert.deepEqual(result.liveEvents[1], {
    id: 'evt-tool-1',
    type: 'tool_call',
    toolCallId: 'call_1',
    name: 'read_file',
    args: { path: '/tmp/a.txt' },
    timestamp: 9,
  });
  assert.deepEqual(result.toolCallsAccumulator, [
    { toolCallId: 'call_1', name: 'read_file', args: { path: '/tmp/a.txt' } },
    { toolCallId: 'call_2', name: 'list_directory', args: {} },
  ]);
}

function testUpdatesExistingToolCallWhenProviderReplaysArgs(): void {
  const result = upsertToolCallState(
    [
      {
        id: 'evt-tool-1',
        type: 'tool_call',
        toolCallId: 'call_1',
        name: 'read_file',
        args: { path: '/tmp/old.txt' },
        timestamp: 2,
      },
    ],
    [{ toolCallId: 'call_1', name: 'read_file', args: { path: '/tmp/old.txt' } }],
    {
      toolCallId: 'call_1',
      name: 'read_file',
      args: { path: '/tmp/new.txt' },
      timestamp: 5,
      createEventId: () => 'evt-new',
    }
  );

  assert.equal(result.liveEvents.length, 1);
  assert.deepEqual(result.liveEvents[0], {
    id: 'evt-tool-1',
    type: 'tool_call',
    toolCallId: 'call_1',
    name: 'read_file',
    args: { path: '/tmp/new.txt' },
    timestamp: 5,
  });
  assert.deepEqual(result.toolCallsAccumulator, [
    { toolCallId: 'call_1', name: 'read_file', args: { path: '/tmp/new.txt' } },
  ]);
}

function testAppendsWhenNoMatchingToolCallIdExists(): void {
  const result = upsertToolCallState(
    [],
    [],
    {
      toolCallId: 'call_9',
      name: 'list_directory',
      args: { path: '.' },
      timestamp: 4,
      createEventId: () => 'evt-new',
    }
  );

  assert.deepEqual(result.liveEvents, [
    {
      id: 'evt-new',
      type: 'tool_call',
      toolCallId: 'call_9',
      name: 'list_directory',
      args: { path: '.' },
      timestamp: 4,
    },
  ]);
  assert.deepEqual(result.toolCallsAccumulator, [
    {
      toolCallId: 'call_9',
      name: 'list_directory',
      args: { path: '.' },
    },
  ]);
}

function testContextUtilizationUsesTokensBeforeChars(): void {
  const utilization = contextUtilizationFromPrecompressPayload({
    ratio: 0.1,
    usedChars: 1000,
    limitChars: 10000,
    usedTokens: 900,
    limitTokens: 1000,
    source: 'provider_usage',
    anchorPromptTokens: 850,
    deltaEstimatedTokens: 50,
  });

  assert.deepEqual(utilization, {
    ratio: 0.9,
    usedChars: 1000,
    limitChars: 10000,
    usedTokens: 900,
    limitTokens: 1000,
    source: 'provider_usage',
    anchorPromptTokens: 850,
    deltaEstimatedTokens: 50,
    isWarning: true,
    initializing: false,
  });
}

function runAll(): void {
  testUpgradesMatchingPlaceholderWhenNotLast();
  testUpdatesExistingToolCallWhenProviderReplaysArgs();
  testAppendsWhenNoMatchingToolCallIdExists();
  testContextUtilizationUsesTokensBeforeChars();
  console.log('web-tool-call-state tests passed');
}

runAll();
