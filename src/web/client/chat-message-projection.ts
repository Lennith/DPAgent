import type { Message } from './chat-types.js';
import { isContextEventVersionConflictError } from '../../shared/context-version-conflict.js';
import type { ContextUtilizationMap, SessionDetail } from './app-shell-types.js';
import { createMessageId, createRunErrorTranscriptMessage, inferToolResultSuccess } from './app-shell-types.js';

function timestampFromCreatedAt(createdAt: unknown, fallback: number): number {
  const parsed = Date.parse(String(createdAt ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function projectSessionMessages(sessionId: string, session: SessionDetail): Message[] {
  const sourceMessages = session.messages ?? [];
  const loadedMessages: Message[] = [];
  let renderedIndex = 0;

  for (const msg of sourceMessages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      loadedMessages.push({
        id: createMessageId(`msg-${sessionId}-${renderedIndex}`),
        role: msg.role,
        content: msg.content,
        timestamp: timestampFromCreatedAt(
          msg.createdAt,
          Date.now() - (sourceMessages.length - renderedIndex) * 1000
        ),
        thinking: msg.thinking,
        metadata: msg.metadata,
        toolCalls: msg.toolCalls?.map((toolCall) => ({
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        })),
        toolResults: [],
      });
      renderedIndex += 1;
      continue;
    }

    if (msg.role === 'tool') {
      const lastMessage = loadedMessages[loadedMessages.length - 1];
      if (lastMessage?.role === 'assistant') {
        lastMessage.toolResults = [
          ...(lastMessage.toolResults ?? []),
          {
            name: msg.name || 'tool',
            result: {
              success: inferToolResultSuccess(msg.content),
              content: msg.content,
            },
          },
        ];
      }
    }
  }

  for (const runtimeError of session.runtimeErrors ?? []) {
    if (runtimeError.terminalCode === 'cancelled') {
      continue;
    }
    const message = String(runtimeError.message ?? '').trim();
    const runId = String(runtimeError.runId ?? '').trim();
    if (isContextEventVersionConflictError(message)) {
      continue;
    }
    if (!message || !runId) {
      continue;
    }
    loadedMessages.push(
      createRunErrorTranscriptMessage({
        id: runtimeError.id || `run-error-${runId}`,
        runId,
        message,
        createdAt: runtimeError.createdAt,
      })
    );
  }

  return loadedMessages;
}

export function projectSessionContextUtilization(
  session: SessionDetail
): ContextUtilizationMap[string] {
  return session.contextUtilization
    ? {
        ratio:
          typeof session.contextUtilization.usedTokens === 'number' &&
          typeof session.contextUtilization.limitTokens === 'number' &&
          session.contextUtilization.limitTokens > 0
            ? session.contextUtilization.usedTokens / session.contextUtilization.limitTokens
            : session.contextUtilization.ratio ?? 0,
        usedChars: session.contextUtilization.usedChars ?? 0,
        limitChars: session.contextUtilization.limitChars ?? 230000,
        usedTokens: session.contextUtilization.usedTokens,
        limitTokens: session.contextUtilization.limitTokens,
        source: session.contextUtilization.source,
        anchorPromptTokens: session.contextUtilization.anchorPromptTokens,
        deltaEstimatedTokens: session.contextUtilization.deltaEstimatedTokens,
        isWarning: session.contextUtilization.isWarning === true,
        initializing: false,
      }
    : {
        ratio: 0,
        usedChars: 0,
        limitChars: 230000,
        isWarning: false,
        initializing: true,
      };
}
