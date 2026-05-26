import type { PublicSettingsView } from '../app-shell-types.js';
import {
  REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
} from '../../../shared/remote-access-auth-defaults.js';
import {
  DEFAULT_SESSION_SHARE_TTL_HOURS,
  normalizeSessionShareTtlHours,
} from '../../../shared/session-share-defaults.js';
import {
  charsToTokenHint,
  tokensToCharHint,
} from '../../../shared/context-token-estimation.js';

export interface SettingsDraft {
  skillsDir: string;
  globalAgentsDir: string;
  completionMarkerEnforcementEnabled: boolean;
  maxSteps: number;
  authEnabled: boolean;
  authConfigured: boolean;
  authPassword: string;
  authClearPassword: boolean;
  authSessionTtlMs: number;
  authTrustProxy: boolean;
  sessionShareTtlHours: number;
  ctxReplayMinRounds: number;
  ctxReplayMaxRounds: number;
  ctxReplayBudgetRatio: number;
  ctxWindowTokens: number;
  ctxPrecompressTriggerRatio: number;
  ctxPrecompressKeepLlmRounds: number;
  ctxPrecompressChunkTokens: number;
  ctxCompressionMaxTokens: number;
}

export interface SettingsDraftState {
  initial: SettingsDraft;
  draft: SettingsDraft;
}

export type SettingsDraftAction =
  | { type: 'reset'; value: SettingsDraft }
  | { type: 'patch'; patch: Partial<SettingsDraft> };

export function createDefaultSettingsDraft(): SettingsDraft {
  return {
    skillsDir: '',
    globalAgentsDir: '',
    completionMarkerEnforcementEnabled: false,
    maxSteps: 100,
    authEnabled: false,
    authConfigured: false,
    authPassword: '',
    authClearPassword: false,
    authSessionTtlMs: REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
    authTrustProxy: false,
    sessionShareTtlHours: DEFAULT_SESSION_SHARE_TTL_HOURS,
    ctxReplayMinRounds: 6,
    ctxReplayMaxRounds: 12,
    ctxReplayBudgetRatio: 0.55,
    ctxWindowTokens: 230000,
    ctxPrecompressTriggerRatio: 0.9,
    ctxPrecompressKeepLlmRounds: 5,
    ctxPrecompressChunkTokens: charsToTokenHint(60000),
    ctxCompressionMaxTokens: charsToTokenHint(6000),
  };
}

export function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function optionalPositiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function createSettingsDraftFromResponse(settings: PublicSettingsView): SettingsDraft {
  const contextBudget = settings.contextBudget ?? {};
  const defaultContextWindowTokens = numberOrDefault(contextBudget.defaultContextWindowTokens, 230000);
  return {
    skillsDir: String(settings.agent?.skillsDir ?? ''),
    globalAgentsDir: String(settings.agent?.globalAgentsDir ?? ''),
    completionMarkerEnforcementEnabled: settings.agent?.completionMarkerEnforcementEnabled === true,
    maxSteps:
      typeof settings.agent?.maxSteps === 'number' && Number.isFinite(settings.agent.maxSteps)
        ? Math.max(1, Math.floor(settings.agent.maxSteps))
        : 100,
    authEnabled: settings.remoteAccessAuth?.enabled === true,
    authConfigured: settings.remoteAccessAuth?.configured === true,
    authPassword: '',
    authClearPassword: false,
    authSessionTtlMs:
      settings.remoteAccessAuth?.sessionTtlMs ?? REMOTE_ACCESS_AUTH_DEFAULT_SESSION_TTL_MS,
    authTrustProxy: settings.remoteAccessAuth?.trustProxy === true,
    sessionShareTtlHours: numberOrDefault(
      settings.web?.sessionShareTtlHours,
      DEFAULT_SESSION_SHARE_TTL_HOURS
    ),
    ctxReplayMinRounds: numberOrDefault(settings.agent?.contextReplayMinRounds, 6),
    ctxReplayMaxRounds: numberOrDefault(settings.agent?.contextReplayMaxRounds, 12),
    ctxReplayBudgetRatio: numberOrDefault(settings.agent?.contextReplayBudgetRatio, 0.55),
    ctxWindowTokens: defaultContextWindowTokens,
    ctxPrecompressTriggerRatio: numberOrDefault(contextBudget.compressionTriggerRatio, 0.9),
    ctxPrecompressKeepLlmRounds: numberOrDefault(contextBudget.precompressKeepLlmRounds, 5),
    ctxPrecompressChunkTokens: charsToTokenHint(numberOrDefault(contextBudget.precompressChunkChars, 60000)),
    ctxCompressionMaxTokens: charsToTokenHint(numberOrDefault(contextBudget.compressionMaxChars, 6000)),
  };
}

export function settingsDraftReducer(state: SettingsDraftState, action: SettingsDraftAction): SettingsDraftState {
  switch (action.type) {
    case 'reset':
      return { initial: action.value, draft: action.value };
    case 'patch':
      return { ...state, draft: { ...state.draft, ...action.patch } };
    default:
      return state;
  }
}

export function buildAgentSettingsPayload(draft: SettingsDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    skillsDir: draft.skillsDir,
    globalAgentsDir: draft.globalAgentsDir,
    completionMarkerEnforcementEnabled: draft.completionMarkerEnforcementEnabled,
    maxSteps: draft.maxSteps,
    contextReplayMinRounds: draft.ctxReplayMinRounds,
    contextReplayMaxRounds: draft.ctxReplayMaxRounds,
    contextReplayBudgetRatio: draft.ctxReplayBudgetRatio,
    contextBudget: {
      defaultContextWindowTokens: Math.max(1, Math.floor(draft.ctxWindowTokens)),
      compressionTriggerRatio: draft.ctxPrecompressTriggerRatio,
      precompressKeepLlmRounds: draft.ctxPrecompressKeepLlmRounds,
      precompressChunkChars: tokensToCharHint(draft.ctxPrecompressChunkTokens),
      compressionMaxChars: tokensToCharHint(draft.ctxCompressionMaxTokens),
    },
    web: {
      sessionShareTtlHours: normalizeSessionShareTtlHours(draft.sessionShareTtlHours),
    },
  };
  if (draft.authClearPassword) {
    payload.remoteAccessAuth = {
      enabled: draft.authEnabled,
      clearPassword: true,
      sessionTtlMs: draft.authSessionTtlMs,
      trustProxy: draft.authTrustProxy,
    };
  } else if (draft.authPassword.length > 0) {
    payload.remoteAccessAuth = {
      enabled: draft.authEnabled,
      password: draft.authPassword,
      sessionTtlMs: draft.authSessionTtlMs,
      trustProxy: draft.authTrustProxy,
    };
  } else {
    payload.remoteAccessAuth = {
      enabled: draft.authEnabled,
      sessionTtlMs: draft.authSessionTtlMs,
      trustProxy: draft.authTrustProxy,
    };
  }
  return payload;
}
