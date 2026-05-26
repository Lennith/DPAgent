import express, { Request, Response } from 'express';
import * as fs from 'node:fs/promises';
import {
  LocalProcessAsrService,
  normalizeAsrConfig,
  type AsrLifecycleStatus,
  type AsrRuntimeConfig,
  type AsrService,
} from '../../asr/index.js';
import {
  toSessionContext,
  type WebServerRouteRegistrationDependencies,
} from './web-server-route-contracts.js';
import { rejectObserveOnlyIfNeeded, rejectShareOnlyIfNeeded } from './web-server-route-guards.js';
import { extensionFromAudioMime, mapAsrHttpError, writeTempAudioFile } from './web-server-asr-utils.js';

interface AsrRouteOptions {
  createService?: (config: AsrRuntimeConfig) => AsrService;
}

interface AsrStatusPayloadInput {
  configured: boolean;
  ready: boolean;
  state: AsrLifecycleStatus['state'];
  provider: string;
  modelId: string;
  maxAudioBytes: number;
  secureContextRequired: boolean;
  error?: AsrLifecycleStatus['error'];
}

function buildAsrStatusPayload(input: AsrStatusPayloadInput) {
  return {
    configured: input.configured,
    enabled: input.ready,
    ready: input.ready,
    state: input.state,
    provider: input.provider,
    modelId: input.modelId,
    maxAudioBytes: input.maxAudioBytes,
    secureContextRequired: input.secureContextRequired,
    ...(input.error ? { error: input.error } : {}),
    ...(input.configured ? {} : { unavailableReason: 'disabled' as const }),
  };
}

function buildAsrStatus(config: AsrRuntimeConfig) {
  return buildAsrStatusPayload({
    configured: config.enabled,
    ready: false,
    state: config.enabled ? 'stopped' : 'unconfigured',
    provider: config.provider,
    modelId: config.modelId,
    maxAudioBytes: config.maxAudioBytes,
    secureContextRequired: true,
  });
}

function buildManagedAsrStatus(status: AsrLifecycleStatus) {
  return buildAsrStatusPayload({
    configured: status.configured,
    ready: status.ready,
    state: status.state,
    provider: status.provider,
    modelId: status.modelId,
    maxAudioBytes: status.maxAudioBytes,
    secureContextRequired: status.secureContextRequired,
    error: status.error,
  });
}

export function registerAsrRoutes(
  deps: WebServerRouteRegistrationDependencies,
  options: AsrRouteOptions = {}
): void {
  let cachedServiceKey = '';
  let cachedService: AsrService | null = null;
  const createService = options.createService ?? ((config) => new LocalProcessAsrService(config));

  const getRuntimeConfig = (): AsrRuntimeConfig => normalizeAsrConfig(deps.agent.getConfig().asr);
  const getService = (config: AsrRuntimeConfig): AsrService => {
    const key = JSON.stringify(config);
    if (!cachedService || cachedServiceKey !== key) {
      cachedService = createService(config);
      cachedServiceKey = key;
    }
    return cachedService;
  };

  deps.app.get('/api/asr/status', (_req: Request, res: Response) => {
    const managedStatus = deps.asrServices?.getStatus();
    res.json(managedStatus ? buildManagedAsrStatus(managedStatus) : buildAsrStatus(getRuntimeConfig()));
  });

  deps.app.post(
    '/api/sessions/:id/asr/transcribe',
    express.raw({
      type: ['audio/*', 'application/octet-stream'],
      limit: `${Math.max(getRuntimeConfig().maxAudioBytes, 64 * 1024 * 1024)}b`,
    }),
    async (req: Request, res: Response) => {
      const context = toSessionContext(req.params.id);
      if (rejectShareOnlyIfNeeded(deps, req, res)) {
        return;
      }
      if (rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      const config = getRuntimeConfig();
      if (!config.enabled) {
        res.status(503).json({ error: 'ASR is disabled.', code: 'ASR_DISABLED' });
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) {
        res.status(400).json({ error: 'Audio body is required.', code: 'AUDIO_EMPTY' });
        return;
      }
      if (body.length > config.maxAudioBytes) {
        res.status(413).json({
          error: `Audio body is ${body.length} bytes, exceeding limit ${config.maxAudioBytes}.`,
          code: 'AUDIO_TOO_LARGE',
        });
        return;
      }
      const mimeType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
      let tempDir: string | null = null;
      try {
        const temp = await writeTempAudioFile({
          runtimeDataDir: deps.agent.getConfig().agent.runtimeDataDir,
          bucket: 'asr',
          ownerId: req.params.id,
          fileStem: 'audio',
          body,
          extension: extensionFromAudioMime(mimeType),
        });
        tempDir = temp.tempDir;
        const result = await (deps.asrServices ?? { transcribe: (input) => getService(config).transcribe(input) }).transcribe({
          audioPath: temp.audioPath,
          mimeType,
          language: String(req.query.language ?? '').trim() || undefined,
          requestId: String(req.headers['x-request-id'] ?? '').trim() || undefined,
        });
        res.json({ success: true, result });
      } catch (error) {
        const mapped = mapAsrHttpError(error);
        res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
      } finally {
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  );
}
