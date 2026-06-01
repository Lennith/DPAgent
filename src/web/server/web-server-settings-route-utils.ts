import type { DPAgent } from '../../dpagent-runtime.js';
import { normalizeLlmProfilesConfig } from '../../llm/provider-profiles.js';
import { cloneContextBudgetConfig } from '../../runtime/context-window-budget.js';
import type {
  AgentConfig,
  LlmProfilesConfig,
  LlmProviderProfileConfig,
} from '../../types.js';
import { normalizeSessionShareTtlHours } from '../../shared/session-share-defaults.js';
import {
  DEFAULT_WORKSPACE_TIMELINE_CONFIG,
  normalizeWorkspaceTimelineConfig,
} from '../../workspace-timeline/index.js';
import type {
  LlmProfileMutationView,
  SettingsMutationRequest,
} from '../../shared/web-settings-contracts.js';
import { DEFAULT_REMOTE_ACCESS_AUTH_CONFIG, hashPassword } from './remote-access-auth.js';

type LlmProfileMutationInput = LlmProfileMutationView;

export class RouteValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function findLlmProfile(config: AgentConfig, profileId: string): LlmProviderProfileConfig | undefined {
  const trimmedId = String(profileId ?? '').trim();
  if (!trimmedId) {
    return undefined;
  }
  return normalizeLlmProfilesConfig(config).profiles.find((profile) => profile.id === trimmedId);
}

export function resolveDiscoveryProfileDraft(
  profileId: string,
  persistedProfile: LlmProviderProfileConfig | undefined,
  draft: LlmProfileMutationInput | undefined
): LlmProviderProfileConfig | undefined {
  if (!persistedProfile && !draft) {
    return undefined;
  }

  const provider =
    draft?.provider === 'openai' || draft?.provider === 'anthropic'
      ? draft.provider
      : persistedProfile?.provider ?? 'anthropic';
  const id = String(draft?.id ?? profileId ?? persistedProfile?.id ?? '').trim();
  const now = new Date().toISOString();

  const defaultModel =
    String(draft?.defaultModel ?? persistedProfile?.defaultModel ?? '').trim();

  return {
    id,
    name: String(draft?.name ?? persistedProfile?.name ?? id).trim() || id,
    provider,
    apiKey: String(draft?.apiKey ?? persistedProfile?.apiKey ?? '').trim(),
    apiBase:
      String(draft?.apiBase ?? persistedProfile?.apiBase ?? '').trim(),
    defaultModel,
    availableModels: Array.isArray(draft?.availableModels)
      ? draft.availableModels
      : persistedProfile?.availableModels ?? [defaultModel],
    maxOutputTokens:
      typeof draft?.maxOutputTokens === 'number'
        ? draft.maxOutputTokens
        : persistedProfile?.maxOutputTokens ?? 32768,
    contextWindowTokens:
      typeof draft?.contextWindowTokens === 'number' && Number.isFinite(draft.contextWindowTokens) && draft.contextWindowTokens > 0
        ? Math.floor(draft.contextWindowTokens)
        : draft?.contextWindowTokens === null
          ? undefined
          : persistedProfile?.contextWindowTokens,
    enabled: draft?.enabled ?? persistedProfile?.enabled ?? true,
    capabilities: draft?.capabilities ?? persistedProfile?.capabilities,
    createdAt: persistedProfile?.createdAt ?? now,
    updatedAt: draft?.updatedAt ?? persistedProfile?.updatedAt ?? now,
  };
}

