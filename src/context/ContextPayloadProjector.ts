import type {
  ContextPayloadProjectionMetrics,
  ContextWindowTrimOptions,
  Message,
  ToolResultArtifactRef,
} from '../types.js';
import {
  estimateMessagesCharacters,
  messageTextContent,
  prepareMessagesForModel,
  sanitizeMessagesForToolProtocol,
} from '../llm/index.js';

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

const DEFAULT_TOOL_RESULT_INLINE_CHARS = 6000;
const DEFAULT_NON_TOOL_INLINE_CHARS = 12000;

export class ContextPayloadProjector {
  normalizeMessages(
    messages: Message[],
    options?: Pick<ContextPayloadProjectionOptions, 'maxToolResultChars' | 'maxNonToolChars' | 'truncateNonToolMessages'>
  ): NormalizedPayloadResult {
    const maxToolResultChars = Math.max(1000, Math.floor(options?.maxToolResultChars ?? DEFAULT_TOOL_RESULT_INLINE_CHARS));
    const maxNonToolChars = Math.max(2000, Math.floor(options?.maxNonToolChars ?? DEFAULT_NON_TOOL_INLINE_CHARS));
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
          content: truncateWithMarker(content, maxNonToolChars, 'CONTEXT_PAYLOAD_TRUNCATED'),
        };
      }

      const artifact = message.metadata?.toolResultArtifact;
      if (artifact) {
        toolResultRefReplacements += 1;
        return {
          ...message,
          content: buildToolResultArtifactPayload(artifact, messageTextContent(message.content), maxToolResultChars),
        };
      }

      const content = messageTextContent(message.content);
      if (content.length <= maxToolResultChars) {
        return { ...message };
      }
      oversizedInlineToolTruncations += 1;
      return {
        ...message,
        content: truncateWithMarker(content, maxToolResultChars, 'TOOL_RESULT_INLINE_BUDGET_APPLIED'),
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

function buildToolResultArtifactPayload(
  artifact: ToolResultArtifactRef,
  currentContent: string,
  maxChars: number
): string {
  const header = [
    `[TOOL_RESULT_STORED tool=${artifact.toolName || '(unknown)'} tool_call_id=${artifact.toolCallId || '(unknown)'} artifact_id=${artifact.artifactId} original_chars=${artifact.originalChars} preview_chars=${artifact.previewChars}]`,
    'Use read_tool_result with artifact_id, offset, and limit when the full output is needed.',
  ].join('\n');
  const previewMatch = currentContent.match(/Preview:\n([\s\S]*)$/);
  const preview = (previewMatch?.[1] ?? currentContent).slice(0, Math.max(0, maxChars - header.length - 12));
  return `${header}\n\nPreview:\n${preview}`;
}

function truncateWithMarker(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  const header = `[${marker} original_chars=${value.length} kept_chars=${maxChars}]`;
  const bodyBudget = Math.max(0, maxChars - header.length - 1);
  return bodyBudget > 0 ? `${header}\n${value.slice(0, bodyBudget)}` : header.slice(0, maxChars);
}
