import type { LiveEvent } from './components/chat/ChatContainer.js';
import type { Message, ToolCall, ToolResult } from './hooks/useAgent.js';

export type ReasoningPreset = 'off' | 'low' | 'medium' | 'high';

export interface SessionLlmProviderOptionsView {
  openai?: {
    reasoningEffort?: 'low' | 'medium' | 'high' | null;
  };
  anthropic?: {
    thinkingBudgetTokens?: number | null;
  };
}

export interface SessionLlmSelectionView {
  profileId: string;
  model: string;
  reasoningPreset: ReasoningPreset;
  providerOptions?: SessionLlmProviderOptionsView;
  updatedAt: string;
}

export interface SessionLlmSelectionPatch {
  profileId?: string;
  model?: string;
  reasoningPreset?: ReasoningPreset;
  providerOptions?: SessionLlmProviderOptionsView;
  updatedAt?: string;
}

export interface PublicLlmProfile {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai';
  apiBase: string;
  defaultModel: string;
  maxOutputTokens?: number;
  enabled?: boolean;
  capabilities?: {
    modelDiscovery?: boolean;
    reasoningEffort?: boolean;
    thinkingBudget?: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
  hasApiKey: boolean;
}

export interface LlmProfilesConfigView {
  defaultProfileId: string;
  profiles: PublicLlmProfile[];
}

export interface LlmProfileIntrospectionView {
  profileId: string;
  source: 'live' | 'cache' | 'manual';
  fetchedAt: string;
  models: Array<{
    id: string;
    displayName?: string;
    ownedBy?: string;
    provider: 'anthropic' | 'openai';
    supportsReasoningEffort?: boolean;
    supportsThinkingBudget?: boolean;
  }>;
  manualModelEntryAllowed: boolean;
  capabilities: {
    modelDiscovery: boolean;
    reasoningEffort: boolean;
    thinkingBudget: boolean;
  };
  error?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  workspaceDir?: string;
  toolsetName?: string;
  createdAt?: string;
  updatedAt?: string;
  memoryPromotionState?: MemoryPromotionStateView | null;
  completionMarkerStats?: {
    repairCount: number;
    lastTriggeredAt?: string;
    lastResolvedAt?: string;
    lastIssue?: 'missing_tail_marker' | 'duplicate_tail_marker';
  } | null;
  llmSelection?: SessionLlmSelectionView;
  isLocalDraft?: boolean;
}

export interface SessionDetail {
  id: string;
  workspaceDir?: string;
  memoryPromotionState?: MemoryPromotionStateView | null;
  completionMarkerStats?: SessionInfo['completionMarkerStats'];
  llmSelection?: SessionLlmSelectionView;
  contextUtilization?: {
    observedAt: string;
    ratio: number;
    usedChars: number;
    limitChars: number;
    isWarning: boolean;
  } | null;
  activeRun?: ActiveRunView | null;
  pendingResume?: boolean;
  interruptedArtifact?: InterruptedArtifactView | null;
  pendingPlanInput?: {
    runId: string;
    requestId: string;
    requestedAt: string;
    questions: PlanInputQuestion[];
    lastError?: string | null;
  } | null;
  messages: Array<{
    role: 'user' | 'assistant' | 'tool' | string;
    content: string;
    thinking?: string;
    metadata?: Message['metadata'];
    toolCalls?: Array<{ id: string; function: { name: string; arguments: Record<string, unknown> } }>;
    toolCallId?: string;
    name?: string;
  }>;
}

export interface ActiveRunView {
  runId: string;
  runFamilyId?: string;
  draftId?: string;
  context: ContextRef;
  startedAt: string;
  llmRuntime?: RunLlmRuntimeView;
}

export interface InterruptedArtifactView {
  artifactId: string;
  context: ContextRef;
  draftId: string;
  turnId: string;
  runId: string;
  runFamilyId: string;
  terminalCode: 'cancelled' | 'error';
  replayCutoffKind: 'none' | 'checkpoint';
  resumable: boolean;
  lastSafeStep: number;
  maxSteps: number;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
  previewMessages: SessionDetail['messages'];
  sideEffectLedger: Array<{
    id: string;
    observedAt: string;
    toolName: string;
    toolCallId?: string;
    resultSuccess?: boolean;
    resultSummary: string;
  }>;
  checkpointTurnId?: string;
  dismissedAt?: string;
}

export interface RunTerminalStateView {
  runId: string;
  runFamilyId: string;
  draftId: string;
  terminalCode: 'completed' | 'cancelled' | 'error';
  resumable: boolean;
  lastSafeStep: number;
  maxSteps: number;
  replayCutoffKind: 'none' | 'checkpoint' | 'endturn';
  errorSummary?: string | null;
  createdAt: string;
  artifact?: InterruptedArtifactView | null;
}

export interface RunLlmRuntimeView {
  profileId: string;
  provider: 'anthropic' | 'openai';
  model: string;
  reasoningPreset: ReasoningPreset;
}

export interface RuntimeCompressionStatus {
  source: 'replay_prepare' | 'in_turn_precompress';
  phase: 'started' | 'running';
  observedAt: string;
  ratio?: number;
  progressPercent?: number;
  chunkIndex?: number;
  chunkTotal?: number;
}

export interface MemoryPromotionStateView {
  lastProcessedContextVersion: number;
  lastQueuedContextVersion: number;
  pendingTurnCount: number;
  lastActivityAt: string;
  lastProcessedAt?: string;
  status?: 'idle' | 'queued' | 'processing' | 'failed';
  lastError?: string;
}

export interface TodoItem {
  id: string;
  work: string;
  detectionStandard: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed';
  priority: 'low' | 'medium' | 'high';
  blockedReason?: string;
  completionTaskId?: string;
  evidence?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceAuditItem {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: 'info' | 'success' | 'warning';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ContextRef {
  scope: 'session' | 'workspace' | 'global';
  namespace: string;
}

export interface PlanInputOption {
  label: string;
  description: string;
}

export interface PlanInputQuestion {
  header: string;
  id: string;
  question: string;
  options: PlanInputOption[];
}

export interface PlanInputRequestPayload {
  runId: string;
  context: ContextRef;
  requestId: string;
  questions: PlanInputQuestion[];
}

export interface PendingPlanInputSessionItem {
  sessionId: string;
  sessionName: string;
  requestId: string;
}

export interface PlanInputAnswerPayload {
  id: string;
  selectedLabel: string;
  selectedIndex: number;
  freeText?: string;
}

export interface SessionRuntimeState {
  runId: string | null;
  ignoredRunIds: string[];
  runStartedAt: number;
  lastActivityAt: number;
  hasHydrated: boolean;
  hydrating: boolean;
  isRunning: boolean;
  resumePending: boolean;
  dismissPending: boolean;
  cancelInitiated: boolean;
  cancelAcknowledged: boolean;
  cancelRequestedAt: number;
  contextPrecompressActive: boolean;
  compressionStatus: RuntimeCompressionStatus | null;
  forceResetCount: number;
  currentStep: number;
  maxSteps: number;
  liveEvents: LiveEvent[];
  contentAccumulator: string;
  toolCallsAccumulator: ToolCall[];
  toolResultsAccumulator: ToolResult[];
  error: string | null;
  interruptedArtifact: InterruptedArtifactView | null;
  lastTerminalState: RunTerminalStateView | null;
  pendingPlanInput: PlanInputRequestPayload | null;
  pendingPlanInputError: string | null;
  currentLlmRuntime: RunLlmRuntimeView | null;
}

export interface ChatStartedEvent {
  runId: string;
  context: ContextRef;
  startedAt?: string;
  llmRuntime?: RunLlmRuntimeView;
}

export function inferToolResultSuccess(content: string): boolean {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) {
    return true;
  }

  if (/^(error|failed|exception)\b/i.test(trimmed)) {
    return false;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && 'success' in parsed) {
        return Boolean((parsed as { success?: unknown }).success);
      }
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        return false;
      }
    } catch {
      // Ignore parse failures and fall back to string heuristics.
    }
  }

  return true;
}

