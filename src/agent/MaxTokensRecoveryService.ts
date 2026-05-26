import type { MaxTokensRecoveryEvent, TokenUsage } from '../types.js';
import { estimateAgentMessagesChars } from './agent-message-utils.js';
import type { ContextOverflowHandler } from './ContextOverflowHandler.js';
import type { MessageStore } from './MessageStore.js';

export interface MaxTokensRecoveryServiceOptions {
  messageStore: MessageStore;
  contextOverflowHandler: ContextOverflowHandler;
  clearPromptUsageAnchor: () => void;
  maxAttempts: number;
}

export interface HandleMaxTokensRecoveryInput {
  step: number;
  previousAttempt: number;
  usage?: TokenUsage;
}

export interface MaxTokensRecoveryResult {
  event: MaxTokensRecoveryEvent;
  attempt: number;
  recovered: boolean;
}

export class MaxTokensRecoveryService {
  constructor(private readonly options: MaxTokensRecoveryServiceOptions) {}

  async handleMaxTokensRecovery(input: HandleMaxTokensRecoveryInput): Promise<MaxTokensRecoveryResult> {
    const messages = this.options.messageStore.messages;
    const preCompressMessageCount = messages.length;
    const preCompressChars = estimateAgentMessagesChars(messages);
    const compacted = this.options.contextOverflowHandler.compactCompletedToolHistory(messages);
    this.options.messageStore.messages = compacted.messages;
    this.options.clearPromptUsageAnchor();

    const compressed = await this.options.contextOverflowHandler.compressForMaxTokensRecovery(
      this.options.messageStore.messages
    );
    this.options.messageStore.messages = compressed.messages;
    this.options.clearPromptUsageAnchor();

    const attempt = input.previousAttempt + 1;
    const recovered = attempt <= this.options.maxAttempts;
    if (recovered) {
      this.options.messageStore.messages.push({
        role: 'user',
        content: this.options.contextOverflowHandler.buildMaxTokensContinuationPrompt(
          attempt,
          this.options.maxAttempts
        ),
      });
    }

    const event: MaxTokensRecoveryEvent = {
      observedAt: new Date().toISOString(),
      step: input.step,
      attempt,
      maxAttempts: this.options.maxAttempts,
      recovered,
      finishReason: 'max_tokens',
      usage: input.usage,
      preCompressMessageCount,
      preCompressChars,
      postCompressMessageCount: this.options.messageStore.messages.length,
      postCompressChars: estimateAgentMessagesChars(this.options.messageStore.messages),
      compactedToolCallChains: compacted.compactedToolCallChains,
      compactedToolMessages: compacted.compactedToolMessages,
      compressionMode: compressed.compressionMode,
      compressionError: compressed.compressionError,
      continuationInjected: recovered,
    };

    return {
      event,
      attempt,
      recovered,
    };
  }
}
