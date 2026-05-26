import { messageTextContent } from '../llm/index.js';
import type { Message } from '../types.js';
import { INTERNAL_CONTEXT_MARKERS } from './context-replay-assembly.js';
import { cloneMessage } from '../interrupted-turn-recovery.js';

export function filterCommittedTurnMessages(messages: Message[]): Message[] {
  return messages.filter((message) => {
    const text = messageTextContent(message.content).trim();
    if (text.startsWith('[CONTEXT_PRECOMPRESSED')) {
      return true;
    }
    if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
      return false;
    }
    if (message.role === 'user' && !text) {
      return false;
    }
    return true;
  });
}

export function collectCommittedTurnMessagesFromSnapshot(
  messages: Message[],
  fallbackBaselineMessageCount: number
): Message[] {
  const body = messages.filter((message) => message.role !== 'system').map((message) => cloneMessage(message));
  const firstCurrentTurnIndex = body.findIndex((message) => Boolean(message.metadata?.checkpointId));
  const rawTurnMessages =
    firstCurrentTurnIndex >= 0
      ? body.slice(firstCurrentTurnIndex)
      : body.slice(Math.max(0, fallbackBaselineMessageCount));
  return filterCommittedTurnMessages(rawTurnMessages);
}
