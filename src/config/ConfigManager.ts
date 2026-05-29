import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { AgentConfig, MCPServerConfig } from '../types.js';
import { DEFAULT_GLM_ASR_CONFIG, normalizeAsrConfig } from '../asr/index.js';
import {
  createDefaultLlmProfile,
  getResolvedProfileCapabilities,
  DEFAULT_LLM_PROFILE_ID,
  normalizeLlmProfilesConfig,
  resolveOptionalDefaultLlmProfile,
} from '../llm/provider-profiles.js';
import { DEFAULT_REMOTE_ACCESS_AUTH_SETTINGS } from '../shared/remote-access-auth-defaults.js';
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  createDefaultContextBudgetConfig,
} from '../runtime/context-window-budget.js';
import { DEFAULT_TOOLSETS } from '../tools/CapabilityCatalog.js';
import {
  DEFAULT_SESSION_SHARE_TTL_HOURS,
  normalizeSessionShareTtlHours,
} from '../shared/session-share-defaults.js';

export interface MCPRuntimeConfig {
  enabled: boolean;
  servers: MCPServerConfig[];
  connectTimeout: number;
  executeTimeout: number;
}

const DEFAULT_API_CONFIG: AgentConfig['api'] = {
  apiKey: '',
  apiBase: '',
  model: '',
  provider: 'anthropic',
  maxOutputTokens: 32768,
};

const REMOVED_AGENT_CONTEXT_KEYS = [
  'contextWindowChars',
  'contextPrecompressTriggerRatio',
  'contextOverflowForcedTrimChars',
  'contextPrecompressKeepLlmRounds',
  'contextPrecompressChunkChars',
  'contextPrecompressRetry',
  'contextCompressionMaxChars',
] as const;
const REMOVED_AGENT_CONFIG_KEYS = [
  'memoryWriteMode',
  'skillListPath',
  'skillWriteMode',
  ...REMOVED_AGENT_CONTEXT_KEYS,
] as const;

const DEFAULT_CONFIG: AgentConfig = {
  api: DEFAULT_API_CONFIG,
  llmProfiles: {
    defaultProfileId: '',
    profiles: [],
  },
  agent: {
    maxSteps: 100,
    tokenLimit: 80000,
    workspaceDir: './workspace',
    completionMarkerEnforcementEnabled: false,
    defaultToolset: 'windows-safe',
    subAgentMaxParallelPerParent: 4,
    subAgentGlobalMaxParallel: 10,
    contextReplayMinRounds: 6,
    contextReplayMaxRounds: 12,
    contextReplayBudgetRatio: 0.55,
    contextOverflowMaxErrorsBeforeTrim: 2,
    contextDir: './contexts',
    runtimeDataDir: './runtime',
    globalAgentsDir: './agents',
  },
  tools: {
    enableFileTools: true,
    enableWeb: false,
    enableShell: false,
    shellType: 'powershell',
    shellTimeout: 30000,
  },
  mcp: {
    enabled: false,
    servers: [],
    connectTimeout: 10,
    executeTimeout: 60,
  },
  toolsets: {
    custom: [],
  },
  retry: {
    enabled: true,
    maxRetries: 3,
    initialDelay: 1,
    maxDelay: 60,
    exponentialBase: 2,
  },
  web: {
    downloadLinkTtlMs: 24 * 60 * 60 * 1000,
    sessionShareTtlHours: DEFAULT_SESSION_SHARE_TTL_HOURS,
  },
  contextBudget: createDefaultContextBudgetConfig(),
  remoteAccessAuth: { ...DEFAULT_REMOTE_ACCESS_AUTH_SETTINGS },
  agentProviders: [
    {
      id: 'local-default',
      type: 'local',
      enabled: true,
      timeoutMs: 300000,
    },
  ],
  asr: DEFAULT_GLM_ASR_CONFIG,
};

type CustomToolsetConfig = NonNullable<NonNullable<AgentConfig['toolsets']>['custom']>[number];

export class ConfigManager {
  private config: AgentConfig;

  constructor(config?: Partial<AgentConfig>) {
    this.config = this.sanitizeConfig(this.mergeConfig(DEFAULT_CONFIG, config ?? {}));
  }

