import type { APIProvider, ResolvedLlmRuntimeConfig } from '../../types.js';

export type LlmVendorDialectId =
  | 'official-anthropic'
  | 'official-openai'
  | 'generic-anthropic-compatible'
  | 'generic-openai-compatible'
  | 'minimax'
  | 'deepseek'
  | 'xiaomi-mimo';

export type AnthropicReasoningRequestMode = 'thinking_budget' | 'output_config_effort';

export interface LlmVendorDialectContext {
  provider?: APIProvider;
  profileId?: string;
  apiBase?: string;
  model?: string;
}

export interface LlmVendorDialectPolicy {
  id: LlmVendorDialectId;
  label: string;
  matches: (context: LlmVendorDialectContext) => boolean;
  endpoint: {
    normalizeAnthropicBaseUrl: 'none' | 'minimax-compatible';
  };
  anthropic: {
    allowUnsignedThinkingReplay: boolean;
    reasoningRequest: AnthropicReasoningRequestMode;
  };
  openai: {
    enableThinkingRequest: boolean;
    replayAssistantThinkingAsReasoningContent: boolean;
    suppressReasoningEffort: boolean;
  };
}

export type LlmVendorDialectRuntime = ResolvedLlmRuntimeConfig | LlmVendorDialectContext | undefined;
