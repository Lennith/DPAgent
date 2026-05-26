import type { Message } from '../../types.js';

export interface ShareTextMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ShareTextTurn {
  user: ShareTextMessage;
  assistant: ShareTextMessage;
}

export function normalizeShareTextTurns(value: unknown, fallback = 3): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 50);
}

export function messageTextBody(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

export function buildShareTextHistory(messages: Message[], turns: number): ShareTextMessage[] {
  const completedTurns: ShareTextTurn[] = [];
  let pendingUser: ShareTextMessage | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      const content = messageTextBody(message.content);
      pendingUser = content ? { role: 'user', content } : null;
      continue;
    }

    if (message.role !== 'assistant' || !pendingUser) {
      continue;
    }

    const content = messageTextBody(message.content);
    if (!content) {
      continue;
    }
    completedTurns.push({
      user: pendingUser,
      assistant: { role: 'assistant', content },
    });
    pendingUser = null;
  }

  return completedTurns
    .slice(-Math.max(0, turns))
    .flatMap((turn) => [turn.user, turn.assistant]);
}
