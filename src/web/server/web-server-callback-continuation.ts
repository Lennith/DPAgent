import type { WebSocket } from 'ws';
import type { AutoLoopConfig } from '../../auto-loop/index.js';
import {
  getCompletionMarkerRuleText,
  hasRequiredCompletionMarker,
} from '../../completion-marker-policy.js';
import type { TodoProtocolState } from '../../todo/index.js';
import type { ContextRef } from '../../types.js';
import { DEFAULT_AUTO_LOOP_PROMPT } from './web-server-shared.js';

export type CallbackContinuationPlan =
  | {
      kind: 'stopped';
      reason?: string;
      totalRounds: number;
      emitComplete: boolean;
    }
  | {
      kind: 'continue';
      controller: unknown;
      nextPrompt: string;
      round: number;
      emitComplete: true;
    }
  | {
      kind: 'continue_marker_required';
      controller: unknown;
      nextPrompt: string;
      emitComplete: false;
    }
  | {
      kind: 'none';
      emitComplete: boolean;
    };

export interface CallbackContinuationDispatcherLike {
  autoLoopStopped: (reason?: string, totalRounds?: number) => void;
  autoLoopRound: (round: number, prompt: string) => void;
}

interface ResolveCallbackContinuationPlanInput {
  context: ContextRef;
  controller: unknown;
  result: string;
  completionMarkerEnforcementEnabled: boolean;
  skipCompletionMarkerRepair?: boolean;
  todoState?: TodoProtocolState;
  approvedPlanMarkdown?: string;
  getAutoLoopConfig: (controller: unknown) => AutoLoopConfig;
  getAutoLoopState: (controller: unknown) => { isRunning: boolean; currentRound: number };
  shouldContinue: (
    controller: unknown,
    result: string,
    options?: { ignoreSimilarity?: boolean }
  ) => { shouldContinue: boolean; reason?: string };
}

interface ApplyCallbackContinuationPlanInput {
  ws: WebSocket;
  context: ContextRef;
  dispatcher: CallbackContinuationDispatcherLike;
  plan: CallbackContinuationPlan;
  scheduleCallbackContinuation: (
    ws: WebSocket,
    context: ContextRef,
    controller: unknown,
    prompt: string
  ) => void;
}

function getAdditionalLoopHint(controller: unknown, getAutoLoopConfig: (controller: unknown) => AutoLoopConfig): string | null {
  const prompt = getAutoLoopConfig(controller).prompt.trim();
  if (!prompt || prompt === DEFAULT_AUTO_LOOP_PROMPT) {
    return null;
  }
  return prompt;
}

function appendAdditionalLoopHint(
  lines: string[],
  controller: unknown,
  getAutoLoopConfig: (controller: unknown) => AutoLoopConfig
): void {
  const extraPrompt = getAdditionalLoopHint(controller, getAutoLoopConfig);
  if (!extraPrompt) {
    return;
  }
  lines.push('Additional loop hint:');
  lines.push(extraPrompt);
}

function buildCompletionMarkerContinuationPrompt(
  controller: unknown,
  getAutoLoopConfig: (controller: unknown) => AutoLoopConfig,
  completionMarkerEnforcementEnabled: boolean,
  todoState?: TodoProtocolState
): string {
  const completionMarkerRuleText = getCompletionMarkerRuleText(completionMarkerEnforcementEnabled);
  const lines = [
    '[COMPLETION_MARKER_REQUIRED]',
    'Your previous reply did not end with the required completion marker.',
    ...(completionMarkerRuleText ? [completionMarkerRuleText] : []),
    'Continue the same task immediately.',
    'If the task is already done, produce the missing final report now instead of inventing extra work.',
    'If you are truly blocked, clearly explain the blocker and still end that final report with one exact completion marker.',
  ];

  if (todoState?.hasUnfinished) {
    lines.push('Unfinished session todos still exist, but this repair turn is only for the missing final report from the previous real work round.');
    lines.push('Do not start a new execution round, do not promote another todo, and do not rewrite the plan in this repair turn.');
    if (todoState.activeItem) {
      lines.push(
        `Active todo: ${todoState.activeItem.id} | work=${todoState.activeItem.work} | detection_standard=${todoState.activeItem.detectionStandard}`
      );
    }
    if (todoState.blockedItem) {
      lines.push(
        `Blocked todo: ${todoState.blockedItem.id} | work=${todoState.blockedItem.work} | blocked_reason=${todoState.blockedItem.blockedReason ?? 'missing'}`
      );
      lines.push('If the previous round was blocked, resend that blocker report with one exact completion marker instead of resuming work.');
    }
    if (todoState.pendingItems.length > 0) {
      lines.push('Pending todos:');
      for (const item of todoState.pendingItems.slice(0, 6)) {
        lines.push(`- ${item.id} | work=${item.work} | detection_standard=${item.detectionStandard}`);
      }
    }
  } else if ((todoState?.items.length ?? 0) > 0) {
    lines.push('All current session todos are already complete. Do not reopen them just to continue; send the required final report with one exact completion marker now.');
  }

  appendAdditionalLoopHint(lines, controller, getAutoLoopConfig);
  lines.push('[/COMPLETION_MARKER_REQUIRED]');
  return lines.join('\n');
}

