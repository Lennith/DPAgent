import type { AgentConfig, LlmProviderProfileConfig } from '../../types.js';
import { normalizeLlmProfilesConfig } from '../../llm/provider-profiles.js';
import { createDefaultContextBudgetConfig } from '../../runtime/context-window-budget.js';
import { DEFAULT_REMOTE_ACCESS_AUTH_CONFIG } from './remote-access-auth.js';
import type {
  LlmProfilesConfigView,
  PublicLlmProfile,
  PublicSettingsView,
  RemoteAccessAuthView,
} from '../../shared/web-settings-contracts.js';
import { DEFAULT_SESSION_SHARE_TTL_HOURS } from '../../shared/session-share-defaults.js';

export interface ConfigMutationAgent {
  getConfig(): AgentConfig;
  updateConfig(updates: Partial<AgentConfig>): void;
}

export interface ConfigMutationServices {
  refreshConfigDependentRuntimes: () => Promise<void>;
  persistConfigFile: (nextConfig: AgentConfig) => void;
}

export interface ConfigMutationOptions {
  updates: Partial<AgentConfig>;
  afterPersist?: (nextConfig: AgentConfig) => void | Promise<void>;
}

export function cloneAgentConfig<T>(config: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(config)
    : (JSON.parse(JSON.stringify(config)) as T);
}

export class ConfigMutationService {
  constructor(
    private readonly agent: ConfigMutationAgent,
    private readonly services: ConfigMutationServices
  ) {}

  async apply(options: ConfigMutationOptions): Promise<AgentConfig> {
    const previousConfig = cloneAgentConfig(this.agent.getConfig());
    this.agent.updateConfig(options.updates);
    try {
      await this.services.refreshConfigDependentRuntimes();
      const nextConfig = this.agent.getConfig();
      this.services.persistConfigFile(nextConfig);
      await options.afterPersist?.(nextConfig);
      return nextConfig;
    } catch (error) {
      this.rollback(previousConfig);
      throw error;
    }
  }

  private rollback(previousConfig: AgentConfig): void {
    this.agent.updateConfig({
      api: previousConfig.api,
      llmProfiles: previousConfig.llmProfiles,
      agent: buildRollbackAgentConfig(previousConfig.agent),
      mcp: previousConfig.mcp,
      toolsets: previousConfig.toolsets,
      contextBudget: previousConfig.contextBudget,
      web: previousConfig.web,
      remoteAccessAuth: previousConfig.remoteAccessAuth,
      agentProviders: previousConfig.agentProviders,
    });
    try {
      this.services.persistConfigFile(previousConfig);
    } catch {
      // Keep the request failure focused on the original refresh/persist error.
    }
  }
}

function buildRollbackAgentConfig(agent: AgentConfig['agent']): AgentConfig['agent'] {
  return {
    ...agent,
    completionMarkerEnforcementEnabled: agent.completionMarkerEnforcementEnabled,
    defaultToolset: agent.defaultToolset,
    contextReplayMinRounds: agent.contextReplayMinRounds,
    contextReplayMaxRounds: agent.contextReplayMaxRounds,
    contextReplayBudgetRatio: agent.contextReplayBudgetRatio,
    contextOverflowMaxErrorsBeforeTrim: agent.contextOverflowMaxErrorsBeforeTrim,
    contextDir: agent.contextDir,
    runtimeDataDir: agent.runtimeDataDir,
    systemPromptPath: agent.systemPromptPath,
    skillsDir: agent.skillsDir,
    globalAgentsDir: agent.globalAgentsDir,
  };
}

export function serializeLlmProfile(profile: LlmProviderProfileConfig): PublicLlmProfile {
  const { apiKey, ...rest } = profile;
  return {
    ...rest,
    hasApiKey: String(apiKey ?? '').trim().length > 0,
  };
}

export function serializeLlmProfiles(config: AgentConfig): LlmProfilesConfigView {
  const llmProfiles = normalizeLlmProfilesConfig(config);
  return {
    defaultProfileId: llmProfiles.defaultProfileId,
    profiles: llmProfiles.profiles.map((profile) => serializeLlmProfile(profile)),
  };
}

function getRemoteAccessAuthView(config: AgentConfig): RemoteAccessAuthView {
  const authConfig = config.remoteAccessAuth ?? DEFAULT_REMOTE_ACCESS_AUTH_CONFIG;
  return {
    enabled: authConfig.enabled,
    configured: !!(authConfig.passwordHash && authConfig.passwordSalt),
    sessionTtlMs: authConfig.sessionTtlMs,
    trustProxy: authConfig.trustProxy,
  };
}

function getContextBudgetView(config: AgentConfig) {
  return config.contextBudget ?? createDefaultContextBudgetConfig();
}

export function buildPublicSettingsView(
  config: AgentConfig,
  hasUsableApiKey: boolean
): PublicSettingsView {
  const budget = getContextBudgetView(config);
  return {
    hasApiKey: hasUsableApiKey,
    llmProfiles: serializeLlmProfiles(config),
    contextBudget: budget,
    web: {
      sessionShareTtlHours: config.web?.sessionShareTtlHours ?? DEFAULT_SESSION_SHARE_TTL_HOURS,
    },
    agent: {
      workspaceDir: config.agent.workspaceDir,
      skillsDir: config.agent.skillsDir || '',
      globalAgentsDir: config.agent.globalAgentsDir || '',
      maxSteps: config.agent.maxSteps,
      completionMarkerEnforcementEnabled:
        config.agent.completionMarkerEnforcementEnabled === true,
      defaultToolset: config.agent.defaultToolset || 'windows-dev',
      contextReplayMinRounds: config.agent.contextReplayMinRounds ?? 6,
      contextReplayMaxRounds: config.agent.contextReplayMaxRounds ?? 12,
      contextReplayBudgetRatio: config.agent.contextReplayBudgetRatio ?? 0.55,
    },
    remoteAccessAuth: getRemoteAccessAuthView(config),
  };
}
