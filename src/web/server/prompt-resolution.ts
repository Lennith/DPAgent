import {
  buildPromptWithAgentProfileBootstrap,
  buildPromptWithAgentProfileReference,
  parseLeadingAgentMention,
  type AgentProfile,
} from '../../agents/index.js';
import type { ContextNamespaceMeta } from '../../types.js';

export interface PromptResolutionInput {
  prompt: string;
  selectedAgentName?: string;
  usePlanMode?: boolean;
  currentAgentInjectionState?: ContextNamespaceMeta['agentInjectionState'];
  globalAgentProfilesByName: ReadonlyMap<string, AgentProfile>;
  loadWorkspaceProfile: () => AgentProfile | null;
  planModePromptPrefix: string;
}

export interface PromptResolutionInjectedAgent {
  source: 'workspace' | 'global';
  name: string;
  path: string;
}

export type PromptResolutionProfileInjectionMode = 'initial' | 'switch' | 'none';

export type PromptResolutionStateUpdate = Partial<
  NonNullable<ContextNamespaceMeta['agentInjectionState']>
>;

export interface PromptResolutionSuccessResult {
  ok: true;
  displayPrompt: string;
  effectiveUserPrompt: string;
  historyUserPrompt: string;
  profileInjectionMode: PromptResolutionProfileInjectionMode;
  hasSystemPromptInjection: boolean;
  promptRef?: string;
  activeAgent?: PromptResolutionInjectedAgent;
  agentInjectionState: PromptResolutionStateUpdate;
}

export type PromptResolutionResult =
  | PromptResolutionSuccessResult
  | {
      ok: false;
      error: string;
    };

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function applyPlanMode(prompt: string, input: PromptResolutionInput): string {
  if (input.usePlanMode !== true) {
    return prompt;
  }
  return `${input.planModePromptPrefix}\n\n${prompt}`;
}

function encodePromptRefPart(value: string | undefined): string | undefined {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return undefined;
  }
  return encodeURIComponent(normalized);
}

function buildPromptReference(options: {
  reason:
    | 'selected_agent'
    | 'mentioned_agent'
    | 'workspace_agent'
    | 'cleared_agent'
    | 'plan_mode'
    | 'system_injection';
  source?: 'global' | 'workspace' | 'plan_mode' | 'system';
  agentName?: string;
  profilePath?: string;
  injectionMode?: PromptResolutionProfileInjectionMode;
  planMode?: boolean;
}): string {
  const parts: string[] = ['[PROMPT_REF'];
  parts.push(`reason=${options.reason}`);
  if (options.source) {
    parts.push(`source=${options.source}`);
  }
  const encodedName = encodePromptRefPart(options.agentName);
  if (encodedName) {
    parts.push(`name=${encodedName}`);
  }
  const encodedPath = encodePromptRefPart(options.profilePath);
  if (encodedPath) {
    parts.push(`path=${encodedPath}`);
  }
  if (options.injectionMode && options.injectionMode !== 'none') {
    parts.push(`injection_mode=${options.injectionMode}`);
  }
  if (options.planMode === true) {
    parts.push('plan_mode=true');
  }
  parts.push(']');
  return parts.join(' ');
}

function findGlobalAgentProfile(
  profiles: ReadonlyMap<string, AgentProfile>,
  name: string
): AgentProfile | undefined {
  const normalized = normalizeAgentName(name);
  if (!normalized) {
    return undefined;
  }
  return profiles.get(normalized);
}

function toInjectedAgent(profile: Pick<AgentProfile, 'source' | 'name' | 'path'>): PromptResolutionInjectedAgent {
  return {
    source: profile.source,
    name: profile.name,
    path: profile.path,
  };
}

function sameInjectedAgent(
  left: PromptResolutionInjectedAgent | undefined,
  right: PromptResolutionInjectedAgent | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.source === right.source && left.name === right.name && left.path === right.path;
}

function resolveCurrentActiveAgent(
  current: ContextNamespaceMeta['agentInjectionState'],
  globalAgentProfilesByName: ReadonlyMap<string, AgentProfile>,
  workspaceProfile: AgentProfile | null
): PromptResolutionInjectedAgent | undefined {
  if (!current) {
    return undefined;
  }
  if (current.lastProfileSource === 'workspace') {
    return workspaceProfile ? toInjectedAgent(workspaceProfile) : undefined;
  }
  if (current.lastProfileSource === 'global') {
    const preferredName = String(current.lastExplicitAgentName ?? current.lastProfileName ?? '').trim();
    const resolvedProfile = preferredName
      ? findGlobalAgentProfile(globalAgentProfilesByName, preferredName)
      : undefined;
    if (resolvedProfile) {
      return toInjectedAgent(resolvedProfile);
    }
    const name = String(current.lastProfileName ?? '').trim();
    const path = String(current.lastProfilePath ?? '').trim();
    if (name && path) {
      return {
        source: 'global',
        name,
        path,
      };
    }
  }
  return undefined;
}

