import type { Message } from '../../chat-types.js';

export const CHAT_BOTTOM_STICKY_THRESHOLD_PX = 96;

export interface ChatScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function getChatDistanceFromBottom(metrics: ChatScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isChatScrolledNearBottom(
  metrics: ChatScrollMetrics,
  thresholdPx = CHAT_BOTTOM_STICKY_THRESHOLD_PX
): boolean {
  return getChatDistanceFromBottom(metrics) <= thresholdPx;
}

export function shouldAutoScrollToLatest(input: {
  sessionChanged: boolean;
  wasNearBottomBeforeUpdate: boolean;
  latestMessageRole?: Message['role'];
}): boolean {
  return input.sessionChanged || input.wasNearBottomBeforeUpdate || input.latestMessageRole === 'user';
}
