import express, { Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import path from 'path';
import * as fs from 'fs';
import { autoLoopManager, type AutoLoopConfig } from '../../auto-loop/index.js';
import { resolveAgentPool, type AgentProfile } from '../../agents/index.js';
import type { MiniMaxAgent } from '../../index.js';
import type { AutomationRoutes } from '../../automation/index.js';
import {
  applySessionLlmSelectionInput,
  createManualLlmIntrospection,
  normalizeLlmProfilesConfig,
  resolveSessionLlmSelection,
} from '../../llm/provider-profiles.js';
import type { TodoPriority, TodoProtocolState, TodoScope, TodoStatus } from '../../todo/index.js';
import type {
  AgentConfig,
  ContextNamespaceMeta,
  ContextRef,
  LlmProfileIntrospection,
  LlmProviderProfileConfig,
  MCPStatusResponse,
  SessionLlmSelectionInput,
} from '../../types.js';
import { webServerLogger } from '../../utils/logger.js';
import { toInterruptedArtifactView } from './interrupted-artifact-view.js';

interface WebServerRouteRegistrationDependencies {
  app: express.Express;
  wss: WebSocketServer;
  agent: MiniMaxAgent;
  automationRoutes: AutomationRoutes;
  configServices: {
    hasUsableApiKey: () => boolean;
    persistConfigFile: (nextConfig: AgentConfig) => void;
    setBootMissingApiKey: (value: boolean) => void;
    refreshConfigDependentRuntimes: () => Promise<void>;
  };
  agentCatalogServices: {
    refreshGlobalAgentCatalog: () => void;
    getGlobalAgentProfiles: () => AgentProfile[];
  };
  llmServices: {
    discoverProfileModels: (profile: LlmProviderProfileConfig) => Promise<LlmProfileIntrospection>;
  };
  contextServices: {
    getContextNamespaceMetaSafe: (context: ContextRef) => ContextNamespaceMeta | undefined;
    getPendingPlanInputView: (
      context: ContextRef,
      meta: ContextNamespaceMeta | null | undefined
    ) => ContextNamespaceMeta['pendingPlanInput'] | null;
    getActiveRunState: (context: ContextRef) => {
      runId: string;
      runFamilyId?: string;
      draftId?: string;
      context: ContextRef;
      startedAt: string;
      llmRuntime?: {
        profileId: string;
        provider: 'anthropic' | 'openai';
        model: string;
        reasoningPreset: 'off' | 'low' | 'medium' | 'high';
      };
    } | null;
    isPendingResume: (context: ContextRef) => boolean;
    getInterruptedArtifact: (context: ContextRef) => ReturnType<typeof toInterruptedArtifactView>;
    updateContextNamespaceMetaSafe: (
      context: ContextRef,
      patch: Partial<ContextNamespaceMeta>
    ) => void;
    resolveWorkspaceDirForContext: (context: ContextRef) => string;
    resolveAgentForContext: (context: ContextRef) => MiniMaxAgent;
    cleanupSessionRuntime: (sessionId: string) => Promise<void>;
  };
  todoServices: {
    ensureTodoDrivenAutoLoop: (sessionId: string, workspaceDir?: string) => void;
    getSessionTodoProtocolState: (sessionId: string, workspaceDir?: string) => TodoProtocolState;
  };
}

function cloneAgentConfig<T>(config: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(config)
    : (JSON.parse(JSON.stringify(config)) as T);
}

function toSessionContext(sessionId: string): ContextRef {
  return { scope: 'session', namespace: sessionId };
}

function normalizeTodoScope(value: unknown, fallback: TodoScope): TodoScope {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'session' || normalized === 'workspace' || normalized === 'user') {
    return normalized;
  }
  return fallback;
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'pending' ||
    normalized === 'in_progress' ||
    normalized === 'blocked' ||
    normalized === 'completed'
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeTodoPriority(value: unknown): TodoPriority | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return undefined;
}

function normalizeTodoTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [];
}

function listUnexpectedTodoKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): string[] {
  return Object.keys(record).filter((key) => !allowedKeys.has(key));
}

type PublicLlmProfile = Omit<LlmProviderProfileConfig, 'apiKey'> & {
  hasApiKey: boolean;
};

function serializeLlmProfile(profile: LlmProviderProfileConfig): PublicLlmProfile {
  const { apiKey, ...rest } = profile;
  return {
    ...rest,
    hasApiKey: String(apiKey ?? '').trim().length > 0,
  };
}

function serializeLlmProfiles(config: AgentConfig): {
  defaultProfileId: string;
  profiles: PublicLlmProfile[];
} {
  const llmProfiles = normalizeLlmProfilesConfig(config);
  return {
    defaultProfileId: llmProfiles.defaultProfileId,
    profiles: llmProfiles.profiles.map((profile) => serializeLlmProfile(profile)),
  };
}

function findLlmProfile(config: AgentConfig, profileId: string): LlmProviderProfileConfig | undefined {
  const trimmedId = String(profileId ?? '').trim();
  if (!trimmedId) {
    return undefined;
  }
  return normalizeLlmProfilesConfig(config).profiles.find((profile) => profile.id === trimmedId);
}

function resolveDiscoveryProfileDraft(
  config: AgentConfig,
  profileId: string,
  persistedProfile: LlmProviderProfileConfig | undefined,
  draft: Partial<LlmProviderProfileConfig> | undefined
): LlmProviderProfileConfig | undefined {
  if (!persistedProfile && !draft) {
    return undefined;
  }

  const provider =
    draft?.provider === 'openai' || draft?.provider === 'anthropic'
      ? draft.provider
      : persistedProfile?.provider ?? config.api.provider;
  const id = String(draft?.id ?? profileId ?? persistedProfile?.id ?? '').trim();
  const now = new Date().toISOString();

  return {
    id,
    name: String(draft?.name ?? persistedProfile?.name ?? id).trim() || id,
    provider,
    apiKey: String(draft?.apiKey ?? persistedProfile?.apiKey ?? '').trim(),
    apiBase:
      String(draft?.apiBase ?? persistedProfile?.apiBase ?? '').trim() ||
      config.api.apiBase,
    defaultModel:
      String(draft?.defaultModel ?? persistedProfile?.defaultModel ?? '').trim() ||
      config.api.model,
    maxOutputTokens:
      typeof draft?.maxOutputTokens === 'number'
        ? draft.maxOutputTokens
        : persistedProfile?.maxOutputTokens ?? config.api.maxOutputTokens,
    enabled: draft?.enabled ?? persistedProfile?.enabled ?? true,
    capabilities: draft?.capabilities ?? persistedProfile?.capabilities,
    createdAt: persistedProfile?.createdAt ?? now,
    updatedAt: draft?.updatedAt ?? persistedProfile?.updatedAt ?? now,
  };
}

