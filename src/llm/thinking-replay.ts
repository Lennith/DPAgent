import type { Message, ResolvedLlmRuntimeConfig } from '../types.js';
import { resolveLlmVendorDialect } from './vendor-dialects/index.js';

export interface ReplayableThinkingBlock {
  thinking: string;
  signature?: string;
}

export class ReasoningReplayPolicy {
  constructor(private readonly llmRuntime: ResolvedLlmRuntimeConfig | undefined) {}

  getReplayableThinkingBlock(message: Message): ReplayableThinkingBlock | null {
    return getReplayableThinkingBlock(message, this.llmRuntime);
  }

  hasNonReplayableThinking(message: Message): boolean {
    return hasAssistantThinkingPayload(message) && !this.getReplayableThinkingBlock(message);
  }

  shouldCollapseAnthropicToolBundle(assistant: Message): boolean {
    return shouldCollapseAnthropicToolBundleForThinking(assistant, this.llmRuntime);
  }
}

export function createReasoningReplayPolicy(
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): ReasoningReplayPolicy {
  return new ReasoningReplayPolicy(llmRuntime);
}

export function isAnthropicThinkingEnabled(llmRuntime: ResolvedLlmRuntimeConfig | undefined): boolean {
  return (
    llmRuntime?.provider === 'anthropic' &&
    llmRuntime.reasoningPreset !== 'off' &&
    llmRuntime.capabilities.thinkingBudget === true
  );
}

export function hasAssistantThinkingPayload(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    (String(message.thinking ?? '').trim().length > 0 || String(message.thinkingSignature ?? '').trim().length > 0)
  );
}

export function getReplayableThinkingBlock(
  message: Message,
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): ReplayableThinkingBlock | null {
  if (message.role !== 'assistant') {
    return null;
  }

  const thinking = String(message.thinking ?? '').trim();
  if (!thinking) {
    return null;
  }

  const metadata = message.metadata;
  if (metadata?.thinkingComplete === false) {
    return null;
  }

  if (llmRuntime && hasLlmRuntimeIdentity(metadata) && !matchesLlmRuntime(metadata, llmRuntime)) {
    return null;
  }

  const signature = String(message.thinkingSignature ?? '').trim();
  const dialect = resolveLlmVendorDialect(llmRuntime);
  if (!signature && (!llmRuntime || (llmRuntime.provider === 'anthropic' && !dialect.anthropic.allowUnsignedThinkingReplay))) {
    return null;
  }

  return {
    thinking,
    ...(signature ? { signature } : {}),
  };
}

export function shouldCollapseAnthropicToolBundleForThinking(
  assistant: Message,
  llmRuntime: ResolvedLlmRuntimeConfig | undefined
): boolean {
  if (!isAnthropicThinkingEnabled(llmRuntime)) {
    return false;
  }
  if (assistant.role !== 'assistant' || !Array.isArray(assistant.toolCalls) || assistant.toolCalls.length === 0) {
    return false;
  }
  if (getReplayableThinkingBlock(assistant, llmRuntime)) {
    return false;
  }
  return true;
}

function hasLlmRuntimeIdentity(metadata: Message['metadata']): boolean {
  return Boolean(metadata?.llmProvider || metadata?.llmModel || metadata?.llmProviderProfileId);
}

function matchesLlmRuntime(metadata: Message['metadata'], llmRuntime: ResolvedLlmRuntimeConfig): boolean {
  return (
    metadata?.llmProvider === llmRuntime.provider &&
    metadata?.llmModel === llmRuntime.model &&
    metadata?.llmProviderProfileId === llmRuntime.profileId
  );
}
