import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import { ToolRegistry } from '../../src/tools/index.js';
import type { ContextRef, LLMResponse, Message } from '../../src/types.js';
import type { LLMClient } from '../../src/llm/index.js';
import { cleanupIntegrationHarness, createIntegrationHarness } from './helpers/integration-harness.js';

class ScriptedLLMClient {
  async generateWithCallbacks(
    _messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onComplete?: (result: LLMResponse) => void;
    }
  ): Promise<LLMResponse> {
    const content = 'Confirmed. I will remember the workspace publish flow and use npm run build:web.';
    callbacks.onText?.(content);
    const response: LLMResponse = {
      content,
      finishReason: 'end_turn',
    };
    callbacks.onComplete?.(response);
    return response;
  }

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
  }

  async generate(): Promise<LLMResponse> {
    return {
      content: JSON.stringify({
        items: [
          {
            turnId: 'turn-1',
            decision: 'memory_candidate',
            scope: 'workspace',
            title: 'Workspace publish flow',
            content: 'Use npm run build:web before publish.',
            reason: 'stable workspace release command',
            stability: 'stable',
            conflictHints: [],
          },
        ],
      }),
      finishReason: 'end_turn',
    };
  }
}

async function runCase(): Promise<void> {
  const harness = createIntegrationHarness('p0-session-transcript-search-');
  const context: ContextRef = {
    scope: 'session',
    namespace: 'p0-memory-search',
  };
  try {
    const agent = new DPAgent({
      allowMissingApiKeyAtBoot: true,
      configPath: path.join(process.cwd(), 'config.example.yaml'),
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
    });
    const asAny = agent as unknown as {
      llmClient: LLMClient;
      toolRegistry: ToolRegistry;
      fullSystemPrompt: string;
    };
    asAny.llmClient = new ScriptedLLMClient() as unknown as LLMClient;
    asAny.toolRegistry = new ToolRegistry();
    asAny.fullSystemPrompt = 'You are a unit-test assistant.';

    await agent.runWithResult({
      prompt: 'Please remember that this workspace uses npm run build:web before publish.',
      context,
      workspaceDir: harness.workspaceDir,
    });

    const organizeResult = await agent.organizeSessionMemory({
      sessionId: context.namespace,
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(organizeResult.appliedCount, 1);
    assert.equal(organizeResult.pendingTurnCount, 0);

    const hits = agent.getSessionSearchIndex().search('build web publish command', {
      workspaceDir: harness.workspaceDir,
      maxResults: 5,
    });
    assert.equal(hits.length > 0, true);
    assert.equal(hits.every((item) => item.kind === 'session'), true);
    assert.equal(hits.some((item) => item.sessionId === context.namespace), true);
    assert.equal(
      hits.some((item) => item.excerpt.includes('npm run build:web before publish')),
      true
    );

    const searchDocPath = path.join(
      harness.runtimeDir,
      'session-search',
      'sessions',
      `${encodeURIComponent(context.namespace)}.json`
    );
    const searchDoc = JSON.parse(fs.readFileSync(searchDocPath, 'utf-8')) as {
      turnExcerpts: string[];
      workspaceDir?: string;
      updatedAt: string;
    };
    assert.equal(Array.isArray(searchDoc.turnExcerpts), true);
    assert.equal(searchDoc.turnExcerpts.length > 0, true);
    assert.equal(
      searchDoc.turnExcerpts.some((excerpt) => excerpt.includes('npm run build:web before publish')),
      true
    );
    assert.deepEqual(
      Object.keys(searchDoc).sort(),
      ['namespace', 'scope', 'sessionId', 'turnExcerpts', 'updatedAt', 'workspaceDir'].sort()
    );

    console.log('p0-session-transcript-search integration test passed');
  } finally {
    cleanupIntegrationHarness(harness);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
