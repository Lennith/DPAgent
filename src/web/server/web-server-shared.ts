import { WebSocket } from 'ws';
import { DEFAULT_AUTO_LOOP_CONFIG } from '../../auto-loop/index.js';
import { getCompletionMarkerRuleText } from '../../completion-marker-policy.js';
import type { ContextRef, MCPServerConfig, SessionLlmSelectionInput } from '../../types.js';

import type { RawPlanInputAnswer } from './plan-input-normalization.js';

export interface WSMessage {
  type: string;
  data?: unknown;
  timestamp?: unknown;
}

export interface ChatRequest {
  prompt: string;
  fileReferences?: string[];
  context?: ContextRef;
  sessionId?: string;
  clientMessageId?: string;
  clientKind?: 'web' | 'cli';
  workspaceDir?: string;
  selectedAgentName?: string;
  llmSelection?: SessionLlmSelectionInput;
  planningAction?: 'enter_drafting';
  externalMcpServers?: MCPServerConfig[];
}

export interface CancelRequest {
  runId?: string;
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

export interface RunningInputEnqueueRequest {
  prompt?: string;
  clientRequestId?: string;
  selectedAgentName?: string;
  fileReferences?: string[];
  context?: ContextRef;
  sessionId?: string;
}

export interface RunningInputInsertRequest {
  itemId?: string;
  runId?: string;
  context?: ContextRef;
  sessionId?: string;
}

export interface RunningInputCancelRequest {
  itemId?: string;
  context?: ContextRef;
  sessionId?: string;
}

export interface TextAskRequest {
  text?: string;
  clientMessageId?: string;
  timeoutMs?: number;
}

export interface TextHistoryRequest {
  turns?: number | string;
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
  [
    '[PLAN_MODE]',
    'You are in Plan Mode for this turn. Your job is to investigate, clarify, and produce an executable plan, not to implement it.',
    '',
    'Core rules:',
    '1. Do not modify files, run mutating shell commands, create todos, or start execution work in Plan Mode.',
    '2. Use read-only inspection tools to understand the current project before planning.',
    '3. For a complex project, split read-only exploration across subagents when available so each subagent can focus on a specific area such as module ownership, data flow, UI behavior, tests, or integration boundaries.',
    '4. Explore first, ask second: resolve all questions that can be answered from files, configs, docs, logs, or current runtime state before asking the user.',
    '5. If a decision depends on unclear requirements, missing context, implementation boundaries, risk tolerance, or user preference, ask the user with `request_user_input`.',
    '6. Use `request_user_input` only for planning clarification. Never use it for execution approval.',
    '7. Do not fabricate user answers or silently choose a high-impact preference without labeling it as an assumption.',
    '',
    'Conversational planning:',
    '- If product requirements are unclear, contradictory, or too broad, clarify them before finalizing even when the implementation path looks straightforward.',
    '- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key tradeoffs.',
    '- Keep asking until the implementation spec is decision complete: approach, interfaces, data flow, edge cases, failure modes, tests, compatibility, and acceptance criteria.',
    '- You SHOULD ask many questions when they materially change the plan, confirm an important assumption, or choose between meaningful tradeoffs.',
    '- Do not ask questions that are answerable by non-mutating inspection.',
    '- Each `request_user_input` call must contain 1 to 3 focused questions. Prefer 2 to 3 mutually exclusive options with a recommended option first when useful; use free text only when options would be misleading.',
    '',
    'Finalization:',
    '- When the plan is ready, call `finalize_plan` with structured steps. Every step must include concrete work and a detection standard.',
    '- Do not output a free-form final plan; the runtime renders finalized plans from `finalize_plan`.',
    '- `finalize_plan` shows the runtime-owned execution approval card and returns decision `approved`, `revise`, or `rejected`.',
    '- If decision is `approved`, do not implement or call more tools in the same drafting turn. Briefly acknowledge approval and end the turn because the server will create todos and start a new execution turn.',
    '- If decision is `revise`, incorporate the user feedback and call `finalize_plan` again with the updated plan.',
    '- If decision is `rejected`, do not execute the plan; ask for next direction or stop planning.',
    '[/PLAN_MODE]',
  ].join('\n');

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
