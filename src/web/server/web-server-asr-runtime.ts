import {
  AsrError,
  PersistentLocalProcessAsrService,
  normalizeAsrConfig,
  type AsrLifecycleStatus,
  type AsrRuntimeConfig,
  type AsrTranscriptionInput,
  type AsrTranscriptionResult,
  type ManagedAsrService,
} from '../../asr/index.js';
import type { AgentConfig } from '../../types.js';

export interface WebServerAsrRuntimeOptions {
  getConfig: () => AgentConfig;
  createService?: (config: AsrRuntimeConfig) => ManagedAsrService;
}

export class WebServerAsrRuntime {
  private readonly getConfig: () => AgentConfig;
  private readonly createService: (config: AsrRuntimeConfig) => ManagedAsrService;
  private service: ManagedAsrService | null = null;
  private serviceKey = '';

  constructor(options: WebServerAsrRuntimeOptions) {
    this.getConfig = options.getConfig;
    this.createService = options.createService ?? ((config) => new PersistentLocalProcessAsrService(config));
  }

  getStatus(): AsrLifecycleStatus {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      return this.buildUnconfiguredStatus(config);
    }
    return this.getService(config).getStatus();
  }

  async start(): Promise<void> {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      return;
    }
    await this.getService(config).start();
  }

  async refresh(): Promise<void> {
    const existing = this.service;
    this.service = null;
    this.serviceKey = '';
    if (existing) {
      await existing.stop();
    }
    await this.start();
  }

  async stop(): Promise<void> {
    const existing = this.service;
    this.service = null;
    this.serviceKey = '';
    if (existing) {
      await existing.stop();
    }
  }

  async transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResult> {
    const status = this.getStatus();
    if (!status.ready) {
      throw new AsrError('ASR_NOT_READY', 'ASR worker is not ready.');
    }
    return await this.getService(this.getRuntimeConfig()).transcribe(input);
  }

  private getRuntimeConfig(): AsrRuntimeConfig {
    return normalizeAsrConfig(this.getConfig().asr);
  }

  private getService(config: AsrRuntimeConfig): ManagedAsrService {
    const key = JSON.stringify(config);
    if (!this.service || this.serviceKey !== key) {
      void this.service?.stop();
      this.service = this.createService(config);
      this.serviceKey = key;
    }
    return this.service;
  }

  private buildUnconfiguredStatus(config: AsrRuntimeConfig): AsrLifecycleStatus {
    return {
      configured: false,
      enabled: false,
      ready: false,
      state: 'unconfigured',
      provider: config.provider,
      modelId: config.modelId,
      maxAudioBytes: config.maxAudioBytes,
      secureContextRequired: true,
    };
  }
}
