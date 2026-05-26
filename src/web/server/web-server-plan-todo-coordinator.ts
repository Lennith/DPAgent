import { autoLoopManager, DEFAULT_AUTO_LOOP_CONFIG, type AutoLoopConfig } from '../../auto-loop/index.js';
import type { DPAgent } from '../../dpagent-runtime.js';
import type {
  ContextRef,
  FinalizedPlanStep,
  PlanInputAnswer,
  PlanInputRequest,
  SessionPlanningState,
} from '../../types.js';
import type { TodoPriority, TodoProtocolState } from '../../todo/index.js';
import { webServerLogger } from '../../utils/logger.js';

export interface WebServerPlanTodoHost {
  agent?: DPAgent;
  readPlanningState(context: ContextRef): SessionPlanningState;
  getPendingStructuredContextValue(context: ContextRef, key: string, turnId: string | undefined): string | undefined;
  resolveWorkspaceDirForContext(context: ContextRef): string;
  resolveAgentForContext(context: ContextRef): DPAgent;
  getSessionTodoProtocolState?: (sessionId: string, workspaceDir?: string) => TodoProtocolState;
  getContextNamespaceMetaSafe(context: ContextRef): {
    planningState?: {
      state?: SessionPlanningState;
      pendingPlanId?: string;
      activeExecutionPlanId?: string;
      updatedAt?: string;
    };
    autoLoopConfig?: Partial<AutoLoopConfig>;
  } | undefined;
  updateContextNamespaceMetaSafe(context: ContextRef, patch: Record<string, unknown>): void;
  getAutoLoopConfigSafe(controller: unknown): AutoLoopConfig;
  getAutoLoopStateSafe(controller: unknown): { isRunning: boolean; currentRound: number };
  updateAutoLoopConfigSafe(controller: unknown, config: Partial<AutoLoopConfig>): void;
  stopAutoLoopSafe(
    controller: unknown,
    reason: 'similarity' | 'max_rounds' | 'timeout' | 'user_stop' | 'error' | 'tool_exit'
  ): void;
}

