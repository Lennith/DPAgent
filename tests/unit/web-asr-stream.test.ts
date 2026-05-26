import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { WebAsrStreamController } from '../../src/web/server/web-server-asr-stream.js';
import type { AsrTranscriptionInput, AsrTranscriptionResult } from '../../src/asr/index.js';
import type { ContextRef } from '../../src/types.js';
import type { WSMessage } from '../../src/web/server/web-server-shared.js';
import {
  createTestAsrLifecycleStatus,
  TEST_ASR_MAX_AUDIO_BYTES,
} from './helpers/asr-test-harness.js';
import { createOpenSocket } from './helpers/web-server-harness.js';

const TEST_SESSION_ID = 'session-a';
const TEST_STREAM_ID = 'stream-a';

interface Harness {
  tempDir: string;
  messages: WSMessage[];
  inputs: AsrTranscriptionInput[];
  socket: WebSocket;
  controller: WebAsrStreamController;
}

function createHarness(options?: {
  ready?: boolean;
  observeOnly?: boolean;
  fullAccess?: boolean;
  text?: string;
  maxAudioBytes?: number;
}): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-asr-stream-'));
  const messages: WSMessage[] = [];
  const inputs: AsrTranscriptionInput[] = [];
  const context: ContextRef = { scope: 'session', namespace: TEST_SESSION_ID };
  const socket = {
    ...createOpenSocket('asr'),
    send: () => undefined,
  } as unknown as WebSocket;
  const controller = new WebAsrStreamController({
    getRuntimeDataDir: () => tempDir,
    getStatus: () =>
      createTestAsrLifecycleStatus({
        ready: options?.ready ?? true,
        maxAudioBytes: options?.maxAudioBytes ?? TEST_ASR_MAX_AUDIO_BYTES,
      }),
    transcribe: async (input): Promise<AsrTranscriptionResult> => {
      inputs.push(input);
      assert.equal(fs.existsSync(input.audioPath), true);
      return { text: options?.text ?? 'streamed text', language: input.language, model: 'fake-asr' };
    },
    canAccessContext: (_ws, candidate) => candidate.scope === context.scope && candidate.namespace === context.namespace,
    hasFullAccess: () => options?.fullAccess ?? true,
    getInteractionStateForContext: () =>
      options?.observeOnly ? { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' } : { mode: 'normal' },
    emit: (_ws, message) => messages.push(message),
  });
  return { tempDir, messages, inputs, socket, controller };
}

function cleanupHarness(harness: Harness): void {
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
}

function encodedAudio(value = 'fake-audio'): string {
  return Buffer.from(value).toString('base64');
}

function messageTypes(harness: Harness): string[] {
  return harness.messages.map((message) => message.type);
}

async function testStreamChunkEmitsPartialAndDone(): Promise<void> {
  const harness = createHarness();
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID, language: 'zh' });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      sequence: 1,
      mimeType: 'audio/webm',
      audioBase64: encodedAudio(),
    });
    await harness.controller.stop(harness.socket, { streamId: TEST_STREAM_ID });
    assert.deepEqual(messageTypes(harness), [
      'asr_stream_ready',
      'asr_stream_partial',
      'asr_stream_done',
    ]);
    assert.equal((harness.messages[1].data as { text?: string }).text, 'streamed text');
    assert.equal((harness.messages[1].data as { isFinal?: boolean }).isFinal, false);
    assert.equal((harness.messages[1].data as { sequence?: number }).sequence, 1);
    assert.equal(harness.inputs[0]?.language, 'zh');
  } finally {
    cleanupHarness(harness);
  }
}

async function testFinalChunkMarksPartialAsFinal(): Promise<void> {
  const harness = createHarness();
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      sequence: 2,
      mimeType: 'audio/wav',
      audioBase64: encodedAudio(),
      isFinal: true,
    });
    await harness.controller.stop(harness.socket, { streamId: TEST_STREAM_ID });
    assert.equal((harness.messages[1].data as { isFinal?: boolean }).isFinal, true);
    assert.equal((harness.messages[1].data as { sequence?: number }).sequence, 2);
  } finally {
    cleanupHarness(harness);
  }
}