export function createClientSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createRuntimeState(): SessionRuntimeState {
  return {
    runId: null,
    ignoredRunIds: [],
    runStartedAt: 0,
    lastActivityAt: 0,
    hasHydrated: false,
    hydrating: false,
    isRunning: false,
    resumePending: false,
    dismissPending: false,
    cancelInitiated: false,
    cancelAcknowledged: false,
    cancelRequestedAt: 0,
    contextPrecompressActive: false,
    compressionStatus: null,
    forceResetCount: 0,
    currentStep: 0,
    maxSteps: 0,
    liveEvents: [],
    contentAccumulator: '',
    toolCallsAccumulator: [],
    toolResultsAccumulator: [],
    error: null,
    interruptedArtifact: null,
    lastTerminalState: null,
    pendingPlanInput: null,
    pendingPlanInputError: null,
    currentLlmRuntime: null,
  };
}

export function createPendingRunRuntimeState(
  runtime: SessionRuntimeState,
  startedAt: number
): SessionRuntimeState {
  return {
    ...createRuntimeState(),
    hasHydrated: runtime.hasHydrated,
    ignoredRunIds: runtime.ignoredRunIds,
    interruptedArtifact: runtime.interruptedArtifact,
    isRunning: true,
    runStartedAt: startedAt,
    lastActivityAt: startedAt,
  };
}

function runtimeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const normalized = String(error ?? '').trim();
  return normalized || fallback;
}

export function finishRuntimeHydrationAfterLoadFailure(
  runtime: SessionRuntimeState,
  error: unknown
): SessionRuntimeState {
  return {
    ...runtime,
    hydrating: false,
    error: runtimeErrorMessage(error, 'Failed to load session messages'),
  };
}

export function isRuntimeInteractionLocked(
  runtime:
    | (Pick<SessionRuntimeState, 'hydrating' | 'isRunning' | 'resumePending' | 'dismissPending'> &
        Partial<Pick<SessionRuntimeState, 'cancelInitiated' | 'cancelAcknowledged'>>)
    | null
    | undefined
): boolean {
  if (!runtime) {
    return false;
  }
  return (
    runtime.hydrating === true ||
    runtime.isRunning === true ||
    runtime.resumePending === true ||
    runtime.dismissPending === true ||
    (runtime.cancelInitiated === true && runtime.cancelAcknowledged !== true)
  );
}

export function isRuntimeLlmSelectionLocked(
  runtime:
    | (Pick<SessionRuntimeState, 'hydrating' | 'isRunning' | 'resumePending' | 'dismissPending'> &
        Partial<Pick<SessionRuntimeState, 'cancelInitiated' | 'cancelAcknowledged'>>)
    | null
    | undefined
): boolean {
  return (
    runtime?.hydrating === true ||
    runtime?.isRunning === true ||
    runtime?.resumePending === true ||
    runtime?.dismissPending === true ||
    (runtime?.cancelInitiated === true && runtime.cancelAcknowledged !== true)
  );
}

export function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_IGNORED_RUN_IDS = 30;

export function addIgnoredRunId(
  runtime: SessionRuntimeState,
  runId: string | null | undefined
): SessionRuntimeState {
  const normalizedRunId = String(runId ?? '').trim();
  if (!normalizedRunId) {
    return runtime;
  }
  const previous = runtime.ignoredRunIds.filter((item) => item !== normalizedRunId);
  return {
    ...runtime,
    ignoredRunIds: [...previous, normalizedRunId].slice(-MAX_IGNORED_RUN_IDS),
  };
}

export function shouldApplyRunEvent(runtime: SessionRuntimeState, runId: string): boolean {
  const normalizedRunId = String(runId ?? '').trim();
  if (!normalizedRunId) {
    return false;
  }
  if (runtime.ignoredRunIds.includes(normalizedRunId)) {
    return false;
  }
  if (runtime.runId === normalizedRunId) {
    return true;
  }
  if (!runtime.runId && runtime.isRunning) {
    return false;
  }
  if (!runtime.runId && !runtime.cancelInitiated && runtime.runStartedAt <= 0) {
    return true;
  }
  return false;
}

export function shouldApplyContextPrecompressEvent(runtime: SessionRuntimeState, runId: string): boolean {
  const normalizedRunId = String(runId ?? '').trim();
  if (!normalizedRunId) {
    return false;
  }
  if (runtime.runId && runtime.runId !== normalizedRunId) {
    return false;
  }
  if (!runtime.runId && !runtime.isRunning) {
    return false;
  }
  return shouldApplyRunEvent(runtime, normalizedRunId);
}

export function shouldApplyCancelAck(
  runtime: Pick<SessionRuntimeState, 'runId' | 'cancelInitiated' | 'ignoredRunIds'>,
  runId: string | null | undefined
): boolean {
  const normalizedRunId = String(runId ?? '').trim();
  if (!normalizedRunId) {
    return runtime.cancelInitiated;
  }
  if (runtime.runId === normalizedRunId) {
    return true;
  }
  return runtime.cancelInitiated && runtime.ignoredRunIds.includes(normalizedRunId);
}

export function shouldApplyRunTerminalEvent(runtime: SessionRuntimeState, runId: string): boolean {
  const normalizedRunId = String(runId ?? '').trim();
  if (!normalizedRunId) {
    return false;
  }
  if (runtime.runId === normalizedRunId) {
    return true;
  }
  if (runtime.ignoredRunIds.includes(normalizedRunId)) {
    return true;
  }
  return false;
}

