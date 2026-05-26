import { WebSocket } from 'ws';
import type { DPAgent } from '../../dpagent-runtime.js';
import { resolveLlmRuntimeConfig } from '../../llm/provider-profiles.js';
import type {
  AgentCallback,
  AgentRuntimeOverrides,
  ContextNamespaceMeta,
  ContextRef,
  MCPServerConfig,
  ResolvedLlmRuntimeConfig,
  SessionLlmSelection,
  SessionOrigin,
  SessionPlanningState,
} from '../../types.js';
import { autoLoopManager, type AutoLoopController } from '../../auto-loop/index.js';
import { webServerLogger } from '../../utils/logger.js';
import {
  type CallbackEventDispatcher,
  type PreparedChatExecution,
  type ResolvedUserPromptResult,
  type SessionRuntime,
} from './web-server-runtime-contracts.js';
import {
  createRunId,
  makeAutoLoopKey,
  type ChatRequest,
  type WSMessage,
} from './web-server-shared.js';

type LlmSelectionValidation = { ok: true } | { ok: false; error: string };
type AgentRuntimeLlmSelection =
  | { ok: true; selection: SessionLlmSelection }
  | { ok: false; error: string };

export interface WebServerChatPreparationHost {
  agent: DPAgent;
  currentSessionId: string | null;
  rootRuntimeConfigDirty: boolean;
  rootRuntimeCleanupPromise?: Promise<void>;
  resolveChatContext(request: ChatRequest): ContextRef;
  canWebSocketAccessContext(ws: WebSocket, context: ContextRef): boolean;
  emitToClient(ws: WebSocket | undefined, message: WSMessage): void;
  resolveRunOrigin(ws: WebSocket): SessionOrigin;
  createRunScopedDispatcher(
    ws: WebSocket | undefined,
    context: ContextRef,
    runId: string,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    runOrigin?: SessionOrigin
  ): CallbackEventDispatcher;
  resolveWorkspaceDirForRun(context: ContextRef, requestedWorkspaceDir?: string): string;
  persistSessionRunMetadata(context: ContextRef, origin: SessionOrigin, workspaceDir?: string): void;
  validateRequestedLlmSelection(input: ChatRequest['llmSelection']): LlmSelectionValidation;
  resolveRequestedSessionLlmSelection(
    context: ContextRef,
    input: ChatRequest['llmSelection']
  ): SessionLlmSelection;
  resolvePlanningStateForChat(context: ContextRef, action?: ChatRequest['planningAction']): SessionPlanningState;
  cloneExternalMcpServers(servers: MCPServerConfig[] | undefined): MCPServerConfig[];
  resolveContinuationExternalMcpServers(
    context: ContextRef,
    requestedExternalMcpServers?: MCPServerConfig[]
  ): MCPServerConfig[] | undefined;
  persistExternalMcpAttachment(context: ContextRef, servers: MCPServerConfig[]): void;
  resolveUserPrompt(input: {
    prompt: string;
    fileReferences?: ChatRequest['fileReferences'];
    selectedAgentName?: string;
    workspaceDir: string;
    planningState?: SessionPlanningState;
    context: ContextRef;
  }): ResolvedUserPromptResult;
  refreshGlobalAgentCatalog(): void;
  resolveAgentRuntimeLlmSelection(
    baseSelection: SessionLlmSelection,
    overrides?: AgentRuntimeOverrides
  ): AgentRuntimeLlmSelection;
  hasUsableApiKeyForRuntime(llmRuntime: ResolvedLlmRuntimeConfig): boolean;
  hasActiveRunForContext(context: ContextRef): boolean;
  getActiveRunState(context: ContextRef): unknown;
  makeRunContextStateKey(context: ContextRef): string;
  getActiveRunControllerMap(): Map<string, string>;
  getWebSocketScopeMap(): WeakMap<WebSocket, unknown>;
  getActiveRunIdsForContext(context: ContextRef): string[];
  summarizeWebSocketScopeForLog(scope: unknown): Record<string, unknown> | undefined;
  hasCancelingRunForContext(context: ContextRef): boolean;
  waitForNoActiveRunForContext(context: ContextRef, timeoutMs?: number): Promise<boolean>;
  bindRunController(ws: WebSocket, context: ContextRef): void;
  reserveTrackedRun(
    runId: string,
    context: ContextRef,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    runOrigin?: SessionOrigin
  ): () => void;
  releaseRunController(context: ContextRef): void;
  ensureSessionRuntime(
    sessionId: string,
    workspaceDir: string,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    llmSelection?: SessionLlmSelection,
    externalMcpServers?: MCPServerConfig[]
  ): Promise<{ agent: DPAgent; reused: boolean }>;
  hasActiveRootAgentRun(): boolean;
  cleanupRootRuntimeAfterConfigChangeIfIdle(): Promise<void>;
  createCallback(
    ws: WebSocket,
    context: ContextRef,
    runId: string,
    llmRuntime: ResolvedLlmRuntimeConfig,
    runOrigin?: SessionOrigin
  ): AgentCallback;
  resolveAgentForContext(context: ContextRef): DPAgent;
  activateTrackedRun(
    runId: string,
    context: ContextRef,
    dispatcher: CallbackEventDispatcher,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    runFamilyId?: string,
    runOrigin?: SessionOrigin
  ): void;
  getContextNamespaceMetaSafe(context: ContextRef): ContextNamespaceMeta | undefined;
  clearTodoPlanConfirmationPending(sessionId: string): void;
  ensureTodoDrivenAutoLoop(sessionId: string, workspaceDir?: string): void;
  getAutoLoopConfigSafe(controller: unknown): { enabled?: boolean };
  getAutoLoopStateSafe(controller: unknown): { isRunning: boolean };
  startAutoLoopSafe(controller: unknown): void;
  touchSessionRuntime(sessionId: string): void;
}

