import type {
  AgentConfig,
  ContextBudgetConfig,
  ContextUsageEstimate,
  LlmProviderProfileConfig,
  ResolvedContextBudget,
} from '../types.js';
import { findResolvedLlmProfile } from '../llm/provider-profiles.js';
import {
  charsToTokenHint,
  estimateWeightedTokenDeltaFromSerializedPayload,
  estimateWeightedTokensFromPayload,
  tokensToCharHint,
} from '../shared/context-token-estimation.js';

export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
  defaultContextWindowTokens: 230000,
  compressionTriggerRatio: 0.9,
  postCompressionTargetRatio: 0.35,
  minTokensAddedAfterCompression: 16000,
  compressionMaxChars: 6000,
  precompressKeepLlmRounds: 5,
  precompressChunkChars: 60000,
  precompressRetry: 1,
  reservedOutputTokens: 16000,
  reservedReasoningTokens: 0,
  reservedProtocolTokens: 8000,
  modelOverrides: {},
};

export function createDefaultContextBudgetConfig(): ContextBudgetConfig {
  return {
    ...DEFAULT_CONTEXT_BUDGET_CONFIG,
    modelOverrides: {},
  };
}

export function cloneContextBudgetConfig(
  config?: Partial<ContextBudgetConfig> | null
): ContextBudgetConfig {
  return {
    ...createDefaultContextBudgetConfig(),
    ...(config ?? {}),
    modelOverrides: { ...(config?.modelOverrides ?? {}) },
  };
}

export interface ContextBudgetResolveInput {
  config: AgentConfig;
  profileId?: string;
  provider: string;
  model: string;
  modelRuntimeOptions?: {
    maxOutputTokens?: number;
    thinkingBudgetTokens?: number;
  };
}

export interface PreparedInputUsageSnapshot {
  serialized: string;
  rawChars: number;
  inputTokens: number;
  anchorMode: 'full' | 'message_sequence';
  anchorStaticSerialized: string;
  anchorMessageSerialized: string;
}

export interface PromptUsageAnchor {
  adapterProvider: string;
  apiBaseHost: string;
  model: string;
  promptTokens: number;
  serialized: string;
  rawChars: number;
  observedAt: string;
  anchorMode: 'full' | 'message_sequence';
  anchorStaticSerialized: string;
  anchorMessageSerialized: string;
}

export interface AnchoredContextUsageEstimate {
  anchorPromptTokens: number;
  deltaEstimatedTokens: number;
  inputTokens: number;
  rawChars: number;
}

function normalizeAnchorPayload(payload: unknown): {
  mode: 'full' | 'message_sequence';
  staticSerialized: string;
  messageSerialized: string;
} {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const { messages, ...rest } = record;
    if (Array.isArray(messages)) {
      return {
        mode: 'message_sequence',
        staticSerialized: JSON.stringify(rest),
        messageSerialized: messages.map((message) => JSON.stringify(message)).join('\n'),
      };
    }
  }
  const serialized =
    typeof payload === 'string'
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload);
          } catch {
            return String(payload ?? '');
          }
        })();
  return {
    mode: 'full',
    staticSerialized: '',
    messageSerialized: serialized,
  };
}

function buildModelOverrideKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

