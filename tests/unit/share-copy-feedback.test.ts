import * as assert from 'node:assert/strict';
import { copyShareUrlToClipboard } from '../../src/web/client/share-copy-feedback.js';

interface ToastRecord {
  type: 'success' | 'error' | 'warning';
  message: string;
  autoDismiss?: boolean;
}

function translate(key: string, params?: Record<string, string | number>): string {
  if (key === 'app.share.copySucceeded') {
    return 'Share link copied';
  }
  if (key === 'app.share.copyFailed') {
    return `Failed to copy share link: ${params?.message ?? ''}`;
  }
  return key;
}

async function testSuccessfulCopyShowsSuccessToast(): Promise<void> {
  const copied: string[] = [];
  const toasts: ToastRecord[] = [];

  const ok = await copyShareUrlToClipboard({
    url: 'http://localhost:3000/dpagent-share/token',
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
    addToast: (toast) => {
      toasts.push(toast);
    },
    t: translate,
  });

  assert.equal(ok, true);
  assert.deepEqual(copied, ['http://localhost:3000/dpagent-share/token']);
  assert.deepEqual(toasts, [
    {
      type: 'success',
      message: 'Share link copied',
      autoDismiss: true,
    },
  ]);
}

async function testFailedCopyShowsErrorToast(): Promise<void> {
  const toasts: ToastRecord[] = [];

  const ok = await copyShareUrlToClipboard({
    url: 'http://localhost:3000/dpagent-share/token',
    clipboard: {
      writeText: async () => {
        throw new Error('permission denied');
      },
    },
    addToast: (toast) => {
      toasts.push(toast);
    },
    t: translate,
  });

  assert.equal(ok, false);
  assert.deepEqual(toasts, [
    {
      type: 'error',
      message: 'Failed to copy share link: permission denied',
      autoDismiss: true,
    },
  ]);
}

async function runAll(): Promise<void> {
  await testSuccessfulCopyShowsSuccessToast();
  await testFailedCopyShowsErrorToast();
  console.log('share-copy-feedback tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
