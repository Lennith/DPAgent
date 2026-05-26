import { messageTextContent } from '../llm/index.js';
import type { Message, PersistedMessage } from '../types.js';

export function toPersistedMessages(
  messages: Message[],
  options?: { idPrefix?: string }
): PersistedMessage[] {
  const timestamp = new Date().toISOString();
  const idPrefix = options?.idPrefix ?? 'msg';
  return messages.map((message, index) => ({
    id: `${idPrefix}-${index + 1}`,
    role: message.role,
    content: messageTextContent(message.content),
    timestamp,
    thinking: message.thinking,
    thinkingSignature: message.thinkingSignature,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    name: message.name,
    metadata: message.metadata,
  }));
}