function buildLlmProfilesUpdate(
  currentConfig: AgentConfig,
  body: Pick<SettingsMutationRequest, 'defaultProfileId' | 'profiles'>
): LlmProfilesConfig {
  if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
    throw new RouteValidationError('profiles must be a non-empty array');
  }

  const currentProfiles = normalizeLlmProfilesConfig(currentConfig);
  const currentById = new Map(currentProfiles.profiles.map((profile) => [profile.id, profile]));
  const seenProfileIds = new Set<string>();
  const now = new Date().toISOString();
  const nextProfiles = body.profiles.map((incoming, index) => {
    if (!incoming || typeof incoming !== 'object') {
      throw new RouteValidationError(`Profile at index ${index} must be an object`);
    }
    const id = String(incoming.id ?? '').trim();
    if (!id) {
      throw new RouteValidationError(`Profile at index ${index} is missing an id`);
    }
    if (seenProfileIds.has(id)) {
      throw new RouteValidationError(`Duplicate profile id: ${id}`);
    }
    seenProfileIds.add(id);
    if (
      incoming.provider !== undefined &&
      incoming.provider !== 'anthropic' &&
      incoming.provider !== 'openai'
    ) {
      throw new RouteValidationError(`Profile ${id} has invalid provider: ${String(incoming.provider)}`);
    }

    const existing = currentById.get(id);
    const providedApiKey =
      typeof incoming.apiKey === 'string' && incoming.apiKey.trim().length > 0
        ? incoming.apiKey.trim()
        : undefined;

    const defaultModel =
      String(incoming.defaultModel ?? existing?.defaultModel ?? '').trim() ||
      existing?.defaultModel ||
      '';

    return {
      id,
      name: String(incoming.name ?? existing?.name ?? '').trim() || existing?.name || id,
      provider:
        incoming.provider === 'anthropic' || incoming.provider === 'openai'
          ? incoming.provider
          : existing?.provider ?? 'anthropic',
      apiKey:
        incoming.clearApiKey === true
          ? ''
          : providedApiKey ?? existing?.apiKey ?? '',
      apiBase:
        String(incoming.apiBase ?? existing?.apiBase ?? '').trim() ||
        existing?.apiBase ||
        '',
      defaultModel,
      availableModels: Array.isArray(incoming.availableModels)
        ? incoming.availableModels
        : existing?.availableModels ?? [defaultModel],
      maxOutputTokens:
        typeof incoming.maxOutputTokens === 'number'
          ? incoming.maxOutputTokens
          : existing?.maxOutputTokens ?? 32768,
      contextWindowTokens:
        incoming.contextWindowTokens === null
          ? undefined
          : typeof incoming.contextWindowTokens === 'number' &&
              Number.isFinite(incoming.contextWindowTokens) &&
              incoming.contextWindowTokens > 0
            ? Math.floor(incoming.contextWindowTokens)
            : existing?.contextWindowTokens,
      enabled: incoming.enabled ?? existing?.enabled ?? true,
      capabilities: incoming.capabilities ?? existing?.capabilities,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } satisfies LlmProviderProfileConfig;
  });

  const requestedDefaultProfileId =
    String(body.defaultProfileId ?? '').trim() || currentProfiles.defaultProfileId;
  if (!nextProfiles.some((profile) => profile.id === requestedDefaultProfileId)) {
    throw new RouteValidationError(
      `defaultProfileId must reference one of the submitted profiles: ${requestedDefaultProfileId}`
    );
  }

  return normalizeLlmProfilesConfig({
    llmProfiles: {
      defaultProfileId: requestedDefaultProfileId,
      profiles: nextProfiles,
    },
  });
}