export function normalizeApiBaseHost(apiBase: string): string {
  try {
    const parsed = new URL(apiBase);
    return parsed.host.toLowerCase();
  } catch {
    return String(apiBase).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
}

function getModelOverride(
  budget: NonNullable<AgentConfig['contextBudget']>,
  provider: string,
  model: string
): NonNullable<AgentConfig['contextBudget']>['modelOverrides'][string] | undefined {
  const key = buildModelOverrideKey(provider, model);
  return budget.modelOverrides[key];
}

function getProfileOverride(
  config: AgentConfig,
  profileId?: string
): Pick<LlmProviderProfileConfig, 'contextWindowTokens'> | undefined {
  const trimmedProfileId = String(profileId ?? '').trim();
  if (!trimmedProfileId) {
    return undefined;
  }
  return findResolvedLlmProfile(config, trimmedProfileId);
}

export function resolveContextBudget(input: ContextBudgetResolveInput): ResolvedContextBudget {
  const budget = input.config.contextBudget!;
  const profile = getProfileOverride(input.config, input.profileId);
  const override = getModelOverride(budget, input.provider, input.model);
  const hasExplicitProfileOverride =
    profile?.contextWindowTokens !== undefined &&
    Number.isFinite(profile.contextWindowTokens);
  const hasExplicitOverride =
    override?.contextWindowTokens !== undefined &&
    Number.isFinite(override.contextWindowTokens);

  const contextWindowTokens =
    profile?.contextWindowTokens !== undefined && Number.isFinite(profile.contextWindowTokens)
      ? Math.floor(profile.contextWindowTokens)
      : override?.contextWindowTokens !== undefined && Number.isFinite(override.contextWindowTokens)
      ? Math.floor(override.contextWindowTokens)
      : budget.defaultContextWindowTokens;

  const compressionTriggerRatio =
    override?.compressionTriggerRatio !== undefined &&
    Number.isFinite(override.compressionTriggerRatio) &&
    override.compressionTriggerRatio > 0 &&
    override.compressionTriggerRatio <= 1
      ? override.compressionTriggerRatio
      : budget.compressionTriggerRatio;

  const postCompressionTargetRatio =
    override?.postCompressionTargetRatio !== undefined &&
    Number.isFinite(override.postCompressionTargetRatio) &&
    override.postCompressionTargetRatio > 0 &&
    override.postCompressionTargetRatio <= 1
      ? override.postCompressionTargetRatio
      : budget.postCompressionTargetRatio;

  const reservedOutputTokens =
    override?.reservedOutputTokens !== undefined && Number.isFinite(override.reservedOutputTokens)
      ? Math.floor(override.reservedOutputTokens)
      : input.modelRuntimeOptions?.maxOutputTokens !== undefined &&
          Number.isFinite(input.modelRuntimeOptions.maxOutputTokens)
        ? Math.floor(input.modelRuntimeOptions.maxOutputTokens)
        : budget.reservedOutputTokens;

  const reservedReasoningTokens =
    override?.reservedReasoningTokens !== undefined && Number.isFinite(override.reservedReasoningTokens)
      ? Math.floor(override.reservedReasoningTokens)
      : input.modelRuntimeOptions?.thinkingBudgetTokens !== undefined &&
          Number.isFinite(input.modelRuntimeOptions.thinkingBudgetTokens)
        ? Math.floor(input.modelRuntimeOptions.thinkingBudgetTokens)
        : budget.reservedReasoningTokens;

  const reservedProtocolTokens =
    override?.reservedProtocolTokens !== undefined && Number.isFinite(override.reservedProtocolTokens)
      ? Math.floor(override.reservedProtocolTokens)
      : budget.reservedProtocolTokens;

  const minTokensAddedAfterCompression =
    Number.isFinite(budget.minTokensAddedAfterCompression)
      ? budget.minTokensAddedAfterCompression
      : 16000;

  const compressionMaxChars =
    Number.isFinite(budget.compressionMaxChars) && budget.compressionMaxChars > 0
      ? Math.floor(budget.compressionMaxChars)
      : DEFAULT_CONTEXT_BUDGET_CONFIG.compressionMaxChars;

  const precompressKeepLlmRounds =
    Number.isFinite(budget.precompressKeepLlmRounds) && budget.precompressKeepLlmRounds > 0
      ? Math.floor(budget.precompressKeepLlmRounds)
      : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressKeepLlmRounds;

  const precompressChunkChars =
    Number.isFinite(budget.precompressChunkChars) && budget.precompressChunkChars > 0
      ? Math.floor(budget.precompressChunkChars)
      : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressChunkChars;

  const precompressRetry =
    Number.isFinite(budget.precompressRetry) && budget.precompressRetry >= 0
      ? Math.floor(budget.precompressRetry)
      : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressRetry;

  const safeInputTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens - reservedReasoningTokens - reservedProtocolTokens
  );

  const compressionTriggerTokens = Math.floor(safeInputTokens * compressionTriggerRatio);

  const postCompressionTargetTokens = Math.floor(
    contextWindowTokens * postCompressionTargetRatio
  );

  const estimatedContextWindowChars = Math.floor(
    tokensToCharHint(contextWindowTokens)
  );

  const source = hasExplicitProfileOverride
    ? 'profile_override'
    : hasExplicitOverride
      ? 'model_override'
      : 'config_default';

  return {
    provider: input.provider,
    model: input.model,
    contextWindowTokens,
    estimatedContextWindowChars,
    compressionTriggerRatio,
    postCompressionTargetRatio,
    minTokensAddedAfterCompression,
    compressionMaxChars,
    precompressKeepLlmRounds,
    precompressChunkChars,
    precompressRetry,
    reservedOutputTokens,
    reservedReasoningTokens,
    reservedProtocolTokens,
    safeInputTokens,
    compressionTriggerTokens,
    postCompressionTargetTokens,
    source,
  };
}

export function buildContextBudgetKey(provider: string, model: string): string {
  return buildModelOverrideKey(provider, model);
}

export function estimateInputTokensFromChars(
  totalChars: number
): ContextUsageEstimate {
  const inputTokens = charsToTokenHint(Math.max(0, totalChars));
  return {
    inputTokens,
    source: 'weighted_char_estimate',
    confidence: 'estimated',
    rawChars: totalChars,
  };
}

export function estimateContextUsageFromPayload(payload: unknown): ContextUsageEstimate {
  const estimate = estimateWeightedTokensFromPayload(payload);
  return {
    inputTokens: estimate.inputTokens,
    source: 'weighted_char_estimate',
    confidence: 'estimated',
    rawChars: estimate.rawChars,
  };
}