export function normalizeFinalizedPlanSteps(raw: string | undefined): FinalizedPlanStep[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const steps: FinalizedPlanStep[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Partial<FinalizedPlanStep> & {
      plan_step_id?: unknown;
      detection_standard?: unknown;
    };
    const planStepId = String(record.planStepId ?? record.plan_step_id ?? `step-${String(i + 1).padStart(3, '0')}`).trim();
    const work = String(record.work ?? '').trim();
    const detectionStandard = String(record.detectionStandard ?? record.detection_standard ?? '').trim();
    const priorityRaw = String(record.priority ?? '').trim().toLowerCase();
    const priority: TodoPriority | undefined =
      priorityRaw === 'low' || priorityRaw === 'medium' || priorityRaw === 'high'
        ? priorityRaw
        : undefined;
    const tags = Array.isArray(record.tags)
      ? record.tags.map((tag) => String(tag ?? '').trim()).filter((tag) => tag.length > 0)
      : undefined;
    if (!planStepId || !work || !detectionStandard) {
      return [];
    }
    steps.push({
      planStepId,
      work,
      detectionStandard,
      ...(priority ? { priority } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    });
  }
  return steps;
}

export function activatePendingPlanIfApprovalSelected(
  host: WebServerPlanTodoHost,
  context: ContextRef,
  request: PlanInputRequest,
  answers: PlanInputAnswer[]
): { approved: boolean; activated: boolean; planId?: string; reason?: string; stepCount?: number } {
  if (request.source !== 'finalize_plan_approval') {
    return { approved: false, activated: false, reason: 'not_finalize_plan_approval' };
  }
  if (context.scope !== 'session' || host.readPlanningState(context) !== 'plan_drafting') {
    return { approved: false, activated: false, reason: 'not_session_or_not_drafting' };
  }
  const approved = answers.some(
    (answer) =>
      answer.id === 'plan_execution_approval' &&
      String(answer.selectedLabel ?? '').trim() === 'Approve execution'
  );
  if (!approved) {
    return { approved: false, activated: false, reason: 'approval_option_not_selected' };
  }
  const pendingPlanId = String(
    host.getPendingStructuredContextValue(context, 'plan_mode.pending_plan_id', request.turnId) ?? ''
  ).trim();
  if (!pendingPlanId) {
    return { approved: true, activated: false, reason: 'missing_pending_plan_id' };
  }
  const finalSteps = normalizeFinalizedPlanSteps(
    host.getPendingStructuredContextValue(context, 'plan_mode.final_plan_steps', request.turnId)
  );
  if (finalSteps.length === 0) {
    return { approved: true, activated: false, planId: pendingPlanId, reason: 'empty_final_steps', stepCount: 0 };
  }
  let workspaceDir: string | undefined;
  try {
    workspaceDir = host.resolveWorkspaceDirForContext(context);
  } catch {
    workspaceDir = undefined;
  }
  const agent = host.resolveAgentForContext(context);
  const getTodoStore = (agent as {
    getTodoStore?: () => {
      setTodoPlan: (input: {
        sessionId: string;
        workspaceDir?: string;
        items: Array<{
          work: string;
          detectionStandard: string;
          priority?: TodoPriority;
          tags?: string[];
          status?: 'pending';
          planStepId?: string;
        }>;
        sourceSessionId?: string;
        planId?: string;
      }) => unknown;
    };
  }).getTodoStore;
  if (typeof getTodoStore !== 'function') {
    return {
      approved: true,
      activated: false,
      planId: pendingPlanId,
      reason: 'todo_store_unavailable',
      stepCount: finalSteps.length,
    };
  }
  webServerLogger.info(
    `[PlanMode] activating approved plan sessionId=${context.namespace} requestId=${request.requestId} turnId=${request.turnId ?? ''} planId=${pendingPlanId} stepCount=${finalSteps.length} hasTodoStore=true`
  );
  getTodoStore.call(agent).setTodoPlan({
    sessionId: context.namespace,
    ...(workspaceDir ? { workspaceDir } : {}),
    sourceSessionId: context.namespace,
    planId: pendingPlanId,
    items: finalSteps.map((step) => ({
      work: step.work,
      detectionStandard: step.detectionStandard,
      ...(step.priority ? { priority: step.priority } : {}),
      ...(step.tags ? { tags: step.tags } : {}),
      planStepId: step.planStepId,
      status: 'pending',
    })),
  });
  const existing = host.getContextNamespaceMetaSafe(context)?.planningState;
  host.updateContextNamespaceMetaSafe(context, {
    planningState: {
      ...existing,
      state: 'plan_executing',
      pendingPlanId: undefined,
      activeExecutionPlanId: pendingPlanId,
      updatedAt: new Date().toISOString(),
    },
  });
  webServerLogger.info(
    `[PlanMode] activated plan sessionId=${context.namespace} requestId=${request.requestId} turnId=${request.turnId ?? ''} planId=${pendingPlanId} stepCount=${finalSteps.length}`
  );
  return {
    approved: true,
    activated: true,
    planId: pendingPlanId,
    reason: 'activated',
    stepCount: finalSteps.length,
  };
}

export function getSessionTodoProtocolState(
  host: Pick<WebServerPlanTodoHost, 'agent' | 'resolveAgentForContext'>,
  sessionId: string,
  workspaceDir?: string
): TodoProtocolState {
  const rootAgent = host.agent ?? host.resolveAgentForContext({ scope: 'session', namespace: sessionId });
  const getTodoStore = (rootAgent as {
    getTodoStore?: () => {
      getProtocolState: (input: { sessionId?: string; workspaceDir?: string }) => TodoProtocolState;
    };
  }).getTodoStore;
  if (typeof getTodoStore !== 'function') {
    return emptyTodoProtocolState();
  }
  return getTodoStore.call(rootAgent).getProtocolState({
    sessionId,
    workspaceDir,
  });
}

export function getApprovedExecutionPlanMarkdown(
  host: Pick<WebServerPlanTodoHost, 'getContextNamespaceMetaSafe' | 'resolveAgentForContext'>,
  context: ContextRef
): string | undefined {
  if (context.scope !== 'session') {
    return undefined;
  }
  const planId = String(host.getContextNamespaceMetaSafe(context)?.planningState?.activeExecutionPlanId ?? '').trim();
  if (!planId) {
    return undefined;
  }
  try {
    const projection = host.resolveAgentForContext(context).getContextManager().getProjection(context);
    const planRecordRaw = projection.keyValues[`plan_mode.plans.${planId}`];
    if (planRecordRaw) {
      const parsed = JSON.parse(planRecordRaw) as { markdown?: unknown };
      const markdown = String(parsed.markdown ?? '').trim();
      if (markdown) {
        return markdown;
      }
    }
    return String(projection.keyValues['plan_mode.final_plan_markdown'] ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function markTodoPlanConfirmationPending(host: WebServerPlanTodoHost, sessionId: string): void {
  const ref: ContextRef = { scope: 'session', namespace: sessionId };
  const meta = host.getContextNamespaceMetaSafe(ref);
  const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
  const currentConfig = host.getAutoLoopConfigSafe(controller);
  const ralphEnabled = currentConfig.ralphEnabled ?? (currentConfig.mode === 'ralph' ? currentConfig.enabled : false);
  const nextConfig: AutoLoopConfig = {
    ...currentConfig,
    enabled: false,
    mode: 'todo',
    ralphEnabled,
    pendingPlanConfirmation: true,
  };
  host.updateAutoLoopConfigSafe(controller, nextConfig);
  if (host.getAutoLoopStateSafe(controller).isRunning) {
    host.stopAutoLoopSafe(controller, 'user_stop');
  }
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: nextConfig,
  });
}

export function clearTodoPlanConfirmationPending(host: WebServerPlanTodoHost, sessionId: string): void {
  const ref: ContextRef = { scope: 'session', namespace: sessionId };
  const meta = host.getContextNamespaceMetaSafe(ref);
  const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
  const currentConfig = host.getAutoLoopConfigSafe(controller);
  if (currentConfig.pendingPlanConfirmation !== true) {
    return;
  }
  const nextConfig: AutoLoopConfig = {
    ...currentConfig,
    pendingPlanConfirmation: false,
  };
  host.updateAutoLoopConfigSafe(controller, nextConfig);
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: nextConfig,
  });
}

