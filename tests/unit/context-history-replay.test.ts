import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DPAgent } from '../../src/index.js';
import { estimateMessageCharacters } from '../../src/llm/index.js';
import { ContextReplayAssembler, type ReplayRound } from '../../src/runtime/context-replay-assembly.js';
import { filterCommittedTurnMessages } from '../../src/runtime/dpagent-turn-messages.js';
import {
  buildInterruptedSideEffectSegment,
  buildSideEffectLedgerFromPreview,
  slicePreviewMessages,
} from '../../src/interrupted-turn-recovery.js';
import type { ContextRef, Message } from '../../src/types.js';
import {
  buildPromptWithAgentProfileReference,
  type AgentProfileReference,
} from '../../src/agents/AgentProfiles.js';
import {
  ScriptedLLMClient,
  appendTurn,
  cleanupHarness,
  createAgent,
  createHarness,
  messageToText,
} from './helpers/context-history-replay-harness.js';

class TransportResetAfterVisibleOutputLLMClient extends ScriptedLLMClient {
  public callCount = 0;

  constructor(
    private readonly visibleText: string,
    private readonly visibleThinking: string = ''
  ) {
    super([]);
  }

  async generateWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    const callbacks = args[1];
    this.callCount += 1;
    if (this.visibleThinking) {
      callbacks.onThinking?.(this.visibleThinking);
    }
    if (this.visibleText) {
      callbacks.onText?.(this.visibleText);
    }
    throw new Error('read ECONNRESET');
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

class TransportResetBeforeVisibleOutputLLMClient extends ScriptedLLMClient {
  public callCount = 0;

  constructor() {
    super([]);
  }

  async generateWithCallbacks(): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    this.callCount += 1;
    throw new Error('read ECONNRESET');
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }
}

