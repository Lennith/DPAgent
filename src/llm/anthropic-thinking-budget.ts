import type { ResolvedLlmRuntimeConfig } from '../types.js';
import { resolveLlmVendorDialect } from './vendor-dialects/index.js';

export type AnthropicReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

function hasPositiveThinkingBudgetOverride(llmRuntime: ResolvedLlmRuntimeConfig): boolean {
  const override = llmRuntime.providerOptions?.anthropic?.thinkingBudgetTokens;
  return typeof override === 'number' && Number.isFinite(override) && override > 0;
}

function isOfficialAnthropicEffortRuntime(llmRuntime: ResolvedLlmRuntimeConfig): boolean {
  return resolveLlmVendorDialect(llmRuntime).anthropic.reasoningRequest === 'output_config_effort';
}

export function resolveAnthropicReasoningEffort(
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): AnthropicReasoningEffort | undefined {
  if (
    !llmRuntime ||
    llmRuntime.provider !== 'anthropic' ||
    llmRuntime.reasoningPreset === 'off' ||
    llmRuntime.capabilities.thinkingBudget !== true ||
    hasPositiveThinkingBudgetOverride(llmRuntime) ||
    !isOfficialAnthropicEffortRuntime(llmRuntime)
  ) {
    return undefined;
  }

  switch (llmRuntime.reasoningPreset) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

export function resolveAnthropicThinkingBudgetTokens(
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): number | undefined {
  if (
    !llmRuntime ||
    llmRuntime.provider !== 'anthropic' ||
    llmRuntime.reasoningPreset === 'off' ||
    llmRuntime.capabilities.thinkingBudget !== true ||
    resolveAnthropicReasoningEffort(llmRuntime) !== undefined
  ) {
    return undefined;
  }

  const override = llmRuntime.providerOptions?.anthropic?.thinkingBudgetTokens;
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  switch (llmRuntime.reasoningPreset) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    case 'max':
      return 32768;
    default:
      return undefined;
  }
}
