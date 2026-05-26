import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import type { ContextEvent, ContextRef } from '../../src/types.js';

function createHarness(prefix: string): {
  tempDir: string;
  context: ContextRef;
  manager: ContextManager;
  eventStore: ContextEventStore;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `turn-summary-v2-${prefix}-`));
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(contextDir, { recursive: true });
  const eventStore = new ContextEventStore(contextDir);
  const manager = new ContextManager(eventStore);
  const context: ContextRef = {
    scope: 'session',
    namespace: `turn-summary-v2-${prefix}`,
  };
  return { tempDir, context, manager, eventStore };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function findRequiredEvent(events: ContextEvent[], type: ContextEvent['type']): ContextEvent {
  const found = [...events].reverse().find((event) => event.type === type);
  if (!found) {
    throw new Error(`Expected event type=${type} to exist`);
  }
  return found;
}

function testNonInjectedSummaryPersistsPromptAndFinalOutputWithoutTruncation(): void {
  const harness = createHarness('non-injected');
  try {
    const longPrompt = `user-prompt-${'x'.repeat(9000)}`;
    const longFinalOutput = `final-output-${'y'.repeat(11000)}`;
    const turn = harness.manager.beginTurn(harness.context, longPrompt, undefined, {
      rawUserPrompt: longPrompt,
      effectivePrompt: longPrompt,
      promptInjected: false,
    });
    harness.manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: longPrompt },
        { role: 'assistant', content: 'assistant message should not be the turn summary body' },
      ],
      rawUserPrompt: longPrompt,
      effectivePrompt: longPrompt,
      finalOutputText: longFinalOutput,
    finishReason: 'end_turn',
    });

    const events = harness.eventStore.readEvents(harness.context.scope, harness.context.namespace);
    const turnSummaryEvent = findRequiredEvent(events, 'turn_summary');
    const userEvent = findRequiredEvent(events, 'user_message');

    assert.equal(String(turnSummaryEvent.data.prompt ?? ''), longPrompt);
    assert.equal(turnSummaryEvent.data.promptRef, undefined);
    assert.equal(String(turnSummaryEvent.data.finalOutput ?? ''), longFinalOutput);
    assert.equal(String(turnSummaryEvent.data.finalOutput ?? '').includes('...(truncated)'), false);
    assert.equal(String(turnSummaryEvent.data.summary ?? '').includes('Assistant:'), false);
    assert.equal(String(userEvent.data.content ?? ''), longPrompt);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testInjectedSummaryStoresPromptRefOnlyAndPersistsRawPrompt(): void {
  const harness = createHarness('injected');
  try {
    const rawPrompt = 'Please show the current build status';
    const historyPrompt =
      '[AGENT_PROFILE_REF source=global name=Coder path=D:/Agent/Profiles/Coder.md]\n\n' + rawPrompt;
    const effectivePrompt =
      '[AGENT_PROFILE_REF source=global name=Coder path=D:/Agent/Profiles/Coder.md]\n' +
      '[AGENT_PROFILE_BODY_BEGIN]\n' +
      'Coder content\n' +
      '[AGENT_PROFILE_BODY_END]\n\n' +
      rawPrompt;
    const promptRef = '[PROMPT_REF reason=selected_agent source=global name=Coder]';
    const turn = harness.manager.beginTurn(harness.context, rawPrompt, undefined, {
      rawUserPrompt: rawPrompt,
      historyUserPrompt: historyPrompt,
      effectivePrompt,
      promptRef,
      promptInjected: true,
    });
    harness.manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: effectivePrompt },
        { role: 'assistant', content: 'assistant stream text' },
      ],
      rawUserPrompt: rawPrompt,
      historyUserPrompt: historyPrompt,
      effectivePrompt,
      promptRef,
      promptInjected: true,
      finalOutputText: 'authoritative final output',
    finishReason: 'end_turn',
    });

    const events = harness.eventStore.readEvents(harness.context.scope, harness.context.namespace);
    const turnStartedEvent = findRequiredEvent(events, 'turn_started');
    const turnSummaryEvent = findRequiredEvent(events, 'turn_summary');
    const userEvent = findRequiredEvent(events, 'user_message');

    assert.equal(String(turnStartedEvent.data.historyUserPrompt ?? ''), historyPrompt);
    assert.equal(String(turnStartedEvent.data.effectivePrompt ?? ''), effectivePrompt);
    assert.equal(String(turnStartedEvent.data.effectivePrompt ?? '').includes('Coder content'), true);
    assert.equal(turnSummaryEvent.data.prompt, undefined);
    assert.equal(String(turnSummaryEvent.data.promptRef ?? ''), promptRef);
    assert.equal(String(turnSummaryEvent.data.finalOutput ?? ''), 'authoritative final output');
    assert.equal(String(userEvent.data.content ?? ''), rawPrompt);

    const displayMessages = harness.manager.getConversationMessages(harness.context);
    assert.equal(String(displayMessages[0]?.content ?? ''), rawPrompt);

    const replayMessages = harness.manager.getConversationMessages(harness.context, {
      preserveAgentProfileRefs: true,
    });
    assert.equal(String(replayMessages[0]?.content ?? ''), rawPrompt);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testContextSnapshotOmitsActiveAgentRefAndPath(): void {
  const harness = createHarness('active-agent-snapshot');
  try {
    harness.manager.updateNamespaceMeta(harness.context, {
      agentInjectionState: {
        lastProfileSource: 'workspace',
        lastProfileName: 'workspace',
        lastProfilePath: 'D:/Repo/AGENTS.md',
        updatedAt: new Date().toISOString(),
      },
    });
    const loaded = harness.manager.loadForTurn(harness.context);
    assert.doesNotMatch(loaded.systemSegment, /### Active Agent/);
    assert.doesNotMatch(loaded.systemSegment, /\[AGENT_PROFILE_REF source=workspace name=workspace/);
    assert.doesNotMatch(loaded.systemSegment, /D:\/Repo\/AGENTS\.md/);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testFinalOutputUsesCommitFinalOutputTextInsteadOfAssistantMessage(): void {
  const harness = createHarness('final-output');
  try {
    const rawPrompt = 'Generate final answer';
    const turn = harness.manager.beginTurn(harness.context, rawPrompt);
    harness.manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: rawPrompt },
        { role: 'assistant', content: 'assistant-message-not-authoritative' },
      ],
      finalOutputText: 'result.content-authoritative',
    finishReason: 'end_turn',
    });

    const events = harness.eventStore.readEvents(harness.context.scope, harness.context.namespace);
    const turnSummaryEvent = findRequiredEvent(events, 'turn_summary');
    assert.equal(String(turnSummaryEvent.data.finalOutput ?? ''), 'result.content-authoritative');

    const projection = harness.manager.getProjection(harness.context);
    const latestTurn = projection.recentTurns[0];
    assert.ok(latestTurn);
    assert.equal(latestTurn?.finalOutput, 'result.content-authoritative');
    assert.equal(latestTurn?.assistant, 'result.content-authoritative');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function testReplayMessagesCollapseStreamingAssistantOutputToCommittedFinalOutput(): void {
  const harness = createHarness('replay-collapse');
  try {
    const rawPrompt = 'Why did the agent stop after text output?';
    const turn = harness.manager.beginTurn(harness.context, rawPrompt);
    harness.manager.commitTurn(turn.turnId, {
      messages: [
        { role: 'user', content: rawPrompt },
        { role: 'assistant', content: 'Let me inspect the event stream first.' },
        { role: 'assistant', content: 'Now I will trace the tool scheduling path.' },
      ],
      finalOutputText: 'Root cause confirmed: replay must use the committed final output only.',
      finishReason: 'end_turn',
    });

    const replayMessages = harness.manager.getConversationMessages(harness.context);
    assert.deepEqual(
      replayMessages.map((message) => ({
        role: message.role,
        content: String(message.content),
      })),
      [
        { role: 'user', content: rawPrompt },
        {
          role: 'assistant',
          content: 'Root cause confirmed: replay must use the committed final output only.',
        },
      ]
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

function runAll(): void {
  testNonInjectedSummaryPersistsPromptAndFinalOutputWithoutTruncation();
  testInjectedSummaryStoresPromptRefOnlyAndPersistsRawPrompt();
  testContextSnapshotOmitsActiveAgentRefAndPath();
  testFinalOutputUsesCommitFinalOutputTextInsteadOfAssistantMessage();
  testReplayMessagesCollapseStreamingAssistantOutputToCommittedFinalOutput();
  console.log('turn-summary-v2 tests passed');
}

runAll();
