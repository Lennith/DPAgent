import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../../src/index.js';
import type { LLMRequestOptions, LLMStreamEvent } from '../../src/llm/index.js';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';
import type { LLMResponse, ResolvedLlmRuntimeConfig, SessionLlmSelection, ToolSchema } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';

function createRuntimeConfig(tempDir: string, workspaceDir: string) {
  return createWebServerTestConfig({
    llmProfiles: {
      defaultProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          provider: 'openai',
          apiKey: 'sk-test-placeholder-key-1234567890',
          apiBase: 'https://api.example.test',
          defaultModel: 'test-model',
          models: ['test-model'],
          maxOutputTokens: 1024,
          capabilities: {
            reasoningEffort: false,
            thinkingBudget: false,
          },
        },
      ],
    },
    agent: {
      workspaceDir,
      runtimeDataDir: path.join(tempDir, 'runtime'),
      contextDir: path.join(tempDir, 'contexts'),
      globalAgentsDir: path.join(tempDir, 'agents'),
      skillsDir: path.join(tempDir, 'skills'),
    },
    mcp: {
      enabled: false,
      servers: [
        {
          name: 'disabled-noop',
          type: 'stdio',
          command: 'noop',
          disabled: true,
        },
      ],
      connectTimeout: 1,
      executeTimeout: 1,
    },
  });
}

async function testSessionRuntimeReceivesDownloadIssuer(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-session-download-tool-'));
  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  try {
    const workspaceDir = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, 'report.md');
    fs.writeFileSync(filePath, '# report\n', 'utf-8');

    const server = createWebServerDouble();
    server.sessionRuntimes = new Map();
    server.activeRunContexts = new Map();
    server.activeRunStatesByContext = new Map();
    server.bootMissingApiKey = true;
    server.downloadLinkService = {
      createLink: (input: { filename: string; displayPath: string; size: number }) => ({
        href: `http://localhost:53721/download/session/${input.filename}`,
        displayPath: input.displayPath,
        filename: input.filename,
        size: input.size,
        expiresAt: '2026-05-08T00:00:00.000Z',
      }),
    };
    server.agent = new DPAgent({
      config: createRuntimeConfig(tempDir, workspaceDir),
      allowMissingApiKeyAtBoot: true,
    });

    const llmSelection: SessionLlmSelection = {
      profileId: 'default',
      model: 'test-model',
      reasoningPreset: 'off',
      updatedAt: '2026-05-07T00:00:00.000Z',
    };
    const llmRuntime: ResolvedLlmRuntimeConfig = {
      profileId: 'default',
      provider: 'openai',
      apiKey: 'sk-test-placeholder-key-1234567890',
      apiBase: 'https://api.example.test',
      model: 'test-model',
      maxOutputTokens: 1024,
      reasoningPreset: 'off',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: false,
      },
    };

    const runtime = await server.ensureSessionRuntime('sess-download', workspaceDir, llmRuntime, llmSelection, []);
    assert.equal(runtime.reused, false);

    const capturedTools: ToolSchema[][] = [];
    let callCount = 0;
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      _payload: PreparedProviderPayload,
      tools?: ToolSchema[],
      _options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedTools.push(tools ?? []);
      callCount += 1;
      if (callCount === 1) {
        const response: LLMResponse = {
          content: '',
          finishReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-send-file',
              type: 'function',
              function: {
                name: 'send_file_to_user',
                arguments: { path: filePath },
              },
            },
          ],
        };
        yield { type: 'complete', data: response };
        return response;
      }
      const response: LLMResponse = {
        content: 'download done',
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    const context = {
      scope: 'session' as const,
      namespace: 'sess-download',
    };
    const result = await runtime.agent.runWithResult({
      prompt: 'Send report.md to the user.',
      context,
      workspaceDir,
    });
    assert.equal(result.content, 'download done');
    assert.equal(callCount, 2);
    assert.equal(capturedTools[0]?.some((tool) => tool.name === 'send_file_to_user'), true);

    const toolMessage = runtime.agent.getContextMessages(context).find(
      (message) => message.role === 'tool' && message.name === 'send_file_to_user'
    );
    assert.ok(toolMessage);
    const payload = JSON.parse(String(toolMessage.content)) as { href: string; displayPath: string };
    assert.equal(payload.href, 'http://localhost:53721/download/session/report.md');
    assert.equal(payload.displayPath, path.normalize(filePath));
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDefaultDownloadBaseIsSameOriginRelative(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-session-download-base-'));
  try {
    const workspaceDir = path.join(tempDir, 'workspace');
    const server = createWebServerDouble();
    server.port = 53721;
    const base = server.resolveDownloadPublicBaseUrl(createRuntimeConfig(tempDir, workspaceDir));
    assert.equal(base, '');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testDefaultDownloadBaseIsSameOriginRelative();

testSessionRuntimeReceivesDownloadIssuer()
  .then(() => {
    console.log('web-session-download-tool tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
