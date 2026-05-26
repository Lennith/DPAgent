import * as crypto from 'crypto';
import {
  estimateMessageCharacters as estimatePreparedMessageCharacters,
  messageTextContent,
} from '../llm/index.js';
import type { Message, TokenUsage } from '../types.js';

export function truncateForAgentLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

function estimateAgentMessageChars(message: Message): number {
  return estimatePreparedMessageCharacters(message);
}

export function estimateAgentMessagesChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + estimateAgentMessageChars(message), 0);
}

export function hashAgentMessages(messages: Message[]): string {
  const normalized = messages
    .map((message) =>
      JSON.stringify({
        role: message.role,
        content: messageTextContent(message.content),
        toolCallId: message.toolCallId ?? '',
        name: message.name ?? '',
      })
    )
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function formatTokenUsage(usage?: TokenUsage): string {
  if (!usage) {
    return 'none';
  }
  return `prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}`;
}

export function formatProviderErrorDiagnostics(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'none';
  }
  const record = error as Record<string, unknown>;
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : undefined;
  const errorPayload =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;
  const body =
    record.body && typeof record.body === 'object'
      ? (record.body as Record<string, unknown>)
      : undefined;
  const diagnostics = {
    name: typeof record.name === 'string' ? record.name : undefined,
    status: typeof record.status === 'number' ? record.status : undefined,
    code: typeof record.code === 'string' ? record.code : undefined,
    type:
      typeof record.type === 'string'
        ? record.type
        : typeof errorPayload?.type === 'string'
          ? errorPayload.type
          : undefined,
    requestId:
      typeof record.request_id === 'string'
        ? record.request_id
        : typeof body?.request_id === 'string'
          ? body.request_id
          : typeof response?.request_id === 'string'
            ? response.request_id
            : undefined,
    errorMessage:
      typeof errorPayload?.message === 'string'
        ? errorPayload.message
        : typeof body?.message === 'string'
          ? body.message
          : undefined,
    body,
    response,
  };
  try {
    return JSON.stringify(diagnostics);
  } catch {
    return 'unserializable';
  }
}
