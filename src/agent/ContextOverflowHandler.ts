import type { ContextCompressor } from '../compression/index.js';
import {
  messageTextContent,
  sanitizeMessagesForToolProtocol,
  trimMessagesForContextWindow,
} from '../llm/index.js';
import {
  CONTEXT_REDUCTION_MARKERS,
  buildContextCompressedRecoveryContent,
  buildForcedContextTrimOptions,
  buildMaxTokensRecoveryTrimOptions,
  buildMaxTokensContinuationPrompt as buildPolicyMaxTokensContinuationPrompt,
  buildNormalContextTrimOptions,
  buildProviderProjectionTrimOptions as buildPolicyProviderProjectionTrimOptions,
  type ContextReductionTrimOptions,
} from '../runtime/context-reduction-policy.js';
import { toPersistedMessages } from '../runtime/persisted-message-utils.js';
import type { AgentCallback, ContextOverflowEvent, Message, ResolvedContextBudget } from '../types.js';
import { agentLogger } from '../utils/logger.js';
import {
  estimateAgentMessagesChars,
  truncateForAgentLog,
} from './agent-message-utils.js';

export interface ForcedTrimResult {
  messages: Message[];
  beforeMessageCount: number;
  beforeChars: number;
  afterMessageCount: number;
  afterChars: number;
}

export interface ToolHistoryCompactionResult {
  messages: Message[];
  compactedToolCallChains: number;
  compactedToolMessages: number;
}

export interface MaxTokensCompressionResult {
  messages: Message[];
  compressionMode: 'llm_compressor' | 'deterministic_trim' | 'none';
  compressionError?: string;
}

export interface ContextOverflowHandlerOptions {
  contextBudget: ResolvedContextBudget;
  contextCompressor: ContextCompressor;
  getCallback: () => AgentCallback | undefined;
}

export class ContextOverflowHandler {
  private totalOverflowSnapshots = 0;

  constructor(private readonly options: ContextOverflowHandlerOptions) {}

  resetOverflowSnapshots(): void {
    this.totalOverflowSnapshots = 0;
  }

  buildNormalTrimOptions(): ContextReductionTrimOptions {
    return buildNormalContextTrimOptions(this.options.contextBudget);
  }

  buildProviderProjectionTrimOptions(maxTotalChars?: number): ContextReductionTrimOptions {
    return buildPolicyProviderProjectionTrimOptions(this.options.contextBudget, maxTotalChars);
  }

  buildForcedTrimOptions(): ContextReductionTrimOptions {
    return buildForcedContextTrimOptions(this.options.contextBudget);
  }

  applyForcedTrim(messages: Message[]): ForcedTrimResult {
    const beforeMessageCount = messages.length;
    const beforeChars = estimateAgentMessagesChars(messages);
    const forcedTrim = trimMessagesForContextWindow(messages, this.buildForcedTrimOptions());
    const nextMessages = sanitizeMessagesForToolProtocol(forcedTrim.messages).messages;
    return {
      messages: nextMessages,
      beforeMessageCount,
      beforeChars,
      afterMessageCount: nextMessages.length,
      afterChars: estimateAgentMessagesChars(nextMessages),
    };
  }

  async emitContextOverflowEvent(event: ContextOverflowEvent): Promise<void> {
    this.totalOverflowSnapshots += 1;
    agentLogger.contextOverflowSnapshot(
      event.stage,
      event.overflowCountInTurn,
      this.totalOverflowSnapshots,
      event.decision,
      event.beforeChars ?? 0
    );
    await Promise.resolve(this.options.getCallback()?.onContextOverflow?.(event));
  }

