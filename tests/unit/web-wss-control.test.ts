import * as assert from 'node:assert/strict';
import type { ContextRef } from '../../src/types.js';
import {
  attachEmitCapture,
  createOpenSocket,
  createWebServerDouble,
  createSessionContext,
  type CapturedWebMessage,
} from './helpers/web-server-harness.js';

const DEFAULT_SESSION_ID = 'sess-1';
const OTHER_SESSION_ID = 'sess-2';
const DEFAULT_RUN_ID = 'run-1';
const DEFAULT_CONTEXT_KEY = `session:${DEFAULT_SESSION_ID}`;
const DEFAULT_CONTROLLER_WSS_ID = 'owner-wss';
const DEFAULT_SHARE_HASH = 'hash-1';
const OTHER_SHARE_HASH = 'hash-2';
const TEXT_SHARE_TOKEN = 'share-token-1';

function createHarness() {
  const context: ContextRef = createSessionContext(DEFAULT_SESSION_ID);
  const otherContext: ContextRef = createSessionContext(OTHER_SESSION_ID);
  const ownerWs = createOpenSocket('owner');
  const observerWs = createOpenSocket('observer');
  const sharedTargetWs = createOpenSocket('shared-target');
  const sharedOtherWs = createOpenSocket('shared-other');
  const textSharedWs = createOpenSocket('text-shared');
  const server = createWebServerDouble();
  const { emitted } = attachEmitCapture(server) as { emitted: CapturedWebMessage[]; lifecycle: string[] };
  const share = {
    tokenHash: DEFAULT_SHARE_HASH,
    createdAt: '2026-05-07T00:00:00.000Z',
    expiresAt: '2099-05-07T00:00:00.000Z',
    version: 1,
  };

  server.activeRunControllerWssByContext = new Map([[DEFAULT_CONTEXT_KEY, DEFAULT_CONTROLLER_WSS_ID]]);
  server.websocketClientKinds = new WeakMap([
    [ownerWs as any, 'web'],
    [observerWs as any, 'web'],
    [sharedTargetWs as any, 'web'],
    [sharedOtherWs as any, 'web'],
  ]);
  server.websocketScopes = new WeakMap([
    [ownerWs as any, { mode: 'full', wssId: DEFAULT_CONTROLLER_WSS_ID, clientKind: 'web' }],
    [observerWs as any, { mode: 'full', wssId: 'observer-wss', clientKind: 'web' }],
    [
      sharedTargetWs as any,
      { mode: 'shared_ls', wssId: 'shared-target-wss', clientKind: 'web', sessionId: DEFAULT_SESSION_ID, tokenHash: DEFAULT_SHARE_HASH, shareVersion: 1 },
    ],
    [
      textSharedWs as any,
      {
        mode: 'shared_ls',
        wssId: 'text-shared-wss',
        clientKind: 'web',
        sessionId: DEFAULT_SESSION_ID,
        tokenHash: DEFAULT_SHARE_HASH,
        shareToken: TEXT_SHARE_TOKEN,
        shareVersion: 1,
        transportMode: 'text',
      },
    ],
    [
      sharedOtherWs as any,
      { mode: 'shared_ls', wssId: 'shared-other-wss', clientKind: 'web', sessionId: OTHER_SESSION_ID, tokenHash: OTHER_SHARE_HASH, shareVersion: 1 },
    ],
  ]);
  server.websocketsByWssId = new Map();
  server.cancelingRunIds = new Set();
  server.wss = {
    clients: new Set([ownerWs, observerWs, sharedTargetWs, sharedOtherWs, textSharedWs]),
  };
  server.getContextNamespaceMetaSafe = (nextContext: ContextRef) =>
    nextContext.namespace === DEFAULT_SESSION_ID
      ? { sessionShare: share }
      : {
          sessionShare: {
            ...share,
            tokenHash: OTHER_SHARE_HASH,
          },
        };
  server.getActiveRunState = (nextContext: ContextRef) =>
    nextContext.namespace === DEFAULT_SESSION_ID
      ? {
          runId: DEFAULT_RUN_ID,
          context,
          startedAt: '2026-05-07T00:00:00.000Z',
          lastActivityAt: '2026-05-07T00:00:00.000Z',
          currentStep: 0,
          owner: 'web',
          origin: 'web',
          interactionState: { mode: 'normal', owner: 'web' },
          runningInputQueue: [],
        }
      : null;
  server.getRunningInputQueue = () => ({
    enqueue: () => ({ id: 'rin-1', prompt: 'hello' }),
    list: () => [],
  });
  return {
    server,
    context,
    otherContext,
    ownerWs,
    observerWs,
    sharedTargetWs,
    sharedOtherWs,
    textSharedWs,
    emitted,
  };
}

