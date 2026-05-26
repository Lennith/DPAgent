import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AsrLifecycleStatus,
  AsrSegment,
  AsrTranscriptionInput,
  AsrTranscriptionResult,
  LocalProcessAsrConfig,
  ManagedAsrService,
} from './types.js';
import { AsrError } from './types.js';
import { normalizeAsrConfig } from './glm-asr-config.js';

type SpawnFactory = typeof spawn;

interface PendingRequest {
  resolve: (result: AsrTranscriptionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startedAt: number;
}

interface StartWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_LANGUAGE = 'auto';

export class PersistentLocalProcessAsrService implements ManagedAsrService {
  private readonly config: LocalProcessAsrConfig;
  private readonly spawnProcess: SpawnFactory;
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: AsrLifecycleStatus['state'];
  private lastError: AsrLifecycleStatus['error'];
  private startPromise: Promise<void> | null = null;
  private startWaiter: StartWaiter | null = null;
  private stdoutBuffer = '';
  private stderr = '';
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private nextRequestId = 1;
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config?: Partial<LocalProcessAsrConfig>, spawnFactory: SpawnFactory = spawn) {
    this.config = normalizeAsrConfig(config);
    this.spawnProcess = spawnFactory;
    this.state = this.config.enabled ? 'stopped' : 'unconfigured';
  }

