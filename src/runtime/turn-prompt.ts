import {
  getCompletionMarkerRuleText,
  isCompletionMarkerEnforcementEnabled,
} from '../completion-marker-policy.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import type { SkillLoader } from '../skills/SkillLoader.js';
import type { TodoStore } from '../todo/index.js';
import type { ToolsetRegistry } from '../tools/index.js';
import type { AgentConfig, ContextRef, DPAgentRunOptions } from '../types.js';

export interface TurnPromptEnvelope {
  effectivePrompt: string;
  rawUserPrompt: string;
  historyUserPrompt: string;
  additionalSystemPrompt: string;
  promptReference?: string;
  hasSystemPromptInjection: boolean;
}

export function resolveTurnPromptEnvelope(options: DPAgentRunOptions): TurnPromptEnvelope {
  const effectivePrompt = String(options.effectivePrompt ?? options.prompt ?? '');
  const rawUserPrompt = String(options.rawUserPrompt ?? options.prompt ?? '');
  const historyUserPrompt = String(options.historyUserPrompt ?? rawUserPrompt);
  const additionalSystemPrompt = String(options.additionalSystemPrompt ?? '').trim();
  const providedPromptReference = normalizePromptReference(options.promptReference);
  const hasPromptMismatch = effectivePrompt !== rawUserPrompt || historyUserPrompt !== rawUserPrompt;
  const hasAdditionalSystemPrompt = additionalSystemPrompt.length > 0;
  const hasSystemPromptInjection =
    options.hasSystemPromptInjection === true ||
    Boolean(providedPromptReference) ||
    hasPromptMismatch ||
    hasAdditionalSystemPrompt;
  const promptReference = hasSystemPromptInjection
    ? providedPromptReference ??
      buildFallbackPromptReference({
        hasPromptMismatch,
        hasAdditionalSystemPrompt,
      })
    : undefined;
  return {
    effectivePrompt,
    rawUserPrompt,
    historyUserPrompt,
    additionalSystemPrompt,
    promptReference,
    hasSystemPromptInjection,
  };
}

export interface BuildTurnSystemPromptInput {
  config: AgentConfig;
  fullSystemPrompt: string;
  workspaceDir?: string;
  agentSkillDir?: string;
  includeGlobalSkills?: boolean;
  context: ContextRef;
  additionalSystemPrompt: string;
  activeAgentRoleSegment?: string;
  workspaceInstructionsSegment?: string;
  compressedHistorySegment?: string;
  systemSegment: string;
  interruptedSideEffectSegment?: string;
  resolveToolsetName: (context: ContextRef) => string;
  toolsetName?: string;
  toolsetRegistry: ToolsetRegistry;
  skillLoader: SkillLoader;
  memoryStore: MemoryStore;
  todoStore: TodoStore;
}

export function buildTurnSystemPrompt(input: BuildTurnSystemPromptInput): string {
  const requestedToolsetName = String(input.toolsetName ?? '').trim();
  const activeToolset = requestedToolsetName
    ? input.toolsetRegistry.requireToolset(requestedToolsetName, 'explicit toolsetName').name
    : input.resolveToolsetName(input.context);
  const activeToolsetDefinition = input.toolsetRegistry.requireToolset(activeToolset);
  const activeCapabilities = new Set(activeToolsetDefinition.capabilities.map((item) => item.toLowerCase()));
  const skillCatalogSegment = input.skillLoader.generateSkillCatalogPrompt({
    workspaceDir: input.workspaceDir,
    agentSkillDir: input.agentSkillDir,
    includeGlobalSkills: input.includeGlobalSkills,
    toolsetName: activeToolset,
    capabilities: {
      canListOrViewSkills: activeCapabilities.has('skills_catalog'),
      canManageSkills: activeCapabilities.has('skill_manage'),
    },
  });
  const memorySegment = input.memoryStore.getPromptSegment(input.workspaceDir);
  const todoSegment = input.todoStore.getPromptSegment({
    sessionId: input.context.scope === 'session' ? input.context.namespace : undefined,
    workspaceDir: input.workspaceDir,
  });
  const segments = [input.fullSystemPrompt];
  if (input.activeAgentRoleSegment && input.activeAgentRoleSegment.trim().length > 0) {
    segments.push(input.activeAgentRoleSegment.trim());
  }
  if (input.workspaceInstructionsSegment && input.workspaceInstructionsSegment.trim().length > 0) {
    segments.push(input.workspaceInstructionsSegment.trim());
  }
  if (input.additionalSystemPrompt.length > 0) {
    segments.push(input.additionalSystemPrompt);
  }
  segments.push(buildToolsetSummary(activeToolset));
  segments.push(MEMORY_PROTOCOL_SEGMENT);
  segments.push(TODO_PROTOCOL_SEGMENT);
  segments.push(buildExecutionReminderSegment(input.config));
  if (memorySegment.length > 0) {
    segments.push(memorySegment);
  }
  if (todoSegment.length > 0) {
    segments.push(todoSegment);
  }
  segments.push(skillCatalogSegment);
  segments.push(input.systemSegment);
  if (input.interruptedSideEffectSegment && input.interruptedSideEffectSegment.trim().length > 0) {
    segments.push(input.interruptedSideEffectSegment.trim());
  }
  if (input.compressedHistorySegment && input.compressedHistorySegment.trim().length > 0) {
    segments.push(input.compressedHistorySegment.trim());
  }
  return segments.join('\n\n');
}

