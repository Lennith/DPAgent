import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AsrError,
  GLM_ASR_NANO_2512_MODEL_ID,
  LocalProcessAsrService,
  PersistentLocalProcessAsrService,
  normalizeAsrConfig,
} from '../../src/asr/index.js';

function createHarness(): { tempDir: string; audioPath: string; scriptPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-local-process-'));
  const audioPath = path.join(tempDir, 'sample.wav');
  fs.writeFileSync(audioPath, Buffer.from('fake-audio'));
  const scriptPath = path.join(tempDir, 'fake-asr.mjs');
  fs.writeFileSync(
    scriptPath,
    [
      "const audioArgIndex = process.argv.indexOf('--audio');",
      "const langArgIndex = process.argv.indexOf('--language');",
      "const modelArgIndex = process.argv.indexOf('--model');",
      "const audioPath = audioArgIndex >= 0 ? process.argv[audioArgIndex + 1] : '';",
      "const language = langArgIndex >= 0 ? process.argv[langArgIndex + 1] : 'auto';",
      "const model = modelArgIndex >= 0 ? process.argv[modelArgIndex + 1] : '';",
      "if (!audioPath) { console.error('missing audio'); process.exit(3); }",
      "console.log(JSON.stringify({ text: 'hello from local glm asr', language, model, segments: [{ startMs: 0, endMs: 320, text: 'hello' }] }));",
    ].join('\n')
  );
  return { tempDir, audioPath, scriptPath };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeScript(tempDir: string, name: string, lines: string[]): string {
  const scriptPath = path.join(tempDir, name);
  fs.writeFileSync(scriptPath, lines.join('\n'));
  return scriptPath;
}

function testNormalizeAsrConfigUsesGlmDefault(): void {
  const config = normalizeAsrConfig({ enabled: true });
  assert.equal(config.enabled, true);
  assert.equal(config.modelId, GLM_ASR_NANO_2512_MODEL_ID);
  assert.equal(config.provider, 'local-process');
  assert.equal(config.maxConcurrent, 1);
}

async function testLocalProcessTranscribesJsonOutput(): Promise<void> {
  const harness = createHarness();
  try {
    const service = new LocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [
        harness.scriptPath,
        '--model',
        '{modelId}',
        '--audio',
        '{audioPath}',
        '--language',
        '{language}',
      ],
      modelId: GLM_ASR_NANO_2512_MODEL_ID,
      timeoutMs: 10000,
      maxConcurrent: 1,
      maxAudioBytes: 1024,
      resultFormat: 'json',
    });

    const result = await service.transcribe({
      audioPath: harness.audioPath,
      mimeType: 'audio/wav',
      language: 'zh',
    });

    assert.equal(result.text, 'hello from local glm asr');
    assert.equal(result.language, 'zh');
    assert.equal(result.model, GLM_ASR_NANO_2512_MODEL_ID);
    assert.equal(result.segments?.[0]?.text, 'hello');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testDisabledConfigRejects(): Promise<void> {
  const harness = createHarness();
  try {
    const service = new LocalProcessAsrService({
      enabled: false,
      command: process.execPath,
      args: [harness.scriptPath],
    });
    await assert.rejects(
      () => service.transcribe({ audioPath: harness.audioPath }),
      (error) => error instanceof AsrError && error.code === 'ASR_DISABLED'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testAudioSizeLimitRejects(): Promise<void> {
  const harness = createHarness();
  try {
    const service = new LocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [harness.scriptPath],
      maxAudioBytes: 1,
    });
    await assert.rejects(
      () => service.transcribe({ audioPath: harness.audioPath }),
      (error) => error instanceof AsrError && error.code === 'AUDIO_TOO_LARGE'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testTimeoutWaitsForProcessClose(): Promise<void> {
  const harness = createHarness();
  try {
    const slowScript = writeScript(harness.tempDir, 'slow-asr.mjs', [
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 160));",
      "setInterval(() => {}, 1000);",
    ]);
    const service = new LocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [slowScript],
      timeoutMs: 50,
      maxConcurrent: 1,
      maxAudioBytes: 1024,
    });

    await assert.rejects(
      () => service.transcribe({ audioPath: harness.audioPath }),
      (error) => error instanceof AsrError && error.code === 'ASR_TIMEOUT'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testOutputLimitRejects(): Promise<void> {
  const harness = createHarness();
  try {
    const noisyScript = writeScript(harness.tempDir, 'noisy-asr.mjs', [
      "console.log('x'.repeat(2048));",
    ]);
    const service = new LocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [noisyScript],
      timeoutMs: 10000,
      maxAudioBytes: 1024,
      maxOutputBytes: 64,
    });

    await assert.rejects(
      () => service.transcribe({ audioPath: harness.audioPath }),
      (error) => error instanceof AsrError && error.code === 'ASR_OUTPUT_TOO_LARGE'
    );
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testPersistentWorkerLifecycleAndEmptyText(): Promise<void> {
  const harness = createHarness();
  try {
    const emptyAudioPath = path.join(harness.tempDir, 'empty.wav');
    fs.writeFileSync(emptyAudioPath, Buffer.from('fake-audio'));
    const workerScript = writeScript(harness.tempDir, 'fake-worker.mjs', [
      "console.log(JSON.stringify({ type: 'ready' }));",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() || '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const request = JSON.parse(line);",
      "    const text = String(request.audioPath || '').includes('empty') ? '' : 'stream worker text';",
      "    console.log(JSON.stringify({ id: request.id, result: { text, language: request.language, model: 'fake-worker' } }));",
      "  }",
      "});",
    ]);
    const service = new PersistentLocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [workerScript],
      timeoutMs: 5000,
      startupTimeoutMs: 5000,
      restartBackoffMs: 60000,
      maxAudioBytes: 1024,
    });
    await service.start();
    assert.equal(service.getStatus().state, 'ready');
    const result = await service.transcribe({ audioPath: harness.audioPath, language: 'zh' });
    assert.equal(result.text, 'stream worker text');
    assert.equal(result.language, 'zh');
    const empty = await service.transcribe({ audioPath: emptyAudioPath });
    assert.equal(empty.text, '');
    await service.stop();
    assert.equal(service.getStatus().state, 'stopped');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testPersistentWorkerStartFailure(): Promise<void> {
  const harness = createHarness();
  try {
    const failingWorker = writeScript(harness.tempDir, 'failing-worker.mjs', [
      "console.error('load failed');",
      "process.exit(7);",
    ]);
    const service = new PersistentLocalProcessAsrService({
      enabled: true,
      command: process.execPath,
      args: [failingWorker],
      timeoutMs: 1000,
      startupTimeoutMs: 1000,
      restartBackoffMs: 60000,
      maxAudioBytes: 1024,
    });
    await assert.rejects(() => service.start(), (error) => error instanceof AsrError && error.code === 'ASR_PROCESS_FAILED');
    assert.equal(service.getStatus().state, 'failed');
    await assert.rejects(
      () => service.transcribe({ audioPath: harness.audioPath }),
      (error) => error instanceof AsrError && error.code === 'ASR_NOT_READY'
    );
    await service.stop();
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  testNormalizeAsrConfigUsesGlmDefault();
  await testLocalProcessTranscribesJsonOutput();
  await testDisabledConfigRejects();
  await testAudioSizeLimitRejects();
  await testTimeoutWaitsForProcessClose();
  await testOutputLimitRejects();
  await testPersistentWorkerLifecycleAndEmptyText();
  await testPersistentWorkerStartFailure();
  console.log('asr-local-process tests passed');
}

void runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
