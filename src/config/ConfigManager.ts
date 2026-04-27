import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { AgentConfig, MCPServerConfig } from '../types.js';
import {
  createLlmProfileFromLegacyApi,
  mirrorLegacyApiUpdateToLlmProfiles,
  syncLegacyApiFromLlmProfiles,
} from '../llm/provider-profiles.js';

export interface MCPRuntimeConfig {
  enabled: boolean;
  servers: MCPServerConfig[];
  connectTimeout: number;
  executeTimeout: number;
}

const DEFAULT_LEGACY_API_CONFIG: AgentConfig['api'] = {
  apiKey: '',
  apiBase: 'https://api.minimax.io',
  model: 'MiniMax-M2.5',
  provider: 'anthropic',
  maxOutputTokens: 32768,
};

const DEFAULT_CONFIG: AgentConfig = {
  api: DEFAULT_LEGACY_API_CONFIG,
  llmProfiles: {
    defaultProfileId: 'legacy-default',
    profiles: [createLlmProfileFromLegacyApi(DEFAULT_LEGACY_API_CONFIG)],
  },
  agent: {
    maxSteps: 100,
    tokenLimit: 80000,
    workspaceDir: './workspace',
    completionMarkerEnforcementEnabled: false,
    defaultToolset: 'full-access',
    skillWriteMode: 'auto',
    subAgentMaxParallelPerParent: 4,
    subAgentGlobalMaxParallel: 10,
    contextReplayMinRounds: 6,
    contextReplayMaxRounds: 12,
    contextReplayBudgetRatio: 0.55,
    contextCompressionMaxChars: 6000,
    contextWindowChars: 230000,
    contextPrecompressTriggerRatio: 0.85,
    contextOverflowForcedTrimChars: 160000,
    contextOverflowMaxErrorsBeforeTrim: 2,
    contextPrecompressKeepLlmRounds: 5,
    contextPrecompressChunkChars: 60000,
    contextPrecompressRetry: 1,
    contextDir: './contexts',
    runtimeDataDir: './runtime',
    globalAgentsDir: './agents',
  },
  tools: {
    enableFileTools: true,
    enableWeb: true,
    enableShell: true,
    shellType: 'powershell',
    shellTimeout: 30000,
  },
  mcp: {
    enabled: true,
    servers: [],
    connectTimeout: 10,
    executeTimeout: 60,
  },
  retry: {
    enabled: true,
    maxRetries: 3,
    initialDelay: 1,
    maxDelay: 60,
    exponentialBase: 2,
  },
  agentProviders: [
    {
      id: 'local-default',
      type: 'local',
      enabled: true,
      timeoutMs: 300000,
    },
  ],
  subAgentPresets: {
    coding: {
      description: 'Code implementation and debugging specialist',
      providerId: 'local-default',
      systemPrompt:
        'You are a coding sub-agent. Focus on implementation, debugging, and concise progress updates.',
    },
    research: {
      description: 'Repository and technical investigation specialist',
      providerId: 'local-default',
      systemPrompt:
        'You are a research sub-agent. Focus on evidence-driven exploration and clear findings.',
    },
    review: {
      description: 'Code review and risk assessment specialist',
      providerId: 'local-default',
      systemPrompt:
        'You are a review sub-agent. Focus on correctness risks, regressions, and missing tests.',
    },
  },
};

export class ConfigManager {
  private config: AgentConfig;
  private configPath: string | null = null;

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
      retry: this.mergeDeepObject(defaults.retry, overrides.retry),
      agentProviders: overrides.agentProviders
        ? this.deepClone(overrides.agentProviders)
        : this.deepClone(defaults.agentProviders),
      subAgentPresets: this.mergeDeepObject(
        (defaults.subAgentPresets ?? {}) as Record<string, unknown>,
        (overrides.subAgentPresets ?? {}) as Record<string, unknown>
      ) as AgentConfig['subAgentPresets'],
    };

    if (!overrides.llmProfiles && overrides.api) {
      return mirrorLegacyApiUpdateToLlmProfiles(merged, overrides.api);
    }

    return merged;
  }

  private sanitizeConfig(config: AgentConfig): AgentConfig {
    const sanitized = this.deepClone(config);
    delete (sanitized.agent as Record<string, unknown>).memoryWriteMode;
    return syncLegacyApiFromLlmProfiles(sanitized);
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
    const parsed = yaml.load(content) as Partial<AgentConfig>;
    this.config = this.sanitizeConfig(this.mergeConfig(this.config, parsed));
    this.configPath = filePath;
  }

  loadFromJson(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<AgentConfig>;
    this.config = this.sanitizeConfig(this.mergeConfig(this.config, parsed));
    this.configPath = filePath;
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
    const apiKey = String(this.config.api.apiKey ?? '').trim();
    const apiBase = String(this.config.api.apiBase ?? '').trim();
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

  getRetryConfig() {
    return { ...this.config.retry };
  }

  setApiKey(apiKey: string): void {
    this.config = mirrorLegacyApiUpdateToLlmProfiles(this.config, { apiKey });
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

  setSkillListPath(filePath: string): void {
    this.config.agent.skillListPath = path.resolve(filePath);
  }

  addWritableDir(dir: string): void {
    const absoluteDir = path.resolve(dir);
    if (!this.config.agent.workspaceDir.includes(absoluteDir)) {
      this.config.agent.workspaceDir = absoluteDir;
    }
  }

  saveToYaml(filePath: string): void {
    const content = yaml.dump(this.sanitizeConfig(this.config), { indent: 2, lineWidth: -1 });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  saveToJson(filePath: string): void {
    const content = JSON.stringify(this.sanitizeConfig(this.config), null, 2);
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