function normalizePromptReference(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildFallbackPromptReference(input: {
  hasPromptMismatch: boolean;
  hasAdditionalSystemPrompt: boolean;
}): string {
  const tags: string[] = [];
  if (input.hasPromptMismatch) {
    tags.push('effective_prompt_mismatch');
  }
  if (input.hasAdditionalSystemPrompt) {
    tags.push('additional_system_prompt');
  }
  if (tags.length === 0) {
    tags.push('system_injection');
  }
  return `[PROMPT_REF reason=system_injection source=runtime tags=${tags.join(',')}]`;
}

function buildToolsetSummary(activeToolset: string): string {
  return [
    '## Active Toolset',
    `name=${activeToolset}`,
    'Only tools in the active toolset are callable for this turn.',
  ].join('\n');
}

function buildExecutionReminderSegment(config: AgentConfig): string {
  const completionMarkerRuleText = getCompletionMarkerRuleText(
    isCompletionMarkerEnforcementEnabled(config.agent)
  );
  return [
    '## Execution Reminder',
    '- Apply `[MANDATORY_EXECUTION_RULES]` strictly in this turn.',
    '- Completed action plus checked result is required before you stop.',
    ...(completionMarkerRuleText
      ? [
          `- ${completionMarkerRuleText}`,
          '- If the tail marker is missing, the system will continue this run automatically.',
        ]
      : []),
    '- Stop only when the request is actually complete or you are truly blocked.',
  ].join('\n');
}

const MEMORY_PROTOCOL_SEGMENT = [
  '## Context and Recall Protocol',
  '- Use context_manage to inspect or patch current structured context and selected runtime context state.',
  '- Use session_search only for raw prior-session transcript recall.',
  '- Use memory_manage only for durable facts worth carrying across sessions.',
  '- Do not store raw logs, temporary workarounds, one-off outputs, or facts already available through context_manage or recent session transcript recall.',
].join('\n');

const TODO_PROTOCOL_SEGMENT = [
  '## Todo Protocol',
  '- For multi-step, verifiable, or staged execution tasks with multiple milestones, call `todo` with `action="plan_set"` before proceeding.',
  '- `plan_set` must create the full remaining session plan in one call. Do not keep a single umbrella todo when multiple independent milestones remain.',
  '- Each todo must map to one verifiable milestone, and detection_standard must describe an external completion check instead of vague progress narration.',
  '- Keep at most one todo in progress at a time, but keep the rest of the plan as pending items instead of collapsing it into one active todo.',
  '- Use `set_status` to promote the next pending todo to `in_progress`, or to mark `blocked` / `completed` with the required fields.',
  '- Use `add` or `update` only for small manual corrections after the plan already exists.',
  '- Do not claim a task is complete until the corresponding todo is marked completed with task_id (the todo item id) and evidence.',
  '- If unfinished todos exist, keep executing against them unless the user paused the loop or the active todo is truly blocked.',
  '- When blocked, record the blocking reason clearly instead of silently stopping.',
].join('\n');
