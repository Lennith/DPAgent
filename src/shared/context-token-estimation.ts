export const ASCII_TOKENS_PER_CHAR = 0.3;
export const NON_ASCII_TOKENS_PER_CHAR = 0.6;
export const MIXED_TOKENS_PER_CHAR = (ASCII_TOKENS_PER_CHAR + NON_ASCII_TOKENS_PER_CHAR) / 2;
export const MIXED_CHARS_PER_TOKEN = 1 / MIXED_TOKENS_PER_CHAR;

function tokenWeightForCodePoint(codePoint: number): number {
  return codePoint <= 0x7f ? ASCII_TOKENS_PER_CHAR : NON_ASCII_TOKENS_PER_CHAR;
}

export function estimateWeightedTokensFromString(value: string): number {
  return estimateWeightedTokensFromStringAllowZero(value, { allowZero: false });
}

export function estimateWeightedTokensFromStringAllowZero(
  value: string,
  options?: { allowZero?: boolean }
): number {
  let weightedTokens = 0;
  for (const char of value) {
    weightedTokens += tokenWeightForCodePoint(char.codePointAt(0) ?? 0);
  }
  const rounded = Math.ceil(weightedTokens);
  if (options?.allowZero) {
    return Math.max(0, rounded);
  }
  return Math.max(1, rounded);
}

export function stringifyPayloadForTokenEstimation(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload ?? '');
  }
}

export function estimateWeightedTokensFromPayload(payload: unknown): {
  serialized: string;
  rawChars: number;
  inputTokens: number;
} {
  const serialized = stringifyPayloadForTokenEstimation(payload);
  return {
    serialized,
    rawChars: serialized.length,
    inputTokens: estimateWeightedTokensFromString(serialized),
  };
}

export function estimateWeightedTokenDeltaFromSerializedPayload(
  previousSerialized: string,
  nextSerialized: string
): {
  appendOnly: boolean;
  deltaChars: number;
  deltaTokens: number;
} {
  if (!nextSerialized.startsWith(previousSerialized)) {
    return {
      appendOnly: false,
      deltaChars: 0,
      deltaTokens: 0,
    };
  }
  const deltaSerialized = nextSerialized.slice(previousSerialized.length);
  return {
    appendOnly: true,
    deltaChars: deltaSerialized.length,
    deltaTokens: estimateWeightedTokensFromStringAllowZero(deltaSerialized, { allowZero: true }),
  };
}

export function tokensToCharHint(tokens: number): number {
  return Math.max(1, Math.floor(tokens * MIXED_CHARS_PER_TOKEN));
}

export function charsToTokenHint(chars: number): number {
  return Math.max(1, Math.floor(chars / MIXED_CHARS_PER_TOKEN));
}
