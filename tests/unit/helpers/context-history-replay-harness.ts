import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../../../src/index.js';
import { ToolRegistry } from '../../../src/tools/index.js';
import type { LLMClient } from '../../../src/llm/index.js';
import type { ContextRef, Message } from '../../../src/types.js';

export class ScriptedLLMClient {
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

  async generatePreparedWithCallbacks(
    ...args: Parameters<ScriptedLLMClient['generateWithCallbacks']>
  ): ReturnType<ScriptedLLMClient['generateWithCallbacks']> {
    return this.generateWithCallbacks(...args);
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

export function createHarness(prefix: string): {
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

export function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

export function messageToText(content: Message['content']): string {
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

export function createAgent(harness: {
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
}, llm: ScriptedLLMClient): DPAgent {
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

export function appendTurn(agent: DPAgent, context: ContextRef, prompt: string, answer: string): void {
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
