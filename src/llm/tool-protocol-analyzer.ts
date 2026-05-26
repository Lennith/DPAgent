import type { Message, ToolCall, ToolProtocolBuildResult, ToolProtocolFrame, ToolProtocolMetrics } from '../types.js';

export interface AssistantToolBundleAnalysis {
  toolCalls: ToolCall[];
  expectedIds: string[];
  followingTools: Message[];
  orderedToolResults: Message[];
  valid: boolean;
  resultCount: number;
  reason?: 'empty_or_duplicate_ids' | 'missing_tool_results' | 'misaligned_tool_results';
}

export interface ToolProtocolAnalysisResult extends ToolProtocolBuildResult {
  invalidAssistantToolBundleCount: number;
  orphanToolResultCount: number;
}

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

export function analyzeAssistantToolBundle(messages: Message[], index: number): AssistantToolBundleAnalysis {
  const message = messages[index];
  const toolCalls = message?.role === 'assistant' ? message.toolCalls ?? [] : [];
  const expectedIds = normalizeToolCallIds(toolCalls);
  const followingTools: Message[] = [];
  let cursor = index + 1;
  while (cursor < messages.length && messages[cursor].role === 'tool') {
    followingTools.push(messages[cursor]);
    cursor += 1;
  }

  if (toolCalls.length === 0) {
    return {
      toolCalls,
      expectedIds,
      followingTools,
      orderedToolResults: [],
      valid: false,
      resultCount: 0,
      reason: 'missing_tool_results',
    };
  }

  if (!hasUniqueNonEmptyIds(expectedIds)) {
    return {
      toolCalls,
      expectedIds,
      followingTools,
      orderedToolResults: [],
      valid: false,
      resultCount: 0,
      reason: 'empty_or_duplicate_ids',
    };
  }

  if (followingTools.length < expectedIds.length) {
    return {
      toolCalls,
      expectedIds,
      followingTools,
      orderedToolResults: [],
      valid: false,
      resultCount: 0,
      reason: 'missing_tool_results',
    };
  }

  const expectedIdSet = new Set(expectedIds);
  const matchedById = new Map<string, Message>();
  const maybeResults = followingTools.slice(0, expectedIds.length);
  for (const toolMessage of maybeResults) {
    const toolCallId = toolMessage.toolCallId?.trim();
    if (!toolCallId || !expectedIdSet.has(toolCallId) || matchedById.has(toolCallId)) {
      return {
        toolCalls,
        expectedIds,
        followingTools,
        orderedToolResults: [],
        valid: false,
        resultCount: 0,
        reason: 'misaligned_tool_results',
      };
    }
    matchedById.set(toolCallId, toolMessage);
  }

  const orderedToolResults = expectedIds
    .map((id) => matchedById.get(id))
    .filter((toolMessage): toolMessage is Message => Boolean(toolMessage));

  if (orderedToolResults.length !== expectedIds.length) {
    return {
      toolCalls,
      expectedIds,
      followingTools,
      orderedToolResults: [],
      valid: false,
      resultCount: 0,
      reason: 'misaligned_tool_results',
    };
  }

  return {
    toolCalls,
    expectedIds,
    followingTools,
    orderedToolResults,
    valid: true,
    resultCount: orderedToolResults.length,
  };
}

export function analyzeToolProtocol(messages: Message[]): ToolProtocolAnalysisResult {
  const frames: ToolProtocolFrame[] = [];
  const metrics = emptyMetrics();
  let invalidAssistantToolBundleCount = 0;
  let orphanToolResultCount = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const toolCalls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (message.role !== 'assistant' || toolCalls.length === 0) {
      if (message.role === 'tool') {
        orphanToolResultCount += 1;
      }
      frames.push({ kind: 'message', message });
      continue;
    }

    const bundle = analyzeAssistantToolBundle(messages, i);
    if (!bundle.valid) {
      invalidAssistantToolBundleCount += 1;
      frames.push({ kind: 'message', message });
      continue;
    }

    metrics.assistantToolBundleCount += 1;
    metrics.toolResultMessageCount += bundle.orderedToolResults.length;
    metrics.maxToolResultsPerBundle = Math.max(metrics.maxToolResultsPerBundle, bundle.orderedToolResults.length);
    frames.push({
      kind: 'assistant_tool_bundle',
      assistant: message,
      toolResults: bundle.orderedToolResults,
    });
    i += bundle.resultCount;
  }

  return {
    frames,
    ...metrics,
    invalidAssistantToolBundleCount,
    orphanToolResultCount,
  };
}

export function prepareToolProtocol(messages: Message[]): ToolProtocolAnalysisResult {
  return analyzeToolProtocol(messages);
}

export function assertReplaySafeToolProtocol(messages: Message[]): void {
  const analysis = prepareToolProtocol(messages);
  if (analysis.orphanToolResultCount > 0) {
    throw new Error('[INVALID_REPLAY_PROTOCOL] tool_result message is not part of a valid assistant/tool bundle.');
  }
  if (analysis.invalidAssistantToolBundleCount > 0) {
    throw new Error('[INVALID_REPLAY_PROTOCOL] assistant tool bundle is missing aligned tool_result messages.');
  }
}

export function buildMalformedToolProtocolNotice(reason: string): string {
  return `[TOOLCALL_FAILED] ${reason}. next_action=Issue fresh tool calls and continue from latest valid state.`;
}
