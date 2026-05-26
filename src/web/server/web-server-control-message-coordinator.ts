import { WebSocket } from 'ws';
import type { DPAgent } from '../../dpagent-runtime.js';
import type { ContextRef } from '../../types.js';
import { webServerLogger } from '../../utils/logger.js';
import type { RunningInputQueueCoordinator } from './running-input-queue-coordinator.js';
import type { ActiveRunState, SessionRuntime } from './web-server-runtime-contracts.js';
import {
  type CancelRequest,
  type RunningInputCancelRequest,
  type RunningInputEnqueueRequest,
  type RunningInputInsertRequest,
  type WSMessage,
  isSameContextRef,
} from './web-server-shared.js';
import type { WebSocketAccessScope } from './websocket-access-controller.js';

export interface WebServerControlMessageHost {
  agent: DPAgent;
  sessionRuntimes: Map<string, SessionRuntime>;
  activeRunContexts: Map<string, ContextRef>;
  cancelingRunIds: Set<string>;
  resolveRunningInputContext(
    request: RunningInputEnqueueRequest | RunningInputInsertRequest | RunningInputCancelRequest
  ): ContextRef | null;
  canWebSocketAccessContext(ws: WebSocket, context: ContextRef): boolean;
  getActiveRunState(context: ContextRef): ActiveRunState | null;
  canControlWebActiveRun(ws: WebSocket, context: ContextRef): boolean;
  getRunningInputQueue(): RunningInputQueueCoordinator;
  broadcastRunningInputQueue(context: ContextRef): void;
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
  resolveCancelContext(request: CancelRequest): ContextRef | null;
  getWebSocketScopeMap(): WeakMap<WebSocket, WebSocketAccessScope>;
  rejectPendingPlanInputByRunId(runId: string, reason: string): void;
  markCancelingRun(runId: string | null | undefined): void;
  isObserveOnlyActiveRun(context: ContextRef): boolean;
  getActiveRunStateForSocket(ws: WebSocket, context: ContextRef): ActiveRunState | null;
  resolveInteractionStateForSocket(ws: WebSocket, context: ContextRef): unknown;
  markCancelingRunsForContext(context: ContextRef): void;
  resolveAgentForContext(context: ContextRef): DPAgent;
  rejectPendingPlanInputByContext(context: ContextRef, reason: string): void;
  isPlanExecutionWithUnfinishedTodos(context: ContextRef): boolean;
  pausePlanExecutionAutoLoopForContext(context: ContextRef, ws?: WebSocket): void;
  stopAutoLoopForContext(context: ContextRef, ws?: WebSocket): void;
  refreshGlobalAgentCatalog(): void;
}

export function handleWebServerRunningInputEnqueueMessage(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  request: RunningInputEnqueueRequest
): void {
  const context = host.resolveRunningInputContext(request);
  const prompt = String(request.prompt ?? '').trim();
  if (!context || context.scope !== 'session' || !prompt) {
    emitRunningInputError(host, ws, context, 'invalid_running_input');
    return;
  }
  if (!host.canWebSocketAccessContext(ws, context)) {
    emitRunningInputError(host, ws, context, 'share_scope_forbidden');
    return;
  }
  const active = host.getActiveRunState(context);
  if (
    !active ||
    active.owner !== 'web' ||
    active.interactionState.mode === 'observe_only' ||
    !host.canControlWebActiveRun(ws, context) ||
    host.cancelingRunIds.has(active.runId)
  ) {
    emitRunningInputError(host, ws, context, 'no_mutable_active_run');
    return;
  }
  const item = host.getRunningInputQueue().enqueue({
    context,
    runId: active.runId,
    prompt,
    clientRequestId: typeof request.clientRequestId === 'string' ? request.clientRequestId.trim() : undefined,
    selectedAgentName: typeof request.selectedAgentName === 'string' ? request.selectedAgentName.trim() : undefined,
    fileReferences: Array.isArray(request.fileReferences) ? request.fileReferences : undefined,
  });
  host.broadcastRunningInputQueue(context);
  host.emitToClient(ws, {
    type: 'running_input_queued',
    data: {
      context,
      item,
    },
  });
}

export function handleWebServerRunningInputInsertMessage(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  request: RunningInputInsertRequest
): void {
  const context = host.resolveRunningInputContext(request);
  const itemId = String(request.itemId ?? '').trim();
  const runId = String(request.runId ?? '').trim();
  if (!context || context.scope !== 'session' || !itemId || !runId) {
    emitRunningInputError(host, ws, context, 'invalid_running_input_insert');
    return;
  }
  if (!host.canWebSocketAccessContext(ws, context)) {
    emitRunningInputError(host, ws, context, 'share_scope_forbidden');
    return;
  }
  const active = host.getActiveRunState(context);
  if (
    !active ||
    active.runId !== runId ||
    active.owner !== 'web' ||
    active.interactionState.mode === 'observe_only' ||
    !host.canControlWebActiveRun(ws, context) ||
    host.cancelingRunIds.has(active.runId)
  ) {
    emitRunningInputError(host, ws, context, 'no_mutable_active_run');
    return;
  }
  const item = host.getRunningInputQueue().requestInsert({ context, runId, itemId });
  if (!item) {
    emitRunningInputError(host, ws, context, 'running_input_not_found');
    return;
  }
  host.broadcastRunningInputQueue(context);
}

