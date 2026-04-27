import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { WebServer } from '../../src/web/server/WebServer.js';

interface EmittedMessage {
  ws: object;
  type: string;
  data: unknown;
}

interface DispatchHarness {
  server: any;
  openSocket: { readyState: number; socket: string };
  emitted: EmittedMessage[];
  lifecycle: string[];
}

function createHarness(): DispatchHarness {
  const server = Object.create(WebServer.prototype) as any;
  const emitted: EmittedMessage[] = [];
  const lifecycle: string[] = [];

  server.emitToClient = (ws: object, message: Omit<EmittedMessage, 'ws'>) => {
    lifecycle.push(`emit:${message.type}`);
    emitted.push({ ws, ...message });
  };

  return {
    server,
    openSocket: { readyState: WebSocket.OPEN, socket: 'open' },
    emitted,
    lifecycle,
  };
}

async function testHandleWSMessageChatDelegatesToChatLifecycle(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleChatMessage = async (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleChatMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'chat',
    data: {
      prompt: 'Hello',
      sessionId: 'sess-1',
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleChatMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      prompt: 'Hello',
      sessionId: 'sess-1',
    },
  ]);
}

async function testHandleWSMessageChatResumeDelegatesToDedicatedHandler(): Promise<void> {
  const harness = createHarness();
  let capturedWs: unknown = null;

  harness.server.handleChatResumeMessage = (ws: unknown) => {
    harness.lifecycle.push('handleChatResumeMessage');
    capturedWs = ws;
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'chat_resume',
    data: null,
  });

  assert.deepEqual(harness.lifecycle, ['handleChatResumeMessage']);
  assert.equal(capturedWs, harness.openSocket);
}

async function testHandleWSMessageCancelDelegatesWithDefaultPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleCancelMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleCancelMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'cancel',
    data: null,
  });

  assert.deepEqual(harness.lifecycle, ['handleCancelMessage']);
  assert.deepEqual(captured, [harness.openSocket, {}]);
}

async function testHandleWSMessageResumeFailedTurnDelegatesWithDefaultPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleResumeFailedTurnMessage = async (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleResumeFailedTurnMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'resume_failed_turn',
    data: null,
  });

  assert.deepEqual(harness.lifecycle, ['handleResumeFailedTurnMessage']);
  assert.deepEqual(captured, [harness.openSocket, {}]);
}

async function testHandleWSMessageDismissInterruptedArtifactDelegatesWithDefaultPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleDismissInterruptedArtifactMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleDismissInterruptedArtifactMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'dismiss_interrupted_artifact',
    data: undefined,
  });

  assert.deepEqual(harness.lifecycle, ['handleDismissInterruptedArtifactMessage']);
  assert.deepEqual(captured, [harness.openSocket, {}]);
}

async function testHandleWSMessagePlanInputResponseDelegatesWithDefaultPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handlePlanInputResponse = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handlePlanInputResponse');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'plan_input_response',
    data: undefined,
  });

  assert.deepEqual(harness.lifecycle, ['handlePlanInputResponse']);
  assert.deepEqual(captured, [harness.openSocket, {}]);
}

async function testHandleWSMessageStopAutoLoopDelegatesWithDefaultPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleStopAutoLoopMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleStopAutoLoopMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'stop_auto_loop',
    data: null,
  });

  assert.deepEqual(harness.lifecycle, ['handleStopAutoLoopMessage']);
  assert.deepEqual(captured, [harness.openSocket, {}]);
}

async function testHandleWSMessagePingDelegatesToDedicatedHandler(): Promise<void> {
  const harness = createHarness();
  const pingData = { timestamp: 12345 };
  let captured: unknown[] | null = null;

  harness.server.handlePingMessage = (ws: unknown, data: unknown) => {
    harness.lifecycle.push('handlePingMessage');
    captured = [ws, data];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'ping',
    data: pingData,
  });

  assert.deepEqual(harness.lifecycle, ['handlePingMessage']);
  assert.deepEqual(captured, [harness.openSocket, pingData]);
}

