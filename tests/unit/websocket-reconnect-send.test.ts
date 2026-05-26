import assert from 'node:assert/strict';
import {
  clearReconnectSendRetryTimeouts,
  scheduleReconnectSendRetry,
} from '../../src/web/client/websocket-reconnect-send.js';
import type { WSMessage } from '../../src/web/client/hooks/useWebSocket.js';

const originalSetTimeout = globalThis.window?.setTimeout;
const originalClearTimeout = globalThis.window?.clearTimeout;

interface ScheduledTimer {
  id: number;
  callback: () => void;
  cleared: boolean;
}

function installFakeTimers() {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 1;
  const fakeWindow = {
    setTimeout(callback: () => void): number {
      const id = nextId++;
      timers.set(id, { id, callback, cleared: false });
      return id;
    },
    clearTimeout(id: number): void {
      const timer = timers.get(id);
      if (timer) {
        timer.cleared = true;
      }
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: fakeWindow,
    configurable: true,
  });
  return timers;
}

function restoreTimers(): void {
  Object.defineProperty(globalThis, 'window', {
    value: {
      setTimeout: originalSetTimeout,
      clearTimeout: originalClearTimeout,
    },
    configurable: true,
  });
}

function createMessage(): WSMessage {
  return { type: 'ping', timestamp: Date.now() } as WSMessage;
}

function testSendSuccessDoesNotScheduleRetry(): void {
  const timers = installFakeTimers();
  const retryTimeouts = new Set<number>();
  let connectCalls = 0;
  let finalFailures = 0;
  const sendCalls: WSMessage[] = [];

  scheduleReconnectSendRetry({
    message: createMessage(),
    retryTimeouts,
    send: (message) => {
      sendCalls.push(message);
      return true;
    },
    connect: () => {
      connectCalls += 1;
    },
    onFinalFailure: () => {
      finalFailures += 1;
    },
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(connectCalls, 0);
  assert.equal(finalFailures, 0);
  assert.equal(retryTimeouts.size, 0);
  assert.equal(timers.size, 0);
  restoreTimers();
}

function testRetrySuccessClearsPendingTimeout(): void {
  const timers = installFakeTimers();
  const retryTimeouts = new Set<number>();
  let connectCalls = 0;
  let finalFailures = 0;
  let attempts = 0;

  scheduleReconnectSendRetry({
    message: createMessage(),
    retryTimeouts,
    send: () => {
      attempts += 1;
      return attempts === 2;
    },
    connect: () => {
      connectCalls += 1;
    },
    onFinalFailure: () => {
      finalFailures += 1;
    },
  });

  const timerId = [...retryTimeouts][0];
  assert.equal(connectCalls, 1);
  assert.equal(retryTimeouts.size, 1);
  timers.get(timerId)?.callback();

  assert.equal(attempts, 2);
  assert.equal(finalFailures, 0);
  assert.equal(retryTimeouts.size, 0);
  restoreTimers();
}

function testRetryFailureCallsFinalFailure(): void {
  const timers = installFakeTimers();
  const retryTimeouts = new Set<number>();
  let finalFailures = 0;

  scheduleReconnectSendRetry({
    message: createMessage(),
    retryTimeouts,
    send: () => false,
    connect: () => {},
    onFinalFailure: () => {
      finalFailures += 1;
    },
  });

  const timerId = [...retryTimeouts][0];
  timers.get(timerId)?.callback();

  assert.equal(finalFailures, 1);
  assert.equal(retryTimeouts.size, 0);
  restoreTimers();
}

function testClearReconnectTimeoutsCancelsAllPendingTimers(): void {
  const timers = installFakeTimers();
  const retryTimeouts = new Set<number>();
  scheduleReconnectSendRetry({
    message: createMessage(),
    retryTimeouts,
    send: () => false,
    connect: () => {},
    onFinalFailure: () => {},
  });
  scheduleReconnectSendRetry({
    message: createMessage(),
    retryTimeouts,
    send: () => false,
    connect: () => {},
    onFinalFailure: () => {},
  });

  clearReconnectSendRetryTimeouts(retryTimeouts);

  assert.equal(retryTimeouts.size, 0);
  assert.deepEqual([...timers.values()].map((timer) => timer.cleared), [true, true]);
  restoreTimers();
}

testSendSuccessDoesNotScheduleRetry();
testRetrySuccessClearsPendingTimeout();
testRetryFailureCallsFinalFailure();
testClearReconnectTimeoutsCancelsAllPendingTimers();

console.log('websocket-reconnect-send tests passed');