export function buildSettingsUpdates(
  currentConfig: AgentConfig,
  body: SettingsMutationRequest,
  deps: { agent: Pick<DPAgent, 'getToolsetRegistry'> }
): {
  updates: Partial<AgentConfig>;
  reloadSkills: boolean;
  refreshGlobalAgentCatalog: boolean;
  clearsBootMissingApiKey: boolean;
} {
  const nextAgent = { ...currentConfig.agent };
  let nextContextBudget = cloneContextBudgetConfig(currentConfig.contextBudget);
  const nextRemoteAccessAuth = {
    ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
    ...(currentConfig.remoteAccessAuth ?? {}),
  };
  const nextWeb = { ...(currentConfig.web ?? {}) };
  const nextWorkspaceTimeline = normalizeWorkspaceTimelineConfig(
    currentConfig.workspaceTimeline ?? DEFAULT_WORKSPACE_TIMELINE_CONFIG
  );
  const hasRemoteAccessAuthUpdate =
    typeof body.remoteAccessAuth === 'object' && body.remoteAccessAuth !== null;

  if (body.skillsDir !== undefined) nextAgent.skillsDir = body.skillsDir;
  if (body.globalAgentsDir !== undefined) nextAgent.globalAgentsDir = body.globalAgentsDir;
  if (body.defaultToolset !== undefined) {
    nextAgent.defaultToolset = deps.agent.getToolsetRegistry().get(body.defaultToolset).name;
  }
  if (body.completionMarkerEnforcementEnabled !== undefined) {
    nextAgent.completionMarkerEnforcementEnabled =
      body.completionMarkerEnforcementEnabled === true;
  }
  if (body.maxSteps !== undefined) {
    const v = Math.max(1, Math.floor(Number(body.maxSteps)));
    if (!Number.isFinite(v)) {
      throw new RouteValidationError('Invalid maxSteps.');
    }
    nextAgent.maxSteps = v;
  }

  if (body.contextReplayMinRounds !== undefined) {
    const v = Math.floor(Number(body.contextReplayMinRounds));
    if (!Number.isFinite(v) || v < 1) {
      throw new RouteValidationError('Invalid contextReplayMinRounds.');
    }
    nextAgent.contextReplayMinRounds = v;
  }
  if (body.contextReplayMaxRounds !== undefined) {
    const v = Math.floor(Number(body.contextReplayMaxRounds));
    if (!Number.isFinite(v) || v < 1) {
      throw new RouteValidationError('Invalid contextReplayMaxRounds.');
    }
    nextAgent.contextReplayMaxRounds = v;
  }
  if (body.contextReplayBudgetRatio !== undefined) {
    const v = Number(body.contextReplayBudgetRatio);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      throw new RouteValidationError('Invalid contextReplayBudgetRatio.');
    }
    nextAgent.contextReplayBudgetRatio = v;
  }

  const hasContextBudgetUpdate =
    typeof body.contextBudget === 'object' && body.contextBudget !== null;
  if (hasContextBudgetUpdate) {
    nextContextBudget = cloneContextBudgetConfig({
      ...nextContextBudget,
      ...body.contextBudget,
      modelOverrides: {
        ...(nextContextBudget.modelOverrides ?? {}),
        ...(body.contextBudget?.modelOverrides ?? {}),
      },
    });
  }

  if (hasRemoteAccessAuthUpdate && body.remoteAccessAuth) {
    if (typeof body.remoteAccessAuth.enabled === 'boolean') {
      nextRemoteAccessAuth.enabled = body.remoteAccessAuth.enabled;
    }
    if (typeof body.remoteAccessAuth.sessionTtlMs === 'number') {
      nextRemoteAccessAuth.sessionTtlMs = body.remoteAccessAuth.sessionTtlMs;
    }
    if (typeof body.remoteAccessAuth.trustProxy === 'boolean') {
      nextRemoteAccessAuth.trustProxy = body.remoteAccessAuth.trustProxy;
    }
    if (body.remoteAccessAuth.clearPassword === true) {
      delete nextRemoteAccessAuth.passwordHash;
      delete nextRemoteAccessAuth.passwordSalt;
    } else if (
      typeof body.remoteAccessAuth.password === 'string' &&
      body.remoteAccessAuth.password.trim().length > 0
    ) {
      const hashed = hashPassword(body.remoteAccessAuth.password.trim());
      nextRemoteAccessAuth.passwordHash = hashed.hash;
      nextRemoteAccessAuth.passwordSalt = hashed.salt;
    }
  }
  const hasWebUpdate = typeof body.web === 'object' && body.web !== null;
  if (hasWebUpdate && body.web) {
    if (body.web.sessionShareTtlHours !== undefined) {
      nextWeb.sessionShareTtlHours = normalizeSessionShareTtlHours(
        body.web.sessionShareTtlHours
      );
    }
  }
  const hasWorkspaceTimelineUpdate =
    typeof body.workspaceTimeline === 'object' && body.workspaceTimeline !== null;
  if (hasWorkspaceTimelineUpdate && body.workspaceTimeline) {
    if (typeof body.workspaceTimeline.enabled === 'boolean') {
      nextWorkspaceTimeline.enabled = body.workspaceTimeline.enabled;
    }
  }

  const updates: Partial<AgentConfig> = { agent: nextAgent };
  if (hasWebUpdate) {
    updates.web = nextWeb;
  }
  if (hasRemoteAccessAuthUpdate) {
    updates.remoteAccessAuth = nextRemoteAccessAuth;
  }
  if (hasContextBudgetUpdate) {
    updates.contextBudget = nextContextBudget;
  }
  if (hasWorkspaceTimelineUpdate) {
    updates.workspaceTimeline = nextWorkspaceTimeline;
  }
  if (Array.isArray(body.profiles)) {
    updates.llmProfiles = buildLlmProfilesUpdate(currentConfig, body);
  }

  return {
    updates,
    reloadSkills: body.skillsDir !== undefined,
    refreshGlobalAgentCatalog: body.globalAgentsDir !== undefined,
    clearsBootMissingApiKey: submittedProfilesContainApiKey(body),
  };
}

function submittedProfilesContainApiKey(body: Pick<SettingsMutationRequest, 'profiles'>): boolean {
  return Array.isArray(body.profiles)
    ? body.profiles.some(
        (profile) => typeof profile?.apiKey === 'string' && profile.apiKey.trim().length >= 20
      )
    : false;
}