function readDraftCheckpointStep(manager: ReturnType<DPAgent['getContextManager']>, context: ContextRef): number | undefined {
  const checkpointPath = path.join(
    manager.getEventStore().getNamespacePath(context),
    'interrupted-draft-checkpoints.jsonl'
  );
  if (!fs.existsSync(checkpointPath)) {
    return undefined;
  }
  let latest: number | undefined;
  for (const line of fs.readFileSync(checkpointPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { checkpoint?: { step?: unknown } };
      if (typeof parsed.checkpoint?.step === 'number') {
        latest = parsed.checkpoint.step;
      }
    } catch {
      // Direct JSONL assertions follow the production corrupt-tail recovery rule.
    }
  }
  return latest;
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const WORKSPACE_AGENT_PROFILE_REF: AgentProfileReference = {
  source: 'workspace',
  name: 'workspace',
  path: 'D:/Repo/AGENTS.md',
};

function workspaceAgentProfilePrompt(prompt: string): string {
  return buildPromptWithAgentProfileReference(prompt, WORKSPACE_AGENT_PROFILE_REF);
}

function testCancelledTurnDoesNotReplayAssistantOutput(): void {
  const harness = createHarness('cancelled');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'cancelled-replay',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'stop this run');
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'stop this run' },
        { role: 'assistant', content: 'Task cancelled by user.' },
      ],
      finalOutputText: 'Task cancelled by user.',
      finishReason: 'cancelled',
    });

    const messages = manager.getConversationMessages(context);
    assert.deepEqual(messages, [{ role: 'user', content: 'stop this run' }]);
    const projection = manager.getProjection(context);
    assert.equal(
      projection.recentTurns.some((item) => String(item.finalOutput ?? '').includes('Task cancelled')),
      false
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testWebTranscriptHasCreatedAtWithoutProviderReplayPollution(): void {
  const harness = createHarness('web-transcript-created-at');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'web-transcript-created-at',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'timestamp this');
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'timestamp this' },
        { role: 'assistant', content: 'done' },
      ],
      finalOutputText: 'done',
      finishReason: 'stop',
    });

    const providerMessages = manager.getConversationMessages(context);
    const webMessages = manager.getConversationMessagesWithTimestamps(context);

    assert.equal('createdAt' in (providerMessages[0] as Record<string, unknown>), false);
    assert.equal(typeof webMessages[0]?.createdAt, 'string');
    assert.equal(typeof webMessages[1]?.createdAt, 'string');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testInterruptedCheckpointTurnIsHiddenByDefaultButAvailableForReplay(): void {
  const harness = createHarness('interrupted-checkpoint');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-checkpoint',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'continue work');
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'continue work' },
        { role: 'assistant', content: 'saved checkpoint result' },
      ],
      finalOutputText: 'saved checkpoint result',
      finishReason: 'interrupted_checkpoint',
    });

    assert.deepEqual(manager.getConversationMessages(context), []);
    assert.deepEqual(manager.getConversationMessages(context, { includeInterruptedCheckpoints: true }), [
      { role: 'user', content: 'continue work' },
      { role: 'assistant', content: 'saved checkpoint result' },
    ]);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testInterruptedCheckpointToolBundleDoesNotInventTrailingAssistantOutput(): void {
  const harness = createHarness('interrupted-tool-bundle');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-tool-bundle',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'continue from tool checkpoint', harness.workspaceDir, {
      draftId: 'draft-1',
      runId: 'run-1',
      runFamilyId: 'family-1',
      maxSteps: 100,
    });
    const checkpointMessages: Message[] = [
      { role: 'user', content: 'continue from tool checkpoint' },
      {
        role: 'assistant',
        content: 'Calling read_file',
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'app_service.py' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"success":true,"content":"file content"}',
        toolCallId: 'tool-1',
        name: 'read_file',
      },
    ];
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:00:00.000Z',
      step: 55,
      messages: checkpointMessages,
    });
    manager.finalizeInterruptedTurn(turn.turnId, {
      terminalCode: 'error',
      maxSteps: 100,
      lastSafeStep: 55,
      errorSummary: 'read ECONNRESET',
      previewMessages: [],
      sideEffectLedger: [],
    });

    const replayMessages = manager.getConversationMessages(context, { includeInterruptedCheckpoints: true });
    assert.equal(replayMessages.length, 3);
    assert.equal(replayMessages[0]?.role, 'user');
    assert.equal(replayMessages[1]?.role, 'assistant');
    assert.equal(replayMessages[2]?.role, 'tool');
    assert.equal(replayMessages.some((message, index) => index > 2 && message.role === 'assistant'), false);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayCheckpointTruncatesPartialToolBundle(): void {
  const harness = createHarness('interrupted-partial-tool');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-partial-tool',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'partial tool checkpoint', harness.workspaceDir, {
      draftId: 'draft-2',
      runId: 'run-2',
      runFamilyId: 'family-2',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:05:00.000Z',
      step: 12,
      messages: [
        { role: 'user', content: 'partial tool checkpoint' },
        {
          role: 'assistant',
          content: 'Calling read_file',
          toolCalls: [
            {
              id: 'tool-2',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: { path: 'app_service.py' },
              },
            },
          ],
        },
      ],
    });

    assert.deepEqual(manager.getDraftRecord(context)?.checkpoint?.messages, [
      { role: 'user', content: 'partial tool checkpoint' },
    ]);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayCheckpointPersistsAsCoalescedJsonlDelta(): void {
  const harness = createHarness('checkpoint-jsonl');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-jsonl',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'checkpoint delta', harness.workspaceDir, {
      draftId: 'draft-jsonl',
      runId: 'run-jsonl',
      runFamilyId: 'family-jsonl',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:05:00.000Z',
      step: 1,
      messages: [
        { role: 'user', content: 'checkpoint delta' },
        { role: 'assistant', content: 'First checkpoint.' },
      ],
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:06:00.000Z',
      step: 2,
      messages: [
        { role: 'user', content: 'checkpoint delta' },
        { role: 'assistant', content: 'Second checkpoint.' },
      ],
    });
    manager.flushReplayCheckpoints(turn.turnId);

    const namespacePath = manager.getEventStore().getNamespacePath(context);
    const header = JSON.parse(fs.readFileSync(path.join(namespacePath, 'interrupted-draft.json'), 'utf-8')) as {
      checkpoint?: unknown;
    };
    const checkpointLines = fs
      .readFileSync(path.join(namespacePath, 'interrupted-draft-checkpoints.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    assert.equal(header.checkpoint, undefined);
    assert.equal(checkpointLines.length, 1);
    assert.equal(manager.getDraftRecord(context)?.checkpoint?.step, 2);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayCheckpointRedactsWriteFileContent(): void {
  const harness = createHarness('checkpoint-write-file-redaction');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-write-file-redaction',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'write large file', harness.workspaceDir, {
      draftId: 'draft-write-redaction',
      runId: 'run-write-redaction',
      runFamilyId: 'family-write-redaction',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:06:30.000Z',
      step: 3,
      messages: [
        { role: 'user', content: 'write large file' },
        {
          role: 'assistant',
          content: 'Writing file.',
          toolCalls: [
            {
              id: 'call-write-large',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: { path: 'large.txt', content: 'x'.repeat(12000) },
              },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-write-large',
          name: 'write_file',
          content: 'written',
        },
      ],
    });
    manager.flushReplayCheckpoints(turn.turnId);

    const checkpointToolCall = manager.getDraftRecord(context)?.checkpoint?.messages.find((message) => message.role === 'assistant')
      ?.toolCalls?.[0];
    assert.equal(
      checkpointToolCall?.function.arguments.content,
      '[TOOL_ARGUMENT_REDACTED field=content original_chars=12000]'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testCommittedWriteFileContentRemainsReplayable(): void {
  const harness = createHarness('committed-write-file-replay');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'committed-write-file-replay',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'write small file', harness.workspaceDir);
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'write small file' },
        {
          role: 'assistant',
          content: 'Writing file.',
          toolCalls: [
            {
              id: 'call-write-small',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: { path: 'small.txt', content: 'hello world' },
              },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call-write-small',
          name: 'write_file',
          content: 'written',
        },
        { role: 'assistant', content: 'Done.' },
      ],
      finalOutputText: 'Done.',
      finishReason: 'end_turn',
    });

    const replayToolCall = manager.getConversationMessages(context).find((message) => message.role === 'assistant' && message.toolCalls)
      ?.toolCalls?.[0];
    assert.equal(replayToolCall?.function.arguments.content, 'hello world');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testInterruptedArtifactPreviewRedactsWriteFileContent(): void {
  const harness = createHarness('artifact-write-file-redaction');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'artifact-write-file-redaction',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'write before interrupt', harness.workspaceDir, {
      draftId: 'draft-artifact-redaction',
      runId: 'run-artifact-redaction',
      runFamilyId: 'family-artifact-redaction',
      maxSteps: 100,
    });
    const artifact = manager.finalizeInterruptedTurn(turn.turnId, {
      terminalCode: 'error',
      lastSafeStep: 0,
      maxSteps: 100,
      previewMessages: [
        {
          role: 'assistant',
          content: 'Writing file.',
          toolCalls: [
            {
              id: 'call-write-artifact',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: { path: 'artifact.txt', content: 'z'.repeat(9000) },
              },
            },
          ],
        },
      ],
      sideEffectLedger: [],
    });

    const previewToolCall = artifact?.previewMessages.find((message) => message.role === 'assistant')?.toolCalls?.[0];
    assert.equal(
      previewToolCall?.function.arguments.content,
      '[TOOL_ARGUMENT_REDACTED field=content original_chars=9000]'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayCheckpointJsonlCorruptTailFallsBackToLatestValidDelta(): void {
  const harness = createHarness('checkpoint-corrupt-tail');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-corrupt-tail',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'checkpoint corrupt tail', harness.workspaceDir, {
      draftId: 'draft-corrupt',
      runId: 'run-corrupt',
      runFamilyId: 'family-corrupt',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:07:00.000Z',
      step: 7,
      messages: [
        { role: 'user', content: 'checkpoint corrupt tail' },
        { role: 'assistant', content: 'Valid checkpoint.' },
      ],
    });
    manager.flushReplayCheckpoints(turn.turnId);

    const checkpointPath = path.join(
      manager.getEventStore().getNamespacePath(context),
      'interrupted-draft-checkpoints.jsonl'
    );
    fs.appendFileSync(checkpointPath, '{"checkpoint":', 'utf-8');

    assert.equal(manager.getDraftRecord(context)?.checkpoint?.step, 7);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayCheckpointAppendAfterCorruptTailAdvancesRecovery(): void {
  const harness = createHarness('checkpoint-append-after-corrupt-tail');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-append-after-corrupt-tail',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'checkpoint append after corrupt tail', harness.workspaceDir, {
      draftId: 'draft-corrupt-append',
      runId: 'run-corrupt-append',
      runFamilyId: 'family-corrupt-append',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:07:00.000Z',
      step: 7,
      messages: [
        { role: 'user', content: 'checkpoint append after corrupt tail' },
        { role: 'assistant', content: 'Valid checkpoint.' },
      ],
    });
    manager.flushReplayCheckpoints(turn.turnId);

    const checkpointPath = path.join(
      manager.getEventStore().getNamespacePath(context),
      'interrupted-draft-checkpoints.jsonl'
    );
    fs.appendFileSync(checkpointPath, '{"checkpoint":', 'utf-8');
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:08:00.000Z',
      step: 8,
      messages: [
        { role: 'user', content: 'checkpoint append after corrupt tail' },
        { role: 'assistant', content: 'Later checkpoint.' },
      ],
    });
    manager.flushReplayCheckpoints(turn.turnId);

    assert.equal(manager.getDraftRecord(context)?.checkpoint?.step, 8);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testQueuedReplayCheckpointDoesNotResurrectAbortedTurn(): void {
  const harness = createHarness('checkpoint-late-abort');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-late-abort',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'late checkpoint', harness.workspaceDir, {
      draftId: 'draft-late',
      runId: 'run-late',
      runFamilyId: 'family-late',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:08:00.000Z',
      step: 8,
      messages: [
        { role: 'user', content: 'late checkpoint' },
        { role: 'assistant', content: 'Late checkpoint.' },
      ],
    });
    assert.equal(manager.abortTurn(turn.turnId), true);
    manager.flushReplayCheckpoints(turn.turnId);

    assert.equal(manager.getDraftRecord(context), undefined);
    assert.equal(
      fs.existsSync(path.join(manager.getEventStore().getNamespacePath(context), 'interrupted-draft-checkpoints.jsonl')),
      false
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testMandatoryReplayCheckpointFlushKeepsQueueOnFailure(): void {
  const harness = createHarness('checkpoint-flush-failure');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-flush-failure',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'flush failure', harness.workspaceDir, {
      draftId: 'draft-flush-failure',
      runId: 'run-flush-failure',
      runFamilyId: 'family-flush-failure',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:09:00.000Z',
      step: 9,
      messages: [
        { role: 'user', content: 'flush failure' },
        { role: 'assistant', content: 'Retryable checkpoint.' },
      ],
    });

    const internals = manager as unknown as {
      interruptedTurnStore: {
        appendDraftCheckpoint: (...args: unknown[]) => unknown;
      };
    };
    const originalAppend = internals.interruptedTurnStore.appendDraftCheckpoint;
    internals.interruptedTurnStore.appendDraftCheckpoint = () => {
      throw new Error('disk full');
    };
    assert.throws(() => manager.flushReplayCheckpoints(turn.turnId), /disk full/);
    internals.interruptedTurnStore.appendDraftCheckpoint = originalAppend;

    manager.flushReplayCheckpoints(turn.turnId);
    assert.equal(manager.getDraftRecord(context)?.checkpoint?.step, 9);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testNonMandatoryReplayCheckpointFlushKeepsQueueForRetry(): Promise<void> {
  const harness = createHarness('checkpoint-nonmandatory-flush-failure');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-nonmandatory-flush-failure',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'nonmandatory flush failure', harness.workspaceDir, {
      draftId: 'draft-nonmandatory-flush-failure',
      runId: 'run-nonmandatory-flush-failure',
      runFamilyId: 'family-nonmandatory-flush-failure',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:09:30.000Z',
      step: 11,
      messages: [
        { role: 'user', content: 'nonmandatory flush failure' },
        { role: 'assistant', content: 'Retryable nonmandatory checkpoint.' },
      ],
    });

    const internals = manager as unknown as {
      interruptedTurnStore: {
        appendDraftCheckpoint: (...args: unknown[]) => unknown;
      };
    };
    const originalAppend = internals.interruptedTurnStore.appendDraftCheckpoint;
    let appendAttempts = 0;
    internals.interruptedTurnStore.appendDraftCheckpoint = () => {
      appendAttempts += 1;
      throw new Error('transient disk failure');
    };
    await waitForImmediate();
    assert.equal(appendAttempts, 1);
    assert.equal(readDraftCheckpointStep(manager, context), undefined);
    internals.interruptedTurnStore.appendDraftCheckpoint = originalAppend;

    manager.flushReplayCheckpoints(turn.turnId);
    assert.equal(readDraftCheckpointStep(manager, context), 11);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testMandatoryReplayCheckpointFlushFailsOnUnreadableDraft(): void {
  const harness = createHarness('checkpoint-unreadable-draft');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-unreadable-draft',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'unreadable draft', harness.workspaceDir, {
      draftId: 'draft-unreadable',
      runId: 'run-unreadable',
      runFamilyId: 'family-unreadable',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(turn.turnId, {
      observedAt: '2026-04-26T10:10:00.000Z',
      step: 10,
      messages: [
        { role: 'user', content: 'unreadable draft' },
        { role: 'assistant', content: 'Checkpoint survives draft header parse failure.' },
      ],
    });

    const draftPath = path.join(manager.getEventStore().getNamespacePath(context), 'interrupted-draft.json');
    const originalDraft = fs.readFileSync(draftPath, 'utf-8');
    fs.writeFileSync(draftPath, '{"draftId":', 'utf-8');
    assert.throws(
      () => manager.flushReplayCheckpoints(turn.turnId),
      /Replay checkpoint flush blocked by unreadable or mismatched draft/
    );

    fs.writeFileSync(draftPath, originalDraft, 'utf-8');
    manager.flushReplayCheckpoints(turn.turnId);
    assert.equal(manager.getDraftRecord(context)?.checkpoint?.step, 10);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testFlushAllReplayCheckpointsPersistsAllPendingQueues(): void {
  const harness = createHarness('checkpoint-flush-all');
  const llm = new ScriptedLLMClient(['unused']);
  const firstContext: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-flush-all-a',
  };
  const secondContext: ContextRef = {
    scope: 'session',
    namespace: 'checkpoint-flush-all-b',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const firstTurn = manager.beginTurn(firstContext, 'first pending checkpoint', harness.workspaceDir, {
      draftId: 'draft-flush-all-a',
      runId: 'run-flush-all-a',
      runFamilyId: 'family-flush-all-a',
      maxSteps: 100,
    });
    const secondTurn = manager.beginTurn(secondContext, 'second pending checkpoint', harness.workspaceDir, {
      draftId: 'draft-flush-all-b',
      runId: 'run-flush-all-b',
      runFamilyId: 'family-flush-all-b',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(firstTurn.turnId, {
      observedAt: '2026-04-26T10:11:00.000Z',
      step: 21,
      messages: [
        { role: 'user', content: 'first pending checkpoint' },
        { role: 'assistant', content: 'First checkpoint.' },
      ],
    });
    manager.saveReplayCheckpoint(secondTurn.turnId, {
      observedAt: '2026-04-26T10:12:00.000Z',
      step: 22,
      messages: [
        { role: 'user', content: 'second pending checkpoint' },
        { role: 'assistant', content: 'Second checkpoint.' },
      ],
    });

    manager.flushReplayCheckpoints();

    assert.equal(readDraftCheckpointStep(manager, firstContext), 21);
    assert.equal(readDraftCheckpointStep(manager, secondContext), 22);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function appendToolTurn(agent: DPAgent, context: ContextRef, input: {
  prompt: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: string;
  finalAnswer: string;
}): void {
  const manager = agent.getContextManager();
  const turn = manager.beginTurn(context, input.prompt);
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: input.prompt },
      {
        role: 'assistant',
        content: `Calling ${input.toolName}`,
        toolCalls: [
          {
            id: input.toolCallId,
            type: 'function',
            function: {
              name: input.toolName,
              arguments: input.toolArgs,
            },
          },
        ],
      },
      {
        role: 'tool',
        content: input.toolResult,
        toolCallId: input.toolCallId,
        name: input.toolName,
      },
      { role: 'assistant', content: input.finalAnswer },
    ],
    finalOutputText: input.finalAnswer,
    finishReason: 'end_turn',
  });
}

