import type { Message, ResolvedContextBudget } from '../types.js';
import {
  CONTEXT_REDUCTION_MARKERS,
  resolveMergedSummaryMaxChars,
  truncateWithReductionMarker,
} from '../runtime/context-reduction-policy.js';

export function isPromptTooLongCompressionError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes('prompt too long') ||
    normalized.includes('context window') ||
    normalized.includes('maximum context') ||
    normalized.includes('request too large') ||
    normalized.includes('413')
  );
}

export function dropOldestCompressionRound(messages: Message[]): { messages: Message[]; droppedCount: number } {
  if (messages.length <= 1) {
    return { messages, droppedCount: 0 };
  }
  let dropEnd = 1;
  for (let i = 1; i < messages.length; i += 1) {
    dropEnd = i + 1;
    if (messages[i].role === 'assistant') {
      while (dropEnd < messages.length && messages[dropEnd].role === 'tool') {
        dropEnd += 1;
      }
      break;
    }
  }
  const safeDropEnd = Math.min(dropEnd, messages.length - 1);
  return {
    messages: messages.slice(safeDropEnd),
    droppedCount: safeDropEnd,
  };
}

export function mergeCompressionChunkSummaries(
  summaryChunks: string[],
  contextBudget: ResolvedContextBudget
): string {
  if (summaryChunks.length <= 1) {
    return summaryChunks[0] ?? '';
  }
  const merged = summaryChunks
    .map((summary, index) => `[COMPRESSION_CHUNK ${index + 1}/${summaryChunks.length}]\n${summary.trim()}`)
    .join('\n\n');
  return truncateMergedCompressionSummary(merged, contextBudget, 'deterministic_merge');
}

function truncateMergedCompressionSummary(
  content: string,
  contextBudget: ResolvedContextBudget,
  reason: string
): string {
  return truncateWithReductionMarker(
    content,
    resolveMergedSummaryMaxChars(contextBudget),
    CONTEXT_REDUCTION_MARKERS.summaryTruncated,
    { reason }
  );
}

export async function yieldCompressionLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
