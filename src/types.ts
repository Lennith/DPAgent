/**
 * Project-wide public/runtime types.
 *
 * Key export groups:
 * - LLM provider profiles, session selections, runtime config, and model introspection.
 * - Agent messages, callbacks, context metadata/events, and session persistence records.
 * - Automation jobs, runs, schedules, reports, and governance report payloads.
 * - Web/runtime support types such as MCP status, tool schemas, permissions, and shell options.
 *
 * Notable edit points:
 * - Keep persisted record migrations explicit when removing or changing durable fields.
 * - Runtime-facing configuration should expose canonical fields only.
 */
export interface ContextBudgetConfig {
  defaultContextWindowTokens: number;
  compressionTriggerRatio: number;
  postCompressionTargetRatio: number;
  minTokensAddedAfterCompression: number;
  compressionMaxChars: number;
  precompressKeepLlmRounds: number;
  precompressChunkChars: number;
  precompressRetry: number;
  reservedOutputTokens: number;
  reservedReasoningTokens: number;
  reservedProtocolTokens: number;
  modelOverrides: Record<string, ModelContextBudgetOverride>;
}

export interface ModelContextBudgetOverride {
  contextWindowTokens?: number;
  compressionTriggerRatio?: number;
  postCompressionTargetRatio?: number;
  reservedOutputTokens?: number;
  reservedReasoningTokens?: number;
  reservedProtocolTokens?: number;
}

export interface ResolvedContextBudget {
  provider: string;
  model: string;
  contextWindowTokens: number;
  estimatedContextWindowChars: number;
  compressionTriggerRatio: number;
  postCompressionTargetRatio: number;
  minTokensAddedAfterCompression: number;
  compressionMaxChars: number;
  precompressKeepLlmRounds: number;
  precompressChunkChars: number;
  precompressRetry: number;
  reservedOutputTokens: number;
  reservedReasoningTokens: number;
  reservedProtocolTokens: number;
  safeInputTokens: number;
  compressionTriggerTokens: number;
  postCompressionTargetTokens: number;
  source: 'profile_override' | 'model_override' | 'config_default';
}

export interface ContextUsageEstimate {
  inputTokens: number;
  source: 'provider_usage' | 'weighted_char_estimate' | 'calibrated_weighted_estimate';
  confidence: 'exact' | 'estimated';
  rawChars?: number;
}

export interface RemoteAccessAuthConfig {
  enabled: boolean;
  passwordHash?: string;
  passwordSalt?: string;
  sessionTtlMs: number;
  trustProxy: boolean;
}

export interface LLMProvider {
  type: 'anthropic' | 'openai';
}

export type APIProvider = 'anthropic' | 'openai';
export type ReasoningPreset = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmProviderCapabilities {
  modelDiscovery?: boolean;
  reasoningEffort?: boolean;
  thinkingBudget?: boolean;
}

export interface LlmProviderProfileConfig {
  id: string;
  name: string;
  provider: APIProvider;
  apiKey: string;
  apiBase: string;
  defaultModel: string;
  availableModels?: string[];
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  enabled?: boolean;
  capabilities?: LlmProviderCapabilities;
  createdAt?: string;
  updatedAt?: string;
}

export interface LlmProfilesConfig {
  defaultProfileId: string;
  profiles: LlmProviderProfileConfig[];
}

export interface SessionLlmProviderOptions {
  openai?: {
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | null;
  };
  anthropic?: {
    thinkingBudgetTokens?: number | null;
  };
}

export interface SessionLlmSelection {
  profileId: string;
  model: string;
  reasoningPreset: ReasoningPreset;
  providerOptions?: SessionLlmProviderOptions;
  updatedAt: string;
}

export interface SessionLlmSelectionInput {
  profileId?: string;
  model?: string;
  reasoningPreset?: ReasoningPreset;
  providerOptions?: SessionLlmProviderOptions;
  updatedAt?: string;
}

export type SessionOrigin = 'web' | 'cli' | 'automation';
export type RunOwner = SessionOrigin;

export interface SessionInteractionState {
  mode: 'normal' | 'observe_only';
  reason?: 'cli_active_run' | 'automation_active_run' | 'wss_controlled_active_run';
  owner?: RunOwner;
}

export interface ResolvedLlmRuntimeConfig {
  profileId: string;
  provider: APIProvider;
  apiKey: string;
  apiBase: string;
  model: string;
  maxOutputTokens: number;
  reasoningPreset: ReasoningPreset;
  capabilities: {
    reasoningEffort: boolean;
    thinkingBudget: boolean;
  };
  providerOptions?: SessionLlmProviderOptions;
}

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  provider?: APIProvider;
  ownedBy?: string;
  supportsReasoningEffort?: boolean;
  supportsThinkingBudget?: boolean;
}

