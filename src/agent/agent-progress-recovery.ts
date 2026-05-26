import type { LLMResponse } from '../types.js';

export function isTurnCompleteFinishReason(finishReason: string | undefined): boolean {
  return finishReason === 'end_turn';
}

export function shouldRecoverProgressOnlyTurnStop(response: LLMResponse): boolean {
  if (!isTurnCompleteFinishReason(response.finishReason)) {
    return false;
  }
  if (response.toolCalls && response.toolCalls.length > 0) {
    return false;
  }

  const text = response.content.trim();
  if (text.length === 0) {
    return false;
  }

  const blockerPattern =
    /(请提供|需要你|需要您|缺少|缺失|无法继续|无法执行|blocked|missing|please provide|need .* from you|cannot proceed|can't proceed)/i;
  if (blockerPattern.test(text)) {
    return false;
  }

  const promiseActionPattern =
    /(?:^|[。！？!?，,\n]\s*)(?:(?:让我|我来|我先|我去|我直接|先让我|我现在|接下来我|下面我)\s*(?:先)?(?:看|查看|检查|读|读取|查|确认|排查|分析|重新审视|梳理|trace|追踪|定位|验证|测试|更新|执行|清理|记录)|(?:现在|接下来|下面)\s*(?:继续|先)?(?:检查|查看|读取|分析|排查|更新|执行|清理|记录|验证|测试)|(?:let me|i(?:'ll| will)|first[,，]?\s*i(?:'ll| will)|now[,，]?\s*(?:let me|i(?:'ll| will))|next[,，]?\s*i(?:'ll| will))\s*(?:first\s*)?(?:check|inspect|look|read|trace|investigate|analy[sz]e|verify|update|run|test|clean|record)\b)/i;

  return promiseActionPattern.test(text);
}

export function buildProgressOnlyContinuationPrompt(attempt: number, maxAttempts: number): string {
  return [
    `[EXECUTION_CONTINUE_REQUIRED attempt=${attempt}/${maxAttempts}]`,
    'Your previous reply ended the turn with progress-only text or a promise to act later, but no concrete action followed.',
    'Continue in the same turn now.',
    'If tools are available, use them immediately instead of describing the next step.',
    'Only stop when the request is actually complete or you are blocked by missing essential user input.',
  ].join(' ');
}

export function buildProgressOnlyStallMessage(attempts: number): string {
  return [
    `[PROGRESS_ONLY_STALL attempts=${attempts}]`,
    'The model repeatedly ended the turn with progress-only text without taking concrete action.',
    'Treat this as a protocol stall and retry with a stronger instruction or a narrower task.',
  ].join(' ');
}