function buildStateUpdate(
  activeAgent: PromptResolutionInjectedAgent | undefined,
  explicitAgentName?: string
): PromptResolutionStateUpdate {
  return {
    lastProfilePath: activeAgent?.path ?? '',
    lastProfileName: activeAgent?.name ?? '',
    lastProfileSource: activeAgent?.source,
    lastExplicitAgentName: explicitAgentName,
  };
}

function buildResolvedPromptResult(input: {
  displayPrompt: string;
  effectiveUserPrompt: string;
  historyUserPrompt: string;
  profileInjectionMode: PromptResolutionProfileInjectionMode;
  promptRef?: string;
  activeAgent?: PromptResolutionInjectedAgent;
  agentInjectionState: PromptResolutionStateUpdate;
}): PromptResolutionSuccessResult {
  return {
    ok: true,
    displayPrompt: input.displayPrompt,
    effectiveUserPrompt: input.effectiveUserPrompt,
    historyUserPrompt: input.historyUserPrompt,
    profileInjectionMode: input.profileInjectionMode,
    hasSystemPromptInjection: input.effectiveUserPrompt !== input.displayPrompt,
    promptRef: input.promptRef,
    activeAgent: input.activeAgent,
    agentInjectionState: input.agentInjectionState,
  };
}

export function mergeAgentInjectionState(
  current: ContextNamespaceMeta['agentInjectionState'],
  next: PromptResolutionStateUpdate,
  updatedAt: string = new Date().toISOString()
): NonNullable<ContextNamespaceMeta['agentInjectionState']> {
  return {
    lastProfilePath: current?.lastProfilePath,
    lastProfileName: current?.lastProfileName,
    lastProfileSource: current?.lastProfileSource,
    lastExplicitAgentName: current?.lastExplicitAgentName,
    ...next,
    updatedAt,
  };
}

