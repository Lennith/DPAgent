import {
  buildPromptWithAgentProfileReference,
  parseLeadingAgentMention,
  toAgentRuntimeOverrides,
  type AgentProfile,
} from '../../agents/AgentProfiles.js';
import type { AgentRuntimeOverrides, ContextNamespaceMeta, SessionPlanningState } from '../../types.js';

export interface PromptResolutionInput {
  prompt: string;
  fileReferences?: string[];
  selectedAgentName?: string;
  planningState?: SessionPlanningState;
  currentAgentInjectionState?: ContextNamespaceMeta['agentInjectionState'];
  globalAgentProfilesByName: ReadonlyMap<string, AgentProfile>;
  loadWorkspaceProfile: () => AgentProfile | null;
  planModePromptPrefix: string;
}

export interface PromptResolutionInjectedAgent {
  source: 'workspace' | 'global' | 'bundled';
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
  agentRuntimeOverrides?: AgentRuntimeOverrides;
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
  if (input.planningState !== 'plan_drafting') {
    return prompt;
  }
  return `${input.planModePromptPrefix}\n\n${prompt}`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeFileReferences(references: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const reference of references ?? []) {
    const trimmed = String(reference ?? '').trim();
    if (!trimmed) {
      continue;
    }
    const dedupeKey = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed)
      ? trimmed.toLowerCase()
      : trimmed;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }
  return normalized;
}

export function buildFileReferencesPromptBlock(references: readonly string[] | undefined): string {
  const normalized = normalizeFileReferences(references);
  if (normalized.length === 0) {
    return '';
  }
  return [
    '<refs_file_for_this_turn>',
    ...normalized.map((reference) => `  <file path="${escapeXmlAttribute(reference)}" />`),
    '</refs_file_for_this_turn>',
  ].join('\n');
}

function applyFileReferences(prompt: string, references: readonly string[] | undefined): string {
  const block = buildFileReferencesPromptBlock(references);
  if (!block) {
    return prompt;
  }
  return `${block}\n\n${prompt}`;
}

function isFileReferenceDirectiveMention(mentionName: string | undefined): boolean {
  return normalizeAgentName(String(mentionName ?? '')) === 'file';
}

function isPlanDrafting(input: PromptResolutionInput): boolean {
  return input.planningState === 'plan_drafting';
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
  source?: 'bundled' | 'global' | 'workspace' | 'plan_mode' | 'system';
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
  if (current.lastProfileSource === 'global' || current.lastProfileSource === 'bundled') {
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
        source: current.lastProfileSource,
        name,
        path,
      };
    }
  }
  return undefined;
}

function resolveCurrentActiveAgentProfile(
  current: ContextNamespaceMeta['agentInjectionState'],
  globalAgentProfilesByName: ReadonlyMap<string, AgentProfile>,
  workspaceProfile: AgentProfile | null
): AgentProfile | undefined {
  if (!current) {
    return undefined;
  }
  if (current.lastProfileSource === 'workspace') {
    return workspaceProfile ?? undefined;
  }
  if (current.lastProfileSource === 'global' || current.lastProfileSource === 'bundled') {
    const preferredName = String(current.lastExplicitAgentName ?? current.lastProfileName ?? '').trim();
    return preferredName ? findGlobalAgentProfile(globalAgentProfilesByName, preferredName) : undefined;
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
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  agentInjectionState: PromptResolutionStateUpdate;
  fileReferences?: readonly string[];
}): PromptResolutionSuccessResult {
  const effectiveUserPrompt = applyFileReferences(input.effectiveUserPrompt, input.fileReferences);
  return {
    ok: true,
    displayPrompt: input.displayPrompt,
    effectiveUserPrompt,
    historyUserPrompt: input.historyUserPrompt,
    profileInjectionMode: input.profileInjectionMode,
    hasSystemPromptInjection: Boolean(input.promptRef) || effectiveUserPrompt !== input.displayPrompt,
    promptRef: input.promptRef,
    activeAgent: input.activeAgent,
    agentRuntimeOverrides: input.agentRuntimeOverrides,
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
  const currentActiveAgentProfile = resolveCurrentActiveAgentProfile(
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
        : planModePrompt;
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
              source: selectedProfile.source,
              agentName: selectedProfile.name,
              profilePath: selectedProfile.path,
              injectionMode: profileInjectionMode,
              planMode: isPlanDrafting(input),
            })
          : effectiveUserPrompt !== displayPrompt
            ? buildPromptReference({
                reason: 'plan_mode',
                source: 'plan_mode',
                planMode: isPlanDrafting(input),
              })
            : undefined,
      activeAgent: selectedAgent,
      agentRuntimeOverrides: toAgentRuntimeOverrides(selectedProfile),
      agentInjectionState: buildStateUpdate(selectedAgent, selectedProfile.name),
      fileReferences: input.fileReferences,
    });
  }

  const mention = parseLeadingAgentMention(trimmedPrompt);
  const mentionedProfile = mention.mentionName && !isFileReferenceDirectiveMention(mention.mentionName)
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
        : applyPlanMode(displayPrompt, input);
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
              source: mentionedProfile.source,
              agentName: mentionedProfile.name,
              profilePath: mentionedProfile.path,
              injectionMode: profileInjectionMode,
              planMode: isPlanDrafting(input),
            })
          : effectiveUserPrompt !== displayPrompt
            ? buildPromptReference({
                reason: 'plan_mode',
                source: 'plan_mode',
                planMode: isPlanDrafting(input),
              })
            : undefined,
      activeAgent: nextActiveAgent,
      agentRuntimeOverrides: toAgentRuntimeOverrides(mentionedProfile),
      agentInjectionState: buildStateUpdate(nextActiveAgent, mentionedProfile.name),
      fileReferences: input.fileReferences,
    });
  }

  if (currentExplicitAgentName) {
    return buildResolvedPromptResult({
      displayPrompt,
      effectiveUserPrompt: planModePrompt,
      historyUserPrompt: displayPrompt,
      profileInjectionMode: 'none',
      promptRef:
        currentActiveAgent
          ? buildPromptReference({
              reason: 'cleared_agent',
              source: currentActiveAgent.source,
              agentName: currentActiveAgent.name,
              profilePath: currentActiveAgent.path,
              planMode: isPlanDrafting(input),
            })
          : planModePrompt !== displayPrompt
            ? buildPromptReference({
                reason: 'plan_mode',
                source: 'plan_mode',
                planMode: isPlanDrafting(input),
              })
            : undefined,
      activeAgent: undefined,
      agentRuntimeOverrides: undefined,
      agentInjectionState: buildStateUpdate(undefined, undefined),
      fileReferences: input.fileReferences,
    });
  }

  const activeAgent =
    currentActiveAgent?.source === 'workspace'
      ? undefined
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
            planMode: isPlanDrafting(input),
          })
        : undefined,
    activeAgent,
    agentRuntimeOverrides:
      activeAgent?.source === 'global' || activeAgent?.source === 'bundled'
        ? toAgentRuntimeOverrides(currentActiveAgentProfile)
        : undefined,
    agentInjectionState: buildStateUpdate(
      activeAgent,
      currentExplicitAgentName ||
        (activeAgent?.source === 'global' || activeAgent?.source === 'bundled' ? activeAgent.name : undefined)
    ),
    fileReferences: input.fileReferences,
  });
}
