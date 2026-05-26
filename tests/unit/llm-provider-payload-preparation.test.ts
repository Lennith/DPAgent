import * as assert from 'node:assert/strict';
import { LLMClient, analyzeToolProtocol, assertReplaySafeToolProtocol } from '../../src/llm/index.js';
import type { LLMResponse, Message } from '../../src/types.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';

function createClientWithCapturedMessages(captured: {
  messages?: Message[];
  systemPrompt?: string;
  snapshots: unknown[];
}): LLMClient {
  const client = new LLMClient({
    apiKey: 'test-api-key',
    apiBase: 'https://api.minimaxi.com',
    model: 'MiniMax-M2.7',
    maxTokens: 4096,
    provider: 'anthropic',
    onPreparedMessages: (snapshot) => {
      captured.snapshots.push(snapshot);
    },
  });
  const complete = async (payload: PreparedProviderPayload): Promise<LLMResponse> => {
      captured.messages = payload.messages;
      captured.systemPrompt = payload.systemPrompt;
      return {
        content: 'ok',
        finishReason: 'end_turn',
      };
    };
  (client as unknown as { adapter: {
    generate: (payload: PreparedProviderPayload) => Promise<LLMResponse>;
    generateStream: (payload: PreparedProviderPayload) => AsyncGenerator<{ type: 'complete'; data: LLMResponse }, LLMResponse, unknown>;
  } }).adapter = {
    generate: complete,
    generateStream: async function* (payload: PreparedProviderPayload) {
      const response = await complete(payload);
      yield { type: 'complete', data: response };
      return response;
    },
  };
  return client;
}

async function testPreparedPayloadBypassesSecondTrim(): Promise<void> {
  const captured: { messages?: Message[]; snapshots: unknown[] } = { snapshots: [] };
  const client = createClientWithCapturedMessages(captured);
  const longContent = 'authoritative provider payload '.repeat(200);

  await client.generatePreparedWithCallbacks([{ role: 'user', content: longContent }], {}, undefined, undefined, {
    trimOptions: {
      maxTotalChars: 100,
      keepLatestCount: 1,
      maxToolChars: 50,
      maxNonToolChars: 50,
    },
  });

  assert.equal(captured.messages?.[0]?.content, longContent);
  const snapshot = captured.snapshots[0] as {
    trim: { originalChars: number; trimmedChars: number; removedCount: number; truncatedCount: number };
  };
  assert.equal(snapshot.trim.originalChars, longContent.length);
  assert.equal(snapshot.trim.trimmedChars, longContent.length);
  assert.equal(snapshot.trim.removedCount, 0);
  assert.equal(snapshot.trim.truncatedCount, 0);
}

async function testProviderPayloadMovesSystemToSystemPrompt(): Promise<void> {
  const captured: { messages?: Message[]; systemPrompt?: string; snapshots: unknown[] } = { snapshots: [] };
  const client = createClientWithCapturedMessages(captured);

  await client.generate(
    [
      { role: 'system', content: 'system from messages' },
      { role: 'user', content: 'hello' },
    ],
    undefined,
    'explicit system'
  );

  assert.deepEqual(
    captured.messages?.map((message) => message.role),
    ['user']
  );
  assert.equal(captured.systemPrompt, 'explicit system\n\nsystem from messages');
  const snapshot = captured.snapshots[0] as { trim: { originalChars: number } };
  assert.equal(snapshot.trim.originalChars, 'system from messages'.length + 'hello'.length);
}

async function testRawSystemMessageDoesNotMaskMalformedToolReplay(): Promise<void> {
  const captured: { messages?: Message[]; systemPrompt?: string; snapshots: unknown[] } = { snapshots: [] };
  const client = createClientWithCapturedMessages(captured);

  await client.generate([
    {
      role: 'assistant',
      content: 'call',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: {} } }],
    },
    { role: 'system', content: 'system between assistant and tool result' },
    { role: 'tool', toolCallId: 'call-1', name: 'read_file', content: 'result' },
  ]);

  assert.equal(captured.systemPrompt, 'system between assistant and tool result');
  assert.equal(captured.messages?.some((message) => message.role === 'system'), false);
  assert.equal(captured.messages?.some((message) => (message.toolCalls?.length ?? 0) > 0), false);
  assert.equal(
    captured.messages?.some((message) => String(message.content).includes('replay_action=dropped_invalid_tool_protocol')),
    true
  );
}

async function testMalformedPreparedPayloadFailsBeforeAdapter(): Promise<void> {
  const captured: { messages?: Message[]; snapshots: unknown[] } = { snapshots: [] };
  const client = createClientWithCapturedMessages(captured);
  const malformed: Message[] = [
    {
      role: 'assistant',
      content: 'call',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: {} } }],
    },
  ];

  await assert.rejects(
    () => client.generatePreparedWithCallbacks(malformed, {}),
    /INVALID_REPLAY_PROTOCOL/
  );
  assert.equal(captured.messages, undefined);
}

async function testUnpreparedPayloadStillUsesLlmClientTrim(): Promise<void> {
  const captured: { messages?: Message[]; snapshots: unknown[] } = { snapshots: [] };
  const client = createClientWithCapturedMessages(captured);
  const longContent = 'llm-client-owned trim '.repeat(200);

  await client.generate([{ role: 'user', content: longContent }], undefined, undefined, {
    trimOptions: {
      maxTotalChars: 100,
      keepLatestCount: 1,
      maxToolChars: 50,
      maxNonToolChars: 50,
    },
  });

  assert.notEqual(captured.messages?.[0]?.content, longContent);
  assert.match(String(captured.messages?.[0]?.content ?? ''), /CONTEXT_TRUNCATED/);
}

function testAnalyzerProvidesReplaySafeDiagnostics(): void {
  const validMessages: Message[] = [
    {
      role: 'assistant',
      content: 'call',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: {} } }],
    },
    { role: 'tool', toolCallId: 'call-1', name: 'read_file', content: 'result' },
  ];
  const valid = analyzeToolProtocol(validMessages);
  assert.equal(valid.assistantToolBundleCount, 1);
  assert.equal(valid.orphanToolResultCount, 0);
  assert.equal(valid.invalidAssistantToolBundleCount, 0);
  assert.doesNotThrow(() => assertReplaySafeToolProtocol(validMessages));

  const invalidMessages: Message[] = [
    {
      role: 'assistant',
      content: 'call',
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: {} } }],
    },
    { role: 'tool', toolCallId: 'wrong-call', name: 'read_file', content: 'result' },
  ];
  const invalid = analyzeToolProtocol(invalidMessages);
  assert.equal(invalid.assistantToolBundleCount, 0);
  assert.equal(invalid.invalidAssistantToolBundleCount, 1);
  assert.equal(invalid.orphanToolResultCount, 1);
  assert.throws(() => assertReplaySafeToolProtocol(invalidMessages), /INVALID_REPLAY_PROTOCOL/);
}

async function runAll(): Promise<void> {
  await testPreparedPayloadBypassesSecondTrim();
  await testUnpreparedPayloadStillUsesLlmClientTrim();
  await testProviderPayloadMovesSystemToSystemPrompt();
  await testRawSystemMessageDoesNotMaskMalformedToolReplay();
  await testMalformedPreparedPayloadFailsBeforeAdapter();
  testAnalyzerProvidesReplaySafeDiagnostics();
  console.log('llm-provider-payload-preparation tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
