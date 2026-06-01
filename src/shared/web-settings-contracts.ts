import type {
  ContextBudgetConfig,
  LlmProviderProfileConfig,
  WorkspaceTimelineConfig,
} from '../types.js';

export type PublicLlmProfile = Omit<LlmProviderProfileConfig, 'apiKey'> & {
  hasApiKey: boolean;
};

export interface LlmProfilesConfigView {
  defaultProfileId: string;
  profiles: PublicLlmProfile[];
}

export type ContextBudgetView = ContextBudgetConfig;

export interface RemoteAccessAuthView {
  enabled?: boolean;
  configured: boolean;
  sessionTtlMs?: number;
  trustProxy?: boolean;
}

export interface PublicSettingsView {
  hasApiKey: boolean;
  llmProfiles: LlmProfilesConfigView;
  contextBudget: ContextBudgetView;
  web: {
    sessionShareTtlHours: number;
  };
  agent: {
    workspaceDir: string;
    skillsDir: string;
    globalAgentsDir: string;
    maxSteps: number;
    completionMarkerEnforcementEnabled: boolean;
    defaultToolset: string;
    contextReplayMinRounds: number;
    contextReplayMaxRounds: number;
    contextReplayBudgetRatio: number;
  };
  remoteAccessAuth: RemoteAccessAuthView;
  workspaceTimeline: Pick<WorkspaceTimelineConfig, 'enabled'>;
}

export type LlmProfileMutationView = Partial<LlmProviderProfileConfig> & {
  apiKey?: string;
  clearApiKey?: boolean;
  contextWindowTokens?: number | null;
};

export interface SettingsMutationRequest {
  defaultProfileId?: string;
  profiles?: LlmProfileMutationView[];
  skillsDir?: string;
  globalAgentsDir?: string;
  defaultToolset?: string;
  completionMarkerEnforcementEnabled?: boolean;
  maxSteps?: number;
  remoteAccessAuth?: {
    enabled?: boolean;
    password?: string;
    clearPassword?: boolean;
    sessionTtlMs?: number;
    trustProxy?: boolean;
  };
  web?: {
    sessionShareTtlHours?: number;
  };
  contextReplayMinRounds?: number;
  contextReplayMaxRounds?: number;
  contextReplayBudgetRatio?: number;
  contextBudget?: Partial<ContextBudgetConfig>;
  workspaceTimeline?: {
    enabled?: boolean;
  };
}