export function ensureTodoDrivenAutoLoop(
  host: WebServerPlanTodoHost,
  sessionId: string,
  workspaceDir?: string
): void {
  const todoState =
    typeof host.getSessionTodoProtocolState === 'function'
      ? host.getSessionTodoProtocolState(sessionId, workspaceDir)
      : getSessionTodoProtocolState(host, sessionId, workspaceDir);
  const ref: ContextRef = { scope: 'session', namespace: sessionId };
  const meta = host.getContextNamespaceMetaSafe(ref);
  const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
  const currentConfig = host.getAutoLoopConfigSafe(controller);
  const ralphEnabled = currentConfig.ralphEnabled ?? (currentConfig.mode === 'ralph' ? currentConfig.enabled : false);
  webServerLogger.info(
    `[PlanMode] ensureTodoDrivenAutoLoop sessionId=${sessionId} hasUnfinished=${todoState.hasUnfinished} pendingPlanConfirmation=${currentConfig.pendingPlanConfirmation === true} pausedByUser=${currentConfig.pausedByUser === true} mode=${currentConfig.mode ?? ''} isRunning=${host.getAutoLoopStateSafe(controller).isRunning}`
  );

  if (currentConfig.pendingPlanConfirmation === true) {
    pauseForPlanConfirmation(host, ref, controller, currentConfig, ralphEnabled);
    return;
  }
  if (!todoState.hasUnfinished) {
    resumeRalphIfTodosFinished(host, ref, controller, currentConfig, ralphEnabled);
    return;
  }
  if (currentConfig.pausedByUser === true) {
    keepTodoLoopPaused(host, ref, controller, currentConfig, ralphEnabled);
    return;
  }
  enableTodoLoop(host, ref, controller, currentConfig, ralphEnabled);
}

function emptyTodoProtocolState(): TodoProtocolState {
  return {
    items: [],
    unfinishedItems: [],
    activeItem: null,
    blockedItem: null,
    pendingItems: [],
    completedItems: [],
    dismissedItems: [],
    hasUnfinished: false,
    allCompleted: false,
  };
}

