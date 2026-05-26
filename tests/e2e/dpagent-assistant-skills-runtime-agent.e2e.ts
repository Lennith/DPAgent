import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { DPAgent } from '../../src/index.js';
import { createWebServer } from '../../src/web/server/WebServer.js';
import type {
  AgentCallback,
  ContextRef,
  LLMResponse,
  Message,
  ToolCall,
  ToolResult,
  ToolSchema,
} from '../../src/types.js';
import type {
  LLMRequestOptions,
  LLMRuntime,
  StreamCallbacks,
} from '../../src/llm/index.js';
import {
  resolveDpAgentAssistantRuntimeOverrides,
  resolveDpAgentAssistantSkillScript,
} from '../helpers/dpagent-assistant-skill-paths.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate test port.')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: args,
    },
  };
}

function psQuote(value: string): string {
  return `"${value.replace(/`/g, '``').replace(/"/g, '`"')}"`;
}

function debugLog(message: string): void {
  if (process.env.DEBUG_DPAI_SKILLS_E2E !== '1') {
    return;
  }
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
  fs.appendFileSync(path.join(process.cwd(), 'logs', 'dpagent-assistant-skills-e2e-debug.log'), line, 'utf8');
}

class ScriptedToolLlm implements LLMRuntime {
  private index = 0;
  readonly calls: Array<{ tools: string[]; messages: Message[] }> = [];

  constructor(private readonly responses: LLMResponse[]) {}

  getRuntimeConfig() {
    return {
      profileId: 'scripted',
      provider: 'openai' as const,
      apiKey: 'test-api-key-0123456789012345',
      apiBase: 'https://openai-compatible.local/v1',
      model: 'scripted-model',
      maxOutputTokens: 4096,
      reasoningPreset: 'off' as const,
      capabilities: {
        modelDiscovery: false,
        reasoningEffort: false,
        thinkingBudget: false,
      },
    };
  }

  async generatePreparedWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    _systemPrompt?: string,
    _options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.calls.push({
      tools: (tools ?? []).map((tool) => tool.name),
      messages: messages.map((message) => ({ ...message })),
    });
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`ScriptedToolLlm missing response at index=${this.index}`);
    }
    this.index += 1;
    for (const call of response.toolCalls ?? []) {
      callbacks.onToolUse?.(call.id, call.function.name, call.function.arguments);
    }
    if (response.content) {
      callbacks.onText?.(response.content);
    }
    callbacks.onComplete?.(response);
    return response;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    return this.generatePreparedWithCallbacks(messages, callbacks, tools, systemPrompt, options);
  }

  async generate(): Promise<LLMResponse> {
    return { content: 'compressed', finishReason: 'end_turn' };
  }

  async *generateStream(): AsyncGenerator<never, LLMResponse, unknown> {
    return { content: 'stream-unused', finishReason: 'end_turn' };
  }
}

