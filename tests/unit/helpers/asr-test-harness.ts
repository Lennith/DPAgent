import type { AsrLifecycleStatus } from '../../../src/asr/index.js';

export const TEST_ASR_MODEL_ID = 'zai-org/GLM-ASR-Nano-2512';
export const TEST_ASR_MAX_AUDIO_BYTES = 1024;

export function createTestAsrLifecycleStatus(input: {
  configured?: boolean;
  ready?: boolean;
  maxAudioBytes?: number;
  modelId?: string;
} = {}): AsrLifecycleStatus {
  const configured = input.configured ?? true;
  const ready = input.ready ?? configured;
  return {
    configured,
    enabled: ready,
    ready,
    state: configured ? (ready ? 'ready' : 'starting') : 'unconfigured',
    provider: 'local-process',
    modelId: input.modelId ?? TEST_ASR_MODEL_ID,
    maxAudioBytes: input.maxAudioBytes ?? TEST_ASR_MAX_AUDIO_BYTES,
    secureContextRequired: true,
  };
}
