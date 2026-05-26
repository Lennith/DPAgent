import * as path from 'node:path';
import { JsonStateStore, nowIso } from '../storage/index.js';

interface ContextUsageCalibrationSample {
  observedAt: string;
  weightedTokens: number;
  promptTokens: number;
  ratio: number;
}

interface ContextUsageCalibrationEntry {
  key: string;
  adapterProvider: string;
  apiBaseHost: string;
  model: string;
  samples: ContextUsageCalibrationSample[];
  updatedAt: string;
}

interface ContextUsageCalibrationState {
  version: 1;
  entries: Record<string, ContextUsageCalibrationEntry>;
}

const MAX_SAMPLES = 20;

function isCalibrationSample(value: unknown): value is ContextUsageCalibrationSample {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.observedAt === 'string' &&
    typeof sample.weightedTokens === 'number' &&
    Number.isFinite(sample.weightedTokens) &&
    sample.weightedTokens > 0 &&
    typeof sample.promptTokens === 'number' &&
    Number.isFinite(sample.promptTokens) &&
    sample.promptTokens > 0 &&
    typeof sample.ratio === 'number' &&
    Number.isFinite(sample.ratio) &&
    sample.ratio > 0
  );
}

function isCalibrationEntry(value: unknown): value is ContextUsageCalibrationEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === 'string' &&
    typeof entry.adapterProvider === 'string' &&
    typeof entry.apiBaseHost === 'string' &&
    typeof entry.model === 'string' &&
    typeof entry.updatedAt === 'string' &&
    Array.isArray(entry.samples) &&
    entry.samples.every(isCalibrationSample)
  );
}

function isCalibrationState(value: unknown): value is ContextUsageCalibrationState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !state.entries || typeof state.entries !== 'object') {
    return false;
  }
  return Object.values(state.entries as Record<string, unknown>).every(isCalibrationEntry);
}

function normalizeApiBaseHost(apiBase: string): string {
  try {
    const parsed = new URL(apiBase);
    return parsed.host.toLowerCase();
  } catch {
    return String(apiBase).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
}

function buildEntryKey(input: {
  adapterProvider: string;
  apiBase: string;
  model: string;
}): string {
  return [
    input.adapterProvider.trim().toLowerCase(),
    normalizeApiBaseHost(input.apiBase),
    input.model.trim().toLowerCase(),
  ].join('::');
}

function percentile90(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.9) - 1));
  return sorted[index] ?? 1;
}

export class ContextUsageCalibrationStore {
  private readonly store: JsonStateStore<ContextUsageCalibrationState>;

  constructor(runtimeDataDir: string) {
    this.store = new JsonStateStore<ContextUsageCalibrationState>(
      path.join(runtimeDataDir, 'context-usage-calibration', 'state.json'),
      {
        defaultValue: () => ({ version: 1, entries: {} }),
        validate: isCalibrationState,
        parseErrorPolicy: 'reset',
      }
    );
  }

  getMultiplier(input: {
    adapterProvider: string;
    apiBase: string;
    model: string;
  }): number {
    const key = buildEntryKey(input);
    const entry = this.store.read().entries[key];
    if (!entry || entry.samples.length === 0) {
      return 1;
    }
    const ratios = entry.samples
      .map((sample) => sample.ratio)
      .filter((ratio) => Number.isFinite(ratio) && ratio > 0);
    if (ratios.length === 0) {
      return 1;
    }
    const rawMultiplier = ratios.length < 5 ? Math.max(...ratios) : percentile90(ratios);
    return Math.max(1, rawMultiplier);
  }

  recordObservation(input: {
    adapterProvider: string;
    apiBase: string;
    model: string;
    weightedTokens: number;
    promptTokens: number;
  }): number {
    const weightedTokens = Math.max(1, Math.ceil(input.weightedTokens));
    const promptTokens = Math.max(1, Math.ceil(input.promptTokens));
    const ratio = promptTokens / weightedTokens;
    const key = buildEntryKey(input);
    this.store.update((current) => {
      const next = {
        ...current,
        entries: { ...current.entries },
      };
      const previous = next.entries[key];
      const sample: ContextUsageCalibrationSample = {
        observedAt: nowIso(),
        weightedTokens,
        promptTokens,
        ratio,
      };
      next.entries[key] = {
        key,
        adapterProvider: input.adapterProvider.trim().toLowerCase(),
        apiBaseHost: normalizeApiBaseHost(input.apiBase),
        model: input.model.trim(),
        samples: [...(previous?.samples ?? []), sample].slice(-MAX_SAMPLES),
        updatedAt: sample.observedAt,
      };
      return next;
    });
    return this.getMultiplier(input);
  }
}