export async function prepareWebServerChatExecution(
  host: WebServerChatPreparationHost,
  ws: WebSocket,
  request: ChatRequest
): Promise<PreparedChatExecution | null> {
  const context = host.resolveChatContext(request);
  if (!host.canWebSocketAccessContext(ws, context)) {
    host.emitToClient(ws, {
      type: 'server_error',
      data: {
        error: 'share_scope_forbidden',
        message: 'This shared link can only access its bound session.',
      },
    });
    return null;
  }
  const runOrigin = host.resolveRunOrigin(ws);
  const sessionKey = makeAutoLoopKey(context);
  const runId = createRunId();
  const dispatcher = host.createRunScopedDispatcher(ws, context, runId, undefined, runOrigin);
  host.currentSessionId = context.scope === 'session' ? context.namespace : host.currentSessionId;
  const workspaceDir = host.resolveWorkspaceDirForRun(context, request.workspaceDir);
  host.persistSessionRunMetadata(context, runOrigin, workspaceDir);
  const llmSelectionValidation = host.validateRequestedLlmSelection(request.llmSelection);
  if (!llmSelectionValidation.ok) {
    dispatcher.error(llmSelectionValidation.error);
    return null;
  }
  const llmSelection = host.resolveRequestedSessionLlmSelection(context, request.llmSelection);
  const planningState = host.resolvePlanningStateForChat(context, request.planningAction);
  const externalMcpServers = host.cloneExternalMcpServers(
    host.resolveContinuationExternalMcpServers(
      context,
      runOrigin === 'cli' ? request.externalMcpServers : undefined
    )
  );
  if (runOrigin === 'cli' && externalMcpServers.length > 0) {
    host.persistExternalMcpAttachment(context, externalMcpServers);
  }

  const resolvedPrompt = host.resolveUserPrompt({
    prompt: request.prompt,
    fileReferences: request.fileReferences,
    selectedAgentName: request.selectedAgentName,
    workspaceDir,
    ...(planningState !== 'normal' ? { planningState } : {}),
    context,
  });
  if (!resolvedPrompt.ok) {
    dispatcher.error(resolvedPrompt.error);
    host.refreshGlobalAgentCatalog();
    return null;
  }
  const agentLlmSelection = host.resolveAgentRuntimeLlmSelection(
    llmSelection,
    resolvedPrompt.agentRuntimeOverrides
  );
  if (!agentLlmSelection.ok) {
    dispatcher.error(agentLlmSelection.error);
    host.refreshGlobalAgentCatalog();
    return null;
  }
  const llmRuntime = resolveLlmRuntimeConfig(host.agent.getConfig(), agentLlmSelection.selection);

  if (!host.hasUsableApiKeyForRuntime(llmRuntime)) {
    dispatcher.error('API Key is not configured. Please open Settings and save a valid API Key first.');
    host.refreshGlobalAgentCatalog();
    return null;
  }

  if (context.scope === 'session' && host.hasActiveRunForContext(context)) {
    const activeRun = host.getActiveRunState(context);
    const contextKey = host.makeRunContextStateKey(context);
    const controllerWssId = host.getActiveRunControllerMap().get(contextKey);
    const socketScope = host.getWebSocketScopeMap().get(ws);
    webServerLogger.warn(
      `[WebServer] Reject chat because session has active run: session=${context.namespace} activeRunIds=${host.getActiveRunIdsForContext(context).join(',') || 'unknown'} details=${JSON.stringify({
        runId: (activeRun as { runId?: string } | null | undefined)?.runId,
        startedAt: (activeRun as { startedAt?: string } | null | undefined)?.startedAt,
        lastActivityAt: (activeRun as { lastActivityAt?: string } | null | undefined)?.lastActivityAt,
        owner: (activeRun as { owner?: unknown } | null | undefined)?.owner,
        controllerWssId,
        socketScope: host.summarizeWebSocketScopeForLog(socketScope),
      })}`
    );
    if (host.hasCancelingRunForContext(context)) {
      const stopped = await host.waitForNoActiveRunForContext(context);
      if (!stopped) {
        dispatcher.error('Previous run is still stopping. Try again shortly.');
        return null;
      }
    } else {
      dispatcher.error('Session already has an active run. Wait for it to finish or cancel it first.');
      return null;
    }
  }

  host.bindRunController(ws, context);
  const releaseReservation =
    context.scope === 'session' ? host.reserveTrackedRun(runId, context, llmRuntime, runOrigin) : null;
  let releaseRunReservation: (() => void) | null = releaseReservation
    ? () => {
        host.releaseRunController(context);
        releaseReservation();
      }
    : null;

  try {
    let reusedSessionRuntime = false;
    if (context.scope === 'session') {
      const runtime = await host.ensureSessionRuntime(
        context.namespace,
        workspaceDir,
        llmRuntime,
        llmSelection,
        externalMcpServers
      );
      reusedSessionRuntime = runtime.reused;
      webServerLogger.info(
        `[WebServer] Session runtime ready: session=${context.namespace} workspaceDir=${workspaceDir} profile=${llmRuntime.profileId} model=${llmRuntime.model} reused=${reusedSessionRuntime} externalMcpServers=${externalMcpServers.length}`
      );
    }

    if (context.scope !== 'session' && (host.rootRuntimeConfigDirty || host.rootRuntimeCleanupPromise)) {
      if (host.hasActiveRootAgentRun()) {
        dispatcher.error('Configuration update is waiting for the active workspace run to finish. Try again shortly.');
        releaseRunReservation?.();
        releaseRunReservation = null;
        return null;
      }
      await host.cleanupRootRuntimeAfterConfigChangeIfIdle();
    }

    const callback = host.createCallback(ws, context, runId, llmRuntime, runOrigin);
    await host.resolveAgentForContext(context).initialize(callback);
    host.activateTrackedRun(runId, context, dispatcher, llmRuntime, undefined, runOrigin);

    const meta = host.getContextNamespaceMetaSafe(context);
    const autoLoopConfig = context.scope === 'session' ? meta?.autoLoopConfig : undefined;
    const autoLoopController = autoLoopManager.getOrCreate(sessionKey, autoLoopConfig) as AutoLoopController;
    let autoLoopControllerForRun: AutoLoopController | undefined;
    if (context.scope === 'session' && planningState !== 'plan_drafting') {
      host.clearTodoPlanConfirmationPending(context.namespace);
      host.ensureTodoDrivenAutoLoop(context.namespace, workspaceDir);
    }
    const resolvedAutoLoopConfig = host.getAutoLoopConfigSafe(autoLoopController);
    if (
      planningState !== 'plan_drafting' &&
      resolvedAutoLoopConfig.enabled &&
      !host.getAutoLoopStateSafe(autoLoopController).isRunning
    ) {
      host.startAutoLoopSafe(autoLoopController);
    }
    if (
      planningState !== 'plan_drafting' &&
      (resolvedAutoLoopConfig.enabled || host.getAutoLoopStateSafe(autoLoopController).isRunning)
    ) {
      autoLoopControllerForRun = autoLoopController;
    }

    if (context.scope === 'session') {
      host.touchSessionRuntime(context.namespace);
    }

    releaseRunReservation = null;
    return {
      request,
      ownerWs: ws,
      context,
      runId,
      workspaceDir,
      llmSelection,
      llmRuntime,
      externalMcpServers,
      displayPrompt: resolvedPrompt.displayPrompt,
      effectivePrompt: resolvedPrompt.effectivePrompt,
      historyUserPrompt: resolvedPrompt.historyUserPrompt,
      agentInjectionStateUpdate: resolvedPrompt.agentInjectionStateUpdate,
      agentRuntimeOverrides: resolvedPrompt.agentRuntimeOverrides,
      runOrigin,
      ...(planningState !== 'normal' ? { planningState } : {}),
      promptRef: resolvedPrompt.promptRef,
      hasSystemPromptInjection: resolvedPrompt.hasSystemPromptInjection,
      callback,
      dispatcher,
      autoLoopController: autoLoopControllerForRun,
    };
  } catch (error) {
    releaseRunReservation?.();
    throw error;
  }
}