  private deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime()) as unknown as T;
    }

    if (obj instanceof RegExp) {
      return new RegExp(obj) as unknown as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepClone(item)) as unknown as T;
    }

    if (typeof obj === 'object') {
      const cloned = {} as Record<string, unknown>;
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          cloned[key] = this.deepClone((obj as Record<string, unknown>)[key]);
        }
      }
      return cloned as T;
    }

    return obj;
  }

  private mergeConfig(defaults: AgentConfig, overrides: Partial<AgentConfig>): AgentConfig {
    const merged: AgentConfig = {
      api: this.mergeDeepObject(defaults.api, overrides.api),
      llmProfiles: {
        defaultProfileId:
          typeof overrides.llmProfiles?.defaultProfileId === 'string' &&
          overrides.llmProfiles.defaultProfileId.trim().length > 0
            ? overrides.llmProfiles.defaultProfileId.trim()
            : defaults.llmProfiles.defaultProfileId,
        profiles: overrides.llmProfiles?.profiles
          ? this.deepClone(overrides.llmProfiles.profiles)
          : this.deepClone(defaults.llmProfiles.profiles),
      },
      agent: this.mergeDeepObject(defaults.agent, overrides.agent),
      tools: this.mergeDeepObject(defaults.tools, overrides.tools),
      mcp: this.mergeDeepObject(defaults.mcp, overrides.mcp),
      toolsets: {
        custom: Array.isArray(overrides.toolsets?.custom)
          ? this.deepClone(overrides.toolsets.custom)
          : this.deepClone(defaults.toolsets?.custom ?? []),
      },
      retry: this.mergeDeepObject(defaults.retry, overrides.retry),
      web: this.mergeDeepObject(
        (defaults.web ?? {}) as Record<string, unknown>,
        (overrides.web ?? {}) as Record<string, unknown>
      ) as unknown as AgentConfig['web'],
      contextBudget: this.mergeDeepObject(
        (defaults.contextBudget ?? {}) as Record<string, unknown>,
        (overrides.contextBudget ?? {}) as Record<string, unknown>
      ) as unknown as NonNullable<AgentConfig['contextBudget']>,
      remoteAccessAuth: this.mergeDeepObject(
        (defaults.remoteAccessAuth ?? {}) as Record<string, unknown>,
        (overrides.remoteAccessAuth ?? {}) as Record<string, unknown>
      ) as unknown as AgentConfig['remoteAccessAuth'],
      agentProviders: overrides.agentProviders
        ? this.deepClone(overrides.agentProviders)
        : this.deepClone(defaults.agentProviders),
      asr: normalizeAsrConfig(
        this.mergeDeepObject(
          (defaults.asr ?? DEFAULT_GLM_ASR_CONFIG) as unknown as Record<string, unknown>,
          (overrides.asr ?? {}) as Record<string, unknown>
        )
      ),
    };

    return merged;
  }

  private sanitizeConfig(config: AgentConfig): AgentConfig {
    const sanitized = this.deepClone(config);
    const agentConfig = sanitized.agent as Record<string, unknown>;
    this.assertNoRemovedAgentConfigKeys(agentConfig);
    sanitized.contextBudget = this.normalizeContextBudget(sanitized);
    sanitized.web = this.normalizeWebConfig(sanitized.web);
    sanitized.asr = normalizeAsrConfig(sanitized.asr);
    sanitized.llmProfiles = normalizeLlmProfilesConfig({ llmProfiles: sanitized.llmProfiles });
    sanitized.toolsets = {
      custom: this.normalizeCustomToolsets(sanitized.toolsets?.custom),
    };
    return sanitized;
  }

  private normalizeCustomToolsets(value: unknown): CustomToolsetConfig[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const builtInToolsetNames = new Set(DEFAULT_TOOLSETS.map((item) => item.name.trim().toLowerCase()));
    const byName = new Map<string, CustomToolsetConfig>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const data = item as Record<string, unknown>;
      const name = String(data.name ?? '').trim();
      if (!name) {
        continue;
      }
      if (builtInToolsetNames.has(name.toLowerCase())) {
        continue;
      }
      const capabilities = Array.isArray(data.capabilities)
        ? data.capabilities.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean)
        : [];
      if (capabilities.length === 0) {
        continue;
      }
      byName.set(name.toLowerCase(), {
        name,
        description: String(data.description ?? '').trim() || `Custom toolset: ${name}`,
        capabilities: Array.from(new Set(capabilities)),
        ...(typeof data.allowUnknownTools === 'boolean' ? { allowUnknownTools: data.allowUnknownTools } : {}),
      });
    }
    return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  private normalizeWebConfig(value: AgentConfig['web']): AgentConfig['web'] {
    return {
      ...(value ?? {}),
      sessionShareTtlHours: normalizeSessionShareTtlHours(value?.sessionShareTtlHours),
    };
  }

  private migrateLegacyApiIntoLlmProfiles(overrides: Partial<AgentConfig>): Partial<AgentConfig> {
    const legacyApi = overrides.api;
    if (!legacyApi || typeof legacyApi !== 'object') {
      return overrides;
    }
    const legacyApiKey = String(legacyApi.apiKey ?? '').trim();
    if (!legacyApiKey) {
      return overrides;
    }

    const existingProfiles = Array.isArray(overrides.llmProfiles?.profiles)
      ? overrides.llmProfiles?.profiles ?? []
      : [];
    const defaultProfileId =
      typeof overrides.llmProfiles?.defaultProfileId === 'string' &&
      overrides.llmProfiles.defaultProfileId.trim().length > 0
        ? overrides.llmProfiles.defaultProfileId.trim()
        : DEFAULT_LLM_PROFILE_ID;
    const profiles = existingProfiles.length > 0 ? this.deepClone(existingProfiles) : [createDefaultLlmProfile(defaultProfileId)];
    const defaultIndex = profiles.findIndex((profile) => profile.id === defaultProfileId);
    const resolvedDefaultIndex = defaultIndex >= 0 ? defaultIndex : 0;
    const currentDefault = profiles[resolvedDefaultIndex] ?? createDefaultLlmProfile(defaultProfileId);
    const currentApiKey = String(currentDefault.apiKey ?? '').trim();

    if (currentApiKey) {
      return overrides;
    }

    const provider = legacyApi.provider === 'openai' ? 'openai' : 'anthropic';
    const defaultModel = String(legacyApi.model ?? '').trim() || currentDefault.defaultModel;
    profiles[resolvedDefaultIndex] = {
      ...currentDefault,
      id: currentDefault.id || defaultProfileId,
      provider,
      apiKey: legacyApiKey,
      apiBase: String(legacyApi.apiBase ?? '').trim() || currentDefault.apiBase,
      defaultModel,
      availableModels: Array.isArray(currentDefault.availableModels)
        ? [...new Set([...currentDefault.availableModels, defaultModel].filter(Boolean))]
        : [defaultModel],
      maxOutputTokens:
        typeof legacyApi.maxOutputTokens === 'number' &&
        Number.isFinite(legacyApi.maxOutputTokens) &&
        legacyApi.maxOutputTokens > 0
          ? Math.floor(legacyApi.maxOutputTokens)
          : currentDefault.maxOutputTokens,
      capabilities: getResolvedProfileCapabilities({ provider, capabilities: undefined }),
    };

    return {
      ...overrides,
      llmProfiles: {
        defaultProfileId: profiles[resolvedDefaultIndex]?.id ?? defaultProfileId,
        profiles,
      },
    };
  }

  private assertNoRemovedAgentConfigKeys(agentConfig: Record<string, unknown>): void {
    const removedKeys = REMOVED_AGENT_CONFIG_KEYS.filter((key) =>
      Object.prototype.hasOwnProperty.call(agentConfig, key)
    );
    if (removedKeys.length > 0) {
      throw new Error(
        `Removed agent config field(s): ${removedKeys.join(', ')}. Use canonical agent settings and root contextBudget instead.`
      );
    }
  }

  private normalizeContextBudget(cfg: AgentConfig): NonNullable<AgentConfig['contextBudget']> {
    const raw = cfg.contextBudget ?? ({} as NonNullable<AgentConfig['contextBudget']>);
    const defaultContextWindowTokens =
      Number.isFinite(raw.defaultContextWindowTokens) && raw.defaultContextWindowTokens > 0
        ? Math.floor(raw.defaultContextWindowTokens)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.defaultContextWindowTokens;

    const rawCompressionTriggerRatio = Number(raw.compressionTriggerRatio);
    const compressionTriggerRatio =
      Number.isFinite(rawCompressionTriggerRatio) &&
      rawCompressionTriggerRatio > 0 &&
      rawCompressionTriggerRatio <= 1
        ? rawCompressionTriggerRatio
        : DEFAULT_CONTEXT_BUDGET_CONFIG.compressionTriggerRatio;

    const postCompressionTargetRatio =
      Number.isFinite(raw.postCompressionTargetRatio) &&
      raw.postCompressionTargetRatio > 0 &&
      raw.postCompressionTargetRatio <= 1
        ? raw.postCompressionTargetRatio
        : DEFAULT_CONTEXT_BUDGET_CONFIG.postCompressionTargetRatio;

    const minTokensAddedAfterCompression =
      Number.isFinite(raw.minTokensAddedAfterCompression) && raw.minTokensAddedAfterCompression >= 0
        ? Math.floor(raw.minTokensAddedAfterCompression)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.minTokensAddedAfterCompression;

    const rawCompressionMaxChars = Number(raw.compressionMaxChars);
    const compressionMaxChars =
      Number.isFinite(rawCompressionMaxChars) && rawCompressionMaxChars > 0
        ? Math.floor(rawCompressionMaxChars)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.compressionMaxChars;

    const rawPrecompressKeepLlmRounds = Number(raw.precompressKeepLlmRounds);
    const precompressKeepLlmRounds =
      Number.isFinite(rawPrecompressKeepLlmRounds) && rawPrecompressKeepLlmRounds > 0
        ? Math.floor(rawPrecompressKeepLlmRounds)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressKeepLlmRounds;

    const rawPrecompressChunkChars = Number(raw.precompressChunkChars);
    const precompressChunkChars =
      Number.isFinite(rawPrecompressChunkChars) && rawPrecompressChunkChars > 0
        ? Math.floor(rawPrecompressChunkChars)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressChunkChars;

    const rawPrecompressRetry = Number(raw.precompressRetry);
    const precompressRetry =
      Number.isFinite(rawPrecompressRetry) && rawPrecompressRetry >= 0
        ? Math.floor(rawPrecompressRetry)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.precompressRetry;

    const reservedOutputTokens =
      Number.isFinite(raw.reservedOutputTokens) && raw.reservedOutputTokens >= 0
        ? Math.floor(raw.reservedOutputTokens)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.reservedOutputTokens;

    const reservedReasoningTokens =
      Number.isFinite(raw.reservedReasoningTokens) && raw.reservedReasoningTokens >= 0
        ? Math.floor(raw.reservedReasoningTokens)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.reservedReasoningTokens;

    const reservedProtocolTokens =
      Number.isFinite(raw.reservedProtocolTokens) && raw.reservedProtocolTokens >= 0
        ? Math.floor(raw.reservedProtocolTokens)
        : DEFAULT_CONTEXT_BUDGET_CONFIG.reservedProtocolTokens;

    const modelOverrides: Record<string, NonNullable<import('../types.js').ModelContextBudgetOverride>> = {};
    if (raw.modelOverrides && typeof raw.modelOverrides === 'object') {
      for (const [key, override] of Object.entries(raw.modelOverrides)) {
        if (!override || typeof override !== 'object') continue;
        const entry: NonNullable<import('../types.js').ModelContextBudgetOverride> = {};
        if (Number.isFinite((override as Record<string, unknown>).contextWindowTokens)) {
          entry.contextWindowTokens = Math.floor((override as Record<string, unknown>).contextWindowTokens as number);
        }
        if (Number.isFinite((override as Record<string, unknown>).compressionTriggerRatio)) {
          entry.compressionTriggerRatio = (override as Record<string, unknown>).compressionTriggerRatio as number;
        }
        if (Number.isFinite((override as Record<string, unknown>).postCompressionTargetRatio)) {
          entry.postCompressionTargetRatio = (override as Record<string, unknown>).postCompressionTargetRatio as number;
        }
        if (Number.isFinite((override as Record<string, unknown>).reservedOutputTokens)) {
          entry.reservedOutputTokens = Math.floor((override as Record<string, unknown>).reservedOutputTokens as number);
        }
        if (Number.isFinite((override as Record<string, unknown>).reservedReasoningTokens)) {
          entry.reservedReasoningTokens = Math.floor((override as Record<string, unknown>).reservedReasoningTokens as number);
        }
        if (Number.isFinite((override as Record<string, unknown>).reservedProtocolTokens)) {
          entry.reservedProtocolTokens = Math.floor((override as Record<string, unknown>).reservedProtocolTokens as number);
        }
        if (Object.keys(entry).length > 0) {
          modelOverrides[key] = entry;
        }
      }
    }

    return {
      defaultContextWindowTokens,
      compressionTriggerRatio,
      postCompressionTargetRatio,
      minTokensAddedAfterCompression,
      compressionMaxChars,
      precompressKeepLlmRounds,
      precompressChunkChars,
      precompressRetry,
      reservedOutputTokens,
      reservedReasoningTokens,
      reservedProtocolTokens,
      modelOverrides,
    };
  }

  private mergeDeepObject<T extends Record<string, unknown>>(
    defaults: T,
    overrides?: Partial<T>
  ): T {
    const cloned = this.deepClone(defaults);
    if (!overrides) {
      return cloned;
    }
    for (const key in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        const val = overrides[key];
        if (val !== undefined) {
          cloned[key] = this.deepClone(val) as T[Extract<keyof T, string>];
        }
      }
    }
    return cloned;
  }

  loadFromYaml(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = this.migrateLegacyApiIntoLlmProfiles(yaml.load(content) as Partial<AgentConfig>);
    this.config = this.sanitizeConfig(this.mergeConfig(this.config, parsed));
  }

  loadFromJson(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = this.migrateLegacyApiIntoLlmProfiles(JSON.parse(content) as Partial<AgentConfig>);
    this.config = this.sanitizeConfig(this.mergeConfig(this.config, parsed));
  }

  loadMcpConfig(filePath: string): MCPServerConfig[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, MCPServerConfig> };

    if (!parsed.mcpServers) {
      return [];
    }

    return Object.entries(parsed.mcpServers).map(([name, server]) => ({
      ...server,
      name,
    }));
  }

  loadSystemPrompt(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      return this.getDefaultSystemPrompt();
    }

    return fs.readFileSync(filePath, 'utf-8');
  }

  getDefaultSystemPrompt(): string {
    return `You are a helpful AI assistant.

You have access to various tools for file operations, shell commands, and other capabilities.

## Current Workspace
You are working in the specified workspace directory. All relative paths will be resolved relative to this directory.

## Tool Usage Guidelines
- Use tools to accomplish tasks efficiently
- Always check file contents before making edits
- Be careful with shell commands, especially on Windows
- Report errors clearly and suggest solutions
- For parallelizable workstreams, prefer using sub-agents
- Before spawning sub-agents, call subagent_manage(action=list_agents) and pick the most suitable agent_name
- Treat skills as reusable procedures, not durable facts
- For non-trivial, domain-specific, or repeated workflows, look for an existing skill before inventing a new process
- When a method is verified, reusable, and likely to help again, capture or update it as a skill when the active toolset allows it
- If a loaded skill is stale, incomplete, or wrong for the current task, correct it before finishing instead of silently working around it
- Use context_manage for current structured context and runtime context state, session_search for raw prior-session transcript recall, and memory_manage for durable workspace/user facts
- Respect the active toolset for the current turn; unavailable tools are intentionally hidden

## [MANDATORY_EXECUTION_RULES]
- SAYING YOU WILL DO IT DOES NOT COUNT AS DOING IT
- For executable or multi-step tasks, act first, then inspect the actual result
- After writing code, run the relevant code, tests, build, or verification step when the environment allows it
- After running code, inspect the actual result: exit status, stdout/stderr, logs, generated files, UI state, or test report
- If the result is incomplete, failing, partial, or ambiguous, continue acting in the same turn instead of stopping for confirmation
- Only stop when the task is complete, truly blocked, explicitly cancelled, or cannot continue because of a hard system limitation
- Treat missing essential user information as blocked only when you clearly explain what is missing, why it blocks progress, and what you already tried yourself

## Response Format
- Be concise but thorough
- Explain your reasoning when helpful
- Use thinking blocks for complex reasoning`;
  }

  getNeutralRuntimeSystemPrompt(): string {
    const neutralRole = [
      'You are running inside the DPAgent runtime.',
      'When an Active Agent Role is present, adopt that role for persona, style, and task focus.',
      'Core runtime rules, tool permissions, workspace instructions, and protocol segments remain binding.',
      'Do not treat the agent profile path as the current workspace.',
    ].join('\n');
    return this.getDefaultSystemPrompt().replace(/^You are a helpful AI assistant\./, neutralRole);
  }

  get(): AgentConfig {
    return this.sanitizeConfig(this.config);
  }

  getApiConfig() {
    return { ...this.config.api };
  }

  getAgentConfig() {
    return { ...this.sanitizeConfig(this.config).agent };
  }

  getToolsConfig() {
    return { ...this.config.tools };
  }

  getMcpConfig() {
    return { ...this.config.mcp };
  }

  getMcpRuntimeConfig(): MCPRuntimeConfig {
    const defaultProfile = resolveOptionalDefaultLlmProfile({ llmProfiles: this.config.llmProfiles });
    const apiKey = String(defaultProfile?.apiKey ?? '').trim();
    const apiBase = String(defaultProfile?.apiBase ?? '').trim();
    const configuredServers = Array.isArray(this.config.mcp.servers)
      ? this.config.mcp.servers
      : [];
    const servers = configuredServers.map((server) =>
      this.applyApiEnvFallbackToMcpServer(server, apiBase, apiKey)
    );
    return {
      enabled: this.config.mcp.enabled === true && servers.length > 0,
      servers,
      connectTimeout: this.config.mcp.connectTimeout,
      executeTimeout: this.config.mcp.executeTimeout,
    };
  }

  private toPersistentConfig(): Record<string, unknown> {
    const persisted = this.sanitizeConfig(this.config) as unknown as Record<string, unknown>;
    delete persisted.api;
    return persisted;
  }

  getRetryConfig() {
    return { ...this.config.retry };
  }

  setApiKey(apiKey: string): void {
    const defaultProfile = resolveOptionalDefaultLlmProfile({ llmProfiles: this.config.llmProfiles });
    if (!defaultProfile) {
      throw new Error('Cannot set API key before an LLM profile exists.');
    }
    this.config.llmProfiles = {
      ...this.config.llmProfiles,
      profiles: this.config.llmProfiles.profiles.map((profile) =>
        profile.id === defaultProfile.id ? { ...profile, apiKey: apiKey.trim(), updatedAt: new Date().toISOString() } : profile
      ),
    };
  }

  setWorkspaceDir(dir: string): void {
    this.config.agent.workspaceDir = path.resolve(dir);
  }

  setRuntimeDataDir(dir: string): void {
    this.config.agent.runtimeDataDir = path.resolve(dir);
  }

  setContextDir(dir: string): void {
    this.config.agent.contextDir = path.resolve(dir);
  }

  addWritableDir(dir: string): void {
    const absoluteDir = path.resolve(dir);
    if (!this.config.agent.workspaceDir.includes(absoluteDir)) {
      this.config.agent.workspaceDir = absoluteDir;
    }
  }

  saveToYaml(filePath: string): void {
    const content = yaml.dump(this.toPersistentConfig(), { indent: 2, lineWidth: -1 });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  saveToJson(filePath: string): void {
    const content = JSON.stringify(this.toPersistentConfig(), null, 2);
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  private applyApiEnvFallbackToMcpServer(
    server: MCPServerConfig,
    apiBase: string,
    apiKey: string
  ): MCPServerConfig {
    if (server.type !== 'stdio') {
      return this.deepClone(server);
    }
    const env = { ...(server.env ?? {}) };
    if ((!env.MINIMAX_API_KEY || env.MINIMAX_API_KEY.trim().length === 0) && apiKey.length > 0) {
      env.MINIMAX_API_KEY = apiKey;
    }
    if ((!env.MINIMAX_API_HOST || env.MINIMAX_API_HOST.trim().length === 0) && apiBase.length > 0) {
      env.MINIMAX_API_HOST = apiBase;
    }
    return {
      ...this.deepClone(server),
      env,
    };
  }
}

export function createConfig(overrides?: Partial<AgentConfig>): ConfigManager {
  return new ConfigManager(overrides);
}

export { DEFAULT_CONFIG };
