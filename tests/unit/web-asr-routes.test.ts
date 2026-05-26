import * as assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerAsrRoutes } from '../../src/web/server/web-server-asr-routes.js';
import {
  AsrError,
  type AsrRuntimeConfig,
  type AsrService,
  type AsrTranscriptionInput,
} from '../../src/asr/index.js';
import {
  createTestAsrLifecycleStatus,
  TEST_ASR_MAX_AUDIO_BYTES,
  TEST_ASR_MODEL_ID,
} from './helpers/asr-test-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';

const TEST_SESSION_ID = 'session-a';
const TEST_TRANSCRIPT_TEXT = 'transcribed route audio';
const TEST_AUDIO_MIME_TYPE = 'audio/wav';
const TEST_AUDIO_PAYLOAD = 'fake-audio';

interface Harness {
  tempDir: string;
  baseUrl: string;
  close: () => Promise<void>;
  service: CapturingAsrService;
}

interface HarnessOptions {
  observeOnly?: boolean;
  shareOnly?: boolean;
  asr?: Partial<AsrRuntimeConfig>;
  asrReady?: boolean;
}

class CapturingAsrService implements AsrService {
  inputs: AsrTranscriptionInput[] = [];
  failure: Error | null = null;

  async transcribe(input: AsrTranscriptionInput) {
    this.inputs.push(input);
    assert.equal(fs.existsSync(input.audioPath), true);
    if (this.failure) {
      throw this.failure;
    }
    return {
      text: TEST_TRANSCRIPT_TEXT,
      language: input.language,
      model: TEST_ASR_MODEL_ID,
    };
  }
}

function resolveHarnessAsrReady(config: ReturnType<typeof createWebServerTestConfig>, input?: HarnessOptions): boolean {
  return input?.asrReady ?? config.asr?.enabled === true;
}

function createHarnessAsrStatus(config: ReturnType<typeof createWebServerTestConfig>, input?: HarnessOptions) {
  const ready = resolveHarnessAsrReady(config, input);
  return createTestAsrLifecycleStatus({
    configured: config.asr?.enabled === true,
    ready,
    maxAudioBytes: config.asr?.maxAudioBytes ?? TEST_ASR_MAX_AUDIO_BYTES,
  });
}

