import type { Message, ToolCall } from '../types.js';

export function applyInputHookModified(input: {
  modified: unknown;
  systemPrompt?: string;
  contentMessages: Message[];
}): { systemPrompt?: string; contentMessages: Message[] } {
  const modified = input.modified;
  if (!isPlainObject(modified)) {
    return { systemPrompt: input.systemPrompt, contentMessages: input.contentMessages };
  }
  const patch = modified;
  const nextSystemPrompt =
    typeof patch.systemPrompt === 'string' ? patch.systemPrompt : input.systemPrompt;
  const nextMessagesRaw = Array.isArray(patch.contentMessages)
    ? patch.contentMessages
    : Array.isArray(patch.messages)
      ? patch.messages
      : undefined;
  if (nextMessagesRaw) {
    return {
      systemPrompt: nextSystemPrompt,
      contentMessages: nextMessagesRaw as Message[],
    };
  }
  const nextInput = typeof patch.input === 'string'
    ? patch.input
    : typeof patch.prompt === 'string'
      ? patch.prompt
      : undefined;
  if (nextInput === undefined) {
    return { systemPrompt: nextSystemPrompt, contentMessages: input.contentMessages };
  }
  const nextContentMessages = input.contentMessages.map((message) => ({ ...message }));
  const lastUserIndex = nextContentMessages.map((message) => message.role).lastIndexOf('user');
  if (lastUserIndex >= 0) {
    nextContentMessages[lastUserIndex] = {
      ...nextContentMessages[lastUserIndex],
      content: nextInput,
    };
  } else {
    nextContentMessages.push({ role: 'user', content: nextInput });
  }
  return { systemPrompt: nextSystemPrompt, contentMessages: nextContentMessages };
}

export function applyBeforeToolCallHookModified(input: {
  modified: unknown;
  toolCall: ToolCall;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): { toolCall: ToolCall; toolName: string; toolArgs: Record<string, unknown> } {
  const modified = input.modified;
  if (!isPlainObject(modified)) {
    return {
      toolCall: input.toolCall,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
    };
  }
  const patch = modified;
  const toolName = typeof patch.toolName === 'string' && patch.toolName.trim()
    ? patch.toolName.trim()
    : typeof patch.name === 'string' && patch.name.trim()
      ? patch.name.trim()
      : input.toolName;
  const argsRaw = patch.toolArgs ?? patch.args ?? patch.arguments;
  const toolArgs = isPlainObject(argsRaw)
    ? argsRaw
    : input.toolArgs;
  const toolCall: ToolCall = {
    ...input.toolCall,
    function: {
      ...input.toolCall.function,
      name: toolName,
      arguments: toolArgs,
    },
  };
  return { toolCall, toolName, toolArgs };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
