import { WebSocket } from 'ws';
import { DEFAULT_AUTO_LOOP_CONFIG } from '../../auto-loop/index.js';
import { getCompletionMarkerRuleText } from '../../completion-marker-policy.js';
import type { ContextRef, SessionLlmSelectionInput } from '../../types.js';

import type { RawPlanInputAnswer } from './plan-input-normalization.js';

export interface WSMessage {
  type: string;
  data?: unknown;
  timestamp?: unknown;
}

export interface ChatRequest {
  prompt: string;
  context?: ContextRef;
  sessionId?: string;
  workspaceDir?: string;
  selectedAgentName?: string;
  llmSelection?: SessionLlmSelectionInput;
  usePlanMode?: boolean;
}

export interface CancelRequest {
  runId?: string;
  context?: ContextRef;
  sessionId?: string;
}

export interface ResumeFailedTurnRequest {
  context?: ContextRef;
  sessionId?: string;
  artifactId?: string;
}

export interface DismissInterruptedArtifactRequest {
  context?: ContextRef;
  sessionId?: string;
}

export interface StopAutoLoopRequest {
  sessionId?: string;
  context?: ContextRef;
}

export interface PlanInputResponseRequest {
  runId?: string;
  requestId?: string;
  context?: ContextRef;
  answers?: RawPlanInputAnswer[];
}

export function isContextRef(input: unknown): input is ContextRef {
  if (!input || typeof input !== 'object') {
    return false;
  }
  const candidate = input as Partial<ContextRef>;
  return (
    (candidate.scope === 'session' ||
      candidate.scope === 'workspace' ||
      candidate.scope === 'global') &&
    typeof candidate.namespace === 'string' &&
    candidate.namespace.trim().length > 0
  );
}

export function isSameContextRef(
  left: ContextRef | null | undefined,
  right: ContextRef | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.scope === right.scope && left.namespace === right.namespace;
}

export function makeAutoLoopKey(context: ContextRef): string {
  if (context.scope === 'session') {
    return context.namespace;
  }
  return `${context.scope}:${context.namespace}`;
}

export function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createSessionNamespace(): string {
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function isSocketOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

export const PLAN_MODE_PROMPT_PREFIX =
  '[PLAN_MODE] Use request_user_input when clarification, approval, or choices are needed. If you create or revise a todo execution plan, ask for explicit approval before executing it. Prefer the recommended option first. Do not fabricate user answers.';

export const DEFAULT_AUTO_LOOP_PROMPT = DEFAULT_AUTO_LOOP_CONFIG.prompt.trim();

export function buildAutoLoopSystemPrompt(completionMarkerEnforcementEnabled: boolean): string {
  const lines = [
    '[MANDATORY_EXECUTION_RULES]',
    'When a task requires multiple steps, describing intent does not count as execution.',
    'After changing code, run code. After running, inspect the result. If the result is incomplete, continue immediately instead of waiting for confirmation.',
  ];
  const completionMarkerRuleText = getCompletionMarkerRuleText(completionMarkerEnforcementEnabled);
  if (completionMarkerRuleText) {
    lines.push(completionMarkerRuleText);
    lines.push('If the tail marker is missing, the system will continue the same work round automatically.');
  }
  lines.push('Only call `exit_auto_loop` when you are highly confident the task is fully complete and no unfinished todo remains.');
  lines.push(
    completionMarkerEnforcementEnabled
      ? 'Even when blocked, you must still give the final blocker report and end it with one exact completion marker.'
      : 'Even when blocked, you must still give the final blocker report clearly.'
  );
  lines.push('[/MANDATORY_EXECUTION_RULES]');
  return lines.join('\n');
}

export const BOOT_PLACEHOLDER_API_KEY = '__MINIMAX_API_KEY_SET_IN_WEB_SETTINGS__';
