export type AsrProvider = 'local-process';

export type AsrResultFormat = 'json' | 'text';

export type AsrLifecycleState = 'unconfigured' | 'starting' | 'ready' | 'failed' | 'stopped';

export interface AsrSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface AsrTranscriptionInput {
  audioPath: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  requestId?: string;
}

export interface AsrTranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments?: AsrSegment[];
  model?: string;
  raw?: unknown;
}

export interface AsrService {
  transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult>;
}

export interface AsrLifecycleStatus {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  state: AsrLifecycleState;
  provider: AsrProvider;
  modelId: string;
  maxAudioBytes: number;
  secureContextRequired: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface ManagedAsrService extends AsrService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): AsrLifecycleStatus;
}

export interface LocalProcessAsrConfig {
  enabled: boolean;
  provider: AsrProvider;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  modelId: string;
  timeoutMs: number;
  maxConcurrent: number;
  maxQueueSize: number;
  maxAudioBytes: number;
  maxOutputBytes: number;
  resultFormat: AsrResultFormat;
  startupTimeoutMs: number;
  restartBackoffMs: number;
}

export interface AsrRuntimeConfig extends LocalProcessAsrConfig {}

export class AsrError extends Error {
  readonly code: string;
  readonly causeValue?: unknown;

  constructor(code: string, message: string, causeValue?: unknown) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    this.causeValue = causeValue;
  }
}