export interface LlmProfileIntrospection {
  profileId: string;
  source: 'live' | 'cache' | 'manual';
  fetchedAt: string;
  models: DiscoveredModel[];
  manualModelEntryAllowed: boolean;
  capabilities: {
    modelDiscovery: boolean;
    reasoningEffort: boolean;
    thinkingBudget: boolean;
  };
  error?: string;
}

export interface AgentProfileConfig {
  version?: 1;
  description?: string;
  llmProfileId?: string;
  llmModel?: string;
  reasoningPreset?: ReasoningPreset;
  toolsetName?: string;
  allowedTools?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  loadGlobalSkills?: boolean;
  exposeAsSubagent?: boolean;
  promptAppend?: string;
}

export interface AgentProfileConfigView extends AgentProfileConfig {
  warnings?: string[];
  path?: string;
}

export interface AgentRuntimeOverrides {
  agentProfile?: {
    source: 'workspace' | 'global' | 'bundled';
    name: string;
    path: string;
  };
  loadGlobalSkills?: boolean;
  llmProfileId?: string;
  llmModel?: string;
  reasoningPreset?: ReasoningPreset;
  toolsetName?: string;
  allowedTools?: string[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface FunctionCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: FunctionCall;
}

// Checkpoint and Metadata types
export type CheckpointReason = 'user_prompt' | 'assistant_toolcall' | 'summary_anchor';

export interface MessageMetadata {
  tokenCount?: number;
  compressed?: boolean;
  originalSize?: number;
  compressedSize?: number;
  contextCompaction?: ContextCompactionMetadata;
  checkpointId?: string;
  checkpointReason?: CheckpointReason;
  summaryAnchor?: boolean;
  summaryFromCheckpointId?: string;
  summaryCompactedMessageCount?: number;
  llmProviderProfileId?: string;
  llmProvider?: APIProvider;
  llmModel?: string;
  thinkingComplete?: boolean;
  toolResultArtifact?: ToolResultArtifactRef;
}

export interface ContextPayloadProjectionMetrics {
  originalChars: number;
  projectedChars: number;
  preparedChars: number;
  originalMessageCount: number;
  projectedMessageCount: number;
  preparedMessageCount: number;
  toolResultRefReplacements: number;
  oversizedInlineToolTruncations: number;
  protocolCorrectionCount: number;
  trimRemovedCount: number;
  trimTruncatedCount: number;
}

export interface ContextCompactionMetadata {
  sourceRange: {
    startIndex: number;
    endIndex: number;
    messageCount: number;
    sourceHash: string;
  };
  sourceCoverage?: {
    status: 'complete' | 'truncated';
    droppedMessageCount: number;
    reason?: string;
  };
  sealedBoundary: {
    keptLlmRounds: number;
    tailMessageCount: number;
  };
  payloadMetrics: ContextPayloadProjectionMetrics;
  configFingerprint: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  metadata?: MessageMetadata;
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Max Tokens Recovery types
export interface MaxTokensRecoveryEvent {
  observedAt: string;
  step: number;
  attempt: number;
  maxAttempts: number;
  recovered: boolean;
  finishReason: 'max_tokens';
  usage?: TokenUsage;
  preCompressMessageCount: number;
  preCompressChars: number;
  postCompressMessageCount: number;
  postCompressChars: number;
  compactedToolCallChains: number;
  compactedToolMessages: number;
  compressionMode: 'llm_compressor' | 'deterministic_trim' | 'none';
  compressionError?: string;
  continuationInjected: boolean;
  maxTokensSnapshotPath?: string | null;
}

export interface AgentCompletionMeta {
  finishReason?: string;
  usage?: TokenUsage;
  step: number;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
  maxTokensSnapshotPath?: string | null;
}

export interface ContextPrecompressEvent {
  phase?: 'started' | 'running' | 'completed' | 'failed';
  source?: 'replay_prepare' | 'in_turn_precompress';
  observedAt: string;
  triggerChars: number;
  triggerTokens?: number;
  triggerRatio?: number;
  triggerThresholdChars?: number;
  triggerThresholdTokens?: number;
  keepLlmRounds: number;
  keepLlmRoundsApplied?: number;
  chunkChars: number;
  retryLimit: number;
  totalCharsBefore: number;
  totalCharsAfter: number;
  systemPromptChars: number;
  messageCharsBefore: number;
  messageCharsAfter: number;
  triggered: boolean;
  applied: boolean;
  chunkCount: number;
  retryCount: number;
  failureReason?: string;
  profileNormalizedCount: number;
  profileRuntimeSource?: string;
  profileRuntimePath?: string;
  mode?: 'light' | 'aggressive';
  forced?: boolean;
  durationMs?: number;
  progressPercent?: number;
  chunkIndex?: number;
  chunkTotal?: number;
  sourceDroppedMessageCount?: number;
  willRetriggerImmediately?: boolean;
  willRetriggerNextTurn?: boolean;
  postCompressRatio?: number;
  providerPayloadCharsAfter?: number;
  providerPayloadTokensAfter?: number;
  projectedCharsAfter?: number;
  projectedTokensAfter?: number;
  postCompactValidation?: 'provider_payload' | 'provider_payload_after_turn';
}

export interface ToolResultArtifactRef {
  artifactId: string;
  toolCallId: string;
  toolName: string;
  relativePath: string;
  absolutePath?: string;
  originalChars: number;
  previewChars: number;
  createdAt: string;
}

export type ContextOverflowStage = 'overflow_detected' | 'forced_compress' | 'forced_trim' | 'forced_trim_failed';

export type ContextOverflowDecision = 'retry_with_forced_compress' | 'retry_with_forced_trim' | 'abort';

export interface ContextOverflowEvent {
  observedAt: string;
  step: number;
  attempt: number;
  overflowCountInTurn: number;
  stage: ContextOverflowStage;
  decision: ContextOverflowDecision;
  errorRaw: string;
  contextWindowChars: number;
  contextWindowTokens?: number;
  precompressTriggerRatio: number;
  precompressTriggerThresholdChars: number;
  precompressTriggerThresholdTokens?: number;
  forcedTrimChars: number;
  maxErrorsBeforeTrim: number;
  beforeMessageCount: number;
  beforeChars: number;
  beforeTokens?: number;
  afterMessageCount?: number;
  afterChars?: number;
  afterTokens?: number;
  tailRoundsKept?: number;
  chunkCount?: number;
  retryCount?: number;
  profileRuntimeSource?: string;
  profileRuntimePath?: string;
  profileRuntimeFailureReason?: string;
  notes?: string;
  llmInputSnapshotPath?: string | null;
  contextOverflowSnapshotPath?: string | null;
}

/**
 * REQ-0025: Context utilization tracking event for UI progress display.
 * Broadcast when context usage changes significantly during execution.
 */
export interface ContextUtilizationEvent {
  observedAt: string;
  runId: string;
  context: ContextRef;
  utilizationRatio: number; // 0.0 to 1.0
  usedChars: number;
  limitChars: number;
  triggerRatio?: number; // The ratio that triggered this event (e.g., 0.8 for warning)
  isWarning: boolean; // True if this is a warning threshold event
  message?: string; // Optional message for warnings
}

export interface LLMResponse {
  content: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Summary and Checkpoint types
export interface SummaryCheckpoint {
  checkpointId: string;
  messageIndex: number;
  role: Message['role'];
  reason: CheckpointReason;
  preview: string;
}

export interface SummaryApplyRequest {
  checkpointId: string;
  summary: string;
  keepRecentMessages: number;
  requestedAt: string;
}

export interface SummaryApplyAcceptedEvent {
  checkpointId: string;
  keepRecentMessages: number;
  summaryChars: number;
  availableCheckpoints: number;
}

export interface SummaryApplyAppliedEvent {
  checkpointId: string;
  keepRecentMessages: number;
  summaryChars: number;
  beforeMessages: number;
  afterMessages: number;
  compactedMessages: number;
  beforeChars: number;
  afterChars: number;
}

// Protocol Recovery types
export interface ProtocolRecoveryEvent {
  kind:
    | 'toolcall_failed_injected'
    | 'toolcall_failed_escalated'
    | 'progress_only_continuation_injected'
    | 'progress_only_stall';
  errorRaw: string;
  missingToolCallId?: string;
  matchedToolName?: string;
  consecutiveFailureCount: number;
  nextAction?: string;
}

export type FinalizedPlanStepPriority = 'low' | 'medium' | 'high';

export interface FinalizedPlanStep {
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
  steps: FinalizedPlanStep[];
  testPlan?: string[];
  assumptions?: string[];
  notes?: string;
  updatedAt?: string;
}

export interface PlanOption {
  label: string;
  description: string;
}

export interface PlanQuestion {
  header: string;
  id: string;
  question: string;
  options: PlanOption[];
}

export type PlanInputRequestSource = 'request_user_input' | 'finalize_plan_approval';

export interface PlanInputRequest {
  requestId: string;
  questions: PlanQuestion[];
  turnId?: string;
  source?: PlanInputRequestSource;
  planPreview?: FinalizedPlanView;
}

export interface MemoryTriggerEvent {
  title: string;
  content: string;
  scope: 'workspace' | 'user';
  entryId?: string;
}

export interface SkillTriggerEvent {
  name: string;
  action: 'create' | 'update';
  target: 'workspace' | 'global';
  targetPath?: string;
  version?: string;
  detail?: string;
}

export type RunningInputQueueStatus = 'queued_next' | 'insert_requested';

export interface RunningInputQueueItem {
  id: string;
  runId: string;
  context: ContextRef;
  prompt: string;
  clientRequestId?: string;
  selectedAgentName?: string;
  fileReferences?: string[];
  createdAt: string;
  updatedAt: string;
  status: RunningInputQueueStatus;
  insertRequestedAt?: string;
}

export interface RunningInputInsertion {
  itemId: string;
  prompt: string;
  selectedAgentName?: string;
  fileReferences?: string[];
}

export interface PlanInputAnswer {
  id: string;
  selectedLabel: string;
  selectedIndex: number;
  freeText?: string;
}

export interface ContextPendingPlanInput {
  runId: string;
  requestId: string;
  source?: PlanInputRequestSource;
  questions: PlanQuestion[];
  planPreview?: FinalizedPlanView;
  requestedAt: string;
  lastError?: string;
}

export interface AgentCallback {
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, toolCallId?: string) => void;
  onBeforeToolExecution?: (name: string, args: Record<string, unknown>, toolCallId?: string) => void | Promise<void>;
  onToolResult?: (name: string, result: ToolResult) => void;
  onReplayCheckpoint?: (event: ReplayCheckpointEvent) => void | Promise<void>;
  onStep?: (step: number, maxSteps: number) => void;
  onMessage?: (role: string, content: string) => void;
  onMemoryTrigger?: (event: MemoryTriggerEvent) => void;
  onSkillTrigger?: (event: SkillTriggerEvent) => void;
  onError?: (error: Error) => void;
  onProtocolRecovery?: (event: ProtocolRecoveryEvent) => void;
  onSummaryMessagesAccepted?: (event: SummaryApplyAcceptedEvent) => void;
  onSummaryMessagesApplied?: (event: SummaryApplyAppliedEvent) => void;
  onMaxTokensRecovery?: (event: MaxTokensRecoveryEvent) => void | Promise<void>;
  onContextUsageEstimate?: (event: ContextUsageEstimateEvent) => void | Promise<void>;
  onContextPrecompress?: (event: ContextPrecompressEvent) => void | Promise<void>;
  onContextOverflow?: (event: ContextOverflowEvent) => void | Promise<void>;
  onRequestUserInput?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;
  onConsumeRunningInput?: (event: {
    runId?: string;
    context?: ContextRef;
    step: number;
  }) => Promise<RunningInputInsertion | null | undefined>;
  onRunningInputInserted?: (event: {
    runId?: string;
    context?: ContextRef;
    itemId: string;
    step: number;
  }) => void | Promise<void>;
  isInAutoLoop?: () => boolean;
  requestAutoLoopExit?: (reason?: string) => { accepted: boolean; message?: string };
  onComplete?: (result: string, finishReason?: string, meta?: AgentCompletionMeta) => void;
}

export interface ContextUsageEstimateEvent {
  observedAt: string;
  stage: 'preflight' | 'provider_usage_anchor';
  source: ContextUsageEstimate['source'];
  confidence: ContextUsageEstimate['confidence'];
  usedTokens: number;
  limitTokens: number;
  usedChars: number;
  limitChars: number;
  ratio: number;
  anchorPromptTokens?: number;
  deltaEstimatedTokens?: number;
  calibrationMultiplier?: number;
}

export interface ReplayCheckpointEvent {
  observedAt: string;
  step: number;
  messages: Message[];
}

export type ContextScope = 'session' | 'workspace' | 'global';

export interface ContextRef {
  scope: ContextScope;
  namespace: string;
}

export type ContextEventType =
  | 'turn_started'
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'context_compaction'
  | 'context_patch'
  | 'turn_summary'
  | 'turn_committed'
  | 'checkpoint_created'
  | 'checkpoint_rollback'
  | 'context_rollback';

export interface ContextEvent {
  id: string;
  scope: ContextScope;
  namespace: string;
  turnId: string;
  type: ContextEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ContextTurnSummary {
  turnId: string;
  startedAt: string;
  committedAt?: string;
  prompt?: string;
  promptRef?: string;
  assistant?: string;
  finalOutput?: string;
  summary?: string;
  toolCalls: number;
}

export interface ContextProjection {
  scope: ContextScope;
  namespace: string;
  version: number;
  eventCount: number;
  keyValues: Record<string, string>;
  latestSummary?: string;
  recentTurns: ContextTurnSummary[];
}

export type ContextValueSourceStatus = 'committed' | 'pending_override' | 'pending_delete' | 'missing';

export interface ContextPendingPatchView {
  key: string;
  op: 'set' | 'delete';
  value?: string;
  source?: string;
}

export interface ContextPendingOverlay {
  turnId?: string;
  patchCount: number;
  patches: ContextPendingPatchView[];
}

export type RunTerminalCode = 'completed' | 'cancelled' | 'error';
export type ReplayCutoffKind = 'none' | 'checkpoint' | 'endturn';

export interface SideEffectLedgerEntry {
  id: string;
  observedAt: string;
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  resultSuccess?: boolean;
  resultSummary: string;
}

export interface ReplayCheckpointSnapshot {
  observedAt: string;
  step: number;
  messages: Message[];
  bufferedEventCount: number;
}

export interface DraftTurnRecord {
  draftId: string;
  context: ContextRef;
  turnId: string;
  runId: string;
  runFamilyId: string;
  workspaceDir?: string;
  createdAt: string;
  updatedAt: string;
  maxSteps: number;
  baselineEventCount: number;
  checkpoint?: ReplayCheckpointSnapshot;
}

export interface InterruptedArtifact {
  artifactId: string;
  context: ContextRef;
  draftId: string;
  turnId: string;
  runId: string;
  runFamilyId: string;
  workspaceDir?: string;
  terminalCode: Exclude<RunTerminalCode, 'completed'>;
  replayCutoffKind: 'none' | 'checkpoint';
  lastSafeStep: number;
  maxSteps: number;
  errorSummary?: string;
  createdAt: string;
  updatedAt: string;
  previewMessages: Message[];
  sideEffectLedger: SideEffectLedgerEntry[];
  checkpointTurnId?: string;
}

export interface RunTerminalState {
  runId: string;
  runFamilyId: string;
  draftId: string;
  terminalCode: RunTerminalCode;
  lastSafeStep: number;
  maxSteps: number;
  replayCutoffKind: ReplayCutoffKind;
  errorSummary?: string | null;
  createdAt: string;
  artifact?: InterruptedArtifact | null;
}

export interface ContextInspectableMeta {
  createdAt?: string;
  updatedAt?: string;
  workspaceDir?: string;
  arenaLock?: {
    arenaId: string;
    lockedAt: string;
    mode: 'answer' | 'implementation';
  };
  arenaBranch?: {
    arenaId: string;
    branchId: string;
    sourceSessionId: string;
    promoted?: boolean;
  };
  arenaJudge?: {
    arenaId: string;
    sourceSessionId: string;
  };
  forkedFrom?: {
    scope: 'session';
    namespace: string;
    sourceEventCount: number;
    forkedAt: string;
  };
  toolsetName?: string;
  origin?: ContextNamespaceMeta['origin'];
  lastRunOrigin?: ContextNamespaceMeta['lastRunOrigin'];
  lastRunAt?: ContextNamespaceMeta['lastRunAt'];
  llmSelection?: ContextNamespaceMeta['llmSelection'];
  memoryPromotionState?: MemoryPromotionState;
  compressedHistoryContext?: ContextNamespaceMeta['compressedHistoryContext'];
  autoLoopConfig?: ContextNamespaceMeta['autoLoopConfig'];
  agentInjectionState?: ContextNamespaceMeta['agentInjectionState'];
  planningState?: ContextNamespaceMeta['planningState'];
  automationRun?: ContextNamespaceMeta['automationRun'];
  completionMarkerStats?: ContextNamespaceMeta['completionMarkerStats'];
  pendingPlanInput?: ContextNamespaceMeta['pendingPlanInput'];
  runtimeErrors?: ContextNamespaceMeta['runtimeErrors'];
}

export interface ContextInspectState {
  context: ContextRef;
  projection: ContextProjection;
  effectiveKeyValues: Record<string, string>;
  summary: string;
  pendingOverlay?: ContextPendingOverlay;
  meta?: ContextInspectableMeta;
}

export interface ContextInspectKeyState {
  key: string;
  found: boolean;
  value: string | null;
  sourceStatus: ContextValueSourceStatus;
  committedValue?: string | null;
}

export interface MemoryPromotionState {
  lastProcessedContextVersion: number;
  lastQueuedContextVersion: number;
  pendingTurnCount: number;
  lastActivityAt: string;
  lastProcessedAt?: string;
  status?: 'idle' | 'queued' | 'processing' | 'failed';
  lastError?: string;
}

export type AutomationFrequency = 'once' | 'interval' | 'hourly' | 'daily' | 'weekly';

export interface AutomationSchedule {
  frequency: AutomationFrequency;
  minute?: number;
  hour?: number;
  weekday?: number;
  intervalSeconds?: number;
}

export type AutomationRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';
export type AutomationTriggerSource = 'schedule' | 'manual';
export type AutomationJobSource = 'user' | 'system';
export type AutomationSystemTask = 'auto_generated_skill_governance';

export interface AutomationRunMeta {
  jobId: string;
  triggerAt: string;
  status: AutomationRunStatus;
  runId?: string;
  scheduledBy?: 'automation';
  triggerSource?: AutomationTriggerSource;
  agentName?: string;
  effectiveAgentName?: string;
  agentFallbackReason?: string;
  completedAt?: string;
}

export interface AutomationJob {
  id: string;
  name: string;
  prompt: string;
  workspaceDir: string;
  skills: string[];
  agentName?: string;
  llmSelection?: SessionLlmSelection;
  schedule: AutomationSchedule;
  timezone: string;
  enabled: boolean;
  jobSource?: AutomationJobSource;
  systemTask?: AutomationSystemTask;
  readOnly?: boolean;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface AutomationRunRecord {
  id: string;
  jobId: string;
  sessionId: string;
  status: AutomationRunStatus;
  triggerAt: string;
  triggerSource?: AutomationTriggerSource;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  error?: string;
  skippedReason?: string;
  agentName?: string;
  effectiveAgentName?: string;
  agentFallbackReason?: string;
  memorySyncStatus?: 'succeeded' | 'failed';
  memorySyncError?: string;
  reportPath?: string;
}

export interface AutomationMemoryTemplate {
  jobId: string;
  template: string;
  version: number;
  updatedAt: string;
  sourceSessionId?: string;
}

export type SkillGovernanceDetection =
  | 'exact_duplicate'
  | 'candidate_duplicate'
  | 'name_conflict'
  | 'boundary_fix_only'
  | 'keep';

export type SkillGovernanceVerdict =
  | 'keep'
  | 'duplicate_of'
  | 'keep_separate_conflict'
  | 'needs_manual_review'
  | 'boundary_fix_only'
  | 'fallback_candidate';

export type SkillGovernanceAction = 'none' | 'soft_archive' | 'boundary_backfill';

export interface SkillGovernanceReportItem {
  id: string;
  name: string;
  targetPath: string;
  workspaceDir?: string;
  detection: SkillGovernanceDetection;
  verdict: SkillGovernanceVerdict;
  action: SkillGovernanceAction;
  canonicalId?: string;
  canonicalTargetPath?: string;
  note?: string;
}

export interface AutomationRunReportSummary {
  scannedSkills: number;
  exactDuplicates: number;
  candidateDuplicates: number;
  autoArchived: number;
  reportOnly: number;
  boundaryFixed: number;
  conflicts: number;
}

export interface AutomationRunReport {
  kind: 'auto_generated_skill_governance';
  jobId: string;
  runId: string;
  generatedAt: string;
  fallback: boolean;
  fallbackReason?: string;
  summary: AutomationRunReportSummary;
  items: SkillGovernanceReportItem[];
}

export interface WorkspaceSkillGovernanceReport {
  kind: 'workspace_skill_governance';
  runId: string;
  workspaceDir: string;
  generatedAt: string;
  fallback: boolean;
  fallbackReason?: string;
  summary: AutomationRunReportSummary;
  items: SkillGovernanceReportItem[];
}

export interface CompletionMarkerStats {
  repairCount: number;
  lastTriggeredAt?: string;
  lastResolvedAt?: string;
  lastIssue?: 'missing_tail_marker' | 'duplicate_tail_marker';
}

export type SessionPlanningState = 'normal' | 'plan_drafting' | 'plan_executing';

export interface SessionPlanningMeta {
  state: SessionPlanningState;
  pendingPlanId?: string;
  activeExecutionPlanId?: string;
  updatedAt: string;
}

export interface ContextRuntimeErrorMessage {
  id: string;
  runId: string;
  message: string;
  createdAt: string;
  terminalCode?: Exclude<RunTerminalCode, 'completed'>;
  replayCutoffKind?: ReplayCutoffKind;
  lastSafeStep?: number;
  maxSteps?: number;
}

export interface ContextNamespaceMeta {
  scope: ContextScope;
  namespace: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir?: string;
  arenaLock?: {
    arenaId: string;
    lockedAt: string;
    mode: 'answer' | 'implementation';
  };
  arenaBranch?: {
    arenaId: string;
    branchId: string;
    sourceSessionId: string;
    promoted?: boolean;
  };
  arenaJudge?: {
    arenaId: string;
    sourceSessionId: string;
  };
  forkedFrom?: {
    scope: 'session';
    namespace: string;
    sourceEventCount: number;
    forkedAt: string;
  };
  toolsetName?: string;
  origin?: SessionOrigin;
  lastRunOrigin?: SessionOrigin;
  lastRunAt?: string;
  runtimeAttachment?: {
    externalMcpServers?: MCPServerConfig[];
    externalMcpServerNames?: string[];
    externalMcpFingerprint?: string;
    updatedAt: string;
  };
  llmSelection?: SessionLlmSelection;
  sessionShare?: {
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    revokedAt?: string;
    version: number;
  };
  memoryPromotionState?: MemoryPromotionState;
  compressedHistoryContext?: {
    sealedRoundCount: number;
    sealedPrefixHash: string;
    summary: string;
    updatedAt: string;
    formatVersion: number;
    configFingerprint: string;
  };
  autoLoopConfig?: {
    enabled: boolean;
    mode?: 'ralph' | 'todo';
    ralphEnabled?: boolean;
    pendingPlanConfirmation?: boolean;
    prompt: string;
    maxRounds: number;
    maxDurationMinutes: number;
    similarityThreshold: number;
    compareRounds: number;
    pausedByUser?: boolean;
  };
  agentInjectionState?: {
    lastProfilePath?: string;
    lastProfileName?: string;
    lastProfileSource?: 'workspace' | 'global' | 'bundled';
    lastExplicitAgentName?: string;
    updatedAt: string;
  };
  planningState?: SessionPlanningMeta;
  lastPlanExecutionExit?: {
    mode: 'normal' | 'force';
    reason?: string;
    planId?: string;
    unfinishedTodoCount: number;
    exitedAt: string;
  };
  automationRun?: AutomationRunMeta;
  completionMarkerStats?: CompletionMarkerStats;
  pendingPlanInput?: ContextPendingPlanInput;
  runtimeErrors?: ContextRuntimeErrorMessage[];
  latestContextUtilization?: {
    observedAt: string;
    ratio: number;
    usedChars: number;
    limitChars: number;
    usedTokens?: number;
    limitTokens?: number;
    source?: ContextUsageEstimate['source'];
    anchorPromptTokens?: number;
    deltaEstimatedTokens?: number;
    isWarning: boolean;
  };
}

export interface ContextNamespaceInfo extends ContextNamespaceMeta {
  projection: ContextProjection;
}

export type SubAgentLifecycleStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timeout';

export type SubAgentProviderType = 'local' | 'external';

export interface SubAgentProviderConfig {
  id: string;
  type: SubAgentProviderType;
  enabled?: boolean;
  endpoint?: string;
  auth?: {
    type: 'bearer' | 'none';
    tokenEnv?: string;
  };
  timeoutMs?: number;
}

export interface SubAgentArtifact {
  files: string[];
  commands: string[];
  notes: string[];
}

export interface SubAgentAssignedAgent {
  name: string;
  source: 'bundled' | 'global' | 'workspace';
  description: string;
  path: string;
  mtime: string;
  config?: AgentProfileConfigView;
}

export interface SubAgentAssignedAgentProfile extends SubAgentAssignedAgent {
  content: string;
}

export interface SubAgentCreateParams {
  parentContext: ContextRef;
  parentTurnId?: string;
  prompt: string;
  agentName?: string;
  providerId?: string;
  allowedTools?: string[];
  timeoutMs?: number;
  workspaceDir?: string;
}

export interface SubAgentResult {
  subagentId: string;
  runSeq: number;
  status: SubAgentLifecycleStatus;
  summary: string;
  artifacts: SubAgentArtifact;
  agent?: SubAgentAssignedAgent;
  finishReason?: string;
  usage?: TokenUsage;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SubAgentStatus {
  subagentId: string;
  parentContext: ContextRef;
  context: ContextRef;
  status: SubAgentLifecycleStatus;
  runSeq: number;
  agent?: SubAgentAssignedAgent;
  queuePosition?: number;
  queuedCount: number;
  running: boolean;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  latestResult?: SubAgentResult;
  lastError?: string;
  lifecycleDiagnostic?: string;
  prompt?: string;
  providerId?: string;
  agentConfig?: AgentProfileConfig;
  allowedTools?: string[];
  effectiveAllowedTools?: string[];
  workspaceDir?: string;
}

export interface DPAgentRunOptions {
  prompt: string;
  context: ContextRef;
  runId?: string;
  runFamilyId?: string;
  rawUserPrompt?: string;
  historyUserPrompt?: string;
  effectivePrompt?: string;
  promptReference?: string;
  hasSystemPromptInjection?: boolean;
  content?: string | ContentBlock[];
  assert?: (result: string) => boolean | Promise<boolean>;
  callback?: AgentCallback;
  planningState?: SessionPlanningState;
  additionalSystemPrompt?: string;
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  workspaceDir?: string;
  additionalDirs?: string[];
}

export interface DPAgentRunResult {
  content: string;
  context: ContextRef;
  turnId: string;
  contextVersion: number;
  runId?: string;
  runFamilyId?: string;
  finishReason?: string;
  step?: number;
  usage?: TokenUsage;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
  maxTokensSnapshotPath?: string;
  maxTokensSnapshotPaths?: string[];
  contextOverflowSnapshotPath?: string;
  contextOverflowSnapshotPaths?: string[];
  tokenLimit?: number;
  maxOutputTokens?: number;
  terminalState?: RunTerminalState | null;
}

export interface Session {
  id: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  workspaceDir: string;
  additionalDirs: string[];
  systemPrompt?: string;
}

export interface MCPServerConfig {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connectTimeout?: number;
  executeTimeout?: number;
}

export type MCPServerRuntimeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disabled';

export type MCPSummaryState = 'connected' | 'degraded' | 'idle' | 'disabled';

export interface MCPServerStatus {
  name: string;
  status: MCPServerRuntimeStatus;
  toolCount: number;
  retryCount: number;
  lastError?: string;
  updatedAt: string;
  disabled: boolean;
}

export interface MCPStatusSummary {
  state: MCPSummaryState;
  connectedCount: number;
  totalEnabled: number;
}

export interface MCPStatusResponse {
  enabled: boolean;
  summary: MCPStatusSummary;
  servers: MCPServerStatus[];
}

export interface SkillConfig {
  name: string;
  description: string;
  path: string;
  enabled?: boolean;
}

export interface AsrConfig {
  enabled: boolean;
  provider: 'local-process';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  modelId: string;
  timeoutMs: number;
  maxConcurrent: number;
  maxQueueSize: number;
  maxAudioBytes: number;
  maxOutputBytes: number;
  resultFormat: 'json' | 'text';
  startupTimeoutMs: number;
  restartBackoffMs: number;
}

export interface AgentConfig {
  api: {
    apiKey: string;
    apiBase: string;
    model: string;
    provider: 'anthropic' | 'openai';
    maxOutputTokens: number;
  };
  llmProfiles: LlmProfilesConfig;
  agent: {
    maxSteps: number;
    tokenLimit: number;
    workspaceDir: string;
    completionMarkerEnforcementEnabled?: boolean;
    defaultToolset?: string;
    subAgentMaxParallelPerParent: number;
    subAgentGlobalMaxParallel: number;
    contextReplayMinRounds?: number;
    contextReplayMaxRounds?: number;
    contextReplayBudgetRatio?: number;
    contextOverflowMaxErrorsBeforeTrim?: number;
    contextDir?: string;
    runtimeDataDir?: string;
    systemPromptPath?: string;
    skillsDir?: string;  // Global skills directory path.
    globalAgentsDir?: string;
  };
  tools: {
    enableFileTools: boolean;
    enableWeb: boolean;
    enableShell: boolean;
    shellType: ShellType;
    shellTimeout: number;
    shellOutputIdleTimeout?: number;
    shellMaxRunTime?: number;
    shellMaxOutputSize?: number;
  };
  mcp: {
    enabled: boolean;
    servers: MCPServerConfig[];
    connectTimeout: number;
    executeTimeout: number;
  };
  toolsets?: {
    custom?: Array<{
      name: string;
      description: string;
      capabilities: string[];
      allowUnknownTools?: boolean;
    }>;
  };
  retry: {
    enabled: boolean;
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
    exponentialBase: number;
  };
  web?: {
    publicBaseUrl?: string;
    downloadLinkTtlMs?: number;
    sessionShareTtlHours?: number;
  };
  contextBudget?: ContextBudgetConfig;
  remoteAccessAuth?: RemoteAccessAuthConfig;
  agentProviders?: SubAgentProviderConfig[];
  asr?: AsrConfig;
}

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'sh';

export interface ShellExecuteOptions {
  command: string;
  shell?: ShellType;
  timeout?: number;
  cwd?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DirectoryPermissions {
  workspaceDir: string;
  additionalWritableDirs: string[];
}

export interface PersistedMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  metadata?: MessageMetadata;
}

// LLM Client related types
export interface ToolProtocolSanitizeResult {
  messages: Message[];
  correctedCount: number;
  orphanToolCallFixed: number;
  orphanToolResultFixed: number;
}

export type ToolProtocolFrame =
  | {
      kind: 'message';
      message: Message;
    }
  | {
      kind: 'assistant_tool_bundle';
      assistant: Message;
      toolResults: Message[];
    };

export interface ToolProtocolMetrics {
  // Metrics are computed from post-sanitize messages only.
  assistantToolBundleCount: number;
  toolResultMessageCount: number;
  maxToolResultsPerBundle: number;
}

export interface ToolProtocolBuildResult extends ToolProtocolMetrics {
  frames: ToolProtocolFrame[];
}

export interface ContextWindowTrimOptions {
  maxTotalChars?: number;
  keepLatestCount?: number;
  maxToolChars?: number;
  maxNonToolChars?: number;
}

export interface ContextWindowTrimResult {
  messages: Message[];
  originalChars: number;
  trimmedChars: number;
  removedCount: number;
  truncatedCount: number;
}

export interface PreparedMessagesSnapshot {
  stage:
    | 'initial'
    | 'retry_context_window'
    | 'overflow_retry_after_compress'
    | 'overflow_retry_after_forced_trim';
  capturedAt: string;
  preTrimSanitized: {
    correctedCount: number;
    orphanToolCallFixed: number;
    orphanToolResultFixed: number;
  };
  postTrimSanitized: {
    correctedCount: number;
    orphanToolCallFixed: number;
    orphanToolResultFixed: number;
  };
  trim: {
    originalChars: number;
    trimmedChars: number;
    removedCount: number;
    truncatedCount: number;
  };
  precompress?: {
    observedAt: string;
    triggered: boolean;
    applied: boolean;
    totalCharsBefore: number;
    totalCharsAfter: number;
    willRetriggerNextTurn?: boolean;
    postCompressRatio?: number;
    chunkCount: number;
    retryCount: number;
    profileNormalizedCount: number;
    failureReason?: string;
  };
  toolProtocol?: ToolProtocolMetrics;
  messages: Message[];
}

export interface PreparedMessagesResult {
  preTrimSanitized: ToolProtocolSanitizeResult;
  trim: ContextWindowTrimResult;
  postTrimSanitized: ToolProtocolSanitizeResult;
  toolProtocol?: ToolProtocolMetrics;
}