  getStatus(): AsrLifecycleStatus {
    return {
      configured: this.config.enabled,
      enabled: this.state === 'ready',
      ready: this.state === 'ready',
      state: this.config.enabled ? this.state : 'unconfigured',
      provider: this.config.provider,
      modelId: this.config.modelId,
      maxAudioBytes: this.config.maxAudioBytes,
      secureContextRequired: true,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.state = 'unconfigured';
      return;
    }
    if (this.state === 'ready') {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.clearRestartTimer();
    this.stopping = false;
    this.state = 'starting';
    this.lastError = undefined;
    this.stderr = '';
    this.stdoutBuffer = '';
    this.startPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failStartup(new AsrError('ASR_START_TIMEOUT', `ASR worker did not become ready within ${this.config.startupTimeoutMs}ms.`));
      }, this.config.startupTimeoutMs);
      this.startWaiter = { resolve, reject, timeout };
      this.spawnWorker();
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.rejectAllPending(new AsrError('ASR_STOPPED', 'ASR worker stopped.'));
    this.queue.splice(0).forEach((next) => next());
    if (this.startWaiter) {
      clearTimeout(this.startWaiter.timeout);
      this.startWaiter.resolve();
      this.startWaiter = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) {
      this.state = this.config.enabled ? 'stopped' : 'unconfigured';
      return;
    }
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
    });
    this.state = this.config.enabled ? 'stopped' : 'unconfigured';
  }

  async transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult> {
    if (!this.config.enabled) {
      throw new AsrError('ASR_DISABLED', 'ASR is disabled.');
    }
    if (this.state !== 'ready' || !this.child || !this.child.stdin.writable) {
      throw new AsrError('ASR_NOT_READY', 'ASR worker is not ready.');
    }
    await this.validateAudio(input.audioPath);
    const release = await this.acquireSlot();
    try {
      return await this.sendTranscriptionRequest(input);
    } finally {
      release();
    }
  }

  private spawnWorker(): void {
    const env = { ...process.env, ...(this.config.env ?? {}) };
    const child = this.spawnProcess(this.config.command, this.expandStartupArgs(), {
      cwd: this.config.cwd,
      env,
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-this.config.maxOutputBytes);
    });
    child.on('error', (error) => this.failStartup(new AsrError('ASR_PROCESS_ERROR', error.message, error)));
    child.on('close', (code) => this.handleClose(code));
  }

  private expandStartupArgs(): string[] {
    const values: Record<string, string> = {
      audioPath: '',
      mimeType: '',
      language: DEFAULT_LANGUAGE,
      modelId: this.config.modelId,
      prompt: '',
      requestId: '',
    };
    return this.config.args.map((arg) =>
      arg.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key: string) => values[key] ?? '')
    );
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.handleProtocolLine(line);
    }
  }

  private handleProtocolLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      this.markReady();
      return;
    }
    if (message.type === 'error') {
      const errorRecord = message.error && typeof message.error === 'object' ? message.error as Record<string, unknown> : {};
      this.failStartup(
        new AsrError(
          typeof errorRecord.code === 'string' ? errorRecord.code : 'ASR_START_FAILED',
          typeof errorRecord.message === 'string' ? errorRecord.message : 'ASR worker failed to start.'
        )
      );
      return;
    }
    const id = typeof message.id === 'string' ? message.id : '';
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (message.error && typeof message.error === 'object') {
      const errorRecord = message.error as Record<string, unknown>;
      pending.reject(
        new AsrError(
          typeof errorRecord.code === 'string' ? errorRecord.code : 'ASR_PROCESS_FAILED',
          typeof errorRecord.message === 'string' ? errorRecord.message : 'ASR worker request failed.'
        )
      );
      return;
    }
    pending.resolve(this.normalizeResult(message.result, Date.now() - pending.startedAt));
  }

  private markReady(): void {
    if (this.state === 'ready') {
      return;
    }
    this.state = 'ready';
    this.lastError = undefined;
    if (this.startWaiter) {
      clearTimeout(this.startWaiter.timeout);
      this.startWaiter.resolve();
      this.startWaiter = null;
    }
  }

  private handleClose(code: number | null): void {
    this.child = null;
    this.rejectAllPending(new AsrError('ASR_PROCESS_FAILED', this.buildFailureMessage(code)));
    if (this.stopping) {
      this.state = this.config.enabled ? 'stopped' : 'unconfigured';
      return;
    }
    this.failStartup(new AsrError('ASR_PROCESS_FAILED', this.buildFailureMessage(code)));
    if (this.config.enabled) {
      this.restartTimer = setTimeout(() => {
        void this.start().catch(() => undefined);
      }, this.config.restartBackoffMs);
    }
  }

  private failStartup(error: AsrError): void {
    this.state = 'failed';
    this.lastError = { code: error.code, message: error.message };
    if (this.startWaiter) {
      clearTimeout(this.startWaiter.timeout);
      this.startWaiter.reject(error);
      this.startWaiter = null;
    }
    if (this.child) {
      this.child.kill('SIGTERM');
    }
  }

  private buildFailureMessage(code: number | null): string {
    const reason = this.stderr.trim() || 'No stderr output.';
    return `ASR worker exited with code ${code ?? 'unknown'}: ${reason}`;
  }

  private async validateAudio(audioPath: string): Promise<void> {
    const normalizedPath = path.resolve(audioPath);
    let fileStat;
    try {
      fileStat = await stat(normalizedPath);
    } catch (error) {
      throw new AsrError('AUDIO_NOT_FOUND', `Audio file not found: ${normalizedPath}`, error);
    }
    if (!fileStat.isFile()) {
      throw new AsrError('AUDIO_NOT_FILE', `Audio path is not a file: ${normalizedPath}`);
    }
    if (fileStat.size <= 0) {
      throw new AsrError('AUDIO_EMPTY', `Audio file is empty: ${normalizedPath}`);
    }
    if (fileStat.size > this.config.maxAudioBytes) {
      throw new AsrError('AUDIO_TOO_LARGE', `Audio file is ${fileStat.size} bytes, exceeding limit ${this.config.maxAudioBytes}.`);
    }
  }

  private async acquireSlot(): Promise<() => void> {
    if (this.active < this.config.maxConcurrent) {
      this.active += 1;
      return () => this.releaseSlot();
    }
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new AsrError('ASR_BUSY', 'ASR local process queue is full.');
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.releaseSlot();
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    this.queue.shift()?.();
  }

  private sendTranscriptionRequest(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult> {
    const child = this.child;
    if (!child) {
      throw new AsrError('ASR_NOT_READY', 'ASR worker is not ready.');
    }
    const id = input.requestId?.trim() || `asr-${Date.now()}-${this.nextRequestId++}`;
    const payload = {
      id,
      audioPath: path.resolve(input.audioPath),
      mimeType: input.mimeType ?? '',
      language: input.language?.trim() || DEFAULT_LANGUAGE,
      prompt: input.prompt ?? '',
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AsrError('ASR_TIMEOUT', `ASR request timed out after ${this.config.timeoutMs}ms.`));
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, startedAt: Date.now() });
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timeout);
          reject(new AsrError('ASR_PROCESS_ERROR', error.message, error));
        }
      });
    });
  }

  private normalizeResult(value: unknown, elapsedMs: number): AsrTranscriptionResult {
    if (typeof value === 'string') {
      return { text: value.trim(), durationMs: elapsedMs, model: this.config.modelId, raw: value };
    }
    if (!value || typeof value !== 'object') {
      throw new AsrError('ASR_INVALID_RESULT', 'ASR worker result must be an object or string.');
    }
    const record = value as Record<string, unknown>;
    return {
      text: typeof record.text === 'string' ? record.text.trim() : '',
      language: typeof record.language === 'string' ? record.language : undefined,
      durationMs: Number.isFinite(record.durationMs) ? Math.floor(record.durationMs as number) : elapsedMs,
      segments: this.normalizeSegments(record.segments),
      model: typeof record.model === 'string' ? record.model : this.config.modelId,
      raw: value,
    };
  }

  private normalizeSegments(value: unknown): AsrSegment[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const segments = value.flatMap((item): AsrSegment[] => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const record = item as Record<string, unknown>;
      const startMs = Number(record.startMs);
      const endMs = Number(record.endMs);
      const text = typeof record.text === 'string' ? record.text.trim() : '';
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !text) {
        return [];
      }
      return [{ startMs: Math.floor(startMs), endMs: Math.floor(endMs), text }];
    });
    return segments.length > 0 ? segments : undefined;
  }

  private rejectAllPending(error: AsrError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}
