import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import { estimateMessageCharacters, type LLMClient } from '../../src/llm/index.js';
import {
  buildInterruptedSideEffectSegment,
  buildSideEffectLedgerFromPreview,
  slicePreviewMessages,
} from '../../src/interrupted-turn-recovery.js';
import type { ContextRef, Message } from '../../src/types.js';

class ScriptedLLMClient {
  private readonly responses: string[];
  private index = 0;
  public readonly calls: Message[][] = [];
  public readonly systemPrompts: string[] = [];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: {
      onThinking?: (thinking: string) => void;
      onText?: (text: string) => void;
      onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
      onComplete?: (result: unknown) => void;
    },
    _tools?: unknown,
    systemPrompt?: string
  ): Promise<{
    content: string;
    finishReason: string;
  }> {
    this.calls.push(messages.map((message) => ({ ...message })));
    this.systemPrompts.push(String(systemPrompt ?? ''));
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error(`ScriptedLLMClient missing response at index=${this.index}`);
    }
    this.index += 1;
    callbacks.onText?.(response);
    callbacks.onComplete?.({ content: response, finishReason: 'end_turn' });
    return {
      content: response,
      finishReason: 'end_turn',
    };
  }

  async generate(messages: Message[]): Promise<{
    content: string;
    finishReason: string;
  }> {
    const seed = messageToText(messages[0]?.content ?? '').slice(0, 40) || 'digest';
    return {
      content: `compressed-${seed}`,
      finishReason: 'end_turn',
    };
  }
}

function createHarness(prefix: string): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `context-history-replay-${prefix}-`));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function messageToText(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }
      if (block.type === 'tool_result') {
        return block.content ?? '';
      }
      if (block.type === 'tool_use') {
        return JSON.stringify(block.input ?? {});
      }
      return '';
    })
    .join('\n');
}

function createAgent(harness: {
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
}, llm: ScriptedLLMClient): MiniMaxAgent {
  const agent = new MiniMaxAgent({
    allowMissingApiKeyAtBoot: true,
    configPath: path.join(process.cwd(), 'config.yaml'),
    workspaceDir: harness.workspaceDir,
    runtimeDataDir: harness.runtimeDir,
    contextDir: harness.contextDir,
  });
  const asAny = agent as unknown as {
    llmClient: LLMClient;
    toolRegistry: ToolRegistry;
    fullSystemPrompt: string;
    memoryPromotionCoordinator: {
      noteCommittedTurn: (...args: unknown[]) => Promise<void>;
    };
  };
  asAny.llmClient = llm as unknown as LLMClient;
  asAny.toolRegistry = new ToolRegistry();
  asAny.fullSystemPrompt = 'You are a unit-test assistant.';
  asAny.memoryPromotionCoordinator.noteCommittedTurn = async () => undefined;
  return agent;
}

function appendTurn(agent: MiniMaxAgent, context: ContextRef, prompt: string, answer: string): void {
  const manager = agent.getContextManager();
  const turn = manager.beginTurn(context, prompt);
  manager.commitTurn(turn.turnId, {
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: answer },
    ],
    finishReason: 'end_turn',
  });
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
      resumable: true,
      resumeToken: 'resume-1',
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

