import type { Message, ToolCall, ToolResultArtifactRef } from '../types.js';

export const TOOL_RESULT_PAYLOAD_MARKERS = {
  truncated: 'TOOL_RESULT_TRUNCATED',
  inlineBudgetApplied: 'TOOL_RESULT_INLINE_BUDGET_APPLIED',
  stored: 'TOOL_RESULT_STORED',
  artifact: 'TOOL_RESULT_ARTIFACT',
  artifactTruncated: 'TOOL_RESULT_ARTIFACT_TRUNCATED',
  artifactScanLimitReached: 'TOOL_RESULT_ARTIFACT_SCAN_LIMIT_REACHED',
  contextPayloadTruncated: 'CONTEXT_PAYLOAD_TRUNCATED',
  toolArgumentRedacted: 'TOOL_ARGUMENT_REDACTED',
} as const;

export const DEFAULT_AGENT_TOOL_RESULT_INLINE_CHARS = 4000;
export const READ_FILE_AGENT_TOOL_RESULT_INLINE_CHARS = 20000;
export const READ_TOOL_RESULT_AGENT_INLINE_CHARS = 26000;
export const DEFAULT_PROJECTED_TOOL_RESULT_INLINE_CHARS = 6000;
export const DEFAULT_PROJECTED_NON_TOOL_INLINE_CHARS = 12000;
export const DEFAULT_ARTIFACT_THRESHOLD_CHARS = 50000;
export const DEFAULT_ARTIFACT_PREVIEW_CHARS = 20000;
export const ARTIFACT_PREVIEW_MIN_CHARS = 200;
export const ARTIFACT_PREVIEW_MAX_CHARS = 20000;
export const ARTIFACT_READ_DEFAULT_MAX_CHARS = 20000;
export const ARTIFACT_READ_MIN_MAX_CHARS = 1000;
export const ARTIFACT_READ_MAX_MAX_CHARS = 24000;
export const ARTIFACT_READ_DEFAULT_LINE_LIMIT = 400;
export const ARTIFACT_READ_MAX_LINE_LIMIT = 400;
export const ARTIFACT_READ_MAX_SCAN_BYTES = 8 * 1024 * 1024;

export function normalizeToolName(toolName?: string): string {
  return String(toolName ?? '').trim().toLowerCase();
}

export function resolveAgentToolResultInlineChars(toolName?: string): number {
  const normalized = normalizeToolName(toolName);
  if (normalized === 'read_file') {
    return READ_FILE_AGENT_TOOL_RESULT_INLINE_CHARS;
  }
  if (normalized === 'read_tool_result') {
    return READ_TOOL_RESULT_AGENT_INLINE_CHARS;
  }
  return DEFAULT_AGENT_TOOL_RESULT_INLINE_CHARS;
}

export function shouldMaterializeLiveToolResult(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized !== 'read_tool_result';
}

export function buildRedactedToolArgumentContent(originalChars: number): string {
  return `[${TOOL_RESULT_PAYLOAD_MARKERS.toolArgumentRedacted} field=content original_chars=${Math.max(
    0,
    Math.floor(originalChars)
  )}]`;
}

export function redactToolCallArgumentsForCheckpoint(toolName: string | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolName(toolName);
  if (normalized !== 'write_file' || typeof args.content !== 'string') {
    return { ...args };
  }
  return {
    ...args,
    content: buildRedactedToolArgumentContent(args.content.length),
  };
}

export function redactToolCallsForCheckpoint(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) {
    return undefined;
  }
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    function: {
      ...toolCall.function,
      arguments: redactToolCallArgumentsForCheckpoint(toolCall.function.name, toolCall.function.arguments),
    },
  }));
}

export function redactToolCallMessagesForCheckpoint(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.toolCalls) {
      return JSON.parse(JSON.stringify(message)) as Message;
    }
    return {
      ...(JSON.parse(JSON.stringify(message)) as Message),
      toolCalls: redactToolCallsForCheckpoint(message.toolCalls),
    };
  });
}

export function resolveProjectedToolResultInlineChars(maxToolResultChars?: number): number {
  return Math.max(
    1000,
    Math.floor(maxToolResultChars ?? DEFAULT_PROJECTED_TOOL_RESULT_INLINE_CHARS)
  );
}

export function resolveProjectedNonToolInlineChars(maxNonToolChars?: number): number {
  return Math.max(
    2000,
    Math.floor(maxNonToolChars ?? DEFAULT_PROJECTED_NON_TOOL_INLINE_CHARS)
  );
}

export function resolveToolResultArtifactThreshold(thresholdChars?: number): number {
  return Math.max(1000, Math.floor(thresholdChars ?? DEFAULT_ARTIFACT_THRESHOLD_CHARS));
}

