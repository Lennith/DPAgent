import type { AgentConfig, ResolvedLlmRuntimeConfig } from '../types.js';
import { normalizeMaxOutputTokens } from '../dpagent-contracts.js';
import { resolveLlmRuntimeConfig } from '../llm/provider-profiles.js';

export function resolveConfiguredMaxOutputTokens(runtimeConfig: ResolvedLlmRuntimeConfig): number {
  const normalized = normalizeMaxOutputTokens(runtimeConfig.maxOutputTokens);
  if (normalized === undefined) {
    throw new Error('llmProfiles default profile maxOutputTokens must be set in config.');
  }
  return normalized;
}

export function assertDPAgentStartupConfig(
  cfg: AgentConfig,
  options?: {
    requireApiKey?: boolean;
    llmRuntime?: ResolvedLlmRuntimeConfig;
  }
): void {
  const requireApiKey = options?.requireApiKey !== false;
  const defaultRuntime = options?.llmRuntime ?? resolveLlmRuntimeConfig({ llmProfiles: cfg.llmProfiles });
  if (requireApiKey && (!defaultRuntime.apiKey || defaultRuntime.apiKey.trim().length < 20)) {
    throw new Error('Invalid config: llmProfiles default profile apiKey must be set in config.yaml.');
  }
  if (!defaultRuntime.apiBase || defaultRuntime.apiBase.trim().length === 0) {
    throw new Error('Invalid config: llmProfiles default profile apiBase must be set in config.yaml.');
  }
  if (!defaultRuntime.model || defaultRuntime.model.trim().length === 0) {
    throw new Error('Invalid config: llmProfiles default profile defaultModel must be set in config.yaml.');
  }
  if (!cfg.agent.workspaceDir || cfg.agent.workspaceDir.trim().length === 0) {
    throw new Error('Invalid config: agent.workspaceDir must be set in config.yaml.');
  }
  if (!Number.isFinite(cfg.agent.subAgentMaxParallelPerParent) || cfg.agent.subAgentMaxParallelPerParent <= 0) {
    throw new Error('Invalid config: agent.subAgentMaxParallelPerParent must be > 0.');
  }
  if (!Number.isFinite(cfg.agent.subAgentGlobalMaxParallel) || cfg.agent.subAgentGlobalMaxParallel <= 0) {
    throw new Error('Invalid config: agent.subAgentGlobalMaxParallel must be > 0.');
  }
  if (
    cfg.agent.contextReplayMinRounds !== undefined &&
    (!Number.isFinite(cfg.agent.contextReplayMinRounds) || cfg.agent.contextReplayMinRounds < 1)
  ) {
    throw new Error('Invalid config: agent.contextReplayMinRounds must be >= 1.');
  }
  if (
    cfg.agent.contextReplayMaxRounds !== undefined &&
    (!Number.isFinite(cfg.agent.contextReplayMaxRounds) || cfg.agent.contextReplayMaxRounds < 1)
  ) {
    throw new Error('Invalid config: agent.contextReplayMaxRounds must be >= 1.');
  }
  if (
    cfg.agent.contextReplayMinRounds !== undefined &&
    cfg.agent.contextReplayMaxRounds !== undefined &&
    cfg.agent.contextReplayMaxRounds < cfg.agent.contextReplayMinRounds
  ) {
    throw new Error('Invalid config: agent.contextReplayMaxRounds must be >= agent.contextReplayMinRounds.');
  }
  if (
    cfg.agent.contextReplayBudgetRatio !== undefined &&
    (!Number.isFinite(cfg.agent.contextReplayBudgetRatio) ||
      cfg.agent.contextReplayBudgetRatio <= 0 ||
      cfg.agent.contextReplayBudgetRatio > 1)
  ) {
    throw new Error('Invalid config: agent.contextReplayBudgetRatio must be within (0, 1].');
  }
  if (
    cfg.agent.contextOverflowMaxErrorsBeforeTrim !== undefined &&
    (!Number.isFinite(cfg.agent.contextOverflowMaxErrorsBeforeTrim) ||
      cfg.agent.contextOverflowMaxErrorsBeforeTrim < 1)
  ) {
    throw new Error('Invalid config: agent.contextOverflowMaxErrorsBeforeTrim must be >= 1.');
  }
  if (!cfg.agent.runtimeDataDir || cfg.agent.runtimeDataDir.trim().length === 0) {
    throw new Error('Invalid config: agent.runtimeDataDir must be set in config.yaml.');
  }
  if (!cfg.agent.contextDir || cfg.agent.contextDir.trim().length === 0) {
    throw new Error('Invalid config: agent.contextDir must be set in config.yaml.');
  }
}
