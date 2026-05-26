import type {
  ContextRef,
  PlanInputAnswerPayload,
  SessionLlmSelectionView,
} from '../app-shell-types.js';
import type { WSMessage } from './useWebSocket.js';

function createSessionContext(sessionId: string): ContextRef {
  return {
    scope: 'session',
    namespace: sessionId,
  };
}

export function createRunningInputClientRequestId(
  now: number = Date.now(),
  random: number = Math.random()
): string {
  return `rin-client-${now.toString(36)}-${random.toString(16).slice(2, 8)}`;
}

export function buildRunningInputEnqueueMessage(input: {
  sessionId: string;
  prompt: string;
  clientRequestId: string;
  selectedAgentName?: string;
  fileReferences?: string[];
}): WSMessage {
  return {
    type: 'running_input_enqueue',
    data: {
      prompt: input.prompt,
      clientRequestId: input.clientRequestId,
      selectedAgentName: input.selectedAgentName,
      ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: input.fileReferences } : {}),
      context: createSessionContext(input.sessionId),
      sessionId: input.sessionId,
    },
  };
}

export function buildChatMessage(input: {
  sessionId: string;
  prompt: string;
  clientMessageId: string;
  workspaceDir: string;
  selectedAgentName?: string;
  planningAction?: 'enter_drafting';
  fileReferences?: string[];
  llmSelection?: SessionLlmSelectionView;
}): WSMessage {
  return {
    type: 'chat',
    data: {
      clientKind: 'web',
      prompt: input.prompt,
      clientMessageId: input.clientMessageId,
      selectedAgentName: input.selectedAgentName,
      ...(input.planningAction ? { planningAction: input.planningAction } : {}),
      ...(input.fileReferences && input.fileReferences.length > 0 ? { fileReferences: input.fileReferences } : {}),
      ...(input.llmSelection ? { llmSelection: input.llmSelection } : {}),
      workspaceDir: input.workspaceDir,
      context: createSessionContext(input.sessionId),
    },
  };
}

export function buildCancelRunMessage(sessionId: string, runId: string | null | undefined): WSMessage {
  return {
    type: 'cancel',
    data: {
      runId,
      context: createSessionContext(sessionId),
    },
  };
}

export function buildRunningInputInsertMessage(input: {
  sessionId: string;
  runId: string;
  itemId: string;
}): WSMessage {
  return {
    type: 'running_input_insert',
    data: {
      itemId: input.itemId,
      runId: input.runId,
      context: createSessionContext(input.sessionId),
    },
  };
}

export function buildRunningInputCancelMessage(sessionId: string, itemId: string): WSMessage {
  return {
    type: 'running_input_cancel',
    data: {
      itemId,
      context: createSessionContext(sessionId),
    },
  };
}

export function buildPlanInputResponseMessage(input: {
  runId: string;
  context: ContextRef;
  requestId: string;
  answers: PlanInputAnswerPayload[];
}): WSMessage {
  return {
    type: 'plan_input_response',
    data: {
      runId: input.runId,
      context: input.context,
      requestId: input.requestId,
      answers: input.answers,
    },
  };
}