function appendToolTurn(agent: MiniMaxAgent, context: ContextRef, input: {
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
            content:
              '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nfirst from history',
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
            content:
              '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nsecond from history',
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
    assert.match(
      String(replayMessages[0]?.content ?? ''),
      /^\[AGENT_PROFILE_REF source=workspace name=workspace path=D:\/Repo\/AGENTS\.md\]\n\nfirst from history$/
    );

    await agent.runWithResult({
      prompt: 'third question',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const call = llm.calls[0] ?? [];
    const userMessages = call.filter((message) => message.role === 'user').map((message) => messageToText(message.content));
    assert.equal(
      userMessages.includes(
        '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nfirst from history'
      ),
      true
    );
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
            content:
              '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nfirst from history',
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
            content:
              '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nsecond from history',
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
    assert.equal(
      userMessages.includes(
        '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nfirst from history'
      ),
      true
    );
    assert.equal(userMessages.includes('plain middle turn'), true);
    assert.equal(
      userMessages.includes(
        '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nsecond from history'
      ),
      true
    );
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
      historyUserPrompt: '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\nImplement login',
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
          thinking: 'Need to inspect package.json before answering.',
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
          content: '{\"name\":\"minimax-agent\"}',
          toolCallId: 'call-package-read',
          name: 'read_file',
        },
        { role: 'assistant', content: 'The package name is minimax-agent.' },
      ],
      finalOutputText: 'The package name is minimax-agent.',
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
        message.thinking === 'Need to inspect package.json before answering.' &&
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
  const harness = createHarness('replay-char-estimate');
  const llm = new ScriptedLLMClient(['unused']);

  try {
    const agent = createAgent(harness, llm);
    const agentAny = agent as unknown as {
      estimateReplayMessageChars: (message: Message) => number;
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

    const plainChars = agentAny.estimateReplayMessageChars(plainAssistant);
    const richChars = agentAny.estimateReplayMessageChars(richAssistant);
    const sharedRichChars = estimateMessageCharacters(richAssistant);
    const sharedToolChars = estimateMessageCharacters(richToolMessage);
    const toolChars = agentAny.estimateReplayMessageChars(richToolMessage);

    assert.equal(richChars > plainChars, true);
    assert.equal(richChars, sharedRichChars);
    assert.equal(toolChars, sharedToolChars);
    assert.equal(toolChars > 'tool-result-content'.length, true);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runInternalContextCommitFilterCase(): Promise<void> {
  const harness = createHarness('internal-filter');
  const llm = new ScriptedLLMClient(['unused answer']);
  try {
    const agent = createAgent(harness, llm);
    const agentAny = agent as unknown as {
      filterCommittedTurnMessages: (messages: Message[]) => Message[];
    };
    const filtered = agentAny.filterCommittedTurnMessages([
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
          id: 'tool-plan-1',
          type: 'function',
          function: {
            name: 'update_plan',
            arguments: { plan: [{ step: 'Patch file', status: 'completed' }] },
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
      content: '{"success":true,"content":"plan updated"}',
      toolCallId: 'tool-plan-1',
      name: 'update_plan',
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
      resumable: true,
      resumeToken: 'resume-ledger-1',
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
      resumable: true,
      resumeToken: 'resume-workspace-1',
    });

    assert.equal(agent.resolveWorkspaceDirForContext(context), interruptedWorkspaceDir);

    await agent.runWithResult({
      prompt: 'continue with conflicting explicit workspace',
      context,
      workspaceDir: harness.workspaceDir,
      resumeRequested: true,
      resumeToken: 'resume-workspace-1',
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
      resumable: true,
      resumeToken: 'resume-workspace-2',
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
      resumable: true,
      resumeToken: 'resume-context-patch-1',
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

function runLegacyToolResultLazyArtifactCase(): void {
  const harness = createHarness('legacy-tool-result-artifact');
  const llm = new ScriptedLLMClient(['unused']);
  const context: ContextRef = {
    scope: 'session',
    namespace: 'context-history-legacy-tool-artifact',
  };
  try {
    const agent = createAgent(harness, llm);
    const manager = agent.getContextManager();
    const turn = manager.beginTurn(context, 'legacy huge tool');
    const hugeResult = 'legacy-line\n'.repeat(6000);
    manager.commitTurn(turn.turnId, {
      messages: [
        {
          role: 'assistant',
          content: 'running shell',
          toolCalls: [
            {
              id: 'call-legacy-large',
              type: 'function',
              function: { name: 'shell_execute', arguments: { command: 'long output' } },
            },
          ],
        },
        {
          role: 'tool',
          name: 'shell_execute',
          toolCallId: 'call-legacy-large',
          content: hugeResult,
        },
      ],
      finalOutputText: 'done',
      finishReason: 'end_turn',
    });

    const replay = manager.getConversationMessages(context);
    const toolMessage = replay.find((message) => message.role === 'tool');
    const artifact = toolMessage?.metadata?.toolResultArtifact;
    assert.ok(artifact);
    assert.match(String(toolMessage?.content ?? ''), /TOOL_RESULT_STORED/);
    assert.equal(artifact?.originalChars, hugeResult.trim().length);
    const read = manager.readToolResultArtifact(context, {
      artifactId: artifact?.artifactId ?? '',
      offset: 1,
      limit: 2,
      maxChars: 1000,
    });
    assert.equal(read.success, true);
    assert.match(read.content, /legacy-line/);
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
        contextWindowChars: 100000,
        contextPrecompressTriggerRatio: 0.1,
        contextCompressionMaxChars: 4000,
      },
    });

    appendTurn(
      agent,
      context,
      `[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\n${makeLongText('legacy first task')}`,
      makeLongText('legacy first answer')
    );
    appendTurn(agent, context, makeLongText('plain middle task'), makeLongText('plain middle answer'));
    appendTurn(
      agent,
      context,
      `[AGENT_PROFILE_REF source=workspace name=workspace path=D:/Repo/AGENTS.md]\n\n${makeLongText('legacy second task')}`,
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

runCase()
  .then(() => testCancelledTurnDoesNotReplayAssistantOutput())
  .then(() => testInterruptedCheckpointTurnIsHiddenByDefaultButAvailableForReplay())
  .then(() => testInterruptedCheckpointToolBundleDoesNotInventTrailingAssistantOutput())
  .then(() => testReplayCheckpointTruncatesPartialToolBundle())
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
  .then(runLegacyToolResultLazyArtifactCase)
  .then(runToolResultArtifactRootRejectsSymlinkCase)
  .then(runDigestSystemPromptCase)
  .then(() => {
    console.log('context-history-replay test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
