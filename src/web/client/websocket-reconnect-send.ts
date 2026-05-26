import type { WSMessage } from './hooks/useWebSocket.js';

export interface ScheduleReconnectSendRetryInput {
  message: WSMessage;
  send: (message: WSMessage) => boolean;
  connect: () => void;
  retryTimeouts: Set<number>;
  onFinalFailure: () => void;
  delayMs?: number;
}

export function scheduleReconnectSendRetry(input: ScheduleReconnectSendRetryInput): void {
  if (input.send(input.message)) {
    return;
  }
  input.connect();
  const timeoutId = window.setTimeout(() => {
    input.retryTimeouts.delete(timeoutId);
    if (!input.send(input.message)) {
      input.onFinalFailure();
    }
  }, input.delayMs ?? 350);
  input.retryTimeouts.add(timeoutId);
}

export function clearReconnectSendRetryTimeouts(retryTimeouts: Set<number>): void {
  retryTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
  retryTimeouts.clear();
}
