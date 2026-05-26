import type { APIProvider, TokenUsage } from '../types.js';

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

export function normalizeTokenUsage(
  rawUsage: unknown,
  provider: APIProvider,
  options: { requireComplete?: boolean } = {}
): TokenUsage | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return undefined;
  }
  const record = rawUsage as Record<string, unknown>;
  const promptTokens =
    provider === 'anthropic'
      ? readNumber(record, ['input_tokens', 'inputTokens', 'promptTokens'])
      : readNumber(record, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
  const completionTokens =
    provider === 'anthropic'
      ? readNumber(record, ['output_tokens', 'outputTokens', 'completionTokens'])
      : readNumber(record, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
  const totalTokens = readNumber(record, ['total_tokens', 'totalTokens']);

  if (promptTokens === undefined) {
    return undefined;
  }
  if (options.requireComplete !== false && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const resolvedCompletion = completionTokens ?? Math.max(0, (totalTokens ?? promptTokens) - promptTokens);
  return {
    promptTokens: Math.ceil(promptTokens),
    completionTokens: Math.ceil(resolvedCompletion),
    totalTokens: Math.ceil(totalTokens ?? promptTokens + resolvedCompletion),
  };
}