export function resolveToolResultArtifactPreviewChars(previewChars?: number): number {
  return Math.max(
    ARTIFACT_PREVIEW_MIN_CHARS,
    Math.min(ARTIFACT_PREVIEW_MAX_CHARS, Math.floor(previewChars ?? DEFAULT_ARTIFACT_PREVIEW_CHARS))
  );
}

export function resolveArtifactReadLineLimit(limit?: number): number {
  return Math.max(1, Math.min(ARTIFACT_READ_MAX_LINE_LIMIT, Math.floor(limit ?? ARTIFACT_READ_DEFAULT_LINE_LIMIT)));
}

export function resolveArtifactReadMaxChars(maxChars?: number): number {
  return Math.max(
    ARTIFACT_READ_MIN_MAX_CHARS,
    Math.min(ARTIFACT_READ_MAX_MAX_CHARS, Math.floor(maxChars ?? ARTIFACT_READ_DEFAULT_MAX_CHARS))
  );
}

export function truncateWithPayloadMarker(
  content: string,
  maxChars: number,
  marker: string,
  attributes: Record<string, string | number | undefined> = {}
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const serializedAttributes = Object.entries({
    ...attributes,
    original_chars: content.length,
    kept_chars: maxChars,
  })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  const header = `[${marker}${serializedAttributes ? ` ${serializedAttributes}` : ''}]`;
  const bodyBudget = Math.max(0, maxChars - header.length - 1);
  return bodyBudget > 0 ? `${header}\n${content.slice(0, bodyBudget)}` : header.slice(0, maxChars);
}

export function buildAgentToolResultTruncatedContent(
  toolName: string | undefined,
  content: string,
  maxChars: number
): string {
  const displayToolName = String(toolName ?? '(unknown)').trim() || '(unknown)';
  return truncateWithPayloadMarker(content, maxChars, TOOL_RESULT_PAYLOAD_MARKERS.truncated, {
    tool: displayToolName,
  });
}

export function buildInlineToolResultBudgetContent(
  content: string,
  maxChars: number,
  artifactError?: string
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const artifactErrorSegment =
    artifactError !== undefined ? ` artifact_error=${JSON.stringify(artifactError)}` : '';
  const header = `[${TOOL_RESULT_PAYLOAD_MARKERS.inlineBudgetApplied} original_chars=${content.length} kept_chars=${maxChars}${artifactErrorSegment}]`;
  const bodyBudget = Math.max(0, maxChars - header.length - 1);
  return bodyBudget > 0 ? `${header}\n${content.slice(0, bodyBudget)}` : header.slice(0, maxChars);
}

export function buildStoredToolResultContent(artifact: ToolResultArtifactRef, preview: string): string {
  return [
    `[${TOOL_RESULT_PAYLOAD_MARKERS.stored} tool=${artifact.toolName || '(unknown)'} tool_call_id=${artifact.toolCallId || '(unknown)'} artifact_id=${artifact.artifactId} original_chars=${artifact.originalChars} preview_chars=${artifact.previewChars}]`,
    'Use read_tool_result with artifact_id, offset, and limit when the full output is needed.',
    '',
    'Preview:',
    preview,
  ].join('\n');
}

export function buildProjectedToolResultArtifactPayload(
  artifact: ToolResultArtifactRef,
  currentContent: string,
  maxChars: number
): string {
  const header = [
    `[${TOOL_RESULT_PAYLOAD_MARKERS.stored} tool=${artifact.toolName || '(unknown)'} tool_call_id=${artifact.toolCallId || '(unknown)'} artifact_id=${artifact.artifactId} original_chars=${artifact.originalChars} preview_chars=${artifact.previewChars}]`,
    'Use read_tool_result with artifact_id, offset, and limit when the full output is needed.',
  ].join('\n');
  const previewMatch = currentContent.match(/Preview:\n([\s\S]*)$/);
  const preview = (previewMatch?.[1] ?? currentContent).slice(0, Math.max(0, maxChars - header.length - 12));
  return `${header}\n\nPreview:\n${preview}`;
}

export function buildReadToolResultArtifactContent(input: {
  artifactId: string;
  offset: number;
  limit: number;
  maxChars: number;
  maxScanBytes: number;
  content: string;
}): string {
  return (
    `[${TOOL_RESULT_PAYLOAD_MARKERS.artifact} artifact_id=${input.artifactId} offset=${input.offset} limit=${input.limit} max_chars=${input.maxChars} max_scan_bytes=${input.maxScanBytes}]\n` +
    input.content
  );
}