export function resolvePromptWithProfiles(input: PromptResolutionInput): PromptResolutionResult {
  const trimmedPrompt = String(input.prompt ?? '').trim();
  if (!trimmedPrompt) {
    return { ok: false, error: 'Prompt cannot be empty' };
  }

  const workspaceProfile = input.loadWorkspaceProfile();
  const currentActiveAgent = resolveCurrentActiveAgent(
    input.currentAgentInjectionState,
    input.globalAgentProfilesByName,
    workspaceProfile
  );
  const currentExplicitAgentName = String(input.currentAgentInjectionState?.lastExplicitAgentName ?? '').trim();
  const selectedAgentName = String(input.selectedAgentName ?? '').trim();
  const planModePrompt = applyPlanMode(trimmedPrompt, input);

  if (selectedAgentName) {
    const selectedProfile = findGlobalAgentProfile(input.globalAgentProfilesByName, selectedAgentName);
    if (!selectedProfile) {
      return { ok: false, error: `selected_agent_invalid: ${selectedAgentName}` };
    }
    const selectedAgent = toInjectedAgent(selectedProfile);
    const profileInjectionMode = currentActiveAgent
      ? sameInjectedAgent(currentActiveAgent, selectedAgent)
        ? 'none'
        : 'switch'
      : 'initial';
    const displayPrompt = trimmedPrompt;
    const effectiveUserPrompt =
      profileInjectionMode === 'none'
        ? applyPlanMode(displayPrompt, input)
        : buildPromptWithAgentProfileBootstrap(planModePrompt, selectedProfile);
    const historyUserPrompt =
      profileInjectionMode === 'none'
        ? displayPrompt
        : buildPromptWithAgentProfileReference(displayPrompt, selectedProfile);
    return buildResolvedPromptResult({
      displayPrompt,
      effectiveUserPrompt,
      historyUserPrompt,
      profileInjectionMode,
      promptRef:
        profileInjectionMode !== 'none'
          ? buildPromptReference({
              reason: 'selected_agent',
              source: 'global',
              agentName: selectedProfile.name,
              profilePath: selectedProfile.path,
              injectionMode: profileInjectionMode,
              planMode: input.usePlanMode === true,
            })
          : effectiveUserPrompt !== displayPrompt
            ? buildPromptReference({
                reason: 'plan_mode',
                source: 'plan_mode',
                planMode: true,
              })
            : undefined,
      activeAgent: selectedAgent,
      agentInjectionState: buildStateUpdate(selectedAgent, selectedProfile.name),
    });
  }

  const mention = parseLeadingAgentMention(trimmedPrompt);
  const mentionedProfile = mention.mentionName
    ? findGlobalAgentProfile(input.globalAgentProfilesByName, mention.mentionName)
    : undefined;
  const displayPrompt = mentionedProfile ? mention.strippedPrompt.trim() : trimmedPrompt;
  if (mentionedProfile && !displayPrompt) {
    return { ok: false, error: `Please enter a message after @${mentionedProfile.name}` };
  }

  if (mentionedProfile) {
    const nextActiveAgent = toInjectedAgent(mentionedProfile);
    const profileInjectionMode = currentActiveAgent
      ? sameInjectedAgent(currentActiveAgent, nextActiveAgent)
        ? 'none'
        : 'switch'
      : 'initial';
    const effectiveUserPrompt =
      profileInjectionMode === 'none'
        ? applyPlanMode(displayPrompt, input)
        : buildPromptWithAgentProfileBootstrap(applyPlanMode(displayPrompt, input), mentionedProfile);
    const historyUserPrompt =
      profileInjectionMode === 'none'
        ? displayPrompt
        : buildPromptWithAgentProfileReference(displayPrompt, mentionedProfile);
    return buildResolvedPromptResult({
      displayPrompt,
      effectiveUserPrompt,
      historyUserPrompt,
      profileInjectionMode,
      promptRef:
        profileInjectionMode !== 'none'
          ? buildPromptReference({
              reason: 'mentioned_agent',
              source: 'global',
              agentName: mentionedProfile.name,
              profilePath: mentionedProfile.path,
              injectionMode: profileInjectionMode,
              planMode: input.usePlanMode === true,
            })
          : effectiveUserPrompt !== displayPrompt
            ? buildPromptReference({
                reason: 'plan_mode',
                source: 'plan_mode',
                planMode: true,
              })
            : undefined,
      activeAgent: nextActiveAgent,
      agentInjectionState: buildStateUpdate(nextActiveAgent, mentionedProfile.name),
    });
  }

  if (currentExplicitAgentName) {
    const nextActiveAgent = workspaceProfile ? toInjectedAgent(workspaceProfile) : undefined;
    const profileInjectionMode =
      nextActiveAgent && currentActiveAgent && !sameInjectedAgent(currentActiveAgent, nextActiveAgent)
        ? 'switch'
        : nextActiveAgent && !currentActiveAgent
          ? 'initial'
          : 'none';
    const effectiveUserPrompt =
      nextActiveAgent && profileInjectionMode !== 'none'
        ? buildPromptWithAgentProfileBootstrap(planModePrompt, workspaceProfile as AgentProfile)
        : planModePrompt;
    const historyUserPrompt =
      nextActiveAgent && profileInjectionMode !== 'none'
        ? buildPromptWithAgentProfileReference(displayPrompt, workspaceProfile as AgentProfile)
        : displayPrompt;
    return buildResolvedPromptResult({
      displayPrompt,
      effectiveUserPrompt,
      historyUserPrompt,
      profileInjectionMode,
      promptRef:
        nextActiveAgent && profileInjectionMode !== 'none'
          ? buildPromptReference({
              reason: 'workspace_agent',
              source: 'workspace',
              agentName: nextActiveAgent.name,
              profilePath: nextActiveAgent.path,
              injectionMode: profileInjectionMode,
              planMode: input.usePlanMode === true,
            })
          : effectiveUserPrompt !== displayPrompt
            ? buildPromptReference({
                reason: workspaceProfile ? 'cleared_agent' : 'plan_mode',
                source: workspaceProfile ? 'workspace' : 'plan_mode',
                planMode: input.usePlanMode === true,
              })
            : undefined,
      activeAgent: nextActiveAgent,
      agentInjectionState: buildStateUpdate(nextActiveAgent, undefined),
    });
  }

  if (!currentActiveAgent && workspaceProfile) {
    const nextActiveAgent = toInjectedAgent(workspaceProfile);
    return buildResolvedPromptResult({
      displayPrompt,
      effectiveUserPrompt: buildPromptWithAgentProfileBootstrap(planModePrompt, workspaceProfile),
      historyUserPrompt: buildPromptWithAgentProfileReference(displayPrompt, workspaceProfile),
      profileInjectionMode: 'initial',
      promptRef: buildPromptReference({
        reason: 'workspace_agent',
        source: 'workspace',
        agentName: workspaceProfile.name,
        profilePath: workspaceProfile.path,
        injectionMode: 'initial',
        planMode: input.usePlanMode === true,
      }),
      activeAgent: nextActiveAgent,
      agentInjectionState: buildStateUpdate(nextActiveAgent, undefined),
    });
  }

  const activeAgent =
    currentActiveAgent?.source === 'workspace' && workspaceProfile
      ? toInjectedAgent(workspaceProfile)
      : currentActiveAgent;
  const effectiveUserPrompt = applyPlanMode(displayPrompt, input);
  return buildResolvedPromptResult({
    displayPrompt,
    effectiveUserPrompt,
    historyUserPrompt: displayPrompt,
    profileInjectionMode: 'none',
    promptRef:
      effectiveUserPrompt !== displayPrompt
        ? buildPromptReference({
            reason: 'plan_mode',
            source: 'plan_mode',
            planMode: true,
          })
        : undefined,
    activeAgent,
    agentInjectionState: buildStateUpdate(
      activeAgent,
      currentExplicitAgentName || (activeAgent?.source === 'global' ? activeAgent.name : undefined)
    ),
  });
}
