import type { Message } from '../types.js';
import { estimateMessageCharacters } from '../llm/index.js';

export interface CompressibleTranscriptItem {
  messageIndex: number;
  role: string;
  charLength: number;
  isToolBundle: boolean;
  isThinkingBlock: boolean;
  content: string;
  message: Message;
}

export interface CompressionChunk {
  id: string;
  startIndex: number;
  endIndex: number;
  charLength: number;
  items: CompressibleTranscriptItem[];
}

export interface BuildCompressionChunksInput {
  items: CompressibleTranscriptItem[];
  maxChunks?: number;
  maxChunkChars?: number;
}

const DEFAULT_MAX_CHUNKS = 3;

export function buildCompressionChunks(
  input: BuildCompressionChunksInput
): CompressionChunk[] {
  const maxChunks = Math.max(1, Math.min(10, Math.floor(input.maxChunks ?? DEFAULT_MAX_CHUNKS)));

  if (input.items.length === 0) {
    return [];
  }

  const totalChars = input.items.reduce((sum, item) => sum + item.charLength, 0);
  const configuredMaxChunkChars =
    typeof input.maxChunkChars === 'number' && Number.isFinite(input.maxChunkChars) && input.maxChunkChars > 0
      ? Math.floor(input.maxChunkChars)
      : undefined;
  const maxChunkChars = Math.max(1, configuredMaxChunkChars ?? Math.ceil(totalChars / maxChunks));

  const chunks: CompressionChunk[] = [];
  let currentItems: CompressibleTranscriptItem[] = [];
  let currentChars = 0;
  let chunkIndex = 0;

  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (chunks.length >= maxChunks - 1) {
      currentItems.push(item);
      currentChars += item.charLength;
      continue;
    }

    const wouldExceed = currentItems.length > 0 && currentChars + item.charLength > maxChunkChars;

    if (wouldExceed) {
      chunks.push({
        id: `chunk-${chunkIndex + 1}`,
        startIndex: currentItems[0].messageIndex,
        endIndex: currentItems[currentItems.length - 1].messageIndex,
        charLength: currentChars,
        items: [...currentItems],
      });
      chunkIndex++;
      currentItems = [];
      currentChars = 0;
    }

    currentItems.push(item);
    currentChars += item.charLength;
  }

  if (currentItems.length > 0) {
    chunks.push({
      id: `chunk-${chunkIndex + 1}`,
      startIndex: currentItems[0].messageIndex,
      endIndex: currentItems[currentItems.length - 1].messageIndex,
      charLength: currentChars,
      items: [...currentItems],
    });
  }

  return chunks;
}

export function collectCompressibleItems(
  messages: Message[],
  options?: {
    systemPromptLength?: number;
    activeTurnStartIndex?: number;
  }
): CompressibleTranscriptItem[] {
  const items: CompressibleTranscriptItem[] = [];
  const activeTurnStart =
    typeof options?.activeTurnStartIndex === 'number' ? options.activeTurnStartIndex : messages.length;

  for (let i = 0; i < messages.length; i++) {
    if (i === 0 && messages[i]?.role === 'system') continue;
    if (i >= activeTurnStart) break;

    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
      continue;
    }

    const charLength = estimateMessageCharacters(message);

    const isToolBundle =
      message.role === 'assistant' &&
      (message.toolCalls?.length ?? 0) > 0;
    const isThinkingBlock =
      message.role === 'assistant' &&
      (typeof message.thinking === 'string' && message.thinking.trim().length > 0);

    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    }

    items.push({
      messageIndex: i,
      role: message.role,
      charLength,
      isToolBundle,
      isThinkingBlock,
      content,
      message,
    });
  }

  return items;
}

export function buildCompressionChunkPrompt(chunk: CompressionChunk): string {
  const lines: string[] = [];
  lines.push(`[COMPRESSION_CHUNK ${chunk.id}]`);
  lines.push(`items=${chunk.items.length} chars=${chunk.charLength}`);
  lines.push('');

  for (const item of chunk.items) {
    const roleTag = item.role.toUpperCase();
    const truncated = item.content.length > 600
      ? `${item.content.slice(0, 600)}...(truncated)`
      : item.content;
    lines.push(`[${roleTag}] ${truncated}`);
  }

  lines.push('');
  lines.push(
    'Summarize this chunk compactly while preserving: user intent, decisions made, ' +
    'files touched, tool outputs needed later, open tasks, constraints, unresolved errors.'
  );

  return lines.join('\n');
}

export function extractChunkMessages(
  messages: Message[],
  chunk: CompressionChunk
): Message[] {
  if (chunk.items.length === 0) return [];
  const startIdx = chunk.items[0].messageIndex;
  const endIdx = chunk.items[chunk.items.length - 1].messageIndex;
  return messages.slice(startIdx, endIdx + 1).map((m) => ({ ...m }));
}
