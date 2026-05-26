import type { LiveEvent } from './components/chat/ChatContainer.js';
import type { Message, ToolCall, ToolResult } from './chat-types.js';
export type {
  LlmProfilesConfigView,
  PublicLlmProfile,
  PublicSettingsView,
} from '../../shared/web-settings-contracts.js';

export type ReasoningPreset = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SessionOrigin = 'web' | 'cli' | 'automation';
export type RunOwner = SessionOrigin;

export interface SessionInteractionStateView {
  mode: 'normal' | 'observe_only';
  reason?: 'cli_active_run' | 'automation_active_run' | 'wss_controlled_active_run';
  owner?: RunOwner;
}

export interface SessionLlmProviderOptionsView {
  openai?: {
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
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
  origin?: SessionOrigin;
  llmSelection?: SessionLlmSelectionView;
  planningState?: SessionPlanningStateView | null;
  activeRun?: ActiveRunView | null;
  interactionState?: SessionInteractionStateView;
  isLocalDraft?: boolean;
}

export interface SessionDetail {
  id: string;
  workspaceDir?: string;
  memoryPromotionState?: MemoryPromotionStateView | null;
  completionMarkerStats?: SessionInfo['completionMarkerStats'];
  origin?: SessionOrigin;
  llmSelection?: SessionLlmSelectionView;
  planningState?: SessionPlanningStateView | null;
  interactionState?: SessionInteractionStateView;
  contextUtilization?: {
    observedAt: string;
    ratio: number;
    usedChars: number;
    limitChars: number;
    usedTokens?: number;
    limitTokens?: number;
    source?: 'provider_usage' | 'weighted_char_estimate' | 'calibrated_weighted_estimate';
    anchorPromptTokens?: number;
    deltaEstimatedTokens?: number;
    isWarning: boolean;
  } | null;
  activeRun?: ActiveRunView | null;
  interruptedArtifact?: InterruptedArtifactView | null;
  pendingPlanInput?: {
    runId: string;
    requestId: string;
    source?: 'request_user_input' | 'finalize_plan_approval';
    requestedAt: string;
    questions: PlanInputQuestion[];
    planPreview?: FinalizedPlanView;
    lastError?: string | null;
  } | null;
  runtimeErrors?: RuntimeErrorMessageView[];
  messages: Array<{
    role: 'user' | 'assistant' | 'tool' | string;
    content: string;
    createdAt?: string;
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
  lastActivityAt?: string;
  currentStep?: number;
  maxSteps?: number;
  owner?: RunOwner;
  origin?: SessionOrigin;
  interactionState?: SessionInteractionStateView;
  llmRuntime?: RunLlmRuntimeView;
  runningInputQueue?: RunningInputQueueItemView[];
}

export interface RunningInputQueueItemView {
  id: string;
  runId: string;
  context: ContextRef;
  prompt: string;
  clientRequestId?: string;
  selectedAgentName?: string;
  fileReferences?: string[];
  createdAt: string;
  updatedAt: string;
  status: 'queued_next' | 'insert_requested';
  insertRequestedAt?: string;
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
}

export interface RunTerminalStateView {
  runId: string;
  runFamilyId: string;
  draftId: string;
  terminalCode: 'completed' | 'cancelled' | 'error';
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
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'dismissed';
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

export interface WorkspaceGovernanceMemoryItem {
  id: string;
  scope: 'user' | 'workspace';
  title: string;
  content: string;
  version: number;
  status: 'active' | 'superseded' | 'expired';
  updatedAt: string;
}

export interface WorkspaceGovernanceSkillItem {
  name: string;
  description: string;
  path: string;
  version?: string;
  reviewStatus?: string;
  isAutoGenerated: boolean;
  metadata?: Record<string, unknown>;
  content: string;
  workspaceDir: string;
}

export interface WorkspaceSkillGovernanceReport {
  kind: 'workspace_skill_governance';
  runId: string;
  workspaceDir: string;
  generatedAt: string;
  fallback: boolean;
  fallbackReason?: string;
  summary: {
    scannedSkills: number;
    exactDuplicates: number;
    candidateDuplicates: number;
    autoArchived: number;
    reportOnly: number;
    boundaryFixed: number;
    conflicts: number;
  };
}

export interface ContextRef {
  scope: 'session' | 'workspace' | 'global';
  namespace: string;
}

export type SessionPlanningState = 'normal' | 'plan_drafting' | 'plan_executing';

export interface SessionPlanningStateView {
  state: SessionPlanningState;
  pendingPlanId?: string;
  activeExecutionPlanId?: string;
  updatedAt?: string;
}

export interface AgentProfileConfigView {
  version?: 1;
  description?: string;
  llmProfileId?: string;
  llmModel?: string;
  reasoningPreset?: ReasoningPreset;
  loadGlobalSkills?: boolean;
  exposeAsSubagent?: boolean;
  promptAppend?: string;
  warnings?: string[];
  path?: string;
}

export interface AgentListItemView {
  name: string;
  source: 'bundled' | 'global' | 'workspace';
  description: string;
  path: string;
  mtime: string;
  config?: AgentProfileConfigView;
}

export interface RuntimeErrorMessageView {
  id: string;
  runId: string;
  message: string;
  createdAt: string;
  terminalCode?: 'cancelled' | 'error';
  replayCutoffKind?: 'none' | 'checkpoint' | 'endturn';
  lastSafeStep?: number;
  maxSteps?: number;
}

export type FinalizedPlanStepPriority = 'low' | 'medium' | 'high';

export interface FinalizedPlanStepView {
  planStepId: string;
  work: string;
  detectionStandard: string;
  priority?: FinalizedPlanStepPriority;
  tags?: string[];
}

export interface FinalizedPlanView {
  planId?: string;
  title: string;
  summary?: string;
  markdown: string;
  steps: FinalizedPlanStepView[];
  testPlan?: string[];
  assumptions?: string[];
  notes?: string;
  updatedAt?: string;
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
  source?: 'request_user_input' | 'finalize_plan_approval';
  questions: PlanInputQuestion[];
  planPreview?: FinalizedPlanView;
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
  activeRunOwner: RunOwner | null;
  interactionState: SessionInteractionStateView;
  runningInputQueue: RunningInputQueueItemView[];
}

export interface ChatStartedEvent {
  runId: string;
  context: ContextRef;
  startedAt?: string;
  owner?: RunOwner;
  origin?: SessionOrigin;
  interactionState?: SessionInteractionStateView;
  llmRuntime?: RunLlmRuntimeView;
  runningInputQueue?: RunningInputQueueItemView[];
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
    activeRunOwner: null,
    interactionState: { mode: 'normal' },
    runningInputQueue: [],
  };
}

export function removeRunningInputQueueItem(
  runtime: SessionRuntimeState,
  itemId: string
): SessionRuntimeState {
  const nextQueue = runtime.runningInputQueue.filter((item) => item.id !== itemId);
  if (nextQueue.length === runtime.runningInputQueue.length) {
    return runtime;
  }
  return {
    ...runtime,
    runningInputQueue: nextQueue,
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
    interruptedArtifact: null,
    isRunning: true,
    runStartedAt: startedAt,
    lastActivityAt: startedAt,
    activeRunOwner: 'web',
    interactionState: { mode: 'normal', owner: 'web' },
  };
}

function parseTimestampMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveActiveRunForHydration(
  runtime: Pick<SessionRuntimeState, 'ignoredRunIds'>,
  activeRun: ActiveRunView | null | undefined
): ActiveRunView | null {
  if (!activeRun) {
    return null;
  }
  return runtime.ignoredRunIds.includes(activeRun.runId) ? null : activeRun;
}

export function shouldPreserveCurrentRunForIgnoredActiveRunHydration(input: {
  runtime: Pick<SessionRuntimeState, 'isRunning' | 'runId'>;
  rawActiveRun: ActiveRunView | null | undefined;
  activeRunForHydration: ActiveRunView | null | undefined;
  pendingPlanInput?: unknown | null;
}): boolean {
  return Boolean(
    input.rawActiveRun &&
      !input.activeRunForHydration &&
      !input.pendingPlanInput &&
      input.runtime.isRunning &&
      input.runtime.runId &&
      input.runtime.runId !== input.rawActiveRun.runId
  );
}

export function hydrateRuntimeFromActiveRun(input: {
  runtime: SessionRuntimeState;
  activeRun: ActiveRunView;
  interactionState?: SessionInteractionStateView | null;
  now?: number;
}): SessionRuntimeState {
  if (input.runtime.ignoredRunIds.includes(input.activeRun.runId)) {
    return {
      ...input.runtime,
      hasHydrated: true,
      hydrating: false,
    };
  }
  const now = input.now ?? Date.now();
  const startedAtMs = parseTimestampMs(input.activeRun.startedAt);
  const activeLastActivityAtMs = parseTimestampMs(input.activeRun.lastActivityAt);
  const sameRunCurrentActivity =
    input.runtime.runId === input.activeRun.runId && input.runtime.lastActivityAt > 0
      ? input.runtime.lastActivityAt
      : 0;
  const staleSameRunHydration =
    sameRunCurrentActivity > 0 &&
    activeLastActivityAtMs > 0 &&
    sameRunCurrentActivity > activeLastActivityAtMs;
  const runStartedAt = startedAtMs || input.runtime.runStartedAt || now;
  const lastActivityAt = Math.max(
    activeLastActivityAtMs,
    sameRunCurrentActivity,
    runStartedAt,
    now && !activeLastActivityAtMs && !sameRunCurrentActivity && !runStartedAt ? now : 0
  );
  return {
    ...input.runtime,
    hasHydrated: true,
    hydrating: false,
    runId: input.activeRun.runId,
    isRunning: true,
    runStartedAt,
    lastActivityAt,
    currentStep: staleSameRunHydration
      ? input.runtime.currentStep
      : finiteNonNegativeInteger(input.activeRun.currentStep, input.runtime.currentStep),
    maxSteps: staleSameRunHydration
      ? input.runtime.maxSteps
      : finiteNonNegativeInteger(input.activeRun.maxSteps, input.runtime.maxSteps),
    currentLlmRuntime: input.activeRun.llmRuntime ?? input.runtime.currentLlmRuntime,
    activeRunOwner: input.activeRun.owner ?? null,
    interactionState: input.activeRun.interactionState ?? input.interactionState ?? { mode: 'normal' },
    runningInputQueue: input.activeRun.runningInputQueue ?? input.runtime.runningInputQueue,
    interruptedArtifact: null,
    lastTerminalState: null,
  };
}

export function resolveInterruptedArtifactForHydration(input: {
  interruptedArtifact: InterruptedArtifactView | null | undefined;
  currentRuntime: Pick<SessionRuntimeState, 'isRunning' | 'runId'> | null | undefined;
  activeRun?: ActiveRunView | null;
  pendingPlanInput?: unknown | null;
}): InterruptedArtifactView | null {
  const artifact = input.interruptedArtifact ?? null;
  if (!artifact) {
    return null;
  }
  if (input.activeRun || input.pendingPlanInput) {
    return null;
  }
  if (input.currentRuntime?.isRunning || input.currentRuntime?.runId) {
    return null;
  }
  return artifact;
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
    | (Pick<SessionRuntimeState, 'hydrating' | 'isRunning'> &
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
    (runtime.cancelInitiated === true && runtime.cancelAcknowledged !== true)
  );
}

export interface RuntimeInteractionLockDiagnostic {
  sessionId: string;
  reason: 'hydrating' | 'running' | 'canceling' | 'observe_only';
  runId: string | null;
  isRunning: boolean;
  hydrating: boolean;
  cancelInitiated: boolean;
  cancelAcknowledged: boolean;
  observeOnly: boolean;
  lastActivityAt?: string;
}

function timestampMsToIso(value: number | undefined): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

export function buildRuntimeInteractionLockDiagnostic(input: {
  sessionId: string;
  runtime: SessionRuntimeState;
}): RuntimeInteractionLockDiagnostic | null {
  const observeOnly = input.runtime.interactionState.mode === 'observe_only';
  if (!isRuntimeInteractionLocked(input.runtime) && !observeOnly) {
    return null;
  }
  const reason: RuntimeInteractionLockDiagnostic['reason'] = observeOnly
    ? 'observe_only'
    : input.runtime.hydrating
      ? 'hydrating'
      : input.runtime.cancelInitiated && input.runtime.cancelAcknowledged !== true
        ? 'canceling'
        : 'running';
  return {
    sessionId: input.sessionId,
    reason,
    runId: input.runtime.runId,
    isRunning: input.runtime.isRunning,
    hydrating: input.runtime.hydrating,
    cancelInitiated: input.runtime.cancelInitiated,
    cancelAcknowledged: input.runtime.cancelAcknowledged,
    observeOnly,
    lastActivityAt: timestampMsToIso(input.runtime.lastActivityAt),
  };
}

export function isRuntimeLlmSelectionLocked(
  runtime:
    | (Pick<SessionRuntimeState, 'hydrating' | 'isRunning'> &
        Partial<Pick<SessionRuntimeState, 'cancelInitiated' | 'cancelAcknowledged'>>)
    | null
    | undefined
): boolean {
  return (
    runtime?.hydrating === true ||
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
  if (runtime.runId && runtime.runId !== normalizedRunId) {
    return false;
  }
  if (runtime.ignoredRunIds.includes(normalizedRunId)) {
    return true;
  }
  return false;
}

export function createRunErrorTranscriptMessage(input: {
  runId: string;
  message: string;
  createdAt?: string;
  timestamp?: number;
  id?: string;
}): Message {
  const createdAt = input.createdAt ?? new Date(input.timestamp ?? Date.now()).toISOString();
  const parsedTimestamp = Date.parse(createdAt);
  return {
    id: input.id ?? `run-error-${input.runId}`,
    role: 'system',
    content: input.message,
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : input.timestamp ?? Date.now(),
    metadata: {
      runtimeEvent: 'run_error',
      runId: input.runId,
    },
  };
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
    activeRunOwner: null,
    interactionState: { mode: 'normal' },
    runningInputQueue: completedRuntime.runningInputQueue,
  };
}

export function finalizeRuntimeAfterRecoverableConflictError(
  runtime: SessionRuntimeState,
  runId: string,
  observedAt: number
): SessionRuntimeState {
  if (runtime.runId !== runId) {
    return runtime;
  }
  const nextRuntime = addIgnoredRunId(runtime, runId);
  return {
    ...nextRuntime,
    runId: null,
    runStartedAt: 0,
    lastActivityAt: observedAt,
    isRunning: false,
    cancelInitiated: false,
    cancelAcknowledged: true,
    cancelRequestedAt: 0,
    contextPrecompressActive: false,
    compressionStatus: null,
    liveEvents: closeStreamingThinking(nextRuntime.liveEvents),
    error: null,
    pendingPlanInput: null,
    pendingPlanInputError: null,
    currentLlmRuntime: null,
    activeRunOwner: null,
    interactionState: { mode: 'normal' },
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
    ...(pendingPlanInput.source ? { source: pendingPlanInput.source } : {}),
    context: {
      scope: 'session',
      namespace: sessionId,
    },
    ...(pendingPlanInput.planPreview ? { planPreview: pendingPlanInput.planPreview } : {}),
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
  {
    ratio: number;
    usedChars: number;
    limitChars: number;
    usedTokens?: number;
    limitTokens?: number;
    source?: 'provider_usage' | 'weighted_char_estimate' | 'calibrated_weighted_estimate';
    anchorPromptTokens?: number;
    deltaEstimatedTokens?: number;
    isWarning: boolean;
    initializing: boolean;
  }
>;

export interface ContextPrecompressUtilizationPayload {
  ratio?: unknown;
  usedChars?: unknown;
  limitChars?: unknown;
  usedTokens?: unknown;
  limitTokens?: unknown;
  source?: unknown;
  anchorPromptTokens?: unknown;
  deltaEstimatedTokens?: unknown;
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
  const usedTokens =
    typeof payload.usedTokens === 'number' && Number.isFinite(payload.usedTokens) && payload.usedTokens >= 0
      ? Math.floor(payload.usedTokens)
      : undefined;
  const limitTokens =
    typeof payload.limitTokens === 'number' && Number.isFinite(payload.limitTokens) && payload.limitTokens > 0
      ? Math.floor(payload.limitTokens)
      : undefined;
  const ratio = usedTokens !== undefined && limitTokens !== undefined ? usedTokens / limitTokens : usedChars / limitChars;
  const source =
    payload.source === 'provider_usage' ||
    payload.source === 'weighted_char_estimate' ||
    payload.source === 'calibrated_weighted_estimate'
      ? payload.source
      : undefined;
  return {
    ratio,
    usedChars,
    limitChars,
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(source ? { source } : {}),
    ...(typeof payload.anchorPromptTokens === 'number' && Number.isFinite(payload.anchorPromptTokens)
      ? { anchorPromptTokens: Math.floor(payload.anchorPromptTokens) }
      : {}),
    ...(typeof payload.deltaEstimatedTokens === 'number' && Number.isFinite(payload.deltaEstimatedTokens)
      ? { deltaEstimatedTokens: Math.floor(payload.deltaEstimatedTokens) }
      : {}),
    isWarning: ratio >= 0.8,
    initializing: false,
  };
}
