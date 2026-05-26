import type { AsrRuntimeConfig, LocalProcessAsrConfig } from './types.js';

export const GLM_ASR_NANO_2512_MODEL_ID = 'zai-org/GLM-ASR-Nano-2512';

export const DEFAULT_GLM_ASR_CONFIG: AsrRuntimeConfig = {
  enabled: false,
  provider: 'local-process',
  command: 'python',
  args: [
    'scripts/asr/glm-asr-transformers-worker.py',
    '--model',
    '{modelId}',
  ],
  modelId: GLM_ASR_NANO_2512_MODEL_ID,
  timeoutMs: 120000,
  maxConcurrent: 1,
  maxQueueSize: 4,
  maxAudioBytes: 25 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  resultFormat: 'json',
  startupTimeoutMs: 180000,
  restartBackoffMs: 3000,
};

function positiveInteger(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : [...fallback];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      record[key] = raw;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export function normalizeAsrConfig(input?: Partial<LocalProcessAsrConfig>): AsrRuntimeConfig {
  const raw = input ?? {};
  const command =
    typeof raw.command === 'string' && raw.command.trim().length > 0
      ? raw.command.trim()
      : DEFAULT_GLM_ASR_CONFIG.command;
  const modelId =
    typeof raw.modelId === 'string' && raw.modelId.trim().length > 0
      ? raw.modelId.trim()
      : DEFAULT_GLM_ASR_CONFIG.modelId;
  const cwd =
    typeof raw.cwd === 'string' && raw.cwd.trim().length > 0 ? raw.cwd.trim() : undefined;
  const resultFormat = raw.resultFormat === 'text' ? 'text' : DEFAULT_GLM_ASR_CONFIG.resultFormat;

  return {
    enabled: raw.enabled === true,
    provider: 'local-process',
    command,
    args: stringArray(raw.args, DEFAULT_GLM_ASR_CONFIG.args),
    env: stringRecord(raw.env),
    cwd,
    modelId,
    timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_GLM_ASR_CONFIG.timeoutMs),
    maxConcurrent: positiveInteger(raw.maxConcurrent, DEFAULT_GLM_ASR_CONFIG.maxConcurrent),
    maxQueueSize: positiveInteger(raw.maxQueueSize, DEFAULT_GLM_ASR_CONFIG.maxQueueSize),
    maxAudioBytes: positiveInteger(raw.maxAudioBytes, DEFAULT_GLM_ASR_CONFIG.maxAudioBytes),
    maxOutputBytes: positiveInteger(raw.maxOutputBytes, DEFAULT_GLM_ASR_CONFIG.maxOutputBytes),
    resultFormat,
    startupTimeoutMs: positiveInteger(raw.startupTimeoutMs, DEFAULT_GLM_ASR_CONFIG.startupTimeoutMs),
    restartBackoffMs: positiveInteger(raw.restartBackoffMs, DEFAULT_GLM_ASR_CONFIG.restartBackoffMs),
  };
}
