import type { HookContext, HookExecutionResult } from '../hooks/index.js';
import type { AgentCallback, AgentCompletionMeta, MaxTokensRecoveryEvent, TokenUsage } from '../types.js';
import type { AgentRunResult } from './agent-contracts.js';

export interface AgentTurnCompletionHost {
  sessionId: string | null;
  callback?: AgentCallback;
  executeHookPoint(event: string, context: HookContext): Promise<HookExecutionResult>;
}

export interface AgentTurnCompletionInput {
  content: string;
  finishReason: string;
  step: number;
  turnEndStep?: number;
  usage?: TokenUsage;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
}

export async function completeAgentTurn(
  host: AgentTurnCompletionHost,
  input: AgentTurnCompletionInput
): Promise<AgentRunResult> {
  const meta = buildCompletionMeta(input);
  await host.executeHookPoint('onTurnEnd', buildTurnEndContext(host, input)).catch(() => {});
  host.callback?.onComplete?.(input.content, input.finishReason, meta);
  return buildRunResult(input);
}

export function completeAgentTurnDetached(
  host: AgentTurnCompletionHost,
  input: AgentTurnCompletionInput
): AgentRunResult {
  const meta = buildCompletionMeta(input);
  void host.executeHookPoint('onTurnEnd', buildTurnEndContext(host, input)).catch(() => {});
  host.callback?.onComplete?.(input.content, input.finishReason, meta);
  return buildRunResult(input);
}

export function completeAgentCancelledRun(
  host: AgentTurnCompletionHost,
  input: {
    step: number;
    usage?: TokenUsage;
    recoveredFromMaxTokens?: boolean;
    maxTokensRecoveryAttempt?: number;
    maxTokensEvents?: MaxTokensRecoveryEvent[];
  }
): AgentRunResult {
  return completeAgentTurnDetached(host, {
    content: 'Task cancelled by user.',
    finishReason: 'cancelled',
    step: input.step,
    usage: input.usage,
    recoveredFromMaxTokens: input.recoveredFromMaxTokens,
    maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
    maxTokensEvents: input.maxTokensEvents,
  });
}

function buildCompletionMeta(input: AgentTurnCompletionInput): AgentCompletionMeta {
  return {
    finishReason: input.finishReason,
    usage: input.usage,
    step: input.step,
    recoveredFromMaxTokens: input.recoveredFromMaxTokens,
    maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
    maxTokensEvents: input.maxTokensEvents,
  };
}

function buildTurnEndContext(host: AgentTurnCompletionHost, input: AgentTurnCompletionInput): HookContext {
  return {
    event: 'onTurnEnd',
    sessionId: host.sessionId ?? '',
    step: input.turnEndStep ?? input.step,
    finishReason: input.finishReason,
    content: input.content,
    usage: input.usage,
  } as HookContext;
}

function buildRunResult(input: AgentTurnCompletionInput): AgentRunResult {
  return {
    content: input.content,
    finishReason: input.finishReason,
    step: input.step,
    usage: input.usage,
    recoveredFromMaxTokens: input.recoveredFromMaxTokens,
    maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
    maxTokensEvents: input.maxTokensEvents,
  };
}
