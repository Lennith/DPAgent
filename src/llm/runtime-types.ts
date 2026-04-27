import type {
  APIProvider,
  ContextWindowTrimOptions,
  LLMResponse,
  Message,
  PreparedMessagesSnapshot,
  ResolvedLlmRuntimeConfig,
  ToolSchema,
} from '../types.js';

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
  onComplete?: (response: LLMResponse) => void;
}

export interface LLMClientConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxTokens: number;
  provider?: APIProvider;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  onPreparedMessages?: (snapshot: PreparedMessagesSnapshot) => void;
}

export interface LLMRequestOptions {
  maxTokens?: number;
  trimOptions?: ContextWindowTrimOptions;
  snapshotStage?: PreparedMessagesSnapshot['stage'];
}

export type LLMStreamEvent =
  | { type: 'text'; data: string }
  | { type: 'thinking'; data: string }
  | { type: 'tool_start'; data: { id: string; name: string } }
  | { type: 'tool_input'; data: string }
  | { type: 'complete'; data: LLMResponse };

export interface LLMRuntime {
  getRuntimeConfig?(): ResolvedLlmRuntimeConfig | undefined;
  generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown>;
  generateWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string,
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
}
