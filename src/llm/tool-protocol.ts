import type { Message, ToolCall, ToolProtocolBuildResult, ToolProtocolMetrics } from '../types.js';

function normalizeToolCallIds(toolCalls: ToolCall[]): string[] {
  return toolCalls.map((toolCall) => toolCall.id?.trim() ?? '');
}

function hasUniqueNonEmptyIds(ids: string[]): boolean {
  if (ids.some((id) => id.length === 0)) {
    return false;
  }
  return new Set(ids).size === ids.length;
}

function emptyMetrics(): ToolProtocolMetrics {
  return {
    assistantToolBundleCount: 0,
    toolResultMessageCount: 0,
    maxToolResultsPerBundle: 0,
  };
}

/**
 * Build canonical protocol frames from sanitized messages.
 * A frame is either a normal message, or an assistant tool bundle that
 * includes the assistant tool_use turn and aligned tool_result messages.
 */
export function buildToolProtocolFrames(messages: Message[]): ToolProtocolBuildResult {
  const frames: ToolProtocolBuildResult['frames'] = [];
  const metrics = emptyMetrics();

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const toolCalls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (message.role !== 'assistant' || toolCalls.length === 0) {
      frames.push({ kind: 'message', message });
      continue;
    }

    const expectedIds = normalizeToolCallIds(toolCalls);
    if (!hasUniqueNonEmptyIds(expectedIds)) {
      frames.push({ kind: 'message', message });
      continue;
    }

    const expectedIdSet = new Set(expectedIds);
    const followingTools: Message[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      followingTools.push(messages[j]);
      j += 1;
    }

    if (followingTools.length < expectedIds.length) {
      frames.push({ kind: 'message', message });
      continue;
    }

    const matchedById = new Map<string, Message>();
    let aligned = true;
    const maybeResults = followingTools.slice(0, expectedIds.length);
    for (const toolMessage of maybeResults) {
      const toolCallId = toolMessage.toolCallId?.trim();
      if (!toolCallId || !expectedIdSet.has(toolCallId) || matchedById.has(toolCallId)) {
        aligned = false;
        break;
      }
      matchedById.set(toolCallId, toolMessage);
    }

    if (!aligned || matchedById.size !== expectedIds.length) {
      frames.push({ kind: 'message', message });
      continue;
    }

    const orderedToolResults = expectedIds
      .map((id) => matchedById.get(id))
      .filter((toolMessage): toolMessage is Message => Boolean(toolMessage));

    if (orderedToolResults.length !== expectedIds.length) {
      frames.push({ kind: 'message', message });
      continue;
    }

    metrics.assistantToolBundleCount += 1;
    metrics.toolResultMessageCount += orderedToolResults.length;
    metrics.maxToolResultsPerBundle = Math.max(metrics.maxToolResultsPerBundle, orderedToolResults.length);
    frames.push({
      kind: 'assistant_tool_bundle',
      assistant: message,
      toolResults: orderedToolResults,
    });
    i += orderedToolResults.length;
  }

  return {
    frames,
    ...metrics,
  };
}