export function handleWebServerRunningInputCancelMessage(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  request: RunningInputCancelRequest
): void {
  const context = host.resolveRunningInputContext(request);
  const itemId = String(request.itemId ?? '').trim();
  if (!context || context.scope !== 'session' || !itemId) {
    emitRunningInputError(host, ws, context, 'invalid_running_input_cancel');
    return;
  }
  if (!host.canWebSocketAccessContext(ws, context)) {
    emitRunningInputError(host, ws, context, 'share_scope_forbidden');
    return;
  }
  if (!host.canControlWebActiveRun(ws, context)) {
    emitRunningInputError(host, ws, context, 'no_mutable_active_run');
    return;
  }
  const removed = host.getRunningInputQueue().remove(context, itemId);
  if (!removed) {
    emitRunningInputError(host, ws, context, 'running_input_not_found');
    return;
  }
  host.broadcastRunningInputQueue(context);
}

export function handleWebServerCancelMessage(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  request: CancelRequest
): void {
  const rawRunId = typeof request.runId === 'string' ? request.runId : null;
  const trimmedRunId = typeof request.runId === 'string' ? request.runId.trim() : '';
  const hasExplicitContext = request.context !== undefined;
  const context = host.resolveCancelContext(request);
  webServerLogger.info(
    `[WebServer] Cancel requested: runId=${trimmedRunId || '(none)'} context=${
      context ? `${context.scope}/${context.namespace}` : '(unscoped)'
    } explicitContext=${hasExplicitContext}`
  );
  if (!context) {
    handleUnscopedCancel(host, ws, rawRunId, trimmedRunId, hasExplicitContext);
    return;
  }
  if (!host.canWebSocketAccessContext(ws, context)) {
    host.emitToClient(ws, {
      type: 'cancel_ack',
      data: {
        runId: rawRunId,
        context,
        canceledCount: 0,
        error: 'share_scope_forbidden',
      },
    });
    return;
  }
  if (host.isObserveOnlyActiveRun(context) || !host.canControlWebActiveRun(ws, context)) {
    host.emitToClient(ws, {
      type: 'cancel_ack',
      data: {
        runId: rawRunId,
        context,
        canceledCount: 0,
        error: 'observe_only',
        activeRun: host.getActiveRunStateForSocket(ws, context),
        interactionState: host.resolveInteractionStateForSocket(ws, context),
      },
    });
    return;
  }
  const ackRunId =
    !hasExplicitContext || isSameContextRef(host.activeRunContexts.get(trimmedRunId), context)
      ? rawRunId
      : null;
  cancelScopedRuns(host, ws, ackRunId, context);
}

function emitRunningInputError(
  host: Pick<WebServerControlMessageHost, 'emitToClient'>,
  ws: WebSocket | undefined,
  context: ContextRef | null,
  error: string
): void {
  host.emitToClient(ws, {
    type: 'running_input_error',
    data: {
      ...(context ? { context } : {}),
      error,
    },
  });
}

function handleUnscopedCancel(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  rawRunId: string | null,
  trimmedRunId: string,
  hasExplicitContext: boolean
): void {
  if (hasExplicitContext) {
    return;
  }
  const scope = host.getWebSocketScopeMap().get(ws);
  if (scope?.mode === 'shared_ls') {
    host.emitToClient(ws, {
      type: 'cancel_ack',
      data: {
        runId: rawRunId,
        canceledCount: 0,
        error: 'share_scope_forbidden',
      },
    });
    return;
  }
  if (trimmedRunId) {
    host.rejectPendingPlanInputByRunId(trimmedRunId, 'run_canceled');
  }
  cancelAllRuns(host, ws, rawRunId);
}

function cancelAllRuns(host: WebServerControlMessageHost, ws: WebSocket, ackRunId: string | null): void {
  for (const runId of host.activeRunContexts.keys()) {
    host.markCancelingRun(runId);
  }
  host.markCancelingRun(ackRunId);
  const agents = new Set<DPAgent>([host.agent]);
  for (const runtime of host.sessionRuntimes.values()) {
    agents.add(runtime.agent);
  }
  for (const agent of agents) {
    agent.cancel();
  }
  host.emitToClient(ws, {
    type: 'cancel_ack',
    data: {
      runId: ackRunId,
      canceled: 'all',
    },
  });
  host.refreshGlobalAgentCatalog();
}

function cancelScopedRuns(
  host: WebServerControlMessageHost,
  ws: WebSocket,
  ackRunId: string | null,
  context: ContextRef
): void {
  host.markCancelingRunsForContext(context);
  host.markCancelingRun(ackRunId);
  const agent = host.resolveAgentForContext(context) as DPAgent & {
    cancelContextWithSummary?: (nextContext: ContextRef) => { mainRunCount: number; subagentCount: number; totalCount: number };
  };
  const cancelSummary = agent.cancelContextWithSummary
    ? agent.cancelContextWithSummary(context)
    : (() => {
        const mainRunCount = agent.cancelContext(context);
        return { mainRunCount, subagentCount: 0, totalCount: mainRunCount };
      })();
  host.rejectPendingPlanInputByContext(context, 'run_canceled');
  if (host.isPlanExecutionWithUnfinishedTodos(context)) {
    host.pausePlanExecutionAutoLoopForContext(context, ws);
  } else {
    host.stopAutoLoopForContext(context, ws);
  }
  host.emitToClient(ws, {
    type: 'cancel_ack',
    data: {
      runId: ackRunId,
      context,
      canceledCount: cancelSummary.mainRunCount,
      cancelSummary,
    },
  });
  host.refreshGlobalAgentCatalog();
}