function isReasoningPresetValue(value: unknown): boolean {
  return value === 'off' || value === 'low' || value === 'medium' || value === 'high';
}

function resolveStaticClientPath(): string | null {
  const packagedClientPath = path.resolve(__dirname, '../client');
  const workspaceClientPath = path.join(process.cwd(), 'dist/web/client');

  const isLikelySourceClientPath = (candidate: string): boolean => {
    const indexPath = path.join(candidate, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return false;
    }
    const html = fs.readFileSync(indexPath, 'utf8');
    return html.includes('main.tsx') || fs.existsSync(path.join(candidate, 'main.tsx'));
  };

  const isRunnableStaticClientPath = (candidate: string): boolean => {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      return false;
    }
    const indexPath = path.join(candidate, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return false;
    }
    return !isLikelySourceClientPath(candidate);
  };

  if (isRunnableStaticClientPath(packagedClientPath)) {
    return packagedClientPath;
  }
  if (isRunnableStaticClientPath(workspaceClientPath)) {
    return workspaceClientPath;
  }
  return null;
}

function registerStaticClient(deps: WebServerRouteRegistrationDependencies): string | null {
  const clientPath = resolveStaticClientPath();
  if (!clientPath) {
    webServerLogger.info('Static files not found, running in API-only mode (dev mode)');
    return null;
  }

  webServerLogger.info(`Serving static client from: ${clientPath}`);

  const mimeOverride: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.map': 'application/json',
  };

  const serveStaticWithMimeFix = express.static(clientPath, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = mimeOverride[ext];
      if (mimeType) {
        res.setHeader('Content-Type', mimeType);
      }
    },
  });

  deps.app.use(serveStaticWithMimeFix);
  return clientPath;
}

function registerSystemRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { configServices, agentCatalogServices } = deps;

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
    });
  });

  deps.app.get('/api/mcp/status', (_req: Request, res: Response) => {
    try {
      res.json(deps.agent.getMcpStatus());
    } catch (error) {
      const fallback: MCPStatusResponse = {
        enabled: false,
        summary: {
          state: 'disabled',
          connectedCount: 0,
          totalEnabled: 0,
        },
        servers: [],
      };
      webServerLogger.warn(`Failed to load MCP status: ${String(error)}`);
      res.status(500).json(fallback);
    }
  });

  deps.app.get('/api/config', (_req: Request, res: Response) => {
    const currentConfig = deps.agent.getConfig();
    const apiConfig = currentConfig.api;
    const agentConfig = currentConfig.agent;
    res.json({
      apiBase: apiConfig.apiBase,
      model: apiConfig.model,
      provider: apiConfig.provider,
      hasApiKey: configServices.hasUsableApiKey(),
      api: {
        apiBase: apiConfig.apiBase,
        model: apiConfig.model,
        provider: apiConfig.provider,
      },
      llmProfiles: serializeLlmProfiles(currentConfig),
      agent: {
        maxSteps: agentConfig.maxSteps,
        tokenLimit: agentConfig.tokenLimit,
        contextWindowChars: agentConfig.contextWindowChars,
        workspaceDir: agentConfig.workspaceDir,
        runtimeDataDir: agentConfig.runtimeDataDir,
        completionMarkerEnforcementEnabled:
          agentConfig.completionMarkerEnforcementEnabled === true,
        globalAgentsDir: agentConfig.globalAgentsDir || '',
        defaultToolset: agentConfig.defaultToolset || 'windows-dev',
        skillWriteMode: agentConfig.skillWriteMode || 'confirm',
      },
    });
  });

  deps.app.post('/api/config', async (req: Request, res: Response) => {
    try {
      const {
        apiBase,
        model,
        provider,
        skillsDir,
        globalAgentsDir,
        defaultToolset,
        skillWriteMode,
        completionMarkerEnforcementEnabled,
        maxSteps,
      } =
        req.body as {
          apiBase?: string;
          model?: string;
          provider?: string;
          skillsDir?: string;
          globalAgentsDir?: string;
          defaultToolset?: string;
          skillWriteMode?: 'confirm' | 'auto';
          completionMarkerEnforcementEnabled?: boolean;
          maxSteps?: number;
        };

      const currentConfig = deps.agent.getConfig();
      const nextApi = { ...currentConfig.api };
      const nextAgent = { ...currentConfig.agent };

      if (apiBase) {
        nextApi.apiBase = apiBase;
      }
      if (model) {
        nextApi.model = model;
      }
      if (provider !== undefined) {
        if (provider !== 'anthropic' && provider !== 'openai') {
          res.status(400).json({
            success: false,
            error: 'Invalid provider. Expected anthropic or openai.',
          });
          return;
        }
        nextApi.provider = provider;
      }
      if (skillsDir !== undefined) {
        nextAgent.skillsDir = skillsDir;
      }
      if (globalAgentsDir !== undefined) {
        nextAgent.globalAgentsDir = globalAgentsDir;
      }
      if (defaultToolset !== undefined) {
        const resolved = deps.agent.getToolsetRegistry().get(defaultToolset).name;
        nextAgent.defaultToolset = resolved;
      }
      if (skillWriteMode !== undefined) {
        nextAgent.skillWriteMode = skillWriteMode;
      }
      if (completionMarkerEnforcementEnabled !== undefined) {
        nextAgent.completionMarkerEnforcementEnabled = completionMarkerEnforcementEnabled === true;
      }
      if (maxSteps !== undefined) {
        const normalizedMaxSteps = Math.max(1, Math.floor(Number(maxSteps)));
        if (!Number.isFinite(normalizedMaxSteps)) {
          res.status(400).json({ success: false, error: 'Invalid maxSteps.' });
          return;
        }
        nextAgent.maxSteps = normalizedMaxSteps;
      }

      const previousConfig = cloneAgentConfig(currentConfig);
      deps.agent.updateConfig({ api: nextApi, agent: nextAgent });
      try {
        await configServices.refreshConfigDependentRuntimes();
        configServices.persistConfigFile(deps.agent.getConfig());
        if (skillsDir !== undefined) {
          deps.agent.reloadSkills();
        }
        if (globalAgentsDir !== undefined) {
          agentCatalogServices.refreshGlobalAgentCatalog();
        }
      } catch (error) {
        deps.agent.updateConfig({
          api: previousConfig.api,
          llmProfiles: previousConfig.llmProfiles,
          agent: previousConfig.agent,
        });
        try {
          configServices.persistConfigFile(previousConfig);
        } catch {
          // Keep the request failure focused on the original refresh/persist error.
        }
        throw error;
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  deps.app.get('/api/settings', (_req: Request, res: Response) => {
    const config = deps.agent.getConfig();
    res.json({
      api: {
        apiBase: config.api.apiBase,
        model: config.api.model,
        provider: config.api.provider,
        hasApiKey: configServices.hasUsableApiKey(),
      },
      llmProfiles: serializeLlmProfiles(config),
      agent: {
        skillsDir: config.agent.skillsDir || '',
        globalAgentsDir: config.agent.globalAgentsDir || '',
        maxSteps: config.agent.maxSteps,
        completionMarkerEnforcementEnabled:
          config.agent.completionMarkerEnforcementEnabled === true,
        defaultToolset: config.agent.defaultToolset || 'windows-dev',
        skillWriteMode: config.agent.skillWriteMode || 'confirm',
      },
    });
  });

  deps.app.get('/api/llm-profiles', (_req: Request, res: Response) => {
    const config = deps.agent.getConfig();
    res.json({
      ...serializeLlmProfiles(config),
      legacyApiMirror: {
        apiBase: config.api.apiBase,
        model: config.api.model,
        provider: config.api.provider,
        hasApiKey: configServices.hasUsableApiKey(),
      },
    });
  });

  deps.app.put('/api/llm-profiles', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        defaultProfileId?: string;
        profiles?: Array<Partial<LlmProviderProfileConfig> & { apiKey?: string; clearApiKey?: boolean }>;
      };
      if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
        res.status(400).json({ success: false, error: 'profiles must be a non-empty array' });
        return;
      }

      const currentConfig = deps.agent.getConfig();
      const currentProfiles = normalizeLlmProfilesConfig(currentConfig);
      const currentById = new Map(currentProfiles.profiles.map((profile) => [profile.id, profile]));
      const seenProfileIds = new Set<string>();
      const nextProfiles = body.profiles.map((incoming, index) => {
        const id = String(incoming.id ?? '').trim();
        if (!id) {
          throw new Error(`Profile at index ${index} is missing an id`);
        }
        if (seenProfileIds.has(id)) {
          throw new Error(`Duplicate profile id: ${id}`);
        }
        seenProfileIds.add(id);
        if (
          incoming.provider !== undefined &&
          incoming.provider !== 'anthropic' &&
          incoming.provider !== 'openai'
        ) {
          throw new Error(`Profile ${id} has invalid provider: ${String(incoming.provider)}`);
        }

        const existing = currentById.get(id);
        const providedApiKey =
          typeof incoming.apiKey === 'string' && incoming.apiKey.trim().length > 0
            ? incoming.apiKey.trim()
            : undefined;

        return {
          id,
          name: String(incoming.name ?? existing?.name ?? '').trim() || existing?.name || id,
          provider:
            incoming.provider === 'anthropic' || incoming.provider === 'openai'
              ? incoming.provider
              : existing?.provider ?? currentConfig.api.provider,
          apiKey:
            incoming.clearApiKey === true
              ? ''
              : providedApiKey ?? existing?.apiKey ?? '',
          apiBase:
            String(incoming.apiBase ?? existing?.apiBase ?? '').trim() ||
            existing?.apiBase ||
            currentConfig.api.apiBase,
          defaultModel:
            String(incoming.defaultModel ?? existing?.defaultModel ?? '').trim() ||
            existing?.defaultModel ||
            currentConfig.api.model,
          maxOutputTokens:
            typeof incoming.maxOutputTokens === 'number'
              ? incoming.maxOutputTokens
              : existing?.maxOutputTokens ?? currentConfig.api.maxOutputTokens,
          enabled: incoming.enabled ?? existing?.enabled ?? true,
          capabilities: incoming.capabilities ?? existing?.capabilities,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies LlmProviderProfileConfig;
      });

      const requestedDefaultProfileId = String(body.defaultProfileId ?? '').trim() || currentProfiles.defaultProfileId;
      if (!nextProfiles.some((profile) => profile.id === requestedDefaultProfileId)) {
        res.status(400).json({
          success: false,
          error: `defaultProfileId must reference one of the submitted profiles: ${requestedDefaultProfileId}`,
        });
        return;
      }

      const nextLlmProfiles = normalizeLlmProfilesConfig({
        api: currentConfig.api,
        llmProfiles: {
          defaultProfileId: requestedDefaultProfileId,
          profiles: nextProfiles,
        },
      });

      const previousConfig = cloneAgentConfig(currentConfig);
      deps.agent.updateConfig({
        llmProfiles: nextLlmProfiles,
      });
      try {
        await configServices.refreshConfigDependentRuntimes();
        configServices.persistConfigFile(deps.agent.getConfig());
      } catch (error) {
        deps.agent.updateConfig({
          api: previousConfig.api,
          llmProfiles: previousConfig.llmProfiles,
          agent: previousConfig.agent,
        });
        try {
          configServices.persistConfigFile(previousConfig);
        } catch {
          // Keep the request failure focused on the original refresh/persist error.
        }
        throw error;
      }

      res.json({
        success: true,
        ...serializeLlmProfiles(deps.agent.getConfig()),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  deps.app.post('/api/llm-profiles/:id/discover-models', async (req: Request, res: Response) => {
    const config = deps.agent.getConfig();
    const persistedProfile = findLlmProfile(config, req.params.id);
    const body = (req.body ?? {}) as {
      profile?: Partial<LlmProviderProfileConfig>;
    } & Partial<LlmProviderProfileConfig>;
    const draftProfile =
      body.profile && typeof body.profile === 'object' ? body.profile : body;
    const profile = resolveDiscoveryProfileDraft(
      config,
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
      const introspection = await deps.llmServices.discoverProfileModels(profile);
      res.json(introspection);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  deps.app.post('/api/settings/apikey', async (req: Request, res: Response) => {
    const { apiKey } = req.body as { apiKey: string };
    if (!apiKey || apiKey.length < 20) {
      res.status(400).json({ success: false, error: 'Invalid API Key' });
      return;
    }
    try {
      const previousConfig = cloneAgentConfig(deps.agent.getConfig());
      deps.agent.updateConfig({ api: { ...previousConfig.api, apiKey } });
      try {
        await configServices.refreshConfigDependentRuntimes();
        configServices.persistConfigFile(deps.agent.getConfig());
        configServices.setBootMissingApiKey(false);
      } catch (error) {
        deps.agent.updateConfig({
          api: previousConfig.api,
          llmProfiles: previousConfig.llmProfiles,
          agent: previousConfig.agent,
        });
        try {
          configServices.persistConfigFile(previousConfig);
        } catch {
          // Keep the request failure focused on the original refresh/persist error.
        }
        throw error;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  deps.app.post('/api/skills/reload', (_req: Request, res: Response) => {
    try {
      const config = deps.agent.getConfig();
      if (config.agent.skillsDir) {
        deps.agent.reloadSkills();
        res.json({ success: true });
        return;
      }
      res.json({ success: false, error: 'No skills directory configured' });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });
}

function registerSessionRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { contextServices } = deps;

  deps.app.get('/api/sessions', (req: Request, res: Response) => {
    try {
      const includeAutomation =
        String(req.query.includeAutomation ?? '').trim().toLowerCase() === 'true';
      const config = deps.agent.getConfig();
      const sessions = deps.agent
        .getContextManager()
        .listNamespaces('session')
        .filter((item) => includeAutomation || !item.automationRun?.jobId)
        .map((item) => ({
          id: item.namespace,
          name: item.name || item.namespace,
          workspaceDir: item.workspaceDir,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          contextVersion: item.projection.version,
          toolsetName:
            item.toolsetName ||
            deps.agent.resolveToolsetName({ scope: 'session', namespace: item.namespace }),
          memoryPromotionState: item.memoryPromotionState ?? null,
          automationRun: item.automationRun ?? null,
          completionMarkerStats: item.completionMarkerStats ?? null,
          llmSelection: resolveSessionLlmSelection(config, item.llmSelection),
        }));
      res.json({ sessions });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.get('/api/sessions/:id', (req: Request, res: Response) => {
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    const activeRun = contextServices.getActiveRunState(ref);
    const pendingResume = contextServices.isPendingResume(ref);
    const interruptedArtifact = contextServices.getInterruptedArtifact(ref);
    if (!meta && !activeRun && !pendingResume && !interruptedArtifact) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const preserveAgentProfileRefs =
      String(req.query.preserveAgentProfileRefs ?? '').trim().toLowerCase() === 'true';
    const messages = deps.agent.getContextMessages(ref, {
      preserveAgentProfileRefs,
      includeInterruptedCheckpoints: true,
    });
    const config = deps.agent.getConfig();
    res.json({
      id: req.params.id,
      name: meta?.name || req.params.id,
      workspaceDir: meta?.workspaceDir ?? contextServices.resolveWorkspaceDirForContext(ref),
      toolsetName: meta?.toolsetName || deps.agent.resolveToolsetName(ref),
      createdAt: meta?.createdAt ?? activeRun?.startedAt ?? interruptedArtifact?.createdAt,
      updatedAt: meta?.updatedAt ?? interruptedArtifact?.updatedAt ?? activeRun?.startedAt,
      memoryPromotionState: meta?.memoryPromotionState ?? null,
      automationRun: meta?.automationRun ?? null,
      completionMarkerStats: meta?.completionMarkerStats ?? null,
      llmSelection: resolveSessionLlmSelection(config, meta?.llmSelection),
      contextUtilization: meta?.latestContextUtilization ?? null,
      activeRun,
      pendingResume,
      interruptedArtifact,
      pendingPlanInput: contextServices.getPendingPlanInputView(ref, meta),
      messages,
    });
  });

  deps.app.get('/api/sessions/:id/llm-selection', (req: Request, res: Response) => {
    const ref = toSessionContext(req.params.id);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const config = deps.agent.getConfig();
    const llmSelection = resolveSessionLlmSelection(config, meta.llmSelection);
    const profile = findLlmProfile(config, llmSelection.profileId);
    res.json({
      llmSelection,
      profile: profile ? serializeLlmProfile(profile) : null,
    });
  });

  deps.app.put('/api/sessions/:id', (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    const ref = toSessionContext(req.params.id);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const nextMeta = deps.agent.updateContextNamespaceMeta(ref, {
      name: typeof name === 'string' ? name.trim() : meta.name,
    });
    res.json({ success: true, meta: nextMeta });
  });

  deps.app.patch('/api/sessions/:id/llm-selection', (req: Request, res: Response) => {
    const ref = toSessionContext(req.params.id);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    if (!meta) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const patch = req.body as SessionLlmSelectionInput;
    if (patch.reasoningPreset !== undefined && !isReasoningPresetValue(patch.reasoningPreset)) {
      res.status(400).json({ error: 'Invalid reasoningPreset' });
      return;
    }

    const config = deps.agent.getConfig();
    const currentSelection = resolveSessionLlmSelection(config, meta.llmSelection);
    const requestedUpdatedAt = typeof patch.updatedAt === 'string' ? patch.updatedAt.trim() : '';
    const requestedUpdatedAtMs = Date.parse(requestedUpdatedAt);
    if (!requestedUpdatedAt || !Number.isFinite(requestedUpdatedAtMs)) {
      res.status(400).json({ error: 'updatedAt is required and must be a valid ISO timestamp' });
      return;
    }
    if (
      patch.profileId !== undefined &&
      !findLlmProfile(config, patch.profileId)
    ) {
      res.status(400).json({ error: 'Unknown profileId' });
      return;
    }
    const currentUpdatedAtMs = Date.parse(currentSelection.updatedAt);
    if (Number.isFinite(currentUpdatedAtMs) && requestedUpdatedAtMs < currentUpdatedAtMs) {
      res.status(409).json({
        error: 'LLM selection update is stale',
        llmSelection: currentSelection,
      });
      return;
    }

    const nextSelection = applySessionLlmSelectionInput(config, meta.llmSelection, patch);

    const nextMeta = deps.agent.updateContextNamespaceMeta(ref, {
      llmSelection: nextSelection,
    });
    res.json({
      success: true,
      llmSelection: nextSelection,
      meta: nextMeta,
    });
  });

  deps.app.delete('/api/sessions/:id', async (req: Request, res: Response) => {
    try {
      await contextServices.cleanupSessionRuntime(req.params.id);
      const success = deps.agent.deleteSessionContext(req.params.id);
      res.json({ success });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  deps.automationRoutes.register(deps.app);
}

function registerSubagentAndToolsetRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { agentCatalogServices, contextServices } = deps;

  deps.app.get('/api/sessions/:id/subagents', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      const items = contextServices.resolveAgentForContext(context).getSubAgentManager().list(context);
      res.json({ items });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/cancel', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      const status = contextServices
        .resolveAgentForContext(context)
        .getSubAgentManager()
        .cancel(context, req.params.subagentId);
      if (!status) {
        res.status(404).json({ error: 'Subagent not found' });
        return;
      }
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/retry', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      const subAgentManager = contextServices.resolveAgentForContext(context).getSubAgentManager();
      const existingItem = subAgentManager
        .list(context)
        .find((item) => item.subagentId === req.params.subagentId);

      if (!existingItem) {
        res.status(404).json({ error: 'Subagent not found' });
        return;
      }
      if (existingItem.status !== 'failed' && existingItem.status !== 'timeout') {
        res.status(400).json({ error: `Cannot retry subagent with status: ${existingItem.status}` });
        return;
      }
      const prompt = String(existingItem.prompt ?? '').trim();
      if (!prompt) {
        res.status(400).json({ error: 'Cannot retry subagent: original prompt is unavailable' });
        return;
      }

      const result = subAgentManager.create({
        parentContext: context,
        prompt,
        providerId: existingItem.providerId,
        agentName: existingItem.agent?.name,
        allowedTools: existingItem.allowedTools,
        workspaceDir: existingItem.workspaceDir,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }
      res.json({ success: true, status: result.status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.post('/api/sessions/:id/subagents/:subagentId/resume', (req: Request, res: Response) => {
    try {
      const context = toSessionContext(req.params.id);
      const subAgentManager = contextServices.resolveAgentForContext(context).getSubAgentManager();
      const existingItem = subAgentManager
        .list(context)
        .find((item) => item.subagentId === req.params.subagentId);

      if (!existingItem) {
        res.status(404).json({ error: 'Subagent not found' });
        return;
      }
      if (existingItem.status !== 'canceled') {
        res.status(400).json({ error: `Cannot resume subagent with status: ${existingItem.status}` });
        return;
      }
      const prompt = String(existingItem.prompt ?? '').trim();
      if (!prompt) {
        res.status(400).json({ error: 'Cannot resume subagent: original prompt is unavailable' });
        return;
      }

      const result = subAgentManager.resume({
        parentContext: context,
        subagentId: req.params.subagentId,
        prompt,
        providerId: existingItem.providerId,
        agentName: existingItem.agent?.name,
        allowedTools: existingItem.allowedTools,
        workspaceDir: existingItem.workspaceDir,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.error, code: result.code });
        return;
      }
      res.json({ success: true, status: result.status });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  deps.app.get('/api/toolsets', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const meta = context ? deps.agent.getContextNamespaceMeta(context) : undefined;
    const workspacePreset = deps.agent.getToolsetPresetStore().getWorkspacePreset(workspaceDir);
    const teamPreset = deps.agent.getToolsetPresetStore().getTeamPreset();
    const activeToolset = context
      ? deps.agent.resolveToolsetName(context)
      : deps.agent.getConfig().agent.defaultToolset;
    const activeSource = meta?.toolsetName
      ? 'session'
      : workspacePreset
        ? 'workspace'
        : teamPreset
          ? 'team'
          : 'default';
    res.json({
      toolsets: deps.agent.listToolsets(),
      activeToolset,
      activeSource,
      defaultToolset: deps.agent.getConfig().agent.defaultToolset,
      presets: {
        teamPreset,
        workspacePreset,
      },
      workspaceDir,
    });
  });

  deps.app.get('/api/toolsets/presets', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir =
      String(req.query.workspaceDir ?? '').trim() ||
      (context ? contextServices.resolveWorkspaceDirForContext(context) : '');
    res.json({
      ...deps.agent.listToolsetPresets(),
      workspacePreset: workspaceDir
        ? deps.agent.getToolsetPresetStore().getWorkspacePreset(workspaceDir)
        : undefined,
    });
  });

  deps.app.post('/api/toolsets/presets', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        sessionId?: string;
        scope?: 'team' | 'workspace';
        toolsetName?: string;
        workspaceDir?: string;
      };
      const scope = String(body.scope ?? '').trim().toLowerCase();
      const toolsetName = String(body.toolsetName ?? '').trim();
      if ((scope !== 'team' && scope !== 'workspace') || !toolsetName) {
        res.status(400).json({ error: 'scope and toolsetName are required' });
        return;
      }
      const sessionId = String(body.sessionId ?? '').trim();
      const context = sessionId ? toSessionContext(sessionId) : null;
      const workspaceDir =
        String(body.workspaceDir ?? '').trim() ||
        (context ? contextServices.resolveWorkspaceDirForContext(context) : undefined);
      const record = deps.agent.setToolsetPreset({
        scope,
        toolsetName,
        workspaceDir,
        sessionId: sessionId || undefined,
      });
      res.json({ success: true, record });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.delete('/api/toolsets/presets', (req: Request, res: Response) => {
    const scope = String(req.query.scope ?? '').trim().toLowerCase();
    if (scope !== 'team' && scope !== 'workspace') {
      res.status(400).json({ error: 'scope must be team or workspace' });
      return;
    }
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir =
      String(req.query.workspaceDir ?? '').trim() ||
      (context ? contextServices.resolveWorkspaceDirForContext(context) : undefined);
    const success = deps.agent.clearToolsetPreset({
      scope,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!success) {
      res.status(404).json({ error: 'Preset not found' });
      return;
    }
    res.json({ success: true });
  });

  deps.app.post('/api/sessions/:id/toolset', (req: Request, res: Response) => {
    const toolsetName = String((req.body as { toolsetName?: string }).toolsetName ?? '').trim();
    if (!toolsetName) {
      res.status(400).json({ error: 'toolsetName is required' });
      return;
    }
    const context = toSessionContext(req.params.id);
    try {
      const resolved = deps.agent.getToolsetRegistry().get(toolsetName);
      const nextMeta = deps.agent.updateContextNamespaceMeta(context, {
        toolsetName: resolved.name,
      });
      deps.agent.getGovernanceAuditStore().append({
        kind: 'session_toolset_overridden',
        title: `Session toolset override set to ${resolved.name}`,
        sessionId: req.params.id,
        workspaceDir: contextServices.resolveWorkspaceDirForContext(context),
        entityType: 'toolset',
        entityId: resolved.name,
        status: 'success',
      });
      res.json({ success: true, toolsetName: resolved.name, meta: nextMeta });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function registerSkillRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { contextServices } = deps;

  deps.app.get('/api/skills', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const toolsetName = context
      ? deps.agent.resolveToolsetName(context)
      : deps.agent.getConfig().agent.defaultToolset;
    const skills = deps.agent.getSkillLoader().getSkillCatalog({
      workspaceDir,
      toolsetName,
    });
    res.json({
      skills: skills.map((item) => ({
        name: item.name,
        description: item.description,
        source: item.source,
        path: item.path,
        version: item.version,
        skillSource: item.skillSource,
        packName: item.packName,
        packVersion: item.packVersion,
        tags: item.tags,
        triggers: item.triggers,
        platforms: item.platforms,
        toolsets: item.toolsets,
        reviewStatus: item.reviewStatus,
      })),
      workspaceDir,
      toolsetName,
    });
  });

  deps.app.get('/api/skills/pending', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const items = deps.agent.getSkillDraftStore().listPending({
      sessionId: sessionId || undefined,
      workspaceDir,
    });
    res.json({ items });
  });

  deps.app.get('/api/skills/history', (req: Request, res: Response) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    res.json({ items: deps.agent.listSkillHistory({ name, workspaceDir }) });
  });

  deps.app.post('/api/skills/rollback', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; name?: string; version?: string };
    const name = String(body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const result = deps.agent.rollbackSkill({
      name,
      workspaceDir,
      version: String(body.version ?? '').trim() || undefined,
      sessionId: sessionId || undefined,
    });
    if (!result) {
      res.status(404).json({ error: 'Skill history not found' });
      return;
    }
    res.json({ success: true, result });
  });

  deps.app.get('/api/skills/packs', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    res.json({
      items: deps.agent.getSkillPackStore().listPacks({ workspaceDir }),
      workspaceDir,
    });
  });

  deps.app.post('/api/skills/packs', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        sessionId?: string;
        name?: string;
        version?: string;
        scope?: 'team' | 'workspace';
        description?: string;
        skillNames?: string[];
      };
      const name = String(body.name ?? '').trim();
      const version = String(body.version ?? '').trim();
      const scope = String(body.scope ?? '').trim().toLowerCase();
      if (!name || !version || (scope !== 'team' && scope !== 'workspace')) {
        res.status(400).json({ error: 'name, version, and scope are required' });
        return;
      }
      const sessionId = String(body.sessionId ?? '').trim();
      const context = sessionId ? toSessionContext(sessionId) : null;
      const workspaceDir = context
        ? contextServices.resolveWorkspaceDirForContext(context)
        : deps.agent.getConfig().agent.workspaceDir;
      const record = deps.agent.publishSkillPack({
        name,
        version,
        scope,
        workspaceDir,
        description: String(body.description ?? '').trim() || undefined,
        skillNames: Array.isArray(body.skillNames)
          ? body.skillNames.map((item) => String(item))
          : undefined,
        sessionId: sessionId || undefined,
      });
      res.json({ success: true, record });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.post('/api/skills/packs/:name/activate', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; scope?: 'team' | 'workspace'; version?: string };
    const version = String(body.version ?? '').trim();
    const scope = String(body.scope ?? '').trim().toLowerCase();
    if (!version || (scope !== 'team' && scope !== 'workspace')) {
      res.status(400).json({ error: 'scope and version are required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const record = deps.agent.activateSkillPack({
      name: req.params.name,
      scope,
      version,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!record) {
      res.status(404).json({ error: 'Skill pack not found' });
      return;
    }
    res.json({ success: true, record });
  });

  deps.app.post('/api/skills/packs/:name/rollback', (req: Request, res: Response) => {
    const body = req.body as { sessionId?: string; scope?: 'team' | 'workspace' };
    const scope = String(body.scope ?? '').trim().toLowerCase();
    if (scope !== 'team' && scope !== 'workspace') {
      res.status(400).json({ error: 'scope is required' });
      return;
    }
    const sessionId = String(body.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const record = deps.agent.rollbackSkillPack({
      name: req.params.name,
      scope,
      workspaceDir,
      sessionId: sessionId || undefined,
    });
    if (!record) {
      res.status(404).json({ error: 'No prior pack version available' });
      return;
    }
    res.json({ success: true, record });
  });

  deps.app.post('/api/skills/pending/:id/approve', (req: Request, res: Response) => {
    const record = deps.agent.approveSkillDraft(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Pending skill draft not found' });
      return;
    }
    res.json({ success: true, record });
  });

  deps.app.post('/api/skills/pending/:id/reject', (req: Request, res: Response) => {
    const reviewNote = String((req.body as { reviewNote?: string }).reviewNote ?? '').trim();
    const record = deps.agent.rejectSkillDraft(req.params.id, reviewNote || undefined);
    if (!record) {
      res.status(404).json({ error: 'Pending skill draft not found' });
      return;
    }
    res.json({ success: true, record });
  });
}

function registerGovernanceRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { agentCatalogServices, contextServices, todoServices } = deps;

  deps.app.get('/api/memory', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const items = deps.agent.getMemoryStore().listEntries({
      workspaceDir,
      includeUser: true,
    });
    res.json({ items, workspaceDir });
  });

  const handleMemoryState = (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    res.json({
      items: [],
      state: sessionId ? deps.agent.getMemoryPromotionState(sessionId) : null,
    });
  };

  deps.app.get('/api/memory/state', handleMemoryState);
  deps.app.get('/api/memory/pending', handleMemoryState);

  deps.app.post('/api/memory/organize', async (req: Request, res: Response) => {
    try {
      const sessionId = String(
        (req.body as { sessionId?: string }).sessionId ?? req.query.sessionId ?? ''
      ).trim();
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }
      const context = toSessionContext(sessionId);
      const meta = deps.agent.getContextNamespaceMeta(context);
      if (!meta) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const record = await deps.agent.organizeSessionMemory({
        sessionId,
        workspaceDir: contextServices.resolveWorkspaceDirForContext(context),
      });
      res.json({
        success: true,
        ...record,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.get('/api/audit', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const workspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const limit = Number.parseInt(String(req.query.limit ?? '40'), 10);
    const items = deps.agent.listGovernanceAudit({
      sessionId: sessionId || undefined,
      workspaceDir,
      limit: Number.isFinite(limit) ? limit : 40,
    });
    res.json({ items, workspaceDir });
  });

  deps.app.get('/api/todos', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const resolvedWorkspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const scope = normalizeTodoScope(
      req.query.scope,
      sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
    );
    const items = deps.agent.getTodoStore().listTodos({
      scope,
      sessionId: sessionId || undefined,
      workspaceDir: resolvedWorkspaceDir,
      includeCompleted: req.query.include_completed === 'true',
    });
    res.json({ items, workspaceDir: resolvedWorkspaceDir });
  });

  deps.app.post('/api/todos', (req: Request, res: Response) => {
    try {
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const action = String(rawBody.action ?? '').trim().toLowerCase();
      if (action !== 'add' && action !== 'plan_set' && action !== 'list' && action !== 'clear_completed') {
        res.status(400).json({
          error: 'Todo requests require action=add, action=plan_set, action=list, or action=clear_completed.',
        });
        return;
      }
      const sessionId = String(rawBody.sessionId ?? '').trim();
      const context = sessionId ? toSessionContext(sessionId) : null;
      const resolvedWorkspaceDir = context
        ? contextServices.resolveWorkspaceDirForContext(context)
        : deps.agent.getConfig().agent.workspaceDir;
      const scope = normalizeTodoScope(
        rawBody.scope,
        sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
      );
      const workspaceDir = resolvedWorkspaceDir;
      if (action === 'list') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope', 'include_completed'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo list does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const protocol = deps.agent.getTodoStore().getProtocolState({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        res.json({ success: true, action, scope, protocol, workspaceDir });
        return;
      }
      if (action === 'clear_completed') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo clear_completed does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const removed = deps.agent.getTodoStore().clearCompletedTodos({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        res.json({ success: true, action, removed });
        return;
      }
      if (action === 'plan_set') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope', 'items'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo plan_set does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const rawItems = rawBody.items;
        if (!Array.isArray(rawItems)) {
          res.status(400).json({ error: 'Todo plan_set requires items[].' });
          return;
        }
        const normalizedItems = [];
        for (const [index, entry] of rawItems.entries()) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            res.status(400).json({ error: `Todo plan_set items[${index}] must be objects.` });
            return;
          }
          const item = entry as Record<string, unknown>;
          const unexpectedItemKeys = listUnexpectedTodoKeys(
            item,
            new Set(['work', 'detection_standard', 'priority', 'status', 'blocked_reason', 'tags'])
          );
          if (unexpectedItemKeys.length > 0) {
            res.status(400).json({
              error: `Todo plan_set items[${index}] do not accept: ${unexpectedItemKeys.join(', ')}.`,
            });
            return;
          }
          const normalizedStatus = normalizeTodoStatus(item.status);
          if (item.status !== undefined && normalizedStatus === undefined) {
            res.status(400).json({
              error: `Todo plan_set items[${index}] status must be pending, in_progress, or blocked.`,
            });
            return;
          }
          normalizedItems.push({
            work: String(item.work ?? '').trim(),
            detectionStandard: String(item.detection_standard ?? '').trim(),
            priority: normalizeTodoPriority(item.priority),
            status: normalizedStatus,
            blockedReason: String(item.blocked_reason ?? '').trim() || undefined,
            tags: normalizeTodoTags(item.tags),
          });
        }
        const items = deps.agent.getTodoStore().setTodoPlan({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
          items: normalizedItems,
          sourceSessionId: sessionId || undefined,
        });
        if (scope === 'session' && sessionId) {
          todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
        }
        res.json({ success: true, items });
        return;
      }
      const unexpectedKeys = listUnexpectedTodoKeys(
        rawBody,
        new Set([
          'action',
          'sessionId',
          'scope',
          'work',
          'detection_standard',
          'priority',
          'tags',
        ])
      );
      if (unexpectedKeys.length > 0) {
        res.status(400).json({
          error: `Todo add does not accept: ${unexpectedKeys.join(', ')}.`,
        });
        return;
      }
      const item = deps.agent.getTodoStore().createTodo({
        scope,
        sessionId: sessionId || undefined,
        workspaceDir,
        work: String(rawBody.work ?? '').trim(),
        detectionStandard: String(rawBody.detection_standard ?? '').trim(),
        priority: normalizeTodoPriority(rawBody.priority),
        tags: normalizeTodoTags(rawBody.tags),
        sourceSessionId: sessionId || undefined,
      });
      if (scope === 'session' && sessionId) {
        todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
      }
      res.json({ success: true, item });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.post('/api/todos/:id', (req: Request, res: Response) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = String(rawBody.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const resolvedWorkspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    try {
      const action = String(rawBody.action ?? '').trim().toLowerCase();
      const scope = normalizeTodoScope(
        rawBody.scope,
        sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
      );
      const workspaceDir = resolvedWorkspaceDir;
      if (action !== 'update' && action !== 'set_status' && action !== 'delete') {
        res.status(400).json({
          error: 'Todo update requires action=update, action=set_status, or action=delete.',
        });
        return;
      }
      const unexpectedKeys = listUnexpectedTodoKeys(
        rawBody,
        action === 'update'
          ? new Set([
              'action',
              'sessionId',
              'scope',
              'work',
              'detection_standard',
              'priority',
              'tags',
            ])
          : action === 'set_status'
            ? new Set([
                'action',
                'sessionId',
                'scope',
                'status',
                'evidence',
                'blocked_reason',
              ])
            : new Set(['action', 'sessionId', 'scope'])
      );
      if (unexpectedKeys.length > 0) {
        res.status(400).json({
          error:
            action === 'update'
              ? `Todo update does not accept: ${unexpectedKeys.join(', ')}.`
              : action === 'set_status'
                ? `Todo set_status does not accept: ${unexpectedKeys.join(', ')}.`
                : `Todo delete does not accept: ${unexpectedKeys.join(', ')}.`,
        });
        return;
      }
      if (action === 'delete') {
        const success = deps.agent.getTodoStore().deleteTodo(req.params.id, {
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        if (!success) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        res.json({ success: true });
        return;
      }
      if (action === 'set_status' && rawBody.status === undefined) {
        res.status(400).json({
          error: 'Todo status updates must include an explicit status.',
        });
        return;
      }
      const normalizedStatus = normalizeTodoStatus(rawBody.status);
      if (action === 'set_status' && normalizedStatus === undefined) {
        res.status(400).json({
          error: 'Todo status updates must use a valid status.',
        });
        return;
      }
      const item = deps.agent.getTodoStore().updateTodo(req.params.id, {
        scope,
        sessionId: sessionId || undefined,
        workspaceDir,
        work: action === 'update' ? String(rawBody.work ?? '').trim() || undefined : undefined,
        detectionStandard:
          action === 'update'
            ? String(rawBody.detection_standard ?? '').trim() || undefined
            : undefined,
        priority: action === 'update' ? normalizeTodoPriority(rawBody.priority) : undefined,
        tags: action === 'update' ? normalizeTodoTags(rawBody.tags) : undefined,
        status: action === 'set_status' ? normalizedStatus : undefined,
        completionTaskId:
          action === 'set_status'
            ? String(req.params.id ?? '').trim() || undefined
            : undefined,
        evidence: action === 'set_status' && Array.isArray(rawBody.evidence) ? rawBody.evidence : undefined,
        blockedReason:
          action === 'set_status'
            ? String(rawBody.blocked_reason ?? '').trim() || undefined
            : undefined,
      });
      if (!item) {
        res.status(404).json({ error: 'Todo not found' });
        return;
      }
      if (scope === 'session' && sessionId) {
        todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
      }
      res.json({ success: true, item });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.delete('/api/todos/:id', (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? '').trim();
    const context = sessionId ? toSessionContext(sessionId) : null;
    const resolvedWorkspaceDir = context
      ? contextServices.resolveWorkspaceDirForContext(context)
      : deps.agent.getConfig().agent.workspaceDir;
    const scope = normalizeTodoScope(
      req.query.scope,
      sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
    );
    const success = deps.agent.getTodoStore().deleteTodo(req.params.id, {
      scope,
      sessionId: sessionId || undefined,
      workspaceDir: resolvedWorkspaceDir,
    });
    if (!success) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }
    res.json({ success: true });
  });

  deps.app.get('/api/agents', (req: Request, res: Response) => {
    const mode = String(req.query.mode ?? '').trim().toLowerCase();
    const query = String(req.query.query ?? '').trim().toLowerCase();
    const profiles =
      mode === 'subagent'
        ? resolveAgentPool({
            globalAgentsDir: deps.agent.getConfig().agent.globalAgentsDir,
            workspaceDir:
              String(req.query.workspaceDir ?? '').trim() ||
              deps.agent.getConfig().agent.workspaceDir,
            includeWorkspace: true,
          })
        : agentCatalogServices.getGlobalAgentProfiles();
    if (mode !== 'subagent') {
      agentCatalogServices.refreshGlobalAgentCatalog();
    }

    const agents = profiles
      .filter((item) => (query.length > 0 ? item.name.toLowerCase().includes(query) : true))
      .map((item) => ({
        name: item.name,
        source: item.source,
        description: item.description,
        path: item.path,
        mtime: item.mtime,
      }));
    res.json({ agents });
  });
}

function resolveAutoLoopView(config: AutoLoopConfig, todoState: TodoProtocolState): {
  config: AutoLoopConfig;
  todoDriven: boolean;
} {
  const todoDriven = todoState.hasUnfinished || config.pendingPlanConfirmation === true;
  const ralphEnabled = config.ralphEnabled ?? (config.mode === 'todo' ? false : config.enabled);
  return {
    todoDriven,
    config: {
      ...config,
      mode: todoDriven ? 'todo' : 'ralph',
      ralphEnabled,
      enabled: todoDriven
        ? todoState.hasUnfinished && config.pausedByUser !== true && config.pendingPlanConfirmation !== true
        : ralphEnabled,
    },
  };
}

function registerAutoLoopRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { contextServices, todoServices } = deps;

  deps.app.get('/api/sessions/:id/autoloop', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const ref = toSessionContext(sessionId);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
    const workspaceDir = contextServices.resolveWorkspaceDirForContext(ref);
    const todoState = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const config = controller.getConfig();
    const view = resolveAutoLoopView(config, todoState);
    res.json({
      success: true,
      config: view.config,
      state: controller.getState(),
      todoDriven: view.todoDriven,
    });
  });

  deps.app.post('/api/sessions/:id/autoloop', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const config = req.body as Partial<AutoLoopConfig>;
    const ref = toSessionContext(sessionId);
    const workspaceDir = contextServices.resolveWorkspaceDirForContext(ref);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
    const normalizedUpdates: Partial<AutoLoopConfig> = { ...config };
    delete normalizedUpdates.pendingPlanConfirmation;
    const todoStateBeforeUpdate = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const currentConfig = controller.getConfig();
    const ralphEnabled = currentConfig.ralphEnabled ?? (currentConfig.mode === 'ralph' ? currentConfig.enabled : false);
    const todoControlled = todoStateBeforeUpdate.hasUnfinished || currentConfig.pendingPlanConfirmation === true;
    if (typeof config.enabled === 'boolean') {
      if (todoControlled && currentConfig.pendingPlanConfirmation === true && config.enabled === true) {
        const view = resolveAutoLoopView(currentConfig, todoStateBeforeUpdate);
        res.status(409).json({
          success: false,
          error: 'Plan confirmation is required before starting the todo loop.',
          config: view.config,
          todoDriven: view.todoDriven,
        });
        return;
      }
      normalizedUpdates.mode = todoControlled ? 'todo' : 'ralph';
      normalizedUpdates.ralphEnabled = todoControlled ? ralphEnabled : config.enabled;
      normalizedUpdates.pausedByUser = todoControlled ? !config.enabled : false;
      normalizedUpdates.pendingPlanConfirmation = currentConfig.pendingPlanConfirmation === true;
      normalizedUpdates.enabled = config.enabled;
    }
    controller.updateConfig(normalizedUpdates);
    if (normalizedUpdates.pausedByUser === true || normalizedUpdates.enabled === false) {
      controller.stop('user_stop');
    }
    contextServices.updateContextNamespaceMetaSafe(ref, {
      autoLoopConfig: controller.getConfig(),
    });
    todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
    const todoState = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const view = resolveAutoLoopView(controller.getConfig(), todoState);
    res.json({
      success: true,
      config: view.config,
      todoDriven: view.todoDriven,
    });
  });

  deps.app.get('/api/autoloop/global', (_req: Request, res: Response) => {
    res.json({
      success: true,
      config: autoLoopManager.getGlobalConfig(),
    });
  });

  deps.app.post('/api/autoloop/global', (req: Request, res: Response) => {
    autoLoopManager.updateGlobalConfig(req.body as Partial<AutoLoopConfig>);
    res.json({
      success: true,
      config: autoLoopManager.getGlobalConfig(),
    });
  });
}

export function registerWebServerRoutes(
  deps: WebServerRouteRegistrationDependencies
): void {
  deps.app.use(express.json());

  const clientPath = registerStaticClient(deps);
  registerSystemRoutes(deps);
  registerSessionRoutes(deps);
  registerSubagentAndToolsetRoutes(deps);
  registerSkillRoutes(deps);
  registerGovernanceRoutes(deps);
  registerAutoLoopRoutes(deps);

  if (clientPath) {
    deps.app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(clientPath, 'index.html'));
    });
  }
}