function pauseForPlanConfirmation(
  host: WebServerPlanTodoHost,
  ref: ContextRef,
  controller: unknown,
  currentConfig: AutoLoopConfig,
  ralphEnabled: boolean
): void {
  const pendingConfig: AutoLoopConfig = {
    ...currentConfig,
    enabled: false,
    mode: 'todo',
    ralphEnabled,
    pendingPlanConfirmation: true,
  };
  host.updateAutoLoopConfigSafe(controller, pendingConfig);
  if (host.getAutoLoopStateSafe(controller).isRunning) {
    host.stopAutoLoopSafe(controller, 'user_stop');
  }
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: pendingConfig,
  });
  webServerLogger.info(
    `[PlanMode] ensureTodoDrivenAutoLoop paused for confirmation sessionId=${ref.namespace}`
  );
}

function resumeRalphIfTodosFinished(
  host: WebServerPlanTodoHost,
  ref: ContextRef,
  controller: unknown,
  currentConfig: AutoLoopConfig,
  ralphEnabled: boolean
): void {
  if (host.readPlanningState(ref) === 'plan_executing') {
    const existingPlanningState = host.getContextNamespaceMetaSafe(ref)?.planningState;
    host.updateContextNamespaceMetaSafe(ref, {
      planningState: {
        ...existingPlanningState,
        state: 'normal',
        pendingPlanId: undefined,
        activeExecutionPlanId: undefined,
        updatedAt: new Date().toISOString(),
      },
      lastPlanExecutionExit: {
        mode: 'normal',
        planId: existingPlanningState?.activeExecutionPlanId,
        unfinishedTodoCount: 0,
        exitedAt: new Date().toISOString(),
      },
    });
  }
  const nextConfig: AutoLoopConfig = {
    ...currentConfig,
    enabled: ralphEnabled,
    mode: 'ralph',
    ralphEnabled,
    pendingPlanConfirmation: false,
    pausedByUser: false,
  };
  host.updateAutoLoopConfigSafe(controller, nextConfig);
  if (host.getAutoLoopStateSafe(controller).isRunning && currentConfig.mode === 'todo') {
    host.stopAutoLoopSafe(controller, 'user_stop');
  }
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: nextConfig,
  });
  webServerLogger.info(
    `[PlanMode] ensureTodoDrivenAutoLoop no unfinished todos sessionId=${ref.namespace} nextMode=${nextConfig.mode} enabled=${nextConfig.enabled}`
  );
}

function keepTodoLoopPaused(
  host: WebServerPlanTodoHost,
  ref: ContextRef,
  controller: unknown,
  currentConfig: AutoLoopConfig,
  ralphEnabled: boolean
): void {
  const pausedConfig: AutoLoopConfig = {
    ...currentConfig,
    enabled: false,
    mode: 'todo',
    ralphEnabled,
    pendingPlanConfirmation: false,
  };
  host.updateAutoLoopConfigSafe(controller, pausedConfig);
  if (host.getAutoLoopStateSafe(controller).isRunning) {
    host.stopAutoLoopSafe(controller, 'user_stop');
  }
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: pausedConfig,
  });
  webServerLogger.info(
    `[PlanMode] ensureTodoDrivenAutoLoop remains paused by user sessionId=${ref.namespace}`
  );
}

function enableTodoLoop(
  host: WebServerPlanTodoHost,
  ref: ContextRef,
  controller: unknown,
  currentConfig: AutoLoopConfig,
  ralphEnabled: boolean
): void {
  const nextConfig: AutoLoopConfig = {
    ...currentConfig,
    enabled: true,
    mode: 'todo',
    ralphEnabled,
    pendingPlanConfirmation: false,
    pausedByUser: false,
  };
  host.updateAutoLoopConfigSafe(controller, nextConfig);
  host.updateContextNamespaceMetaSafe(ref, {
    autoLoopConfig: nextConfig,
  });
  webServerLogger.info(
    `[PlanMode] ensureTodoDrivenAutoLoop enabled todo loop sessionId=${ref.namespace} mode=${nextConfig.mode} enabled=${nextConfig.enabled}`
  );
}