export function buildPreparedInputUsageSnapshot(payload: unknown): PreparedInputUsageSnapshot {
  const estimate = estimateWeightedTokensFromPayload(payload);
  const normalized = normalizeAnchorPayload(payload);
  return {
    serialized: estimate.serialized,
    rawChars: estimate.rawChars,
    inputTokens: estimate.inputTokens,
    anchorMode: normalized.mode,
    anchorStaticSerialized: normalized.staticSerialized,
    anchorMessageSerialized: normalized.messageSerialized,
  };
}

export function normalizeContextUsageFromProviderUsage(
  usage: { promptTokens?: number; inputTokens?: number },
  rawChars?: number
): ContextUsageEstimate {
  const tokens = usage.promptTokens ?? usage.inputTokens;
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
    return {
      inputTokens: Math.ceil(tokens),
      source: 'provider_usage',
      confidence: 'exact',
      rawChars,
    };
  }
  return {
    inputTokens: 0,
    source: 'provider_usage',
    confidence: 'exact',
    rawChars,
  };
}

export function applyCalibrationMultiplier(
  estimate: ContextUsageEstimate,
  multiplier: number
): ContextUsageEstimate {
  const effectiveMultiplier =
    Number.isFinite(multiplier) && multiplier > 1 ? multiplier : 1;
  return {
    inputTokens: Math.max(1, Math.ceil(estimate.inputTokens * effectiveMultiplier)),
    source: effectiveMultiplier > 1 ? 'calibrated_weighted_estimate' : estimate.source,
    confidence: estimate.confidence,
    rawChars: estimate.rawChars,
  };
}

export function createPromptUsageAnchor(input: {
  adapterProvider: string;
  apiBase: string;
  model: string;
  snapshot: PreparedInputUsageSnapshot;
  promptTokens: number;
  observedAt?: string;
}): PromptUsageAnchor | null {
  if (!Number.isFinite(input.promptTokens) || input.promptTokens <= 0) {
    return null;
  }
  return {
    adapterProvider: input.adapterProvider.trim().toLowerCase(),
    apiBaseHost: normalizeApiBaseHost(input.apiBase),
    model: input.model.trim().toLowerCase(),
    promptTokens: Math.max(1, Math.ceil(input.promptTokens)),
    serialized: input.snapshot.serialized,
    rawChars: input.snapshot.rawChars,
    observedAt: input.observedAt ?? new Date().toISOString(),
    anchorMode: input.snapshot.anchorMode,
    anchorStaticSerialized: input.snapshot.anchorStaticSerialized,
    anchorMessageSerialized: input.snapshot.anchorMessageSerialized,
  };
}

export function estimateAnchoredContextUsage(input: {
  anchor: PromptUsageAnchor;
  adapterProvider: string;
  apiBase: string;
  model: string;
  snapshot: PreparedInputUsageSnapshot;
}): AnchoredContextUsageEstimate | null {
  if (input.anchor.adapterProvider !== input.adapterProvider.trim().toLowerCase()) {
    return null;
  }
  if (input.anchor.apiBaseHost !== normalizeApiBaseHost(input.apiBase)) {
    return null;
  }
  if (input.anchor.model !== input.model.trim().toLowerCase()) {
    return null;
  }

  if (input.anchor.anchorMode !== input.snapshot.anchorMode) {
    return null;
  }

  if (input.anchor.anchorMode === 'message_sequence') {
    if (input.anchor.anchorStaticSerialized !== input.snapshot.anchorStaticSerialized) {
      return null;
    }
  }

  const delta = estimateWeightedTokenDeltaFromSerializedPayload(
    input.anchor.anchorMessageSerialized,
    input.snapshot.anchorMessageSerialized
  );
  if (!delta.appendOnly) {
    return null;
  }

  return {
    anchorPromptTokens: input.anchor.promptTokens,
    deltaEstimatedTokens: delta.deltaTokens,
    inputTokens: input.anchor.promptTokens + delta.deltaTokens,
    rawChars: input.snapshot.rawChars,
  };
}

export function shouldCompress(
  estimate: ContextUsageEstimate,
  budget: ResolvedContextBudget,
  lastCompressionInputTokens: number
): {
  shouldCompress: boolean;
  reason: 'budget_exceeded' | 'hard_risk' | 'below_threshold' | 'hysteresis_blocked';
} {
  const hardRiskTokens = Math.floor(budget.safeInputTokens * 0.95);

  if (estimate.inputTokens >= hardRiskTokens) {
    return { shouldCompress: true, reason: 'hard_risk' };
  }

  if (estimate.inputTokens < budget.compressionTriggerTokens) {
    return { shouldCompress: false, reason: 'below_threshold' };
  }

  const tokensAddedSinceLastCompression = estimate.inputTokens - lastCompressionInputTokens;

  if (tokensAddedSinceLastCompression >= budget.minTokensAddedAfterCompression) {
    return { shouldCompress: true, reason: 'budget_exceeded' };
  }

  return { shouldCompress: false, reason: 'hysteresis_blocked' };
}