function testRunEventFiltersSharedSocketsAndKeepsFullWebClientsMutable(): void {
  const harness = createHarness();

  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'chat_started',
    data: {
      context: harness.context,
      interactionState: { mode: 'normal', owner: 'web' },
    },
  });

  assert.equal(harness.emitted.length, 3);
  assert.ok(harness.emitted.some((item) => item.ws === harness.ownerWs));
  assert.ok(harness.emitted.some((item) => item.ws === harness.observerWs));
  assert.ok(harness.emitted.some((item) => item.ws === harness.sharedTargetWs));
  assert.ok(!harness.emitted.some((item) => item.ws === harness.sharedOtherWs));
  assert.ok(!harness.emitted.some((item) => item.ws === harness.textSharedWs));
  assert.deepEqual(
    harness.emitted.find((item) => item.ws === harness.ownerWs)?.data.interactionState,
    { mode: 'normal', owner: 'web' }
  );
  assert.deepEqual(
    harness.emitted.find((item) => item.ws === harness.observerWs)?.data.interactionState,
    { mode: 'normal', owner: 'web' }
  );
}

function testTextOnlySharedSocketReceivesOnlyTextProtocolEvents(): void {
  const harness = createHarness();

  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'thinking',
    data: {
      runId: DEFAULT_RUN_ID,
      context: harness.context,
      thinking: 'private reasoning',
    },
  });
  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'tool_call',
    data: {
      runId: DEFAULT_RUN_ID,
      context: harness.context,
      name: 'shell',
      args: { command: 'secret' },
    },
  });
  assert.equal(harness.emitted.some((item) => item.ws === harness.textSharedWs), false);

  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'tool_result',
    data: {
      runId: DEFAULT_RUN_ID,
      context: harness.context,
      name: 'send_file_to_user',
      result: {
        success: true,
        content: JSON.stringify({
          success: true,
          href: 'http://localhost:53721/download/id/report.zip',
          displayPath: 'D:\\repo\\report.zip',
          filename: 'report.zip',
          size: 12,
          expiresAt: '2099-05-07T00:00:00.000Z',
        }),
      },
    },
  });
  const fileLink = harness.emitted.find((item) => item.ws === harness.textSharedWs && item.type === 'file_link');
  assert.deepEqual(fileLink?.data, {
    runId: DEFAULT_RUN_ID,
    sessionId: DEFAULT_SESSION_ID,
    href: `http://localhost:53721/download/id/report.zip?shareToken=${TEXT_SHARE_TOKEN}`,
    displayPath: 'D:\\repo\\report.zip',
    filename: 'report.zip',
    size: 12,
    expiresAt: '2099-05-07T00:00:00.000Z',
  });

  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'message',
    data: {
      runId: DEFAULT_RUN_ID,
      context: harness.context,
      role: 'assistant',
      content: 'hello text client',
    },
  });
  harness.server.emitRunEvent(harness.ownerWs, harness.context, {
    type: 'complete',
    data: {
      runId: DEFAULT_RUN_ID,
      context: harness.context,
      content: 'final text',
    },
  });

  const textMessages = harness.emitted.filter((item) => item.ws === harness.textSharedWs);
  assert.deepEqual(textMessages.map((item) => item.type), ['file_link', 'text_delta', 'done']);
  assert.deepEqual(textMessages[1]?.data, {
    runId: DEFAULT_RUN_ID,
    sessionId: DEFAULT_SESSION_ID,
    content: 'hello text client',
  });
  assert.deepEqual(textMessages[2]?.data, {
    runId: DEFAULT_RUN_ID,
    sessionId: DEFAULT_SESSION_ID,
    content: 'final text',
  });
}

async function testTextOnlyAskDelegatesToChatWithBoundSharedSession(): Promise<void> {
  const harness = createHarness();
  let captured: unknown[] | null = null;
  harness.server.getActiveRunState = () => null;
  harness.server.handleChatMessage = async (ws: unknown, request: unknown) => {
    captured = [ws, request];
  };

  await harness.server.handleTextAskMessage(harness.textSharedWs, {
    text: 'write hello world',
    clientMessageId: 'client-text-1',
  });

  assert.deepEqual(captured, [
    harness.textSharedWs,
    {
      prompt: 'write hello world',
      sessionId: DEFAULT_SESSION_ID,
      clientMessageId: 'client-text-1',
    },
  ]);
}