function buildTodoLoopPrompt(
  controller: unknown,
  getAutoLoopConfig: (controller: unknown) => AutoLoopConfig,
  completionMarkerEnforcementEnabled: boolean,
  state: TodoProtocolState,
  approvedPlanMarkdown?: string
): string | null {
  if (!state.hasUnfinished) {
    return null;
  }

  const completionMarkerRuleText = getCompletionMarkerRuleText(completionMarkerEnforcementEnabled);
  const lines = [
    '[TODO_LOOP]',
    'Continue executing the current session todo protocol for the next real work round.',
    'Use the todo list below as the source of truth for what remains.',
    'Todo is the only execution ledger in plan execution; do not call plan tools or rewrite plan steps.',
    ...(completionMarkerRuleText ? [completionMarkerRuleText] : []),
    'If multiple milestones remain but the remaining plan is still a single umbrella todo, rewrite the remaining session plan with todo action=plan_set before continuing.',
    'Use set_status to promote the next pending todo to in_progress before executing it.',
    'If a todo is completed this round, call set_status with status=completed plus task_id (the todo item id) and evidence.',
    completionMarkerEnforcementEnabled
      ? 'If the active todo is blocked and needs user input, call set_status with status=blocked plus blocked_reason, explain the blocker, and end that blocker report with one exact completion marker.'
      : 'If the active todo is blocked and needs user input, call set_status with status=blocked plus blocked_reason and explain the blocker clearly.',
    'Use add or update only for small manual corrections after the plan already exists.',
    'Do not call exit_auto_loop while unfinished todos remain.',
  ];

  const planMarkdown = String(approvedPlanMarkdown ?? '').trim();
  if (planMarkdown) {
    lines.push('', '[APPROVED_PLAN_ORIGINAL]');
    lines.push(planMarkdown);
    lines.push('[/APPROVED_PLAN_ORIGINAL]', '');
  }

  if (state.activeItem) {
    lines.push(
      `Active todo: ${state.activeItem.id} | work=${state.activeItem.work} | detection_standard=${state.activeItem.detectionStandard}`
    );
  }

  if (state.blockedItem) {
    lines.push(
      `Blocked todo: ${state.blockedItem.id} | work=${state.blockedItem.work} | blocked_reason=${state.blockedItem.blockedReason ?? 'missing'}`
    );
  }

  if (state.pendingItems.length > 0) {
    lines.push('Pending todos:');
    for (const item of state.pendingItems.slice(0, 6)) {
      lines.push(`- ${item.id} | work=${item.work} | detection_standard=${item.detectionStandard}`);
    }
  }

  lines.push('Continue from the active todo or promote the next pending todo to in_progress before executing it.');
  appendAdditionalLoopHint(lines, controller, getAutoLoopConfig);
  lines.push('[/TODO_LOOP]');
  return lines.join('\n');
}

