import * as assert from 'node:assert/strict';
import { ConfigManager, type MCPRuntimeConfig } from '../../src/config/ConfigManager.js';
import {
  buildMcpStatusResponse,
  summarizeMcpServers,
} from '../../src/runtime/dpagent-mcp-status.js';
import {
  resolveDPAgentExtraReadableDirs,
  sanitizeDroppedFileSessionToken,
} from '../../src/runtime/dpagent-readable-dirs.js';
import {
  assertDPAgentStartupConfig,
  resolveConfiguredMaxOutputTokens,
} from '../../src/runtime/dpagent-startup-config.js';
import {
  collectCommittedTurnMessagesFromSnapshot,
  filterCommittedTurnMessages,
} from '../../src/runtime/dpagent-turn-messages.js';
import type { AgentConfig, Message, ResolvedLlmRuntimeConfig } from '../../src/types.js';

function runtime(overrides: Partial<ResolvedLlmRuntimeConfig> = {}): ResolvedLlmRuntimeConfig {
  return {
    profileId: 'default',
    provider: 'anthropic',
    apiKey: 'a'.repeat(24),
    apiBase: 'https://api.example.test',
    model: 'model-a',
    maxOutputTokens: 1024,
    reasoningPreset: 'off',
    capabilities: {
      reasoningEffort: false,
      thinkingBudget: false,
    },
    ...overrides,
  };
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return new ConfigManager(overrides).get();
}

function msg(input: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: input.id ?? `${input.role}-${Math.random()}`,
    role: input.role,
    content: input.content,
    timestamp: input.timestamp ?? 1,
    metadata: input.metadata,
  };
}

function testReadableDirsIncludeConfiguredAndSessionDroppedFiles(): void {
  const cfg = config({
    agent: {
      skillsDir: 'D:\\skills',
      globalAgentsDir: 'D:\\agents',
      runtimeDataDir: 'D:\\runtime',
    } as Partial<AgentConfig['agent']> as AgentConfig['agent'],
  });

  assert.equal(sanitizeDroppedFileSessionToken('sess:bad/path'), 'sess_bad_path');
  assert.deepEqual(resolveDPAgentExtraReadableDirs(cfg), ['D:\\skills', 'D:\\agents']);
  assert.deepEqual(
    resolveDPAgentExtraReadableDirs(cfg, { scope: 'session', namespace: 'sess:bad/path' }),
    ['D:\\skills', 'D:\\agents', 'D:\\runtime\\dropped-files\\sess_bad_path']
  );
}

function testStartupConfigValidationUsesResolvedRuntime(): void {
  const cfg = config({
    agent: {
      workspaceDir: 'D:\\workspace',
      runtimeDataDir: 'D:\\runtime',
      contextDir: 'D:\\context',
      subAgentMaxParallelPerParent: 1,
      subAgentGlobalMaxParallel: 2,
      contextReplayMinRounds: 2,
      contextReplayMaxRounds: 3,
      contextReplayBudgetRatio: 0.5,
      contextOverflowMaxErrorsBeforeTrim: 1,
    } as Partial<AgentConfig['agent']> as AgentConfig['agent'],
  });
  assert.doesNotThrow(() => assertDPAgentStartupConfig(cfg, { llmRuntime: runtime() }));
  assert.throws(
    () => assertDPAgentStartupConfig(cfg, { llmRuntime: runtime({ apiKey: 'short' }) }),
    /apiKey must be set/
  );
  assert.throws(
    () =>
      assertDPAgentStartupConfig(
        config({
          agent: {
            ...cfg.agent,
            contextReplayMinRounds: 4,
            contextReplayMaxRounds: 3,
          } as AgentConfig['agent'],
        }),
        { llmRuntime: runtime() }
      ),
    /contextReplayMaxRounds must be >= agent.contextReplayMinRounds/
  );
  assert.equal(resolveConfiguredMaxOutputTokens(runtime({ maxOutputTokens: 4096 })), 4096);
  assert.throws(
    () => resolveConfiguredMaxOutputTokens(runtime({ maxOutputTokens: 0 })),
    /maxOutputTokens must be set/
  );
}