async function testHandleWSMessagePingPreservesTopLevelTimestamp(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handlePingMessage = (ws: unknown, data: unknown) => {
    harness.lifecycle.push('handlePingMessage');
    captured = [ws, data];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'ping',
    timestamp: 67890,
  });

  assert.deepEqual(harness.lifecycle, ['handlePingMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      data: undefined,
      timestamp: 67890,
    },
  ]);
}

async function testHandleWSMessageUnknownTypeIsSafeNoop(): Promise<void> {
  const harness = createHarness();

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'unknown',
    data: {
      unexpected: true,
    },
  });

  assert.deepEqual(harness.lifecycle, []);
  assert.deepEqual(harness.emitted, []);
}

async function testHandleChatResumeMessageStillEmitsDisabledError(): Promise<void> {
  const harness = createHarness();

  harness.server.handleChatResumeMessage(harness.openSocket);

  assert.deepEqual(harness.lifecycle, ['emit:error']);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'error',
      data: {
        code: 'chat_resume_disabled',
        error: 'chat_resume is disabled for now. Please stop and send a new message.',
      },
    },
  ]);
}

async function testHandlePingMessageEmitsPongWithProvidedTimestamp(): Promise<void> {
  const harness = createHarness();
  const originalNow = Date.now;
  Date.now = () => 2468;

  try {
    harness.server.handlePingMessage(harness.openSocket, { timestamp: 1357 });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(harness.lifecycle, ['emit:pong']);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'pong',
      data: {
        timestamp: 1357,
        serverTime: 2468,
      },
    },
  ]);
}

async function testHandlePingMessageBackfillsMissingTimestamp(): Promise<void> {
  const harness = createHarness();
  const originalNow = Date.now;
  Date.now = () => 3579;

  try {
    harness.server.handlePingMessage(harness.openSocket, null);
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(harness.lifecycle, ['emit:pong']);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'pong',
      data: {
        timestamp: 3579,
        serverTime: 3579,
      },
    },
  ]);
}

async function testHandlePingMessageEmitsPongWithTopLevelTimestamp(): Promise<void> {
  const harness = createHarness();
  const originalNow = Date.now;
  Date.now = () => 4680;

  try {
    harness.server.handlePingMessage(harness.openSocket, { timestamp: 2468 });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(harness.lifecycle, ['emit:pong']);
  assert.deepEqual(harness.emitted, [
    {
      ws: harness.openSocket,
      type: 'pong',
      data: {
        timestamp: 2468,
        serverTime: 4680,
      },
    },
  ]);
}

async function runAll(): Promise<void> {
  await testHandleWSMessageChatDelegatesToChatLifecycle();
  await testHandleWSMessageChatResumeDelegatesToDedicatedHandler();
  await testHandleWSMessageCancelDelegatesWithDefaultPayload();
  await testHandleWSMessageResumeFailedTurnDelegatesWithDefaultPayload();
  await testHandleWSMessageDismissInterruptedArtifactDelegatesWithDefaultPayload();
  await testHandleWSMessagePlanInputResponseDelegatesWithDefaultPayload();
  await testHandleWSMessageStopAutoLoopDelegatesWithDefaultPayload();
  await testHandleWSMessagePingDelegatesToDedicatedHandler();
  await testHandleWSMessagePingPreservesTopLevelTimestamp();
  await testHandleWSMessageUnknownTypeIsSafeNoop();
  await testHandleChatResumeMessageStillEmitsDisabledError();
  await testHandlePingMessageEmitsPongWithProvidedTimestamp();
  await testHandlePingMessageBackfillsMissingTimestamp();
  await testHandlePingMessageEmitsPongWithTopLevelTimestamp();
  console.log('web-ws-message-dispatch tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