function makeLongText(seed: string): string {
  return `${seed} `.repeat(180).trim();
}

async function runCase(): Promise<void> {
  const harness = createHarness('main');
  const llm = new ScriptedLLMClient(['first answer', 'second answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-replay',
  };
  const firstPrompt = 'first question';
  const secondPrompt = 'second question';

  try {
    const agent = createAgent(harness, llm);

    await agent.runWithResult({
      prompt: firstPrompt,
      context,
      workspaceDir: harness.workspaceDir,
    });
    agent.getContextManager().getEventStore().appendEvents(
      context.scope,
      context.namespace,
      [
        {
          id: 'legacy-summary-marker',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'legacy-marker-turn',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: '[SUMMARY_MESSAGES_APPLIED] legacy summary marker',
          },
        },
        {
          id: 'legacy-precompress-marker',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'legacy-marker-turn',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: '[CONTEXT_PRECOMPRESSED] legacy compressed marker',
          },
        },
      ],
      { workspaceDir: harness.workspaceDir }
    );
    await agent.runWithResult({
      prompt: secondPrompt,
      context,
      workspaceDir: harness.workspaceDir,
    });

    assert.equal(llm.calls.length, 2);
    const secondCall = llm.calls[1] ?? [];
    assert.equal(
      secondCall.some((message) => message.role === 'user' && messageToText(message.content) === firstPrompt),
      true
    );
    assert.equal(
      secondCall.some((message) => message.role === 'assistant' && messageToText(message.content) === 'first answer'),
      true
    );
    assert.equal(
      secondCall.some((message) => messageToText(message.content).includes('[SUMMARY_MESSAGES_APPLIED]')),
      false
    );
    assert.equal(
      secondCall.some((message) => messageToText(message.content).includes('[CONTEXT_PRECOMPRESSED]')),
      false
    );

    const events = agent.getContextManager().getEventStore().readEvents(context.scope, context.namespace);
    const firstPromptEvents = events.filter(
      (event) => event.type === 'user_message' && String(event.data.content ?? '') === firstPrompt
    );
    const firstAnswerEvents = events.filter(
      (event) => event.type === 'assistant_message' && String(event.data.content ?? '') === 'first answer'
    );
    assert.equal(firstPromptEvents.length, 1);
    assert.equal(firstAnswerEvents.length, 1);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAgentProfileReplayNormalizationCase(): Promise<void> {
  const harness = createHarness('agent-profile');
  const llm = new ScriptedLLMClient(['third answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-agent-profile',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.getContextManager().getEventStore().appendEvents(
      context.scope,
      context.namespace,
      [
        {
          id: 'history-user-1',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-1',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: workspaceAgentProfilePrompt('first from history'),
          },
        },
        {
          id: 'history-assistant-1',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-1',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'first answer',
          },
        },
        {
          id: 'history-user-2',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-2',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: workspaceAgentProfilePrompt('second from history'),
          },
        },
        {
          id: 'history-assistant-2',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-2',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'second answer',
          },
        },
      ],
      { workspaceDir: harness.workspaceDir }
    );

    const displayMessages = agent.getContextMessages(context);
    const replayMessages = agent.getContextMessages(context, {
      preserveAgentProfileRefs: true,
    });
    assert.equal(String(displayMessages[0]?.content ?? ''), 'first from history');
    assert.equal(String(replayMessages[0]?.content ?? ''), workspaceAgentProfilePrompt('first from history'));

    await agent.runWithResult({
      prompt: 'third question',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const call = llm.calls[0] ?? [];
    const userMessages = call.filter((message) => message.role === 'user').map((message) => messageToText(message.content));
    assert.equal(userMessages.some((item) => item.includes('first from history') && item.includes('[AGENT_PROFILE_REF_NOTE]')), true);
    assert.equal(userMessages.includes('second from history'), true);
    assert.equal(
      userMessages.filter((item) => item.startsWith('[AGENT_PROFILE_REF source=workspace name=workspace')).length,
      1
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAgentProfileReplayResetAfterPlainTurnCase(): Promise<void> {
  const harness = createHarness('agent-profile-reset');
  const llm = new ScriptedLLMClient(['fourth answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-agent-profile-reset',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.getContextManager().getEventStore().appendEvents(
      context.scope,
      context.namespace,
      [
        {
          id: 'history-user-a1',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a1',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: workspaceAgentProfilePrompt('first from history'),
          },
        },
        {
          id: 'history-assistant-a1',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a1',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'first answer',
          },
        },
        {
          id: 'history-user-a2',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a2',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'plain middle turn',
          },
        },
        {
          id: 'history-assistant-a2',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a2',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'middle answer',
          },
        },
        {
          id: 'history-user-a3',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a3',
          type: 'user_message',
          timestamp: new Date().toISOString(),
          data: {
            content: workspaceAgentProfilePrompt('second from history'),
          },
        },
        {
          id: 'history-assistant-a3',
          scope: context.scope,
          namespace: context.namespace,
          turnId: 'turn-a3',
          type: 'assistant_message',
          timestamp: new Date().toISOString(),
          data: {
            content: 'second answer',
          },
        },
      ],
      { workspaceDir: harness.workspaceDir }
    );

    await agent.runWithResult({
      prompt: 'fifth question',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const call = llm.calls[0] ?? [];
    const userMessages = call.filter((message) => message.role === 'user').map((message) => messageToText(message.content));
    assert.equal(userMessages.some((item) => item.includes('first from history') && item.includes('[AGENT_PROFILE_REF_NOTE]')), true);
    assert.equal(userMessages.includes('plain middle turn'), true);
    assert.equal(userMessages.some((item) => item.includes('second from history') && item.includes('[AGENT_PROFILE_REF_NOTE]')), true);
    assert.equal(
      userMessages.filter((item) => item.startsWith('[AGENT_PROFILE_REF source=workspace name=workspace')).length,
      2
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runRawPromptPersistenceCase(): Promise<void> {
  const harness = createHarness('raw-prompt');
  const llm = new ScriptedLLMClient(['first answer', 'second answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-raw-prompt',
  };

  try {
    const agent = createAgent(harness, llm);
    await agent.runWithResult({
      prompt: 'Implement login',
      rawUserPrompt: 'Implement login',
      historyUserPrompt: workspaceAgentProfilePrompt('Implement login'),
      effectivePrompt: 'Bootstrapped effective prompt for Implement login',
      promptReference: '[PROMPT_REF reason=workspace_agent source=workspace]',
      hasSystemPromptInjection: true,
      context,
      workspaceDir: harness.workspaceDir,
    });

    await agent.runWithResult({
      prompt: 'Follow up',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const secondCall = llm.calls[1] ?? [];
    const userMessages = secondCall.filter((message) => message.role === 'user').map((message) => messageToText(message.content));
    assert.equal(userMessages.includes('Implement login'), true);
    assert.equal(
      userMessages.some((item) => item.includes('[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]')),
      false
    );

    const events = agent.getContextManager().getEventStore().readEvents(context.scope, context.namespace);
    const storedUserEvent = events.find(
      (event) => event.type === 'user_message' && String(event.data.content ?? '') === 'Implement login'
    );
    assert.ok(storedUserEvent);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runToolProtocolReplayCase(): Promise<void> {
  const harness = createHarness('tool-protocol');
  const llm = new ScriptedLLMClient(['follow-up answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-tool-protocol',
  };

  try {
    const agent = createAgent(harness, llm);
    appendToolTurn(agent, context, {
      prompt: 'Inspect the config model',
      toolCallId: 'call-config-read',
      toolName: 'read_file',
      toolArgs: { path: 'config.yaml' },
      toolResult: 'api:\n  model: MiniMax-M2.7-highspeed\n',
      finalAnswer: 'The configured model is MiniMax-M2.7-highspeed.',
    });

    const storedMessages = agent.getContextMessages(context);
    assert.equal(storedMessages.some((message) => message.role === 'tool'), true);
    assert.equal(
      storedMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.toolCalls?.some((toolCall) => toolCall.function.name === 'read_file')
      ),
      true
    );

    await agent.runWithResult({
      prompt: 'What tool did you use last time?',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const replayMessages = llm.calls[0] ?? [];
    const assistantWithToolCall = replayMessages.find(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some(
          (toolCall) =>
            toolCall.id === 'call-config-read' && toolCall.function.name === 'read_file'
        )
    );
    assert.ok(assistantWithToolCall);
    const toolResultMessage = replayMessages.find(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === 'call-config-read' &&
        messageToText(message.content).includes('MiniMax-M2.7-highspeed')
    );
    assert.ok(toolResultMessage);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runToolOnlyAssistantReplayCase(): Promise<void> {
  const harness = createHarness('tool-only-assistant');
  const llm = new ScriptedLLMClient(['tool-only follow-up']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-tool-only-assistant',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'Check package metadata');
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'Check package metadata' },
        {
          role: 'assistant',
          content: '',
          thinking: '  Need to inspect package.json before answering.\n',
          thinkingSignature: 'sig-tool-only',
          toolCalls: [
            {
              id: 'call-package-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: { path: 'package.json' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: '{\"name\":\"dpagent\"}',
          toolCallId: 'call-package-read',
          name: 'read_file',
        },
        { role: 'assistant', content: 'The package name is dpagent.' },
      ],
      finalOutputText: 'The package name is dpagent.',
      finishReason: 'end_turn',
    });

    await agent.runWithResult({
      prompt: 'What tool did you just use?',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const replayMessages = llm.calls[0] ?? [];
    const assistantWithToolCall = replayMessages.find(
      (message) =>
        message.role === 'assistant' &&
        message.thinking === '  Need to inspect package.json before answering.\n' &&
        message.thinkingSignature === 'sig-tool-only' &&
        message.toolCalls?.some(
          (toolCall) => toolCall.id === 'call-package-read' && toolCall.function.name === 'read_file'
        )
    );
    assert.ok(assistantWithToolCall);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runReplaySanitizesInvalidToolProtocolBeforeGroupingCase(): Promise<void> {
  const harness = createHarness('tool-protocol-repair');
  const llm = new ScriptedLLMClient(['repair follow-up']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-tool-protocol-repair',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'Inspect the config');
    manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: 'Inspect the config' },
        {
          role: 'assistant',
          content: 'Calling read_file',
          toolCalls: [
            {
              id: 'call-config-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: { path: 'config.yaml' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: 'api:\n  model: MiniMax-M2.7-highspeed\n',
          toolCallId: 'call-mismatched',
          name: 'read_file',
        },
        {
          role: 'assistant',
          content: 'I inspected config.yaml.',
        },
      ],
      finalOutputText: 'I inspected config.yaml.',
      finishReason: 'end_turn',
    });

    await agent.runWithResult({
      prompt: 'What happened in the previous tool step?',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const replayMessages = llm.calls[0] ?? [];
    assert.equal(
      replayMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.toolCalls?.some((toolCall) => toolCall.id === 'call-config-read')
      ),
      false
    );
    assert.equal(
      replayMessages.some((message) => message.role === 'tool' && message.toolCallId === 'call-mismatched'),
      false
    );
    assert.equal(
      replayMessages.some(
        (message) =>
          message.role === 'user' && messageToText(message.content).includes('[TOOLCALL_FAILED]')
      ),
      true
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runReplayCharEstimateIncludesToolAndThinkingCase(): Promise<void> {
  const assembler = new ContextReplayAssembler({
    getConfig: () => {
      throw new Error('not needed for grouping');
    },
    getLlmClient: () => null,
  });
  const assemblerAny = assembler as unknown as {
    groupReplayRoundsByUser: (messages: Message[]) => ReplayRound[];
  };
  const userMessage: Message = {
    role: 'user',
    content: 'inspect package',
  };
  const plainAssistant: Message = {
    role: 'assistant',
    content: 'short answer',
  };
  const richAssistant: Message = {
    role: 'assistant',
    content: 'short answer',
    thinking: 'Need to inspect package.json before answering.',
    thinkingSignature: 'sig-rich',
    toolCalls: [
      {
        id: 'call-rich',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: { path: 'package.json' },
        },
      },
    ],
  };
  const richToolMessage: Message = {
    role: 'tool',
    content: 'tool-result-content',
    toolCallId: 'call-rich',
    name: 'read_file',
  };

  const [plainRound] = assemblerAny.groupReplayRoundsByUser([userMessage, plainAssistant]);
  const [richRound] = assemblerAny.groupReplayRoundsByUser([userMessage, richAssistant, richToolMessage]);
  const userChars = estimateMessageCharacters(userMessage);
  const plainChars = plainRound.chars - userChars;
  const richChars = richRound.chars - userChars - estimateMessageCharacters(richToolMessage);
  const toolChars = richRound.chars - userChars - estimateMessageCharacters(richAssistant);

  assert.equal(richChars > plainChars, true);
  assert.equal(richChars, estimateMessageCharacters(richAssistant));
  assert.equal(toolChars, estimateMessageCharacters(richToolMessage));
  assert.equal(toolChars > 'tool-result-content'.length, true);
}

async function runInternalContextCommitFilterCase(): Promise<void> {
  const harness = createHarness('internal-filter');
  const llm = new ScriptedLLMClient(['unused answer']);
  try {
    createAgent(harness, llm);
    const filtered = filterCommittedTurnMessages([
      { role: 'user', content: 'real task' },
      { role: 'assistant', content: '[TOOL_HISTORY_COMPACTED] compacted tool history' },
      { role: 'assistant', content: '[CONTEXT_PRECOMPRESSED] compressed older context' },
      { role: 'assistant', content: 'real answer' },
    ]);
    assert.deepEqual(filtered, [
      { role: 'user', content: 'real task' },
      { role: 'assistant', content: '[CONTEXT_PRECOMPRESSED] compressed older context' },
      { role: 'assistant', content: 'real answer' },
    ]);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testPreviewSliceFallsBackToMatchedReplayPrefix(): void {
  const preview = slicePreviewMessages(
    [
      { role: 'user', content: 'continue work' },
      {
        role: 'assistant',
        content: 'Calling read_file',
        thinking: 'internal reasoning that does not survive checkpointing',
        toolCalls: [
          {
            id: 'tool-live',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'app_service.py' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"success":true,"content":"live result"}',
        toolCallId: 'tool-live',
        name: 'read_file',
      },
    ],
    [
      { role: 'user', content: 'continue work' },
      {
        role: 'assistant',
        content: 'Calling read_file',
        toolCalls: [
          {
            id: 'tool-checkpoint',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: { path: 'app_service.py' },
            },
          },
        ],
      },
    ]
  );

  assert.equal(preview.length, 2);
  assert.equal(preview[0]?.role, 'assistant');
  assert.equal(preview[1]?.role, 'tool');
}

function testSideEffectLedgerSkipsObservationOnlyTools(): void {
  const ledger = buildSideEffectLedgerFromPreview([
    {
      role: 'assistant',
      content: 'inspect and patch',
      toolCalls: [
        {
          id: 'tool-read-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: { path: 'src/app_service.py' },
          },
        },
        {
          id: 'tool-write-1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: { path: 'src/app_service.py', content: 'patched' },
          },
        },
        {
          id: 'tool-subagent-list-1',
          type: 'function',
          function: {
            name: 'subagent_manage',
            arguments: { action: 'list' },
          },
        },
        {
          id: 'tool-subagent-create-1',
          type: 'function',
          function: {
            name: 'subagent_manage',
            arguments: { action: 'create', prompt: 'Review the patch' },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '{"success":true,"content":"read result"}',
      toolCallId: 'tool-read-1',
      name: 'read_file',
    },
    {
      role: 'tool',
      content: '{"success":true,"content":"patched file"}',
      toolCallId: 'tool-write-1',
      name: 'write_file',
    },
    {
      role: 'tool',
      content: '{"success":true,"content":"[]"}',
      toolCallId: 'tool-subagent-list-1',
      name: 'subagent_manage',
    },
    {
      role: 'tool',
      content: '{"success":true,"content":"created"}',
      toolCallId: 'tool-subagent-create-1',
      name: 'subagent_manage',
    },
  ]);

  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]?.toolName, 'write_file');
  assert.deepEqual(ledger[0]?.args, { path: 'src/app_service.py', content: 'patched' });
  assert.equal(ledger[1]?.toolName, 'subagent_manage');
  assert.deepEqual(ledger[1]?.args, { action: 'create', prompt: 'Review the patch' });
}

function testSideEffectLedgerKeepsFailedPotentialMutations(): void {
  const ledger = buildSideEffectLedgerFromPreview([
    {
      role: 'assistant',
      content: 'run risky operations',
      toolCalls: [
        {
          id: 'tool-shell-1',
          type: 'function',
          function: {
            name: 'shell_execute',
            arguments: { command: 'npm run migrate' },
          },
        },
        {
          id: 'tool-apply-1',
          type: 'function',
          function: {
            name: 'apply_database_patch',
            arguments: { patch: 'alter table users add column flag boolean' },
          },
        },
        {
          id: 'tool-subagent-cancel-1',
          type: 'function',
          function: {
            name: 'subagent_manage',
            arguments: { action: 'cancel', subagent_id: 'subagent-1' },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '{"success":false,"error":"command exited after partial migration"}',
      toolCallId: 'tool-shell-1',
      name: 'shell_execute',
    },
    {
      role: 'tool',
      content: '{"success":false,"error":"patch failed after writing staging marker"}',
      toolCallId: 'tool-apply-1',
      name: 'apply_database_patch',
    },
    {
      role: 'tool',
      content: '{"success":false,"error":"cancel timed out"}',
      toolCallId: 'tool-subagent-cancel-1',
      name: 'subagent_manage',
    },
  ]);

  assert.equal(ledger.length, 3);
  assert.deepEqual(
    ledger.map((entry) => [entry.toolName, entry.resultSuccess]),
    [
      ['shell_execute', false],
      ['apply_database_patch', false],
      ['subagent_manage', false],
    ]
  );
}

function testSideEffectLedgerSkipsReadOnlyShellCommands(): void {
  const ledger = buildSideEffectLedgerFromPreview([
    {
      role: 'assistant',
      content: 'inspect shell state',
      toolCalls: [
        {
          id: 'tool-shell-1',
          type: 'function',
          function: {
            name: 'shell_execute',
            arguments: { command: 'git status --short' },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '{"success":true,"content":" M src/index.ts"}',
      toolCallId: 'tool-shell-1',
      name: 'shell_execute',
    },
  ]);

  assert.equal(ledger.length, 0);
}

function testSideEffectLedgerKeepsMutatingShellEvenWithReadOnlyPrefix(): void {
  const ledger = buildSideEffectLedgerFromPreview([
    {
      role: 'assistant',
      content: 'inspect and then clean',
      toolCalls: [
        {
          id: 'tool-shell-1',
          type: 'function',
          function: {
            name: 'shell_execute',
            arguments: { command: 'git status --short; Remove-Item -LiteralPath temp.txt -Force' },
          },
        },
      ],
    },
    {
      role: 'tool',
      content: '{"success":false,"error":"remove failed after inspecting status"}',
      toolCallId: 'tool-shell-1',
      name: 'shell_execute',
    },
  ]);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.toolName, 'shell_execute');
  assert.equal(ledger[0]?.resultSuccess, false);
}

function testInterruptedSideEffectSegmentUsesNewestEntries(): void {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    id: `ledger-${index + 1}`,
    observedAt: '2026-04-26T12:00:00.000Z',
    toolName: 'write_file',
    toolCallId: `tool-${index + 1}`,
    args: { path: `file-${index + 1}.txt` },
    resultSuccess: true,
    resultSummary: `updated file-${index + 1}.txt`,
  }));

  const segment = buildInterruptedSideEffectSegment(entries);

  assert.match(segment, /tool-25/);
  assert.doesNotMatch(segment, /tool-1\b/);
  assert.match(segment, /\.\.\.\(5 more post-checkpoint side effects\)/);
}

async function runInterruptedSideEffectCarryForwardCase(): Promise<void> {
  const harness = createHarness('interrupted-ledger-carry-forward');
  const llm = new ScriptedLLMClient(['follow-up answer', 'later answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-ledger-carry-forward',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const interruptedTurn = manager.beginTurn(context, 'resume after error', harness.workspaceDir, {
      draftId: 'draft-ledger-1',
      runId: 'run-ledger-1',
      runFamilyId: 'family-ledger-1',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(interruptedTurn.turnId, {
      observedAt: '2026-04-26T12:00:00.000Z',
      step: 40,
      messages: [
        { role: 'user', content: 'resume after error' },
        { role: 'assistant', content: 'Saved safe checkpoint.' },
      ],
    });
    manager.finalizeInterruptedTurn(interruptedTurn.turnId, {
      terminalCode: 'error',
      maxSteps: 100,
      lastSafeStep: 40,
      errorSummary: 'read ECONNRESET',
      previewMessages: [
        {
          role: 'tool',
          content: '{"success":true,"content":"Updated src/app_service.py"}',
          toolCallId: 'tool-write-1',
          name: 'write_file',
        },
      ],
      sideEffectLedger: [
        {
          id: 'ledger-1',
          observedAt: '2026-04-26T12:00:01.000Z',
          toolName: 'write_file',
          toolCallId: 'tool-write-1',
          args: { path: 'src/app_service.py' },
          resultSuccess: true,
          resultSummary: 'Updated src/app_service.py',
        },
      ],
    });

    assert.equal(manager.getInterruptedSideEffectLedger(context).length, 1);

    await agent.runWithResult({
      prompt: 'where are we now?',
      context,
      workspaceDir: harness.workspaceDir,
    });

    assert.equal(agent.getInterruptedArtifact(context), undefined);
    assert.equal(manager.getInterruptedSideEffectLedger(context).length, 0);
    assert.match(llm.systemPrompts[0] ?? '', /## Interrupted Turn Side Effects/);
    assert.match(llm.systemPrompts[0] ?? '', /write_file/);

    await agent.runWithResult({
      prompt: 'continue with the next task',
      context,
      workspaceDir: harness.workspaceDir,
    });

    assert.doesNotMatch(llm.systemPrompts[1] ?? '', /## Interrupted Turn Side Effects/);
    assert.doesNotMatch(llm.systemPrompts[1] ?? '', /src\/app_service\.py/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runInterruptedWorkspaceBindingCase(): Promise<void> {
  const harness = createHarness('interrupted-workspace-binding');
  const llm = new ScriptedLLMClient([
    'continued from interrupted workspace',
    'fresh turn stayed on interrupted workspace',
  ]);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-workspace-binding',
  };
  const interruptedWorkspaceDir = path.join(harness.tempDir, 'alt-workspace');

  try {
    fs.mkdirSync(interruptedWorkspaceDir, { recursive: true });
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const interruptedTurn = manager.beginTurn(context, 'resume in alternate workspace', interruptedWorkspaceDir, {
      draftId: 'draft-workspace-1',
      runId: 'run-workspace-1',
      runFamilyId: 'family-workspace-1',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(interruptedTurn.turnId, {
      observedAt: '2026-04-26T12:05:00.000Z',
      step: 12,
      messages: [
        { role: 'user', content: 'resume in alternate workspace' },
        { role: 'assistant', content: 'Saved alternate-workspace checkpoint.' },
      ],
    });
    manager.finalizeInterruptedTurn(interruptedTurn.turnId, {
      terminalCode: 'error',
      maxSteps: 100,
      lastSafeStep: 12,
      errorSummary: 'connection reset',
      previewMessages: [],
      sideEffectLedger: [],
    });

    assert.equal(agent.resolveWorkspaceDirForContext(context), interruptedWorkspaceDir);

    await agent.runWithResult({
      prompt: 'continue with conflicting explicit workspace',
      context,
      workspaceDir: harness.workspaceDir,
    });

    assert.equal(agent.getContextNamespaceMeta(context)?.workspaceDir, interruptedWorkspaceDir);

    const freshContext: ContextRef = {
      scope: 'session',
      namespace: 'interrupted-workspace-binding-fresh',
    };
    const freshTurn = manager.beginTurn(
      freshContext,
      'fresh run should inherit interrupted workspace binding',
      interruptedWorkspaceDir,
      {
        draftId: 'draft-workspace-2',
        runId: 'run-workspace-2',
        runFamilyId: 'family-workspace-2',
        maxSteps: 100,
      }
    );
    manager.saveReplayCheckpoint(freshTurn.turnId, {
      observedAt: '2026-04-26T12:06:00.000Z',
      step: 8,
      messages: [
        { role: 'user', content: 'fresh run should inherit interrupted workspace binding' },
        { role: 'assistant', content: 'Fresh checkpoint saved.' },
      ],
    });
    manager.finalizeInterruptedTurn(freshTurn.turnId, {
      terminalCode: 'error',
      maxSteps: 100,
      lastSafeStep: 8,
      errorSummary: 'socket hang up',
      previewMessages: [],
      sideEffectLedger: [],
    });

    await agent.runWithResult({
      prompt: 'fresh turn should still stay on interrupted workspace binding',
      context: freshContext,
      workspaceDir: harness.workspaceDir,
    });

    assert.equal(agent.getContextNamespaceMeta(freshContext)?.workspaceDir, interruptedWorkspaceDir);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runInterruptedContextPatchCarryForwardCase(): Promise<void> {
  const harness = createHarness('interrupted-context-patch');
  const llm = new ScriptedLLMClient(['continued with structured context']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'interrupted-context-patch',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const interruptedTurn = manager.beginTurn(context, 'persist structured state after checkpoint', harness.workspaceDir, {
      draftId: 'draft-context-patch-1',
      runId: 'run-context-patch-1',
      runFamilyId: 'family-context-patch-1',
      maxSteps: 100,
    });
    manager.saveReplayCheckpoint(interruptedTurn.turnId, {
      observedAt: '2026-04-26T12:10:00.000Z',
      step: 22,
      messages: [
        { role: 'user', content: 'persist structured state after checkpoint' },
        { role: 'assistant', content: 'Checkpoint saved.' },
      ],
    });
    manager.recordContextPatch(interruptedTurn.turnId, {
      op: 'set',
      key: 'plan.current',
      value: 'Finish the interrupted refactor before new work.',
      source: 'plan_mode',
    });
    manager.finalizeInterruptedTurn(interruptedTurn.turnId, {
      terminalCode: 'error',
      maxSteps: 100,
      lastSafeStep: 22,
      errorSummary: 'socket hang up',
      previewMessages: [],
      sideEffectLedger: [],
    });

    assert.equal(
      manager.getProjection(context).keyValues['plan.current'],
      'Finish the interrupted refactor before new work.'
    );

    await agent.runWithResult({
      prompt: 'continue after interrupted structured state',
      context,
      workspaceDir: harness.workspaceDir,
    });

    assert.match(llm.systemPrompts[0] ?? '', /plan\.current: Finish the interrupted refactor before new work\./);
    assert.equal(
      manager.getProjection(context).keyValues['plan.current'],
      'Finish the interrupted refactor before new work.'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function runContextCompactionReplayCase(): void {
  const harness = createHarness('context-compaction');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-compaction',
  };
  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    appendTurn(agent, context, 'old task that should be sealed', 'old answer that should be sealed');

    const turn = manager.beginTurn(context, 'new task');
    manager.commitTurn(turn.turnId, {
      messages: [
        {
          role: 'assistant',
          content: '[CONTEXT_PRECOMPRESSED mode=light] kept_llm_rounds=1 chunks=1 source_messages=2\nsummary of old work',
          metadata: {
            compressed: true,
            originalSize: 120000,
            compressedSize: 5000,
            contextCompaction: {
              sourceRange: {
                startIndex: 0,
                endIndex: 1,
                messageCount: 2,
                sourceHash: 'hash-old-work',
              },
              sourceCoverage: {
                status: 'truncated',
                droppedMessageCount: 1,
                reason: 'prompt_too_long',
              },
              sealedBoundary: {
                keptLlmRounds: 1,
                tailMessageCount: 2,
              },
              payloadMetrics: {
                originalChars: 120000,
                projectedChars: 9000,
                preparedChars: 7000,
                originalMessageCount: 2,
                projectedMessageCount: 2,
                preparedMessageCount: 2,
                toolResultRefReplacements: 1,
                oversizedInlineToolTruncations: 0,
                protocolCorrectionCount: 0,
                trimRemovedCount: 0,
                trimTruncatedCount: 0,
              },
              configFingerprint: 'cfg-hash',
            },
          },
        },
        { role: 'user', content: 'new task' },
        { role: 'assistant', content: 'new answer' },
      ],
      finalOutputText: 'new answer',
      finishReason: 'end_turn',
    });

    const replay = manager.getConversationMessages(context);
    const replayText = replay.map((message) => messageToText(message.content)).join('\n');
    assert.match(replayText, /CONTEXT_PRECOMPRESSED/);
    assert.match(replayText, /summary of old work/);
    assert.match(replayText, /new task/);
    assert.match(replayText, /new answer/);
    assert.doesNotMatch(replayText, /old task that should be sealed/);
    const replayCompaction = replay.find((message) =>
      messageToText(message.content).includes('[CONTEXT_PRECOMPRESSED')
    );
    assert.equal(replayCompaction?.metadata?.contextCompaction?.configFingerprint, 'cfg-hash');
    assert.equal(replayCompaction?.metadata?.contextCompaction?.payloadMetrics.preparedChars, 7000);
    assert.equal(replayCompaction?.metadata?.contextCompaction?.sourceCoverage?.status, 'truncated');
    assert.equal(replayCompaction?.metadata?.contextCompaction?.sourceCoverage?.droppedMessageCount, 1);
    assert.equal(replayCompaction?.metadata?.contextCompaction?.sourceCoverage?.reason, 'prompt_too_long');
    const compactionEvent = manager
      .getEventStore()
      .readEvents(context.scope, context.namespace)
      .find((event) => event.type === 'context_compaction');
    assert.equal((compactionEvent?.data.sourceRange as { sourceHash?: string } | undefined)?.sourceHash, 'hash-old-work');
    assert.equal((compactionEvent?.data.sourceCoverage as { status?: string } | undefined)?.status, 'truncated');
    assert.equal(
      (compactionEvent?.data.sourceCoverage as { droppedMessageCount?: number } | undefined)?.droppedMessageCount,
      1
    );
    assert.equal((compactionEvent?.data.sealedBoundary as { keptLlmRounds?: number } | undefined)?.keptLlmRounds, 1);
    assert.equal((compactionEvent?.data.payloadMetrics as { preparedChars?: number } | undefined)?.preparedChars, 7000);
    assert.equal(compactionEvent?.data.configFingerprint, 'cfg-hash');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runContextCompactionLlmReplayCase(): Promise<void> {
  const harness = createHarness('context-compaction-llm');
  const llm = new ScriptedLLMClient(['follow-up answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-compaction-llm',
  };
  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    appendTurn(agent, context, 'old task that should not reach llm', 'old answer that should not reach llm');

    const turn = manager.beginTurn(context, 'new task');
    manager.commitTurn(turn.turnId, {
      messages: [
        {
          role: 'assistant',
          content: '[CONTEXT_PRECOMPRESSED mode=light] kept_llm_rounds=1 chunks=1 source_messages=2\nsummary of old work',
          metadata: {
            compressed: true,
            originalSize: 120000,
            compressedSize: 5000,
          },
        },
        { role: 'user', content: 'new task' },
        { role: 'assistant', content: 'new answer' },
      ],
      finalOutputText: 'new answer',
      finishReason: 'end_turn',
    });

    await agent.runWithResult({
      prompt: 'follow up',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const callText = (llm.calls[0] ?? []).map((message) => messageToText(message.content)).join('\n');
    assert.match(llm.systemPrompts[0] ?? '', /summary of old work/);
    assert.doesNotMatch(callText, /old task that should not reach llm/);
    assert.match(callText, /new task/);
    assert.match(callText, /new answer/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function runToolResultArtifactCase(): void {
  const harness = createHarness('tool-result-artifact');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-tool-artifact',
  };
  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const largeResult = Array.from({ length: 300 }, (_, index) => `line-${index}`).join('\n');
    const materialized = manager.materializeToolResultArtifact(context, {
      toolCallId: 'call-large',
      toolName: 'shell_execute',
      content: largeResult,
      thresholdChars: 40,
      previewChars: 20,
    });
    assert.ok(materialized.artifact);
    assert.match(materialized.content, /TOOL_RESULT_STORED/);
    assert.equal(materialized.artifact.originalChars, largeResult.length);
    assert.equal(materialized.artifact.previewChars <= 200, true);

    const read = manager.readToolResultArtifact(context, {
      artifactId: materialized.artifact.artifactId,
      offset: 10,
      limit: 3,
      maxChars: 1000,
    });
    assert.equal(read.success, true);
    assert.match(read.content, /line-10/);
    assert.match(read.content, /line-12/);
    assert.doesNotMatch(read.content, /line-13/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function runToolResultArtifactRootRejectsSymlinkCase(): void {
  const harness = createHarness('artifact-symlink');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-artifact-symlink',
  };

  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const namespacePath = manager.getEventStore().getNamespacePath(context);
    const outsideDir = path.join(harness.tempDir, 'outside-artifacts');
    fs.mkdirSync(namespacePath, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkPath = path.join(namespacePath, 'tool-results');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'junction');
    } catch {
      return;
    }

    assert.throws(
      () =>
        manager.materializeToolResultArtifact(context, {
          toolCallId: 'call-symlink',
          toolName: 'shell_execute',
          content: 'x'.repeat(2000),
          thresholdChars: 1000,
        }),
      /symbolic link|resolves outside/
    );
    const read = manager.readToolResultArtifact(context, {
      artifactId: 'call-symlink',
    });
    assert.equal(read.success, false);
    assert.match(String(read.error ?? ''), /symbolic link|resolves outside|not found/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runDigestSystemPromptCase(): Promise<void> {
  const harness = createHarness('digest-system');
  const llm = new ScriptedLLMClient(['digest final answer']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-digest-system',
  };

  try {
    const agent = createAgent(harness, llm);
    agent.updateConfig({
      agent: {
        contextReplayMinRounds: 1,
        contextReplayMaxRounds: 1,
        contextReplayBudgetRatio: 0.9,
      },
      contextBudget: {
        defaultContextWindowTokens: 25000,
        compressionTriggerRatio: 0.1,
        compressionMaxChars: 4000,
      },
    });

    appendTurn(
      agent,
      context,
      workspaceAgentProfilePrompt(makeLongText('current first task')),
      makeLongText('legacy first answer')
    );
    appendTurn(agent, context, makeLongText('plain middle task'), makeLongText('plain middle answer'));
    appendTurn(
      agent,
      context,
      workspaceAgentProfilePrompt(makeLongText('current second task')),
      makeLongText('legacy second answer')
    );

    await agent.runWithResult({
      prompt: 'continue',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const systemPrompt = llm.systemPrompts[0] ?? '';
    assert.match(systemPrompt, /## Compressed Earlier Session Context/);
    assert.doesNotMatch(systemPrompt, /\[AGENT_PROFILE_REF source=workspace name=workspace/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runVisibleOutputTransportResetCreatesReplayCheckpointCase(): Promise<void> {
  const harness = createHarness('visible-transport-reset');
  const partial = 'partial answer before transport reset';
  const llm = new TransportResetAfterVisibleOutputLLMClient(partial);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'visible-transport-reset',
  };

  try {
    const agent = createAgent(harness, llm);
    const streamed: string[] = [];
    let terminalReplayCutoff: string | undefined;

    await assert.rejects(
      () =>
        agent.runWithResult({
          prompt: 'recover streamed answer',
          context,
          workspaceDir: harness.workspaceDir,
          callback: {
            onMessage: (role, content) => {
              if (role === 'assistant') {
                streamed.push(content);
              }
            },
          },
        }),
      (error) => {
        const err = error as Error & { terminalState?: { replayCutoffKind?: string } };
        terminalReplayCutoff = err.terminalState?.replayCutoffKind;
        return err.message === 'read ECONNRESET';
      }
    );

    assert.equal(llm.callCount, 1);
    assert.deepEqual(streamed, [partial]);
    assert.equal(terminalReplayCutoff, 'checkpoint');

    const artifact = agent.getInterruptedArtifact(context);
    assert.equal(artifact?.terminalCode, 'error');
    assert.equal(artifact?.replayCutoffKind, 'checkpoint');
    assert.equal(artifact?.lastSafeStep, 1);
    assert.equal(artifact?.errorSummary, 'read ECONNRESET');

    const replayMessages = agent.getContextMessages(context, {
      includeInterruptedCheckpoints: true,
    });
    assert.equal(replayMessages.length, 2);
    assert.equal(replayMessages[0]?.role, 'user');
    assert.equal(replayMessages[1]?.role, 'assistant');
    assert.equal(messageToText(replayMessages[1]?.content ?? ''), partial);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runPreVisibleTransportResetRemainsTerminalWithoutCheckpointCase(): Promise<void> {
  const harness = createHarness('pre-visible-transport-reset');
  const llm = new TransportResetBeforeVisibleOutputLLMClient();
  const context: ContextRef = {
    scope: 'session',
    namespace: 'pre-visible-transport-reset',
  };

  try {
    const agent = createAgent(harness, llm);
    let terminalReplayCutoff: string | undefined;

    await assert.rejects(
      () =>
        agent.runWithResult({
          prompt: 'fail before streaming',
          context,
          workspaceDir: harness.workspaceDir,
        }),
      (error) => {
        const err = error as Error & { terminalState?: { replayCutoffKind?: string } };
        terminalReplayCutoff = err.terminalState?.replayCutoffKind;
        return err.message === 'read ECONNRESET';
      }
    );

    assert.equal(llm.callCount, 3);
    assert.equal(terminalReplayCutoff, 'none');
    assert.equal(agent.getInterruptedArtifact(context)?.replayCutoffKind, 'none');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runThinkingOnlyTransportResetRemainsTerminalWithoutCheckpointCase(): Promise<void> {
  const harness = createHarness('thinking-only-transport-reset');
  const llm = new TransportResetAfterVisibleOutputLLMClient('', 'partial private reasoning');
  const context: ContextRef = {
    scope: 'session',
    namespace: 'thinking-only-transport-reset',
  };

  try {
    const agent = createAgent(harness, llm);
    const streamedThinking: string[] = [];
    let terminalReplayCutoff: string | undefined;

    await assert.rejects(
      () =>
        agent.runWithResult({
          prompt: 'fail after thinking stream',
          context,
          workspaceDir: harness.workspaceDir,
          callback: {
            onThinking: (thinking) => {
              streamedThinking.push(thinking);
            },
          },
        }),
      (error) => {
        const err = error as Error & { terminalState?: { replayCutoffKind?: string } };
        terminalReplayCutoff = err.terminalState?.replayCutoffKind;
        return err.message === 'read ECONNRESET';
      }
    );

    assert.equal(llm.callCount, 1);
    assert.deepEqual(streamedThinking, ['partial private reasoning']);
    assert.equal(terminalReplayCutoff, 'none');
    assert.equal(agent.getInterruptedArtifact(context)?.replayCutoffKind, 'none');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runTextAndThinkingTransportResetCheckpointsTextOnlyCase(): Promise<void> {
  const harness = createHarness('text-thinking-transport-reset');
  const partialText = 'visible answer before reset';
  const llm = new TransportResetAfterVisibleOutputLLMClient(partialText, 'partial private reasoning');
  const context: ContextRef = {
    scope: 'session',
    namespace: 'text-thinking-transport-reset',
  };

  try {
    const agent = createAgent(harness, llm);
    let terminalReplayCutoff: string | undefined;

    await assert.rejects(
      () =>
        agent.runWithResult({
          prompt: 'fail after text and thinking stream',
          context,
          workspaceDir: harness.workspaceDir,
        }),
      (error) => {
        const err = error as Error & { terminalState?: { replayCutoffKind?: string } };
        terminalReplayCutoff = err.terminalState?.replayCutoffKind;
        return err.message === 'read ECONNRESET';
      }
    );

    assert.equal(terminalReplayCutoff, 'checkpoint');
    const replayMessages = agent.getContextMessages(context, {
      includeInterruptedCheckpoints: true,
    });
    assert.equal(messageToText(replayMessages[1]?.content ?? ''), partialText);
    assert.equal(replayMessages[1]?.thinking, undefined);
    assert.equal(replayMessages[1]?.metadata?.thinkingComplete, undefined);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runCase()
  .then(() => testCancelledTurnDoesNotReplayAssistantOutput())
  .then(() => testWebTranscriptHasCreatedAtWithoutProviderReplayPollution())
  .then(() => testInterruptedCheckpointTurnIsHiddenByDefaultButAvailableForReplay())
  .then(() => testInterruptedCheckpointToolBundleDoesNotInventTrailingAssistantOutput())
  .then(() => testReplayCheckpointTruncatesPartialToolBundle())
  .then(() => testReplayCheckpointPersistsAsCoalescedJsonlDelta())
  .then(() => testReplayCheckpointRedactsWriteFileContent())
  .then(() => testCommittedWriteFileContentRemainsReplayable())
  .then(() => testInterruptedArtifactPreviewRedactsWriteFileContent())
  .then(() => testReplayCheckpointJsonlCorruptTailFallsBackToLatestValidDelta())
  .then(() => testReplayCheckpointAppendAfterCorruptTailAdvancesRecovery())
  .then(() => testQueuedReplayCheckpointDoesNotResurrectAbortedTurn())
  .then(() => testMandatoryReplayCheckpointFlushKeepsQueueOnFailure())
  .then(testNonMandatoryReplayCheckpointFlushKeepsQueueForRetry)
  .then(() => testMandatoryReplayCheckpointFlushFailsOnUnreadableDraft())
  .then(() => testFlushAllReplayCheckpointsPersistsAllPendingQueues())
  .then(() => testPreviewSliceFallsBackToMatchedReplayPrefix())
  .then(() => testSideEffectLedgerSkipsObservationOnlyTools())
  .then(() => testSideEffectLedgerKeepsFailedPotentialMutations())
  .then(() => testSideEffectLedgerSkipsReadOnlyShellCommands())
  .then(() => testSideEffectLedgerKeepsMutatingShellEvenWithReadOnlyPrefix())
  .then(() => testInterruptedSideEffectSegmentUsesNewestEntries())
  .then(runInterruptedSideEffectCarryForwardCase)
  .then(runInterruptedWorkspaceBindingCase)
  .then(runInterruptedContextPatchCarryForwardCase)
  .then(runAgentProfileReplayNormalizationCase)
  .then(runAgentProfileReplayResetAfterPlainTurnCase)
  .then(runRawPromptPersistenceCase)
  .then(runToolProtocolReplayCase)
  .then(runToolOnlyAssistantReplayCase)
  .then(runReplaySanitizesInvalidToolProtocolBeforeGroupingCase)
  .then(runReplayCharEstimateIncludesToolAndThinkingCase)
  .then(runInternalContextCommitFilterCase)
  .then(runContextCompactionReplayCase)
  .then(runContextCompactionLlmReplayCase)
  .then(runToolResultArtifactCase)
  .then(runToolResultArtifactRootRejectsSymlinkCase)
  .then(runDigestSystemPromptCase)
  .then(runVisibleOutputTransportResetCreatesReplayCheckpointCase)
  .then(runPreVisibleTransportResetRemainsTerminalWithoutCheckpointCase)
  .then(runThinkingOnlyTransportResetRemainsTerminalWithoutCheckpointCase)
  .then(runTextAndThinkingTransportResetCheckpointsTextOnlyCase)
  .then(() => {
    console.log('context-history-replay test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