function buildAutoLoopContinuationPrompt(
  controller: unknown,
  getAutoLoopConfig: (controller: unknown) => AutoLoopConfig,
  completionMarkerEnforcementEnabled: boolean
): string {
  const completionMarkerRuleText = getCompletionMarkerRuleText(completionMarkerEnforcementEnabled);
  const lines = [
    '[AUTO_LOOP_CONTINUE]',
    'Start the next real work round now.',
    'Apply `[MANDATORY_EXECUTION_RULES]` strictly.',
    ...(completionMarkerRuleText ? [completionMarkerRuleText] : []),
    'Advance the task instead of stopping after plans or status-only narration.',
  ];
  appendAdditionalLoopHint(lines, controller, getAutoLoopConfig);
  lines.push('[/AUTO_LOOP_CONTINUE]');
  return lines.join('\n');
}

export function resolveWebServerCallbackContinuationPlan(
  input: ResolveCallbackContinuationPlanInput
): CallbackContinuationPlan {
  if (input.context.scope === 'session') {
    if (
      input.completionMarkerEnforcementEnabled &&
      input.skipCompletionMarkerRepair !== true &&
      !hasRequiredCompletionMarker(input.result)
    ) {
      return {
        kind: 'continue_marker_required',
        controller: input.controller,
        nextPrompt: buildCompletionMarkerContinuationPrompt(
          input.controller,
          input.getAutoLoopConfig,
          input.completionMarkerEnforcementEnabled,
          input.todoState
        ),
        emitComplete: false,
      };
    }

    const config = input.getAutoLoopConfig(input.controller);
    if (input.todoState?.hasUnfinished && config.pendingPlanConfirmation === true) {
      return {
        kind: 'none',
        emitComplete: true,
      };
    }
    if (input.todoState?.hasUnfinished && config.pausedByUser !== true) {
      if (input.todoState.blockedItem) {
        return {
          kind: 'stopped',
          reason: `Blocked on todo ${input.todoState.blockedItem.id}: ${input.todoState.blockedItem.blockedReason ?? 'waiting for user input'}`,
          totalRounds: input.getAutoLoopState(input.controller).currentRound,
          emitComplete: true,
        };
      }

      const check = input.shouldContinue(input.controller, input.result, { ignoreSimilarity: true });
      if (!check.shouldContinue) {
        return {
          kind: 'stopped',
          reason: check.reason,
          totalRounds: input.getAutoLoopState(input.controller).currentRound,
          emitComplete: true,
        };
      }

      const nextPrompt = buildTodoLoopPrompt(
        input.controller,
        input.getAutoLoopConfig,
        input.completionMarkerEnforcementEnabled,
        input.todoState,
        input.approvedPlanMarkdown
      );
      if (nextPrompt) {
        return {
          kind: 'continue',
          controller: input.controller,
          nextPrompt,
          round: input.getAutoLoopState(input.controller).currentRound,
          emitComplete: true,
        };
      }
    }
  }

  const config = input.getAutoLoopConfig(input.controller);
  if (!config.enabled || config.pausedByUser === true) {
    return {
      kind: 'none',
      emitComplete: true,
    };
  }

  const check = input.shouldContinue(input.controller, input.result);
  if (!check.shouldContinue) {
    return {
      kind: 'stopped',
      reason: check.reason,
      totalRounds: input.getAutoLoopState(input.controller).currentRound,
      emitComplete: true,
    };
  }

  return {
    kind: 'continue',
    controller: input.controller,
    nextPrompt: buildAutoLoopContinuationPrompt(
      input.controller,
      input.getAutoLoopConfig,
      input.completionMarkerEnforcementEnabled
    ),
    round: input.getAutoLoopState(input.controller).currentRound,
    emitComplete: true,
  };
}

export function applyWebServerCallbackContinuationPlan(
  input: ApplyCallbackContinuationPlanInput
): void {
  switch (input.plan.kind) {
    case 'stopped':
      input.dispatcher.autoLoopStopped(input.plan.reason, input.plan.totalRounds);
      return;
    case 'continue':
      input.dispatcher.autoLoopRound(input.plan.round, input.plan.nextPrompt);
      input.scheduleCallbackContinuation(input.ws, input.context, input.plan.controller, input.plan.nextPrompt);
      return;
    case 'continue_marker_required':
      input.scheduleCallbackContinuation(input.ws, input.context, input.plan.controller, input.plan.nextPrompt);
      return;
    case 'none':
      return;
  }
}