function createHarness(input?: HarnessOptions): Promise<Harness> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-asr-routes-'));
  const service = new CapturingAsrService();
  const config = createWebServerTestConfig({
    agent: {
      runtimeDataDir: path.join(tempDir, 'runtime'),
    },
    asr: {
      enabled: true,
      provider: 'local-process',
      command: 'fake-asr',
      args: ['--audio', '{audioPath}'],
      modelId: TEST_ASR_MODEL_ID,
      timeoutMs: 1000,
      maxConcurrent: 1,
      maxQueueSize: 1,
      maxAudioBytes: TEST_ASR_MAX_AUDIO_BYTES,
      maxOutputBytes: TEST_ASR_MAX_AUDIO_BYTES,
      resultFormat: 'json',
      ...(input?.asr ?? {}),
    },
  });
  const app = express();
  registerAsrRoutes(
    {
      app,
      agent: { getConfig: () => config },
      contextServices: {
        getInteractionStateForContext: () =>
          input?.observeOnly
            ? { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' }
            : { mode: 'normal' },
        getActiveRunState: () => null,
      },
      accessServices: {
        getSharedAccessSessionId: () => input?.shareOnly ? TEST_SESSION_ID : null,
        hasFullAccess: () => input?.shareOnly !== true,
        canAccessSession: () => true,
      },
      asrServices: {
        getStatus: () => createHarnessAsrStatus(config, input),
        start: async () => undefined,
        stop: async () => undefined,
        transcribe: (asrInput) => {
          if (!resolveHarnessAsrReady(config, input)) {
            throw new AsrError('ASR_NOT_READY', 'ASR worker is not ready.');
          }
          return service.transcribe(asrInput);
        },
      },
    } as any,
    { createService: () => service }
  );
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({
        tempDir,
        baseUrl: `http://127.0.0.1:${address.port}`,
        service,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function postTranscribe(
  harness: Harness,
  input: {
    body?: BodyInit;
    contentType?: string;
    language?: string;
    sessionId?: string;
  } = {}
): Promise<Response> {
  const sessionId = input.sessionId ?? TEST_SESSION_ID;
  const search = input.language ? `?language=${encodeURIComponent(input.language)}` : '';
  return fetch(`${harness.baseUrl}/api/sessions/${sessionId}/asr/transcribe${search}`, {
    method: 'POST',
    headers: { 'Content-Type': input.contentType ?? TEST_AUDIO_MIME_TYPE },
    body: input.body ?? Buffer.from(TEST_AUDIO_PAYLOAD),
  });
}

async function cleanupHarness(harness: Harness): Promise<void> {
  await harness.close();
  fs.rmSync(harness.tempDir, { recursive: true, force: true });
}

async function waitForMissing(filePath: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function testStatusReturnsPublicAsrCapabilities(): Promise<void> {
  const harness = await createHarness();
  try {
    const response = await fetch(`${harness.baseUrl}/api/asr/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.equal(body.configured, true);
    assert.equal(body.ready, true);
    assert.equal(body.state, 'ready');
    assert.equal(body.modelId, TEST_ASR_MODEL_ID);
    assert.equal(body.maxAudioBytes, TEST_ASR_MAX_AUDIO_BYTES);
    assert.equal(body.secureContextRequired, true);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testTranscribeUploadsRawAudioAndCleansTempFile(): Promise<void> {
  const harness = await createHarness();
  try {
    const response = await postTranscribe(harness, { language: 'zh' });
    assert.equal(response.status, 200);
    const body = await response.json() as { result?: { text?: string; language?: string } };
    assert.equal(body.result?.text, TEST_TRANSCRIPT_TEXT);
    assert.equal(body.result?.language, 'zh');
    assert.equal(harness.service.inputs.length, 1);
    assert.equal(harness.service.inputs[0].mimeType, TEST_AUDIO_MIME_TYPE);
    await waitForMissing(harness.service.inputs[0].audioPath);
    assert.equal(fs.existsSync(harness.service.inputs[0].audioPath), false);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testObserveOnlyRejectsTranscription(): Promise<void> {
  const harness = await createHarness({ observeOnly: true });
  try {
    const response = await postTranscribe(harness);
    assert.equal(response.status, 409);
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testShareOnlyRejectsTranscription(): Promise<void> {
  const harness = await createHarness({ shareOnly: true });
  try {
    const response = await postTranscribe(harness);
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 403);
    assert.equal(body.code, 'SHARE_SCOPE_FORBIDDEN');
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testDisabledAsrRejectsBeforeService(): Promise<void> {
  const harness = await createHarness({ asr: { enabled: false } });
  try {
    const response = await postTranscribe(harness);
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 503);
    assert.equal(body.code, 'ASR_DISABLED');
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testNotReadyAsrRejectsBeforeService(): Promise<void> {
  const harness = await createHarness({ asrReady: false });
  try {
    const response = await postTranscribe(harness);
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 503);
    assert.equal(body.code, 'ASR_NOT_READY');
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testEmptyAudioBodyRejectsBeforeService(): Promise<void> {
  const harness = await createHarness();
  try {
    const response = await postTranscribe(harness, { body: Buffer.alloc(0) });
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 400);
    assert.equal(body.code, 'AUDIO_EMPTY');
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testTooLargeAudioBodyRejectsBeforeService(): Promise<void> {
  const harness = await createHarness({ asr: { maxAudioBytes: 4 } });
  try {
    const response = await postTranscribe(harness, { body: Buffer.from('too-large') });
    const body = await response.json() as { code?: string };
    assert.equal(response.status, 413);
    assert.equal(body.code, 'AUDIO_TOO_LARGE');
    assert.equal(harness.service.inputs.length, 0);
  } finally {
    await cleanupHarness(harness);
  }
}

async function testServiceErrorMapping(): Promise<void> {
  const harness = await createHarness();
  try {
    harness.service.failure = new AsrError('ASR_PROCESS_FAILED', 'local model failed');
    const response = await postTranscribe(harness);
    const body = await response.json() as { code?: string; error?: string };
    assert.equal(response.status, 502);
    assert.equal(body.code, 'ASR_PROCESS_FAILED');
    assert.equal(body.error, 'local model failed');
  } finally {
    await cleanupHarness(harness);
  }
}

async function runAll(): Promise<void> {
  await testStatusReturnsPublicAsrCapabilities();
  await testTranscribeUploadsRawAudioAndCleansTempFile();
  await testObserveOnlyRejectsTranscription();
  await testShareOnlyRejectsTranscription();
  await testDisabledAsrRejectsBeforeService();
  await testNotReadyAsrRejectsBeforeService();
  await testEmptyAudioBodyRejectsBeforeService();
  await testTooLargeAudioBodyRejectsBeforeService();
  await testServiceErrorMapping();
  console.log('web-asr-routes tests passed');
}

void runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
