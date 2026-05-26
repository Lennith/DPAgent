import { extractMissingToolCallId } from '../llm/index.js';
import type { AgentCallback, LLMResponse } from '../types.js';
import {
  decideProgressOnlyRecovery,
  decideToolCallProtocolRecovery,
} from './TurnRecoveryPolicy.js';
import {
  buildProgressOnlyContinuationPrompt,
  buildProgressOnlyStallMessage,
  shouldRecoverProgressOnlyTurnStop,
} from './agent-progress-recovery.js';
import type { MessageStore } from './MessageStore.js';

export interface TurnRecoveryOrchestratorOptions {
  messageStore: MessageStore;
  getCallback: () => AgentCallback | undefined;
  progressOnlyRecoveryEnabled: boolean;
  progressOnlyMaxAttempts: number;
}

export interface ToolCallProtocolRecoveryResult {
  nextCount: number;
  recovered: boolean;
  escalationError?: Error;
}

export type ProgressOnlyRecoveryResult =
  | { kind: 'none' }
  | { kind: 'continue'; nextCount: number }
  | { kind: 'stall'; nextCount: number; content: string };

export class TurnRecoveryOrchestrator {
  constructor(private readonly options: TurnRecoveryOrchestratorOptions) {}

  handleToolCallProtocolRecovery(input: {
    errorRaw: string;
    consecutiveFailureCount: number;
  }): ToolCallProtocolRecoveryResult {
    const missingToolCallId = extractMissingToolCallId(input.errorRaw);
    const matchedToolName = this.options.messageStore.findToolNameById(missingToolCallId);
    const recoveryDecision = decideToolCallProtocolRecovery({
      consecutiveFailureCount: input.consecutiveFailureCount,
    });
    const nextCount = recoveryDecision.nextCount;
    const recoveryMessage = this.options.messageStore.buildToolCallFailedMessage({
      errorRaw: input.errorRaw,
      missingToolCallId,
      matchedToolName,
      consecutiveFailureCount: nextCount,
    });
    this.options.messageStore.messages.push({
      role: 'user',
      content: recoveryMessage,
    });
    this.options.getCallback()?.onMessage?.('system', recoveryMessage);
    this.options.getCallback()?.onProtocolRecovery?.({
      kind: recoveryDecision.kind === 'escalate' ? 'toolcall_failed_escalated' : 'toolcall_failed_injected',
      errorRaw: input.errorRaw,
      missingToolCallId,
      matchedToolName,
      consecutiveFailureCount: nextCount,
      nextAction: 'Issue a fresh tool call, then continue reporting progress.',
    });

    if (recoveryDecision.kind === 'escalate') {
      return {
        nextCount,
        recovered: false,
        escalationError: new Error(`[TOOLCALL_FAILED_ESCALATED] ${input.errorRaw}`),
      };
    }

    return {
      nextCount,
      recovered: true,
    };
  }

  handleProgressOnlyRecovery(input: {
    response: LLMResponse;
    consecutiveStopCount: number;
  }): ProgressOnlyRecoveryResult {
    if (!this.options.progressOnlyRecoveryEnabled || !shouldRecoverProgressOnlyTurnStop(input.response)) {
      return { kind: 'none' };
    }

    const progressDecision = decideProgressOnlyRecovery({
      consecutiveStopCount: input.consecutiveStopCount,
      maxAttempts: this.options.progressOnlyMaxAttempts,
    });
    const nextCount = progressDecision.nextCount;
    const maxAttempts = progressDecision.maxAttempts;
    if (progressDecision.kind === 'stall') {
      const content = buildProgressOnlyStallMessage(nextCount);
      this.options.getCallback()?.onProtocolRecovery?.({
        kind: 'progress_only_stall',
        errorRaw: input.response.content,
        consecutiveFailureCount: nextCount,
        nextAction: 'Abort this turn with an explicit protocol stall result.',
      });
      return {
        kind: 'stall',
        nextCount,
        content,
      };
    }

    const recoveryMessage = buildProgressOnlyContinuationPrompt(nextCount, maxAttempts);
    this.options.messageStore.messages.push({
      role: 'user',
      content: recoveryMessage,
    });
    this.options.getCallback()?.onMessage?.('system', recoveryMessage);
    this.options.getCallback()?.onProtocolRecovery?.({
      kind: 'progress_only_continuation_injected',
      errorRaw: input.response.content,
      consecutiveFailureCount: nextCount,
      nextAction: 'Continue in the same turn and take concrete action now.',
    });

    return {
      kind: 'continue',
      nextCount,
    };
  }
}
