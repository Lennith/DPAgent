import type { ContextRef } from '../../types.js';
import type { ServerWsMessage } from './callback-event-messages.js';

export interface PlanInputErrorMessagePayload {
  error: string;
  runId?: string;
  context?: ContextRef;
  requestId?: string;
}

export interface PlanInputResolvedMessagePayload {
  runId: string;
  context: ContextRef;
  requestId: string;
}

export function createPlanInputErrorMessage(
  payload: PlanInputErrorMessagePayload
): ServerWsMessage {
  return {
    type: 'plan_input_error',
    data: {
      ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
      ...(payload.context !== undefined ? { context: payload.context } : {}),
      ...(payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
      error: payload.error,
    },
  };
}

export function createPlanInputResolvedMessage(
  payload: PlanInputResolvedMessagePayload
): ServerWsMessage {
  return {
    type: 'plan_input_resolved',
    data: {
      runId: payload.runId,
      context: payload.context,
      requestId: payload.requestId,
    },
  };
}