export function observeRunEvent(
  runtime: SessionRuntimeState,
  runId: string,
  timestamp: number
): SessionRuntimeState {
  return {
    ...runtime,
    runId,
    isRunning: true,
    resumePending: false,
    dismissPending: false,
    runStartedAt: runtime.runStartedAt || timestamp,
    lastActivityAt: timestamp,
  };
}

export function finalizeRuntimeAfterComplete(
  runtime: SessionRuntimeState,
  runId: string,
  completedAt: number
): SessionRuntimeState {
  const completedRuntime = addIgnoredRunId(runtime, runId);
  return {
    ...completedRuntime,
    runId: null,
    runStartedAt: 0,
    lastActivityAt: completedAt,
    isRunning: false,
    resumePending: false,
    dismissPending: false,
    cancelInitiated: false,
    cancelAcknowledged: true,
    cancelRequestedAt: 0,
    contextPrecompressActive: false,
    compressionStatus: null,
    liveEvents: [],
    contentAccumulator: '',
    toolCallsAccumulator: [],
    toolResultsAccumulator: [],
    error: null,
    interruptedArtifact: null,
    lastTerminalState: null,
    pendingPlanInput: null,
    pendingPlanInputError: null,
    currentLlmRuntime: null,
  };
}

export function restorePendingPlanInputPayload(
  sessionId: string,
  pendingPlanInput: SessionDetail['pendingPlanInput']
): PlanInputRequestPayload | null {
  if (!pendingPlanInput) {
    return null;
  }
  return {
    runId: pendingPlanInput.runId,
    requestId: pendingPlanInput.requestId,
    context: {
      scope: 'session',
      namespace: sessionId,
    },
    questions: pendingPlanInput.questions.map((question) => ({
      header: question.header,
      id: question.id,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function deriveSessionNameFromPrompt(prompt: string, fallback: string): string {
  const normalized = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= 36) {
    return normalized;
  }
  return `${normalized.slice(0, 33)}...`;
}

export function getSessionSortTimestamp(session: SessionInfo): number {
  const value = Date.parse(session.updatedAt ?? session.createdAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

export function upsertSessionToFront(list: SessionInfo[], session: SessionInfo): SessionInfo[] {
  return [session, ...list.filter((item) => item.id !== session.id)];
}

export function toSessionId(context: ContextRef | undefined): string | null {
  if (!context || context.scope !== 'session') {
    return null;
  }
  const namespace = String(context.namespace ?? '').trim();
  return namespace.length > 0 ? namespace : null;
}

export function closeStreamingThinking(events: LiveEvent[]): LiveEvent[] {
  if (events.length === 0) {
    return events;
  }
  const next = [...events];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const event = next[i];
    if (event.type !== 'thinking') {
      break;
    }
    if (event.isStreaming) {
      next[i] = { ...event, isStreaming: false };
    }
  }
  return next;
}

export function appendLiveTextDelta(
  events: LiveEvent[],
  content: string,
  timestamp: number,
  createEventId: () => string,
  llmRuntime?: RunLlmRuntimeView | null
): LiveEvent[] {
  if (content.length === 0) {
    return events;
  }
  const next = closeStreamingThinking(events);
  const last = next[next.length - 1];
  if (last?.type === 'text') {
    return [
      ...next.slice(0, -1),
      {
        ...last,
        content: `${last.content}${content}`,
        llmRuntime: last.llmRuntime ?? llmRuntime ?? null,
        timestamp,
      },
    ];
  }
  return [
    ...next,
    {
      id: createEventId(),
      type: 'text',
      content,
      llmRuntime: llmRuntime ?? null,
      timestamp,
    },
  ];
}

export function upsertRunStatusEvent(
  events: LiveEvent[],
  payload: {
    title: string;
    summary?: string;
    timestamp: number;
    createEventId: () => string;
  }
): LiveEvent[] {
  const next = closeStreamingThinking(events);
  const last = next[next.length - 1];
  if (last?.type === 'run_status') {
    return [
      ...next.slice(0, -1),
      {
        ...last,
        title: payload.title,
        summary: payload.summary,
        timestamp: payload.timestamp,
      },
    ];
  }
  return [
    ...next,
    {
      id: payload.createEventId(),
      type: 'run_status',
      title: payload.title,
      summary: payload.summary,
      timestamp: payload.timestamp,
    },
  ];
}

function isToolCallArgsEmpty(args: Record<string, unknown>): boolean {
  return Object.keys(args).length === 0;
}

function findToolCallLiveEventIndex(events: LiveEvent[], toolCallId: string): number {
  let latestIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'tool_call' || event.toolCallId !== toolCallId) {
      continue;
    }
    if (latestIndex === -1) {
      latestIndex = i;
    }
    if (isToolCallArgsEmpty(event.args)) {
      return i;
    }
  }
  return latestIndex;
}

function findToolCallAccumulatorIndex(toolCalls: ToolCall[], toolCallId: string): number {
  let latestIndex = -1;
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    const item = toolCalls[i];
    if (item.toolCallId !== toolCallId) {
      continue;
    }
    if (latestIndex === -1) {
      latestIndex = i;
    }
    if (isToolCallArgsEmpty(item.args)) {
      return i;
    }
  }
  return latestIndex;
}

export function upsertToolCallState(
  liveEvents: LiveEvent[],
  toolCallsAccumulator: ToolCall[],
  payload: {
    toolCallId?: string;
    name: string;
    args: Record<string, unknown>;
    timestamp: number;
    createEventId: () => string;
  }
): { liveEvents: LiveEvent[]; toolCallsAccumulator: ToolCall[] } {
  const nextLiveEvents = [...liveEvents];
  const nextToolCallsAccumulator = [...toolCallsAccumulator];
  const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
  const isArgsEmpty = isToolCallArgsEmpty(payload.args);
  const canUpgradeExisting = Boolean(toolCallId) && !isArgsEmpty;

  if (canUpgradeExisting && toolCallId) {
    const liveEventIndex = findToolCallLiveEventIndex(nextLiveEvents, toolCallId);
    if (liveEventIndex >= 0) {
      const event = nextLiveEvents[liveEventIndex];
      if (event.type === 'tool_call') {
        nextLiveEvents[liveEventIndex] = {
          ...event,
          args: payload.args,
          timestamp: payload.timestamp,
        };
      }
    } else {
      nextLiveEvents.push({
        id: payload.createEventId(),
        type: 'tool_call',
        toolCallId,
        name: payload.name,
        args: payload.args,
        timestamp: payload.timestamp,
      });
    }

    const accumulatorIndex = findToolCallAccumulatorIndex(nextToolCallsAccumulator, toolCallId);
    if (accumulatorIndex >= 0) {
      nextToolCallsAccumulator[accumulatorIndex] = {
        ...nextToolCallsAccumulator[accumulatorIndex],
        args: payload.args,
      };
    } else {
      nextToolCallsAccumulator.push({
        toolCallId,
        name: payload.name,
        args: payload.args,
      });
    }

    return {
      liveEvents: nextLiveEvents,
      toolCallsAccumulator: nextToolCallsAccumulator,
    };
  }

  nextLiveEvents.push({
    id: payload.createEventId(),
    type: 'tool_call',
    toolCallId,
    name: payload.name,
    args: payload.args,
    timestamp: payload.timestamp,
  });
  nextToolCallsAccumulator.push({
    toolCallId,
    name: payload.name,
    args: payload.args,
  });
  return {
    liveEvents: nextLiveEvents,
    toolCallsAccumulator: nextToolCallsAccumulator,
  };
}

export function truncateLiveSummary(value: string, maxChars = 180): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

export type MessageMap = Record<string, Message[]>;
export type RuntimeMap = Record<string, SessionRuntimeState>;
export type ContextUtilizationMap = Record<
  string,
  { ratio: number; usedChars: number; limitChars: number; isWarning: boolean; initializing: boolean }
>;

export interface ContextPrecompressUtilizationPayload {
  ratio?: unknown;
  usedChars?: unknown;
  limitChars?: unknown;
}

export function contextUtilizationFromPrecompressPayload(
  payload: ContextPrecompressUtilizationPayload
): ContextUtilizationMap[string] | null {
  if (
    typeof payload.usedChars !== 'number' ||
    !Number.isFinite(payload.usedChars) ||
    payload.usedChars < 0 ||
    typeof payload.limitChars !== 'number' ||
    !Number.isFinite(payload.limitChars) ||
    payload.limitChars <= 0
  ) {
    return null;
  }
  const usedChars = Math.floor(payload.usedChars);
  const limitChars = Math.floor(payload.limitChars);
  if (limitChars <= 0) {
    return null;
  }
  const ratio = usedChars / limitChars;
  return {
    ratio,
    usedChars,
    limitChars,
    isWarning: ratio >= 0.8,
    initializing: false,
  };
}