  compactCompletedToolHistory(messages: Message[]): ToolHistoryCompactionResult {
    if (messages.length <= 3) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const hasSystem = messages[0]?.role === 'system';
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const tailWindow = Math.min(20, body.length);
    const splitIndex = Math.max(0, body.length - tailWindow);
    const head = body.slice(0, splitIndex);
    const tail = body.slice(splitIndex);

    const compactedHead: Message[] = [];
    const summaries: string[] = [];
    let compactedToolCallChains = 0;
    let compactedToolMessages = 0;

    for (let i = 0; i < head.length; i += 1) {
      const message = head[i];
      if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
        compactedHead.push(message);
        continue;
      }

      const expectedToolCalls = message.toolCalls;
      const expectedIds = new Set(
        expectedToolCalls.map((toolCall) => toolCall.id?.trim()).filter((id): id is string => Boolean(id))
      );
      if (expectedIds.size !== expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const alignedResults: Message[] = [];
      let cursor = i + 1;
      while (cursor < head.length && head[cursor].role === 'tool') {
        alignedResults.push(head[cursor]);
        cursor += 1;
      }
      if (alignedResults.length < expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const matchIds = new Set<string>();
      let aligned = true;
      for (const toolMessage of alignedResults.slice(0, expectedToolCalls.length)) {
        const toolCallId = toolMessage.toolCallId?.trim();
        if (!toolCallId || !expectedIds.has(toolCallId) || matchIds.has(toolCallId)) {
          aligned = false;
          break;
        }
        matchIds.add(toolCallId);
      }
      if (!aligned || matchIds.size !== expectedIds.size) {
        compactedHead.push(message);
        continue;
      }

      const chainResults = alignedResults.slice(0, expectedToolCalls.length);
      const resultSummary = chainResults
        .map((toolMessage) => truncateForAgentLog(messageTextContent(toolMessage.content).replace(/\s+/g, ' '), 100))
        .join(' | ');
      const toolNames = expectedToolCalls.map((toolCall) => toolCall.function.name).join(', ');
      summaries.push(
        `tools=[${toolNames}] results=${truncateForAgentLog(resultSummary.length > 0 ? resultSummary : '(empty)', 220)}`
      );

      compactedToolCallChains += 1;
      compactedToolMessages += chainResults.length + 1;
      i = cursor - 1;
    }

    if (compactedToolCallChains === 0) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const summaryPreview = summaries.slice(0, 12).join('\n- ');
    const overflowCount = Math.max(0, summaries.length - 12);
    const summaryMessage: Message = {
      role: 'assistant',
      content:
        `[${CONTEXT_REDUCTION_MARKERS.toolHistoryCompacted}] compacted_chains=${compactedToolCallChains}, compacted_messages=${compactedToolMessages}\n` +
        `- ${summaryPreview}\n` +
        (overflowCount > 0 ? `- ...and ${overflowCount} more compacted chain(s).` : '') +
        '\nKeep only latest tool protocol details in subsequent reasoning.',
    };

    const nextMessages: Message[] = [];
    if (systemMessage) {
      nextMessages.push(systemMessage);
    }
    nextMessages.push(...compactedHead, summaryMessage, ...tail);
    return { messages: nextMessages, compactedToolCallChains, compactedToolMessages };
  }

  async compressForMaxTokensRecovery(messages: Message[]): Promise<MaxTokensCompressionResult> {
    if (messages.length <= 2) {
      return { messages: [...messages], compressionMode: 'none' };
    }

    const hasSystem = messages[0]?.role === 'system';
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const keepTail = Math.min(16, body.length);
    const splitIndex = Math.max(0, body.length - keepTail);
    const olderMessages = body.slice(0, splitIndex);
    const tailMessages = body.slice(splitIndex);

    if (olderMessages.length > 2) {
      try {
        const compressed = await this.options.contextCompressor.compress(toPersistedMessages(olderMessages));
        if (compressed.success && compressed.compressedContent) {
          const summaryMessage: Message = {
            role: 'assistant',
            content: buildContextCompressedRecoveryContent(
              truncateForAgentLog(compressed.compressedContent, 10000)
            ),
          };
          const nextMessages: Message[] = [];
          if (systemMessage) {
            nextMessages.push(systemMessage);
          }
          nextMessages.push(summaryMessage, ...tailMessages);
          return { messages: nextMessages, compressionMode: 'llm_compressor' };
        }
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: 'deterministic_trim',
          compressionError: compressed.error ?? 'llm_compressor_returned_empty',
        };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: 'deterministic_trim',
          compressionError: err,
        };
      }
    }

    return {
      messages: this.applyDeterministicTrim(messages),
      compressionMode: 'deterministic_trim',
    };
  }

  buildMaxTokensContinuationPrompt(attempt: number, maxAttempts: number): string {
    return buildPolicyMaxTokensContinuationPrompt(attempt, maxAttempts);
  }

  private applyDeterministicTrim(messages: Message[]): Message[] {
    return trimMessagesForContextWindow(
      messages,
      buildMaxTokensRecoveryTrimOptions(this.options.contextBudget)
    ).messages;
  }
}
