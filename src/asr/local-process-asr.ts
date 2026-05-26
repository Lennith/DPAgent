import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AsrSegment,
  AsrService,
  AsrTranscriptionInput,
  AsrTranscriptionResult,
  LocalProcessAsrConfig,
} from './types.js';
import { AsrError } from './types.js';
import { normalizeAsrConfig } from './glm-asr-config.js';

type SpawnFactory = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    stdio: 'pipe';
  }
) => ChildProcessWithoutNullStreams;

const DEFAULT_LANGUAGE = 'auto';

export class LocalProcessAsrService implements AsrService {
  private readonly config: LocalProcessAsrConfig;
  private readonly spawnProcess: SpawnFactory;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(config?: Partial<LocalProcessAsrConfig>, spawnFactory: SpawnFactory = spawn) {
    this.config = normalizeAsrConfig(config);
    this.spawnProcess = spawnFactory;
  }

  async transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult> {
    if (!this.config.enabled) {
      throw new AsrError('ASR_DISABLED', 'ASR is disabled.');
    }
    await this.validateAudio(input.audioPath);
    const release = await this.acquireSlot();
    try {
      return await this.runProcess(input);
    } finally {
      release();
    }
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
      throw new AsrError(
        'AUDIO_TOO_LARGE',
        `Audio file is ${fileStat.size} bytes, exceeding limit ${this.config.maxAudioBytes}.`
      );
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
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  private runProcess(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult> {
    const args = this.expandArgs(input);
    const env = { ...process.env, ...(this.config.env ?? {}) };
    const child = this.spawnProcess(this.config.command, args, {
      cwd: this.config.cwd,
      env,
      windowsHide: true,
      stdio: 'pipe',
    });
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let terminalError: AsrError | null = null;
    let forcedKillTimer: NodeJS.Timeout | null = null;

    return new Promise<AsrTranscriptionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return;
        if (terminalError) return;
        timedOut = true;
        child.kill('SIGTERM');
        forcedKillTimer = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, this.config.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf8') > this.config.maxOutputBytes && !settled) {
          terminalError = new AsrError('ASR_OUTPUT_TOO_LARGE', 'ASR stdout exceeded configured limit.');
          child.kill('SIGTERM');
          forcedKillTimer ??= setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr, 'utf8') > this.config.maxOutputBytes && !settled) {
          terminalError = new AsrError('ASR_OUTPUT_TOO_LARGE', 'ASR stderr exceeded configured limit.');
          child.kill('SIGTERM');
          forcedKillTimer ??= setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, 5000);
        }
      });
      child.on('error', (error) => {
        rejectOnce(new AsrError('ASR_PROCESS_ERROR', error.message, error));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forcedKillTimer) {
          clearTimeout(forcedKillTimer);
        }
        if (terminalError) {
          reject(terminalError);
          return;
        }
        if (timedOut) {
          reject(new AsrError('ASR_TIMEOUT', `ASR process timed out after ${this.config.timeoutMs}ms.`));
          return;
        }
        if (code !== 0) {
          reject(new AsrError('ASR_PROCESS_FAILED', this.buildFailureMessage(code, stderr)));
          return;
        }
        try {
          resolve(this.parseResult(stdout, Date.now() - startedAt));
        } catch (error) {
          reject(error);
        }
      });

      const rejectOnce = (error: AsrError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forcedKillTimer) {
          clearTimeout(forcedKillTimer);
        }
        reject(error);
      };
    });
  }

  private expandArgs(input: AsrTranscriptionInput): string[] {
    const values: Record<string, string> = {
      audioPath: path.resolve(input.audioPath),
      mimeType: input.mimeType ?? '',
      language: input.language?.trim() || DEFAULT_LANGUAGE,
      modelId: this.config.modelId,
      prompt: input.prompt ?? '',
      requestId: input.requestId ?? '',
    };
    return this.config.args.map((arg) =>
      arg.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key: string) => values[key] ?? '')
    );
  }

  private buildFailureMessage(code: number | null, stderr: string): string {
    const reason = stderr.trim() || 'No stderr output.';
    return `ASR process exited with code ${code ?? 'unknown'}: ${reason}`;
  }

  private parseResult(stdout: string, elapsedMs: number): AsrTranscriptionResult {
    const output = stdout.trim();
    if (!output) {
      throw new AsrError('ASR_EMPTY_RESULT', 'ASR process returned no output.');
    }
    if (this.config.resultFormat === 'text') {
      return { text: output, durationMs: elapsedMs, model: this.config.modelId };
    }
    const parsed = JSON.parse(output) as unknown;
    return this.normalizeJsonResult(parsed, elapsedMs);
  }

  private normalizeJsonResult(parsed: unknown, elapsedMs: number): AsrTranscriptionResult {
    if (typeof parsed === 'string') {
      return { text: parsed, durationMs: elapsedMs, model: this.config.modelId, raw: parsed };
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new AsrError('ASR_INVALID_RESULT', 'ASR JSON result must be an object or string.');
    }
    const record = parsed as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    return {
      text,
      language: typeof record.language === 'string' ? record.language : undefined,
      durationMs: Number.isFinite(record.durationMs) ? Math.floor(record.durationMs as number) : elapsedMs,
      segments: this.normalizeSegments(record.segments),
      model: typeof record.model === 'string' ? record.model : this.config.modelId,
      raw: parsed,
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
}
