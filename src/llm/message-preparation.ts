import type {
  ContextWindowTrimOptions,
  ContextWindowTrimResult,
  Message,
  PreparedMessagesResult,
  ToolCall,
  ToolProtocolSanitizeResult,
} from '../types.js';
import { buildToolProtocolFrames } from './tool-protocol.js';

const DEFAULT_CONTEXT_MAX_CHARS = Number.MAX_SAFE_INTEGER;
const DEFAULT_KEEP_LATEST_COUNT = 24;
const DEFAULT_TOOL_MAX_CHARS = 4000;
const DEFAULT_NON_TOOL_MAX_CHARS = 12000;

/**
 * Sanitize messages to ensure tool protocol integrity.
 * Fixes orphaned tool calls and tool results.
 */
export function sanitizeMessagesForToolProtocol(messages: Message[]): ToolProtocolSanitizeResult {
  const sanitized: Message[] = [];
  let correctedCount = 0;
  let orphanToolCallFixed = 0;
  let orphanToolResultFixed = 0;

  const truncate = (value: string, limit: number): string =>
    value.length > limit ? `${value.slice(0, limit)}...(truncated)` : value;

  const buildOrphanToolResultNote = (message: Message): Message => {
    const content = truncate(messageTextContent(message.content), 500);
    return {
      role: 'user',
      content:
        `[TOOLCALL_FAILED] Invalid tool_result without matching tool_use.` +
        ` tool_call_id=${message.toolCallId?.trim() || '(missing)'}, tool=${message.name ?? '(unknown)'}.` +
        ` original_content=${content}.` +
        ` replay_action=dropped_invalid_tool_protocol.` +
        ` next_action=Issue a fresh tool call and continue.`,
    };
  };

  const buildOrphanToolCallNote = (toolCalls: ToolCall[], observedToolMessages: number): Message => {
    const ids = toolCalls
      .map((toolCall) => toolCall.id?.trim())
      .filter((id): id is string => Boolean(id))
      .join(',');
    return {
      role: 'user',
      content:
        `[TOOLCALL_FAILED] assistant tool_use sequence is not followed by aligned tool_result messages.` +
        ` tool_call_ids=${ids || '(missing)'}, observed_tool_results=${observedToolMessages}.` +
        ` replay_action=dropped_invalid_tool_protocol.` +
        ` next_action=Issue fresh tool calls and continue from latest valid state.`,
    };
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'assistant') {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length === 0) {
        sanitized.push(message);
        continue;
      }

      const expectedIds = new Set(
        toolCalls.map((toolCall) => toolCall.id?.trim()).filter((id): id is string => Boolean(id))
      );
      const followingTools: Message[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        followingTools.push(messages[j]);
        j += 1;
      }

      const matchedIds = new Set<string>();
      let validSequence = expectedIds.size === toolCalls.length && followingTools.length >= toolCalls.length;
      const expectedToolResults = followingTools.slice(0, toolCalls.length);
      for (const toolMessage of expectedToolResults) {
        const id = toolMessage.toolCallId?.trim();
        if (!id || !expectedIds.has(id) || matchedIds.has(id)) {
          validSequence = false;
          break;
        }
        matchedIds.add(id);
      }
      if (matchedIds.size !== expectedIds.size) {
        validSequence = false;
      }

      if (validSequence) {
        sanitized.push(message);
        sanitized.push(...expectedToolResults);
        i += expectedToolResults.length;
        continue;
      }

      correctedCount += 1;
      orphanToolCallFixed += 1;
      sanitized.push({
        ...message,
        toolCalls: undefined,
      });
      sanitized.push(buildOrphanToolCallNote(toolCalls, followingTools.length));
      for (const toolMessage of followingTools) {
        correctedCount += 1;
        orphanToolResultFixed += 1;
        sanitized.push(buildOrphanToolResultNote(toolMessage));
      }
      i = j - 1;
      continue;
    }

    if (message.role === 'tool') {
      correctedCount += 1;
      orphanToolResultFixed += 1;
      sanitized.push(buildOrphanToolResultNote(message));
      continue;
    }

    sanitized.push(message);
  }

  return { messages: sanitized, correctedCount, orphanToolCallFixed, orphanToolResultFixed };
}

/**
 * Check if error is MiniMax tool result ID not found error (2013)
 */
export function isMiniMaxToolResultIdNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('(2013)') && normalized.includes('tool id') && normalized.includes('not found');
}

/**
 * Extract missing tool call ID from error message
 */
export function extractMissingToolCallId(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [/tool id\(([^)]+)\)\s+not found/i, /tool[_\s-]*use[_\s-]*id[=:]\s*([a-z0-9._:-]+)/i];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const id = match[1].trim();
      if (id.length > 0) {
        return id;
      }
    }
  }
  return undefined;
}

/**
 * Check if error is MiniMax context window exceeded error
 */
export function isMiniMaxContextWindowExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('context window exceeds limit') ||
    (normalized.includes('(2013)') && normalized.includes('context window'))
  );
}

export function messageTextContent(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts = content.map((block) => {
    if (block.type === 'text') {
      return block.text ?? '';
    }
    if (block.type === 'tool_result') {
      return block.content ?? '';
    }
    if (block.type === 'tool_use') {
      return JSON.stringify(block.input ?? {});
    }
    return '';
  });
  return parts.join('\n');
}

