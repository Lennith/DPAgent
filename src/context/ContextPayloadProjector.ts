import type {
  ContextPayloadProjectionMetrics,
  ContextWindowTrimOptions,
  Message,
} from '../types.js';
import {
  estimateMessagesCharacters,
  messageTextContent,
  prepareMessagesForModel,
  sanitizeMessagesForToolProtocol,
} from '../llm/index.js';
import {
  TOOL_RESULT_PAYLOAD_MARKERS,
  buildProjectedToolResultArtifactPayload,
  resolveProjectedNonToolInlineChars,
  resolveProjectedToolResultInlineChars,
  truncateWithPayloadMarker,
} from '../runtime/tool-result-payload-policy.js';

export interface ContextPayloadProjectionOptions {
  systemPrompt?: string;
  trimOptions?: ContextWindowTrimOptions;
  maxToolResultChars?: number;
  maxNonToolChars?: number;
  truncateNonToolMessages?: boolean;
}

export interface ContextPayloadProjectionResult {
  messages: Message[];
  preparedMessages: Message[];
  metrics: ContextPayloadProjectionMetrics;
}

interface NormalizedPayloadResult {
  messages: Message[];
  toolResultRefReplacements: number;
  oversizedInlineToolTruncations: number;
}

export class ContextPayloadProjector {
  normalizeMessages(
    messages: Message[],
    options?: Pick<ContextPayloadProjectionOptions, 'maxToolResultChars' | 'maxNonToolChars' | 'truncateNonToolMessages'>
  ): NormalizedPayloadResult {
    const maxToolResultChars = resolveProjectedToolResultInlineChars(options?.maxToolResultChars);
    const maxNonToolChars = resolveProjectedNonToolInlineChars(options?.maxNonToolChars);
    const truncateNonToolMessages = options?.truncateNonToolMessages === true;
    let toolResultRefReplacements = 0;
    let oversizedInlineToolTruncations = 0;

    const normalized = messages.map((message) => {
      if (message.role !== 'tool') {
        if (!truncateNonToolMessages) {
          return { ...message };
        }
        const content = messageTextContent(message.content);
        if (content.length <= maxNonToolChars) {
          return { ...message };
        }
        return {
          ...message,
          content: truncateWithPayloadMarker(
            content,
            maxNonToolChars,
            TOOL_RESULT_PAYLOAD_MARKERS.contextPayloadTruncated
          ),
        };
      }

      const artifact = message.metadata?.toolResultArtifact;
      if (artifact) {
        toolResultRefReplacements += 1;
        return {
          ...message,
          content: buildProjectedToolResultArtifactPayload(
            artifact,
            messageTextContent(message.content),
            maxToolResultChars
          ),
        };
      }

      const content = messageTextContent(message.content);
      if (content.length <= maxToolResultChars) {
        return { ...message };
      }
      oversizedInlineToolTruncations += 1;
      return {
        ...message,
        content: truncateWithPayloadMarker(
          content,
          maxToolResultChars,
          TOOL_RESULT_PAYLOAD_MARKERS.inlineBudgetApplied
        ),
      };
    });

    return {
      messages: normalized,
      toolResultRefReplacements,
      oversizedInlineToolTruncations,
    };
  }

  projectForProvider(messages: Message[], options?: ContextPayloadProjectionOptions): ContextPayloadProjectionResult {
    const normalized = this.normalizeMessages(messages, options);
    const protocolSanitized = sanitizeMessagesForToolProtocol(normalized.messages);
    const withSystem =
      options?.systemPrompt && options.systemPrompt.length > 0
        ? [{ role: 'system' as const, content: options.systemPrompt }, ...protocolSanitized.messages]
        : protocolSanitized.messages;
    const prepared = prepareMessagesForModel(withSystem, {
      trimOptions: options?.trimOptions,
    });
    const preparedMessages = prepared.postTrimSanitized.messages;
    const messagesWithoutSystem =
      preparedMessages[0]?.role === 'system' ? preparedMessages.slice(1) : preparedMessages;

    return {
      messages: messagesWithoutSystem,
      preparedMessages,
      metrics: {
        originalChars: estimateMessagesCharacters(messages),
        projectedChars: estimateMessagesCharacters(protocolSanitized.messages),
        preparedChars: estimateMessagesCharacters(preparedMessages),
        originalMessageCount: messages.length,
        projectedMessageCount: protocolSanitized.messages.length,
        preparedMessageCount: preparedMessages.length,
        toolResultRefReplacements: normalized.toolResultRefReplacements,
        oversizedInlineToolTruncations: normalized.oversizedInlineToolTruncations,
        protocolCorrectionCount:
          protocolSanitized.correctedCount + prepared.preTrimSanitized.correctedCount + prepared.postTrimSanitized.correctedCount,
        trimRemovedCount: prepared.trim.removedCount,
        trimTruncatedCount: prepared.trim.truncatedCount,
      },
    };
  }
}
