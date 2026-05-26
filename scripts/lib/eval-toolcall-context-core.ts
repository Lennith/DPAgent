import type { ContextEvent } from '../../src/types.js';

const DONE_MARKER = '\u3010\u5b8c\u6210\uff01\u3011';
const REPORT_END_MARKER = '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011';
const REQUIRED_MARKERS = [DONE_MARKER, REPORT_END_MARKER];

export type RoundMode = 'work' | 'review';

export interface SeedSpec {
  index: number;
  code: string;
  value: string;
}

export interface RequiredOperation {
  label: string;
  name: string;
  args: Record<string, string>;
}

export interface ToolCallTrace {
  name: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}

export interface ToolResultTrace {
  name: string;
  toolCallId?: string;
  content: string;
  contentPreview: string;
}

export interface RoundSpec {
  round: number;
  mode: RoundMode;
  seed: SeedSpec;
  outputPath: string;
  prompt: string;
  expectedFields: Record<string, string>;
  expectedArtifact: string;
  requiredTools: string[];
  requiredOperations: RequiredOperation[];
  minToolCalls: number;
  reviewOfRound?: number;
}

export interface RoundEvaluation {
  round: number;
  mode: RoundMode;
  turnId?: string;
  prompt: string;
  outputPath: string;
  finishReason?: string;
  response: string;
  responseFields: Record<string, string>;
  fileFields: Record<string, string>;
  expectedFields: Record<string, string>;
  expectedArtifact: string;
  toolCalls: ToolCallTrace[];
  toolResults: ToolResultTrace[];
  uniqueToolNames: string[];
  requiredToolsMissing: string[];
  markerMatched: boolean;
  matchedMarker?: string;
  responseMatchesExpected: boolean;
  fileMatchesExpected: boolean;
  toolCallCount: number;
  minToolCalls: number;
  validatedOperations: string[];
  toolValidationFlags: string[];
  maxCompressionDurationMs?: number;
  flags: string[];
  ok: boolean;
}

export interface PreviousRoundRuntime {
  round: number;
  token: string;
  uniqueToolNames: string[];
  seedCode: string;
  seedValue: string;
  status: string;
}

