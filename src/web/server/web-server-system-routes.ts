import { Request, Response } from 'express';
import { WebSocket } from 'ws';
import {
  createManualLlmIntrospection,
} from '../../llm/provider-profiles.js';
import type { LlmProfileIntrospection } from '../../types.js';
import { webServerLogger } from '../../utils/logger.js';
import {
  ConfigMutationService,
  buildPublicSettingsView,
} from './config-mutation-service.js';
import type {
  LlmProfileMutationView,
  SettingsMutationRequest,
} from '../../shared/web-settings-contracts.js';
import {
  buildSettingsUpdates,
  findLlmProfile,
  resolveDiscoveryProfileDraft,
  RouteValidationError,
} from './web-server-settings-route-utils.js';
import {
  type WebServerRouteRegistrationDependencies,
} from './web-server-route-contracts.js';
import { rejectShareOnlyIfNeeded } from './web-server-route-guards.js';

function readHeaderValue(req: Request, name: string): string {
  const value = req.headers?.[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] : value ?? '').trim();
}

function hasShutdownConfirmation(req: Request): boolean {
  return readHeaderValue(req, 'x-dpagent-shutdown-confirm').toLowerCase() === 'yes';
}

export function registerSystemRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { configServices, agentCatalogServices } = deps;
  const configMutationService = new ConfigMutationService(deps.agent, configServices);

  deps.app.get('/api/health', (_req: Request, res: Response) => {
    const wsConnections = Array.from(deps.wss.clients).map((ws) => ({
      readyState: ws.readyState,
      url: ws.url,
      protocol: ws.protocol,
    }));
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      websocket: {
        totalClients: deps.wss.clients.size,
        openConnections: wsConnections.filter((c) => c.readyState === WebSocket.OPEN).length,
        connections: wsConnections,
      },
      memory: process.memoryUsage(),
      hasApiKey: configServices.hasUsableApiKey(),
      diagnostics: deps.systemServices?.getRuntimeDiagnostics?.() ?? null,
    });
  });

  deps.app.get('/api/system/runtime-info', (req: Request, res: Response) => {
    if (rejectShareOnlyIfNeeded(deps, req, res)) {
      return;
    }
    if (!deps.systemServices) {
      res.status(503).json({ error: 'Runtime info service is unavailable', code: 'RUNTIME_INFO_UNAVAILABLE' });
      return;
    }
    res.json(deps.systemServices.getRuntimeInfo());
  });

  deps.app.post('/api/system/shutdown', (req: Request, res: Response) => {
    if (rejectShareOnlyIfNeeded(deps, req, res)) {
      return;
    }
    if (!deps.systemServices) {
      res.status(503).json({ error: 'Shutdown service is unavailable', code: 'SHUTDOWN_UNAVAILABLE' });
      return;
    }
    if (!hasShutdownConfirmation(req)) {
      res.status(403).json({
        success: false,
        error: 'Shutdown confirmation header is required.',
        code: 'SHUTDOWN_CONFIRMATION_REQUIRED',
      });
      return;
    }
    const rawDelayMs = Number((req.body as { delayMs?: unknown } | undefined)?.delayMs ?? 250);
    const delayMs = Number.isFinite(rawDelayMs)
      ? Math.max(0, Math.min(60000, Math.floor(rawDelayMs)))
      : 250;
    const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim().length > 0
      ? rawReason.trim().slice(0, 200)
      : undefined;
    deps.systemServices.requestShutdown({ delayMs, reason });
    res.status(202).json({
      success: true,
      delayMs,
      ...(reason ? { reason } : {}),
    });
  });

  deps.app.get('/api/mcp/status', (_req: Request, res: Response) => {
    try {
      res.json(deps.agent.getMcpStatus());
    } catch (error) {
      webServerLogger.warn(`Failed to load MCP status: ${String(error)}`);
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
        code: 'MCP_STATUS_UNAVAILABLE',
      });
    }
  });

  deps.app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(buildPublicSettingsView(deps.agent.getConfig(), configServices.hasUsableApiKey()));
  });

  deps.app.put('/api/settings', async (req: Request, res: Response) => {
    try {
      const currentConfig = deps.agent.getConfig();
      const mutation = buildSettingsUpdates(
        currentConfig,
        req.body as SettingsMutationRequest,
        deps
      );

      await configMutationService.apply({
        updates: mutation.updates,
        afterPersist: () => {
          if (mutation.clearsBootMissingApiKey) configServices.setBootMissingApiKey(false);
          if (mutation.reloadSkills) deps.agent.reloadSkills();
          if (mutation.refreshGlobalAgentCatalog) agentCatalogServices.refreshGlobalAgentCatalog();
        },
      });

      res.json({
        success: true,
        ...buildPublicSettingsView(deps.agent.getConfig(), configServices.hasUsableApiKey()),
      });
    } catch (error) {
      const status = error instanceof RouteValidationError ? error.status : 500;
      res.status(status).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  deps.app.post('/api/llm-profiles/:id/discover-models', async (req: Request, res: Response) => {
    const config = deps.agent.getConfig();
    const persistedProfile = findLlmProfile(config, req.params.id);
    const body = (req.body ?? {}) as {
      profile?: LlmProfileMutationView;
    } & LlmProfileMutationView;
    const draftProfile =
      body.profile && typeof body.profile === 'object' ? body.profile : body;
    const profile = resolveDiscoveryProfileDraft(
      req.params.id,
      persistedProfile,
      draftProfile
    );
    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    try {
      if (profile.capabilities?.modelDiscovery === false) {
        res.json(
          createManualLlmIntrospection(
            profile,
            'Model discovery is disabled for this profile. Manual model entry remains available.'
          )
        );
        return;
      }
      const introspection: LlmProfileIntrospection = await deps.llmServices.discoverProfileModels(profile);
      res.json(introspection);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
