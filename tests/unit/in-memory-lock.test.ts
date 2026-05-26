import * as assert from 'node:assert/strict';
import {
  InMemoryLockTimeoutError,
  acquireInMemoryLockOrThrow,
  releaseInMemoryLock,
} from '../../src/storage/in-memory-lock.js';

function testAcquireReleaseAndReacquire(): void {
  const key = 'lock-test-a';
  acquireInMemoryLockOrThrow(key);
  releaseInMemoryLock(key);
  acquireInMemoryLockOrThrow(key);
  releaseInMemoryLock(key);
}

function testThrowsInsteadOfInfiniteSpin(): void {
  const key = 'lock-test-b';
  acquireInMemoryLockOrThrow(key);
  try {
    assert.throws(
      () => acquireInMemoryLockOrThrow(key, { maxSpinAttempts: 3 }),
      (error) => error instanceof InMemoryLockTimeoutError && /lock-test-b/.test(error.message)
    );
  } finally {
    releaseInMemoryLock(key);
  }
}

testAcquireReleaseAndReacquire();
testThrowsInsteadOfInfiniteSpin();

console.log('in-memory-lock tests passed');