function normalizeCompletionMarkerTail(value: string): string {
  let normalized = String(value || '').replace(/\s+$/u, '');
  for (;;) {
    const next = normalized.replace(/(?:\r?\n|\s)*```[^\r\n]*\s*$/u, '').replace(/\s+$/u, '');
    if (next === normalized) {
      return normalized;
    }
    normalized = next;
  }
}

export function detectCompletionMarker(value: string): { matched: boolean; marker?: string; duplicateTail: boolean } {
  const normalized = normalizeCompletionMarkerTail(value);
  const marker = REQUIRED_MARKERS.find((item) => normalized.endsWith(item));
  if (!marker) {
    return { matched: false, duplicateTail: false };
  }
  const prefix = normalized.slice(0, Math.max(0, normalized.length - marker.length));
  const duplicateTail = REQUIRED_MARKERS.some((item) => prefix.endsWith(item));
  return {
    matched: !duplicateTail,
    marker,
    duplicateTail,
  };
}

export function parseStructuredLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !REQUIRED_MARKERS.includes(line));
  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s+/, '');
    const match = normalized.match(/^(?:\*\*|`)?([A-Z_]+)(?:\*\*|`)?\s*[:=]\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    out[key] = normalizeStructuredValue(match[2].trim());
  }
  return out;
}

function normalizeStructuredValue(value: string): string {
  let normalized = String(value || '').trim();
  const backtickWrapped = normalized.match(/^`([^`]*)`(?:\s*\([^)]*\))?$/);
  if (backtickWrapped) {
    return backtickWrapped[1].trim();
  }
  const boldWrapped = normalized.match(/^\*\*([^*]*)\*\*(?:\s*\([^)]*\))?$/);
  if (boldWrapped) {
    return boldWrapped[1].trim();
  }
  const trailingDecoratedNote = normalized.match(/^(.*?)(?:\*\*|`)\s*\([^)]*\)\s*$/u);
  if (trailingDecoratedNote) {
    normalized = trailingDecoratedNote[1].trim();
  }
  normalized = normalized.replace(/(?:\*\*|`)$/u, '');
  normalized = normalized.replace(/^(?:\*\*|`)/u, '');
  return normalized;
}

function normalizeArtifactText(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\n+$/u, '');
}

function previewText(value: string, maxChars = 180): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

export function extractToolCalls(events: ContextEvent[]): ToolCallTrace[] {
  return events
    .filter((event) => event.type === 'tool_call')
    .map((event) => ({
      name: String(event.data.name ?? '').trim(),
      toolCallId: String(event.data.toolCallId ?? '').trim() || undefined,
      args:
        event.data.args && typeof event.data.args === 'object' && !Array.isArray(event.data.args)
          ? ({ ...(event.data.args as Record<string, unknown>) } satisfies Record<string, unknown>)
          : {},
    }))
    .filter((item) => item.name.length > 0);
}

export function extractToolResults(events: ContextEvent[]): ToolResultTrace[] {
  return events
    .filter((event) => event.type === 'tool_result')
    .map((event) => ({
      name: String(event.data.name ?? '').trim(),
      toolCallId: String(event.data.toolCallId ?? '').trim() || undefined,
      content: String(event.data.content ?? ''),
      contentPreview: previewText(String(event.data.content ?? '').trim(), 140),
    }));
}

function normalizeArgForComparison(key: string, value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  return key === 'content' ? normalizeArtifactText(text) : text.trim();
}

function isToolResultSuccess(result: ToolResultTrace | undefined): boolean {
  return Boolean(result) && !String(result.content ?? '').trimStart().startsWith('Error:');
}

export function validateRequiredOperations(
  toolCalls: ToolCallTrace[],
  toolResults: ToolResultTrace[],
  requiredOperations: RequiredOperation[]
): { validatedOperations: string[]; flags: string[] } {
  const flags: string[] = [];
  const validatedOperations: string[] = [];
  const usedToolCallIndexes = new Set<number>();
  const matchedIndexesByLabel = new Map<string, number>();
  const resultById = new Map(
    toolResults
      .filter((item): item is ToolResultTrace & { toolCallId: string } => Boolean(item.toolCallId))
      .map((item) => [item.toolCallId, item] as const)
  );

  for (const operation of requiredOperations) {
    let matchedIndex = -1;
    let failureFlag: string | null = null;
    let sawNamedCandidate = false;
    for (let index = 0; index < toolCalls.length; index += 1) {
      if (usedToolCallIndexes.has(index)) {
        continue;
      }
      const candidate = toolCalls[index];
      if (candidate.name !== operation.name) {
        continue;
      }
      sawNamedCandidate = true;
      const matchesArgs = Object.entries(operation.args).every(
        ([key, expected]) => normalizeArgForComparison(key, candidate.args[key]) === normalizeArgForComparison(key, expected)
      );
      if (matchesArgs) {
        if (!candidate.toolCallId) {
          failureFlag ??= `tool_result_missing:${operation.label}`;
          continue;
        }
        const matchedResult = resultById.get(candidate.toolCallId);
        if (!matchedResult) {
          failureFlag ??= `tool_result_missing:${operation.label}`;
          continue;
        }
        if (!isToolResultSuccess(matchedResult)) {
          failureFlag ??= `tool_result_error:${operation.label}`;
          continue;
        }
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex < 0) {
      flags.push(failureFlag ?? (sawNamedCandidate ? `required_operation_mismatch:${operation.label}` : `required_operation_missing:${operation.label}`));
      continue;
    }

    validatedOperations.push(operation.label);
    usedToolCallIndexes.add(matchedIndex);
    matchedIndexesByLabel.set(operation.label, matchedIndex);
  }

  const writeIndex = matchedIndexesByLabel.get('write_output');
  if (typeof writeIndex === 'number') {
    for (const [label, matchedIndex] of matchedIndexesByLabel.entries()) {
      if (label === 'write_output') {
        continue;
      }
      if (label === 'verify_output') {
        if (matchedIndex <= writeIndex) {
          flags.push('required_operation_order:verify_output_after_write_output');
        }
        continue;
      }
      if (matchedIndex >= writeIndex) {
        flags.push(`required_operation_order:${label}_before_write_output`);
      }
    }
  }

  return { validatedOperations, flags };
}

export function previousRuntimeFromEvaluation(
  previous: PreviousRoundRuntime | null,
  spec: RoundSpec,
  evaluation: RoundEvaluation
): PreviousRoundRuntime {
  const fallbackToken = previous?.token ?? '';
  const actualToken = evaluation.fileFields.TOKEN || fallbackToken;
  const actualTools = evaluation.uniqueToolNames.length > 0 ? [...evaluation.uniqueToolNames] : previous ? [...previous.uniqueToolNames] : [];
  return {
    round: spec.round,
    token: actualToken,
    uniqueToolNames: actualTools,
    seedCode: evaluation.fileFields.SEED_CODE || previous?.seedCode || '',
    seedValue: evaluation.fileFields.SEED_VALUE || previous?.seedValue || '',
    status: evaluation.fileFields.STATUS || previous?.status || '',
  };
}
