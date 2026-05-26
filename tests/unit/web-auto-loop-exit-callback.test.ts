import * as assert from 'node:assert/strict';
import { autoLoopManager } from '../../src/auto-loop/index.js';
import { webServerLogger } from '../../src/utils/logger.js';
import type { ContextRef } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';

interface ExitResponse {
  accepted: boolean;
  message: string;
}

interface LogCall {
  level: 'info' | 'warn';
  message: string;
}

function createHarness(context: ContextRef = { scope: 'session', namespace: 'sess-1' }) {
  const server = createWebServerDouble();
  server.agent = {
    getConfig: () => createWebServerTestConfig({
      agent: {
        tokenLimit: 1000,
      },
    }),
  };
  server.emitToClient = () => {};

  const logs: LogCall[] = [];
  const originalGet = autoLoopManager.get;
  const originalInfo = webServerLogger.info;
  const originalWarn = webServerLogger.warn;

  (webServerLogger as any).info = (message: string) => {
    logs.push({ level: 'info', message });
  };
  (webServerLogger as any).warn = (message: string) => {
    logs.push({ level: 'warn', message });
  };

  return {
    server,
    context,
    logs,
    setController(getImpl: (key: string) => unknown) {
      (autoLoopManager as any).get = getImpl;
    },
    restore() {
      (autoLoopManager as any).get = originalGet;
      (webServerLogger as any).info = originalInfo;
      (webServerLogger as any).warn = originalWarn;
    },
  };
}

function createCallbackHarness(context?: ContextRef) {
  const harness = createHarness(context);
  const callback = harness.server.createCallback({ readyState: 1 }, harness.context, 'run-1');
  return { ...harness, callback };
}

function testMissingControllerReturnsRejectedContractWithoutLogs(): void {
  const harness = createCallbackHarness();
  try {
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return undefined;
    });

    const response = harness.callback.requestAutoLoopExit('done') as ExitResponse;

    assert.deepEqual(response, {
      accepted: false,
      message: 'exit_auto_loop can only be called during auto-loop',
    });
    assert.equal(requestedKey, 'sess-1');
    assert.deepEqual(harness.logs, []);
  } finally {
    harness.restore();
  }
}

function testAcceptedExitLogsInfoAndPreservesControllerResponse(): void {
  const harness = createCallbackHarness({ scope: 'workspace', namespace: 'repo-a' });
  try {
    const requestedReasons: Array<string | undefined> = [];
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return {
        requestExit: (reason?: string) => {
          requestedReasons.push(reason);
          return {
            accepted: true,
            message: 'auto-loop exit requested',
          };
        },
      };
    });

    const response = harness.callback.requestAutoLoopExit('ship it') as ExitResponse;

    assert.deepEqual(response, {
      accepted: true,
      message: 'auto-loop exit requested',
    });
    assert.equal(requestedKey, 'workspace:repo-a');
    assert.deepEqual(requestedReasons, ['ship it']);
    assert.deepEqual(harness.logs, [
      {
        level: 'info',
        message: '[AutoLoop] exit requested by tool: context=workspace/repo-a runId=run-1',
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testAcceptedIdempotentExitStillLogsInfoAndPreservesMessage(): void {
  const harness = createCallbackHarness();
  try {
    harness.setController(() => ({
      requestExit: () => ({
        accepted: true,
        message: 'auto-loop exit already requested',
      }),
    }));

    const response = harness.callback.requestAutoLoopExit() as ExitResponse;

    assert.deepEqual(response, {
      accepted: true,
      message: 'auto-loop exit already requested',
    });
    assert.deepEqual(harness.logs, [
      {
        level: 'info',
        message: '[AutoLoop] exit requested by tool: context=session/sess-1 runId=run-1',
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testRejectedExitLogsWarnAndPreservesControllerResponse(): void {
  const harness = createCallbackHarness();
  try {
    harness.setController(() => ({
      requestExit: () => ({
        accepted: false,
        message: 'auto-loop is not active',
      }),
    }));

    const response = harness.callback.requestAutoLoopExit() as ExitResponse;

    assert.deepEqual(response, {
      accepted: false,
      message: 'auto-loop is not active',
    });
    assert.deepEqual(harness.logs, [
      {
        level: 'warn',
        message: '[AutoLoop] exit requested by tool while not active: context=session/sess-1 runId=run-1',
      },
    ]);
  } finally {
    harness.restore();
  }
}

function testHelperDirectPathPreservesProvidedLoopKey(): void {
  const harness = createHarness({ scope: 'workspace', namespace: 'repo-b' });
  try {
    let requestedKey = '';
    harness.setController((key: string) => {
      requestedKey = key;
      return {
        requestExit: (reason?: string) => ({
          accepted: true,
          message: reason ? `accepted:${reason}` : 'accepted',
        }),
      };
    });

    const response = harness.server.requestAutoLoopExitFromCallback(
      'workspace:repo-b',
      harness.context,
      'run-helper',
      'continue'
    ) as ExitResponse;

    assert.deepEqual(response, {
      accepted: true,
      message: 'accepted:continue',
    });
    assert.equal(requestedKey, 'workspace:repo-b');
    assert.deepEqual(harness.logs, [
      {
        level: 'info',
        message: '[AutoLoop] exit requested by tool: context=workspace/repo-b runId=run-helper',
      },
    ]);
  } finally {
    harness.restore();
  }
}

function runAll(): void {
  testMissingControllerReturnsRejectedContractWithoutLogs();
  testAcceptedExitLogsInfoAndPreservesControllerResponse();
  testAcceptedIdempotentExitStillLogsInfoAndPreservesMessage();
  testRejectedExitLogsWarnAndPreservesControllerResponse();
  testHelperDirectPathPreservesProvidedLoopKey();
  console.log('web-auto-loop-exit-callback tests passed');
}

runAll();