async function testEmptyTextEmitsDoneWithoutPartial(): Promise<void> {
  const harness = createHarness({ text: '' });
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      audioBase64: encodedAudio(),
    });
    await harness.controller.stop(harness.socket, { streamId: TEST_STREAM_ID });
    assert.deepEqual(messageTypes(harness), [
      'asr_stream_ready',
      'asr_stream_done',
    ]);
  } finally {
    cleanupHarness(harness);
  }
}

async function testFinalEmptyTextEmitsCommitPartial(): Promise<void> {
  const harness = createHarness({ text: '' });
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      sequence: 3,
      audioBase64: encodedAudio(),
      isFinal: true,
    });
    await harness.controller.stop(harness.socket, { streamId: TEST_STREAM_ID });
    assert.deepEqual(messageTypes(harness), [
      'asr_stream_ready',
      'asr_stream_partial',
      'asr_stream_done',
    ]);
    assert.equal((harness.messages[1].data as { text?: string }).text, '');
    assert.equal((harness.messages[1].data as { isFinal?: boolean }).isFinal, true);
  } finally {
    cleanupHarness(harness);
  }
}

async function testNotReadyRejectsStart(): Promise<void> {
  const harness = createHarness({ ready: false });
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    assert.equal(harness.messages[0]?.type, 'asr_stream_error');
    assert.equal((harness.messages[0]?.data as { code?: string }).code, 'ASR_NOT_READY');
  } finally {
    cleanupHarness(harness);
  }
}

async function testObserveOnlyRejectsStart(): Promise<void> {
  const harness = createHarness({ observeOnly: true });
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    assert.equal(harness.messages[0]?.type, 'asr_stream_error');
    assert.equal((harness.messages[0]?.data as { code?: string }).code, 'ASR_OBSERVE_ONLY');
  } finally {
    cleanupHarness(harness);
  }
}

async function testOversizeChunkIsRejectedBeforeTranscribe(): Promise<void> {
  const harness = createHarness({ maxAudioBytes: 4 });
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      sequence: 5,
      mimeType: 'audio/webm',
      audioBase64: encodedAudio('too-large'),
    });
    await harness.controller.stop(harness.socket, { streamId: TEST_STREAM_ID });
    assert.deepEqual(messageTypes(harness), [
      'asr_stream_ready',
      'asr_stream_error',
      'asr_stream_done',
    ]);
    assert.equal((harness.messages[1].data as { code?: string }).code, 'ASR_STREAM_TOO_LARGE');
    assert.equal(harness.inputs.length, 0);
  } finally {
    cleanupHarness(harness);
  }
}

async function testCancelDrainsQueuedChunkWithoutPartialOrError(): Promise<void> {
  const harness = createHarness();
  try {
    await harness.controller.start(harness.socket, { streamId: TEST_STREAM_ID, sessionId: TEST_SESSION_ID });
    await harness.controller.chunk(harness.socket, {
      streamId: TEST_STREAM_ID,
      sequence: 4,
      mimeType: 'audio/wav',
      audioBase64: encodedAudio(),
    });
    await harness.controller.cancel(harness.socket, { streamId: TEST_STREAM_ID });
    assert.deepEqual(messageTypes(harness), ['asr_stream_ready']);
  } finally {
    cleanupHarness(harness);
  }
}

async function runAll(): Promise<void> {
  await testStreamChunkEmitsPartialAndDone();
  await testFinalChunkMarksPartialAsFinal();
  await testEmptyTextEmitsDoneWithoutPartial();
  await testFinalEmptyTextEmitsCommitPartial();
  await testNotReadyRejectsStart();
  await testObserveOnlyRejectsStart();
  await testOversizeChunkIsRejectedBeforeTranscribe();
  await testCancelDrainsQueuedChunkWithoutPartialOrError();
  console.log('web-asr-stream tests passed');
}

void runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