async function testTextOnlyAskRejectsBusyNonController(): Promise<void> {
  const harness = createHarness();
  harness.server.handleChatMessage = async () => {
    throw new Error('busy text ask must not start a concurrent chat');
  };

  await harness.server.handleTextAskMessage(harness.textSharedWs, {
    text: 'try while running',
  });

  assert.equal(harness.emitted.at(-1)?.ws, harness.textSharedWs);
  assert.equal(harness.emitted.at(-1)?.type, 'observe_only');
  assert.equal(harness.emitted.at(-1)?.data.interactionState.reason, 'wss_controlled_active_run');
}

async function testSharedSocketCannotClaimControlWhenControllerMapMissing(): Promise<void> {
  const harness = createHarness();
  harness.server.activeRunControllerWssByContext.clear();
  harness.server.handleChatMessage = async () => {
    throw new Error('shared socket must not claim missing active-run controller');
  };

  await harness.server.handleTextAskMessage(harness.textSharedWs, {
    text: 'try while controller map is missing',
  });

  assert.equal(harness.emitted.at(-1)?.ws, harness.textSharedWs);
  assert.equal(harness.emitted.at(-1)?.type, 'observe_only');
  assert.equal(harness.emitted.at(-1)?.data.interactionState.reason, 'wss_controlled_active_run');
  assert.equal(harness.server.activeRunControllerWssByContext.has(DEFAULT_CONTEXT_KEY), false);
}

function testFullWebClientCanMutateRunningInputFromAnotherSocket(): void {
  const harness = createHarness();

  harness.server.handleRunningInputEnqueueMessage(harness.observerWs, {
    context: harness.context,
    prompt: 'queued',
  });

  assert.ok(harness.emitted.some((item) => item.type === 'running_input_queued'));
  assert.ok(harness.emitted.some((item) => item.type === 'running_input_queue_updated'));
  assert.equal(harness.server.activeRunControllerWssByContext.get(DEFAULT_CONTEXT_KEY), DEFAULT_CONTROLLER_WSS_ID);
}

function testSharedSocketCannotAccessOtherSessionEventsOrControls(): void {
  const harness = createHarness();

  harness.server.broadcastRunningInputQueue(harness.context);
  assert.ok(harness.emitted.some((item) => item.ws === harness.sharedTargetWs));
  assert.ok(!harness.emitted.some((item) => item.ws === harness.sharedOtherWs));

  harness.emitted.length = 0;
  harness.server.handleRunningInputEnqueueMessage(harness.sharedOtherWs, {
    context: harness.context,
    prompt: 'blocked',
  });
  assert.equal(harness.emitted[0]?.type, 'running_input_error');
  assert.equal(harness.emitted[0]?.data.error, 'share_scope_forbidden');
}

async function testPreparedChatBroadcastsUserMessageOnceWithClientId(): Promise<void> {
  const harness = createHarness();
  let executed: unknown = null;
  harness.server.executeTrackedRun = async (input: unknown) => {
    executed = input;
  };

  await harness.server.executePreparedChatRun({
    request: {
      prompt: 'hello from A',
      clientMessageId: 'client-msg-1',
    },
    ownerWs: harness.ownerWs,
    context: harness.context,
    runId: DEFAULT_RUN_ID,
    dispatcher: {},
    effectivePrompt: 'hello from A',
  });

  assert.ok(executed);
  const userMessages = harness.emitted.filter((item) => item.type === 'message' && item.data.role === 'user');
  assert.equal(userMessages.length, 3);
  assert.ok(!userMessages.some((item) => item.ws === harness.sharedOtherWs));
  assert.deepEqual(userMessages[0].data, {
    runId: DEFAULT_RUN_ID,
    context: harness.context,
    role: 'user',
    content: 'hello from A',
    clientMessageId: 'client-msg-1',
    createdAt: userMessages[0].data.createdAt,
  });
  assert.match(String(userMessages[0].data.createdAt ?? ''), /^\d{4}-\d{2}-\d{2}T/);
}

async function runAll(): Promise<void> {
  testRunEventFiltersSharedSocketsAndKeepsFullWebClientsMutable();
  testTextOnlySharedSocketReceivesOnlyTextProtocolEvents();
  testFullWebClientCanMutateRunningInputFromAnotherSocket();
  testSharedSocketCannotAccessOtherSessionEventsOrControls();
  await testTextOnlyAskDelegatesToChatWithBoundSharedSession();
  await testTextOnlyAskRejectsBusyNonController();
  await testSharedSocketCannotClaimControlWhenControllerMapMissing();
  await testPreparedChatBroadcastsUserMessageOnceWithClientId();
  console.log('web-wss-control tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