export function estimateMessageContentCharacters(content: Message['content']): number {
  if (typeof content === 'string') {
    return content.length;
  }
  try {
    return JSON.stringify(content).length;
  } catch {
    return messageTextContent(content).length;
  }
}

export function estimateMessageCharacters(message: Message): number {
  let total = estimateMessageContentCharacters(message.content);
  total += (message.thinking?.length ?? 0) + (message.thinkingSignature?.length ?? 0);
  if (message.toolCalls && message.toolCalls.length > 0) {
    total += message.toolCalls.reduce((sum, toolCall) => {
      const args = JSON.stringify(toolCall.function.arguments ?? {});
      return sum + toolCall.id.length + toolCall.function.name.length + args.length + 16;
    }, 0);
  }
  if (message.role === 'tool') {
    total += (message.toolCallId?.length ?? 0) + (message.name?.length ?? 0) + 8;
  }
  return total;
}

export function estimateMessagesCharacters(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageCharacters(message), 0);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const kept = Math.max(0, maxChars - 64);
  const removed = value.length - kept;
  return `${value.slice(0, kept)}\n...[CONTEXT_TRUNCATED removed_chars=${removed}]`;
}

function normalizeMessageContent(message: Message, maxChars: number): Message {
  const raw = messageTextContent(message.content);
  const trimmed = truncateText(raw, maxChars);
  if (trimmed === raw && typeof message.content === 'string') {
    return message;
  }
  return {
    ...message,
    content: trimmed,
  };
}

/**
 * Trim messages to fit within context window limits.
 */
export function trimMessagesForContextWindow(
  messages: Message[],
  options: ContextWindowTrimOptions = {}
): ContextWindowTrimResult {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const keepLatestCount = options.keepLatestCount ?? DEFAULT_KEEP_LATEST_COUNT;
  const maxToolChars = options.maxToolChars ?? DEFAULT_TOOL_MAX_CHARS;
  const maxNonToolChars = options.maxNonToolChars ?? DEFAULT_NON_TOOL_MAX_CHARS;

  const originalChars = estimateMessagesCharacters(messages);
  if (messages.length === 0 || originalChars <= maxTotalChars) {
    return {
      messages: [...messages],
      originalChars,
      trimmedChars: originalChars,
      removedCount: 0,
      truncatedCount: 0,
    };
  }

  const hasSystem = messages[0]?.role === 'system';
  const systemMessage = hasSystem ? messages[0] : null;
  const contentMessages = hasSystem ? messages.slice(1) : [...messages];

  let truncatedCount = 0;
  const normalizedContentMessages = contentMessages.map((message) => {
    const cap = message.role === 'tool' ? maxToolChars : maxNonToolChars;
    const next = normalizeMessageContent(message, cap);
    if (estimateMessageCharacters(next) < estimateMessageCharacters(message)) {
      truncatedCount += 1;
    }
    return next;
  });

  const reserveForNotice = 220;
  const contentBudget = Math.max(
    1000,
    maxTotalChars - (systemMessage ? estimateMessageCharacters(systemMessage) : 0) - reserveForNotice
  );

  const selected: Message[] = [];
  let selectedChars = 0;
  for (let i = normalizedContentMessages.length - 1; i >= 0; i -= 1) {
    const candidate = normalizedContentMessages[i];
    const candidateChars = estimateMessageCharacters(candidate);
    if (selected.length < keepLatestCount || selectedChars + candidateChars <= contentBudget) {
      selected.push(candidate);
      selectedChars += candidateChars;
      continue;
    }
    break;
  }

  selected.reverse();
  const removedCount = Math.max(0, normalizedContentMessages.length - selected.length);
  const notice: Message | null =
    removedCount > 0
      ? {
          role: 'assistant',
          content:
            `[CONTEXT_WINDOW_GUARD] Earlier context was trimmed to fit model limit.` +
            ` removed_messages=${removedCount}, retained_messages=${selected.length}.`,
        }
      : null;

  const resultMessages: Message[] = [];
  if (systemMessage) {
    resultMessages.push(systemMessage);
  }
  if (notice) {
    resultMessages.push(notice);
  }
  resultMessages.push(...selected);

  const trimmedChars = estimateMessagesCharacters(resultMessages);
  const safeTrimmedChars = Math.min(trimmedChars, originalChars);

  return {
    messages: resultMessages,
    originalChars,
    trimmedChars: safeTrimmedChars,
    removedCount,
    truncatedCount,
  };
}

/**
 * Prepare messages for model by sanitizing and trimming.
 */
export function prepareMessagesForModel(
  messages: Message[],
  options?: { trimOptions?: ContextWindowTrimOptions }
): PreparedMessagesResult {
  const preTrimSanitized = sanitizeMessagesForToolProtocol(messages);
  const trim = trimMessagesForContextWindow(preTrimSanitized.messages, options?.trimOptions);
  const postTrimSanitized = sanitizeMessagesForToolProtocol(trim.messages);
  // Protocol metrics reflect the post-sanitize replay shape consumed by providers.
  const toolProtocol = buildToolProtocolFrames(postTrimSanitized.messages);
  return {
    preTrimSanitized,
    trim,
    postTrimSanitized,
    toolProtocol: {
      assistantToolBundleCount: toolProtocol.assistantToolBundleCount,
      toolResultMessageCount: toolProtocol.toolResultMessageCount,
      maxToolResultsPerBundle: toolProtocol.maxToolResultsPerBundle,
    },
  };
}