function testMcpStatusProjectionPreservesWireShape(): void {
  const runtimeConfig: MCPRuntimeConfig = {
    enabled: true,
    connectTimeout: 1000,
    executeTimeout: 2000,
    servers: [
      { name: 'connected', type: 'stdio', command: 'server-a' },
      { name: 'disabled', type: 'stdio', command: 'server-b', disabled: true },
      { name: 'missing', type: 'stdio', command: 'server-c' },
    ],
  };
  const status = buildMcpStatusResponse({
    runtime: runtimeConfig,
    nowIso: '2026-05-18T00:00:00.000Z',
    snapshot: {
      summary: { state: 'connected', connectedCount: 1, totalEnabled: 2 },
      servers: [
        {
          name: 'connected',
          status: 'connected',
          toolCount: 3,
          retryCount: 1,
          lastError: 'previous',
          updatedAt: '2026-05-18T00:00:01.000Z',
          disabled: false,
        },
        {
          name: 'disabled',
          status: 'connected',
          toolCount: 9,
          retryCount: 0,
          updatedAt: '2026-05-18T00:00:02.000Z',
          disabled: false,
        },
      ],
    },
  });

  assert.deepEqual(status, {
    enabled: true,
    summary: { state: 'connected', connectedCount: 1, totalEnabled: 2 },
    servers: [
      {
        name: 'connected',
        status: 'connected',
        toolCount: 3,
        retryCount: 1,
        lastError: 'previous',
        updatedAt: '2026-05-18T00:00:01.000Z',
        disabled: false,
      },
      {
        name: 'disabled',
        status: 'disabled',
        toolCount: 9,
        retryCount: 0,
        lastError: undefined,
        updatedAt: '2026-05-18T00:00:02.000Z',
        disabled: true,
      },
      {
        name: 'missing',
        status: 'idle',
        toolCount: 0,
        retryCount: 0,
        lastError: undefined,
        updatedAt: '2026-05-18T00:00:00.000Z',
        disabled: false,
      },
    ],
  });
  assert.deepEqual(
    summarizeMcpServers([
      {
        name: 'failed',
        status: 'failed',
        toolCount: 0,
        retryCount: 1,
        updatedAt: 'now',
        disabled: false,
      },
    ]),
    { state: 'degraded', connectedCount: 0, totalEnabled: 1 }
  );
}

function testCommittedTurnMessageFilteringAndSnapshotCollection(): void {
  assert.deepEqual(
    filterCommittedTurnMessages([
      msg({ role: 'user', content: '' }),
      msg({ role: 'assistant', content: '[SUMMARY_MESSAGES_APPLIED] hidden' }),
      msg({ role: 'assistant', content: '[CONTEXT_PRECOMPRESSED] keep marker' }),
      msg({ role: 'assistant', content: 'visible' }),
    ]).map((message) => message.content),
    ['[CONTEXT_PRECOMPRESSED] keep marker', 'visible']
  );

  const messages = [
    msg({ role: 'system', content: 'system prompt' }),
    msg({ role: 'user', content: 'old user' }),
    msg({ role: 'assistant', content: 'checkpoint assistant', metadata: { checkpointId: 'cp-1' } }),
    msg({ role: 'assistant', content: '[EXECUTION_CONTINUE_REQUIRED] hidden' }),
    msg({ role: 'assistant', content: 'current assistant' }),
  ];
  assert.deepEqual(
    collectCommittedTurnMessagesFromSnapshot(messages, 1).map((message) => message.content),
    ['checkpoint assistant', 'current assistant']
  );
  assert.notEqual(collectCommittedTurnMessagesFromSnapshot(messages, 1)[0], messages[2]);
}

testReadableDirsIncludeConfiguredAndSessionDroppedFiles();
testStartupConfigValidationUsesResolvedRuntime();
testMcpStatusProjectionPreservesWireShape();
testCommittedTurnMessageFilteringAndSnapshotCollection();

console.log('dpagent-runtime-support tests passed');
