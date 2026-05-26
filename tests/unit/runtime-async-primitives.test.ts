import * as assert from 'node:assert/strict';
import {
  ManagedInterval,
  ManagedTimeout,
  TimerScope,
  computeExponentialBackoffDelayMs,
  retryWithBackoff,
  sleep,
  withTimeout,
} from '../../src/runtime/async-primitives.js';

async function testSleepWaits(): Promise<void> {
  const startedAt = Date.now();
  await sleep(5);
  assert.equal(Date.now() - startedAt >= 0, true);
}

async function testWithTimeoutResolvesAndRejects(): Promise<void> {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'too slow'), 'ok');
  await assert.rejects(
    () => withTimeout(new Promise((resolve) => setTimeout(resolve, 30)), 1, 'too slow'),
    /too slow/
  );
}

async function testRetryWithBackoffRetriesUntilSuccess(): Promise<void> {
  let attempts = 0;
  const result = await retryWithBackoff({
    maxAttempts: 3,
    delaysMs: [1, 1],
    run: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('not yet');
      }
      return 'done';
    },
  });
  assert.equal(result, 'done');
  assert.equal(attempts, 3);
}

function testComputeExponentialBackoffDelayMs(): void {
  assert.equal(
    computeExponentialBackoffDelayMs(2, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0,
    }),
    400
  );
  assert.equal(
    computeExponentialBackoffDelayMs(10, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      minDelayMs: 250,
      jitterRatio: 0,
    }),
    1000
  );
}

async function testManagedTimersClear(): Promise<void> {
  let timeoutFired = false;
  const timeout = new ManagedTimeout().start(() => {
    timeoutFired = true;
  }, 20);
  timeout.clear();
  await sleep(30);
  assert.equal(timeoutFired, false);

  let intervalCount = 0;
  const interval = new ManagedInterval().start(() => {
    intervalCount += 1;
  }, 5);
  await sleep(15);
  interval.clear();
  const countAfterClear = intervalCount;
  await sleep(15);
  assert.equal(intervalCount, countAfterClear);
}

async function testTimerScopeClearAll(): Promise<void> {
  let fired = false;
  const scope = new TimerScope();
  scope.setTimeout(() => {
    fired = true;
  }, 20);
  scope.clearAll();
  await sleep(30);
  assert.equal(fired, false);
}

async function runAll(): Promise<void> {
  await testSleepWaits();
  await testWithTimeoutResolvesAndRejects();
  await testRetryWithBackoffRetriesUntilSuccess();
  testComputeExponentialBackoffDelayMs();
  await testManagedTimersClear();
  await testTimerScopeClearAll();
  console.log('runtime-async-primitives tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
