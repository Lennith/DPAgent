import * as assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createWebServerDouble } from './helpers/web-server-harness.js';

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
  const server = createWebServerDouble();
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

async function testHandleWSMessageChatPreservesFileReferences(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleChatMessage = async (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleChatMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'chat',
    data: {
      prompt: 'Read files',
      sessionId: 'sess-1',
      fileReferences: ['D:\\repo\\README.md'],
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleChatMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      prompt: 'Read files',
      sessionId: 'sess-1',
      fileReferences: ['D:\\repo\\README.md'],
    },
  ]);
}

async function testHandleWSMessageChatPreservesExternalMcpServers(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleChatMessage = async (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleChatMessage');
    captured = [ws, request];
  };

  const externalMcpServers = [
    {
      name: 'teamtool',
      type: 'stdio',
      command: 'node',
      args: ['teamtool.js'],
      env: { TOKEN: 'secret' },
    },
  ];

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'chat',
    data: {
      prompt: 'Run TeamTool task',
      sessionId: 'sess-1',
      externalMcpServers,
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleChatMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      prompt: 'Run TeamTool task',
      sessionId: 'sess-1',
      externalMcpServers,
    },
  ]);
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

async function testHandleWSMessageRunningInputEnqueueDelegatesWithPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleRunningInputEnqueueMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleRunningInputEnqueueMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'running_input_enqueue',
    data: {
      prompt: 'Please use this when safe',
      fileReferences: ['D:\\repo\\README.md'],
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleRunningInputEnqueueMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      prompt: 'Please use this when safe',
      fileReferences: ['D:\\repo\\README.md'],
      context: { scope: 'session', namespace: 'sess-1' },
    },
  ]);
}

async function testHandleWSMessageRunningInputInsertDelegatesWithPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleRunningInputInsertMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleRunningInputInsertMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'running_input_insert',
    data: {
      itemId: 'rin-1',
      runId: 'run-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleRunningInputInsertMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      itemId: 'rin-1',
      runId: 'run-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  ]);
}

async function testHandleWSMessageRunningInputCancelDelegatesWithPayload(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;

  harness.server.handleRunningInputCancelMessage = (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleRunningInputCancelMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'running_input_cancel',
    data: {
      itemId: 'rin-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleRunningInputCancelMessage']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      itemId: 'rin-1',
      context: { scope: 'session', namespace: 'sess-1' },
    },
  ]);
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

async function testTextOnlySocketAllowsOnlyTextMessages(): Promise<void> {
  const harness = createHarness();
  harness.server.websocketScopes = new WeakMap([
    [
      harness.openSocket as any,
      {
        mode: 'shared_ls',
        wssId: 'text-wss',
        clientKind: 'web',
        sessionId: 'sess-1',
        tokenHash: 'hash-1',
        shareToken: 'share-token-1',
        shareVersion: 1,
        transportMode: 'text',
      },
    ],
  ]);
  let captured: unknown[] | null = null;
  harness.server.handleTextAskMessage = async (ws: unknown, request: unknown) => {
    harness.lifecycle.push('handleTextAskMessage');
    captured = [ws, request];
  };

  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'ask_text',
    data: {
      text: 'hello',
      clientMessageId: 'client-1',
    },
  });
  await harness.server.handleWSMessage(harness.openSocket, {
    type: 'chat',
    data: {
      prompt: 'must be rejected',
      sessionId: 'sess-1',
    },
  });

  assert.deepEqual(harness.lifecycle, ['handleTextAskMessage', 'emit:error']);
  assert.deepEqual(captured, [
    harness.openSocket,
    {
      text: 'hello',
      clientMessageId: 'client-1',
    },
  ]);
  assert.equal(harness.emitted[0]?.type, 'error');
  assert.equal((harness.emitted[0]?.data as any).code, 'TEXT_WS_UNSUPPORTED_MESSAGE');
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
  await testHandleWSMessageChatPreservesFileReferences();
  await testHandleWSMessageChatPreservesExternalMcpServers();
  await testHandleWSMessageCancelDelegatesWithDefaultPayload();
  await testHandleWSMessagePlanInputResponseDelegatesWithDefaultPayload();
  await testHandleWSMessageStopAutoLoopDelegatesWithDefaultPayload();
  await testHandleWSMessageRunningInputEnqueueDelegatesWithPayload();
  await testHandleWSMessageRunningInputInsertDelegatesWithPayload();
  await testHandleWSMessageRunningInputCancelDelegatesWithPayload();
  await testHandleWSMessagePingDelegatesToDedicatedHandler();
  await testTextOnlySocketAllowsOnlyTextMessages();
  await testHandleWSMessagePingPreservesTopLevelTimestamp();
  await testHandleWSMessageUnknownTypeIsSafeNoop();
  await testHandlePingMessageEmitsPongWithProvidedTimestamp();
  await testHandlePingMessageBackfillsMissingTimestamp();
  await testHandlePingMessageEmitsPongWithTopLevelTimestamp();
  console.log('web-ws-message-dispatch tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