async function main(): Promise<void> {
  debugLog('main start');
  const repoRoot = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-assistant-skills-runtime-agent-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const globalAgentsDir = path.join(tempDir, 'external-agents');
  const serverRuntimeDir = path.join(tempDir, 'server-runtime');
  const serverContextDir = path.join(tempDir, 'server-contexts');
  const configPath = path.join(tempDir, 'config.yaml');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(globalAgentsDir, { recursive: true });
  fs.mkdirSync(serverRuntimeDir, { recursive: true });
  fs.mkdirSync(serverContextDir, { recursive: true });

  fs.writeFileSync(
    configPath,
    yaml.dump({
      llmProfiles: {
        defaultProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            provider: 'openai',
            apiKey: 'test-api-key-0123456789012345',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'scripted-model',
            availableModels: ['scripted-model'],
            maxOutputTokens: 4096,
            enabled: true,
          },
        ],
      },
      agent: {
        workspaceDir,
        runtimeDataDir: serverRuntimeDir,
        contextDir: serverContextDir,
        globalAgentsDir,
        defaultToolset: 'full-access',
      },
      tools: {
        enableFileTools: true,
        enableWeb: false,
        enableShell: true,
        shellType: 'powershell',
        shellTimeout: 120000,
      },
      mcp: {
        enabled: false,
        servers: [
          {
            name: 'disabled-test-mcp',
            type: 'stdio',
            command: 'node',
            args: ['-e', 'process.exit(0)'],
            disabled: true,
          },
        ],
      },
    }),
    'utf8'
  );

  debugLog('allocating port');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  debugLog(`creating web server ${baseUrl}`);
  const server = createWebServer({ port, configPath, allowMissingApiKeyAtBoot: true });
  const payloadPath = path.join(tempDir, 'novelist-agent.json');
  const updateVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      agent: {
        name: 'Novelist',
        content: '# Novelist\nWrite compact literary scenes for DPAgent tests.',
        config: {
          version: 1,
          description: 'Runtime E2E novelist',
          toolsetName: 'novelist-tools',
          allowedTools: ['read_file'],
          maxSteps: 8,
          timeoutMs: 120000,
          exposeAsSubagent: true,
        },
      },
      toolsets: {
        upsert: [
          {
            name: 'novelist-tools',
            description: 'Read-only novelist authoring toolset',
            capabilities: ['file_read'],
          },
        ],
      },
    }),
    'utf8'
  );

  const agentCreateScript = resolveDpAgentAssistantSkillScript('dpagent-agent-create', path.join('scripts', 'run.js'));
  const updateScript = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  const createDryRunCommand = [
    'node',
    psQuote(agentCreateScript),
    'validate',
    '--base-url',
    psQuote(baseUrl),
    '--json',
    psQuote(`@${payloadPath}`),
    '--dry-run',
    'true',
    '--output',
    'json',
  ].join(' ');
  const createApplyCommand = [
    'node',
    psQuote(agentCreateScript),
    'apply',
    '--base-url',
    psQuote(baseUrl),
    '--json',
    psQuote(`@${payloadPath}`),
    '--confirm',
    'yes',
    '--output',
    'json',
  ].join(' ');
  const updateDryRunCommand = [
    'node',
    psQuote(updateScript),
    'start',
    '--base-url',
    psQuote(baseUrl),
    '--target-version',
    updateVersion,
    '--allow-source',
    'true',
    '--dry-run',
    'true',
    '--output',
    'json',
  ].join(' ');

  const llm = new ScriptedToolLlm([
    { content: '', finishReason: 'tool_calls', toolCalls: [toolCall('tc-skill-agent', 'skills_view', { name: 'dpagent-agent-create' })] },
    { content: '', finishReason: 'tool_calls', toolCalls: [toolCall('tc-agent-dry', 'shell_execute', { command: createDryRunCommand })] },
    { content: '', finishReason: 'tool_calls', toolCalls: [toolCall('tc-agent-apply', 'shell_execute', { command: createApplyCommand })] },
    { content: '', finishReason: 'tool_calls', toolCalls: [toolCall('tc-skill-update', 'skills_view', { name: 'dpagent-update' })] },
    { content: '', finishReason: 'tool_calls', toolCalls: [toolCall('tc-update-dry', 'shell_execute', { command: updateDryRunCommand })] },
    { content: 'DPAgent assistant skills runtime E2E complete.', finishReason: 'end_turn' },
  ]);

  debugLog('creating runtime agent');
  const runtimeAgent = new DPAgent({
    config: {
      llmProfiles: {
        defaultProfileId: 'default',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            provider: 'openai',
            apiKey: 'test-api-key-0123456789012345',
            apiBase: 'https://openai-compatible.local/v1',
            defaultModel: 'scripted-model',
            availableModels: ['scripted-model'],
            maxOutputTokens: 4096,
            enabled: true,
          },
        ],
      },
      agent: {
        workspaceDir,
        runtimeDataDir,
        contextDir,
        defaultToolset: 'full-access',
        maxSteps: 20,
        tokenLimit: 120000,
        subAgentMaxParallelPerParent: 4,
        subAgentGlobalMaxParallel: 10,
      },
      tools: {
        enableFileTools: true,
        enableWeb: false,
        enableShell: true,
        shellType: 'powershell',
        shellTimeout: 120000,
      },
      mcp: {
        enabled: false,
        servers: [],
        connectTimeout: 10,
        executeTimeout: 60,
      },
    },
    allowMissingApiKeyAtBoot: true,
  });
  const toolResults: Array<{ name: string; result: ToolResult }> = [];
  const callback: AgentCallback = {
    onToolCall: (name, args) => {
      debugLog(`tool_call ${name} ${JSON.stringify(args).slice(0, 240)}`);
    },
    onToolResult: (name, result) => {
      debugLog(`tool_result ${name} success=${result.success} ${String(result.error ?? result.content).slice(0, 240)}`);
      toolResults.push({ name, result });
    },
  };

  try {
    debugLog(`starting server ${baseUrl}`);
    await server.start();
    debugLog('initializing runtime agent');
    await runtimeAgent.initialize(callback);
    (runtimeAgent as unknown as { llmClient: LLMRuntime }).llmClient = llm;
    const context: ContextRef = { scope: 'session', namespace: 'dpagent-assistant-skill-runtime-e2e' };
    debugLog('running scripted agent');
    const result = await runtimeAgent.runWithResult({
      context,
      prompt: 'Use the DPAgent assistant skills to create a Novelist external agent and dry-run a DPAgent update.',
      callback,
      agentRuntimeOverrides: resolveDpAgentAssistantRuntimeOverrides(),
    });
    debugLog('scripted agent completed');
    assert.equal(result.content, 'DPAgent assistant skills runtime E2E complete.');
    assert.equal(llm.calls.some((call) => call.tools.includes('skills_view')), true);
    assert.equal(llm.calls.some((call) => call.tools.includes('shell_execute')), true);
    assert.equal(toolResults.length >= 5, true);
    for (const item of toolResults) {
      assert.equal(item.result.success, true, `${item.name} failed: ${item.result.error ?? item.result.content}`);
      assert.doesNotMatch(item.result.content, /"success":false|tool_error|Traceback|Unhandled/i);
    }
    assert.match(fs.readFileSync(path.join(globalAgentsDir, 'Novelist', 'AGENTS.md'), 'utf8'), /compact literary scenes/);
    assert.match(fs.readFileSync(path.join(globalAgentsDir, 'Novelist', 'agent.yaml'), 'utf8'), /toolsetName: novelist-tools/);
  } finally {
    debugLog('cleanup start');
    await runtimeAgent.cleanup().catch(() => undefined);
    await Promise.race([
      server.stop().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
    fs.rmSync(tempDir, { recursive: true, force: true });
    debugLog('cleanup complete');
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
