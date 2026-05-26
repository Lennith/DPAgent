import type { SessionPlanningState } from '../../app-shell-types.js';

export type ComposerPlanModeClickEffect =
  | { kind: 'set_plan_mode_intent'; enabled: boolean }
  | { kind: 'exit_plan_draft' }
  | { kind: 'exit_plan_execution' }
  | { kind: 'none' };

export interface ChatInputInteractivity {
  isCanceling: boolean;
  isTurnActive: boolean;
  draftInputDisabled: boolean;
  settingsDisabled: boolean;
  canSubmitMessage: boolean;
  sendButtonMode: 'send' | 'stop';
}

export function resolveComposerPlanningAction(
  planningState: SessionPlanningState,
  planModeIntent: boolean
): 'enter_drafting' | undefined {
  if (planningState === 'plan_drafting' || (planningState === 'normal' && planModeIntent)) {
    return 'enter_drafting';
  }
  return undefined;
}

export function resolveComposerPlanModeButtonClick(input: {
  planningState: SessionPlanningState;
  planModeIntent: boolean;
  disabled: boolean;
}): ComposerPlanModeClickEffect {
  if (input.disabled) {
    return { kind: 'none' };
  }
  if (input.planningState === 'plan_executing') {
    return { kind: 'exit_plan_execution' };
  }
  if (input.planningState === 'plan_drafting') {
    return { kind: 'exit_plan_draft' };
  }
  return {
    kind: 'set_plan_mode_intent',
    enabled: !input.planModeIntent,
  };
}

export function resolveChatInputInteractivity(input: {
  isRunning: boolean;
  isInteractionLocked: boolean;
  isCanceling?: boolean;
  isHydrating?: boolean;
  observeOnly: boolean;
  hasDraftContent?: boolean;
}): ChatInputInteractivity {
  const isCanceling = input.isCanceling ?? (input.isInteractionLocked && !input.isRunning);
  const isTurnActive = input.isRunning || isCanceling;
  const readOnly = input.observeOnly || isCanceling || input.isHydrating === true;
  const canQueueRunningMessage = input.isRunning && !readOnly && input.hasDraftContent === true;
  return {
    isCanceling,
    isTurnActive,
    draftInputDisabled: readOnly,
    settingsDisabled: readOnly,
    canSubmitMessage: canQueueRunningMessage || (!input.isRunning && !readOnly && !input.isInteractionLocked),
    sendButtonMode: canQueueRunningMessage || !isTurnActive ? 'send' : 'stop',
  };
}
