import type { AgentConfig, ResolvedLlmRuntimeConfig } from './types.js';

export interface DPAgentOptions {
  config?: Partial<AgentConfig>;
  configPath?: string;
  allowMissingApiKeyAtBoot?: boolean;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  workspaceDir?: string;
  runtimeDataDir?: string;
  contextDir?: string;
  additionalDirs?: string[];
}

export interface TurnPromptEnvelope {
  effectivePrompt: string;
  rawUserPrompt: string;
  historyUserPrompt: string;
  additionalSystemPrompt: string;
  promptReference?: string;
  hasSystemPromptInjection: boolean;
}

export function normalizeMaxOutputTokens(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}
