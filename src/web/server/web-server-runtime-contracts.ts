import { WebSocket } from 'ws';
import type { DPAgent } from '../../dpagent-runtime.js';
import type { AutoLoopController } from '../../auto-loop/index.js';
import type {
  AgentCallback,
  AgentRuntimeOverrides,
  ContextNamespaceMeta,
  ContextRef,
  MCPServerConfig,
  PlanInputAnswer,
  PlanInputRequest,
  ResolvedLlmRuntimeConfig,
  RunOwner,
  RunningInputQueueItem,
  SessionInteractionState,
  SessionLlmSelection,
  SessionOrigin,
  SessionPlanningState,
} from '../../types.js';
import type { ChatRequest } from './web-server-shared.js';
import type { createCallbackEventDispatcher } from './callback-event-dispatcher.js';

export interface WebServerConfig {
  port: number;
  configPath: string;
  allowMissingApiKeyAtBoot?: boolean;
}

export const PENDING_PLAN_INPUT_RECONNECT_GRACE_MS = 5 * 60 * 1000;

export interface PendingPlanInput {
  runId: string;
  context: ContextRef;
  ws: WebSocket;
  request: PlanInputRequest;
  resolve: (answers: PlanInputAnswer[]) => void;
  reject: (error: Error) => void;
  detachedAt?: number;
  detachTimer?: ReturnType<typeof setTimeout>;
}

export interface ResolvedPlanInputResponseTarget {
  runId: string;
  requestId: string;
  pending: PendingPlanInput;
}

export type CallbackEventDispatcher = ReturnType<typeof createCallbackEventDispatcher>;
export type CallbackObservationHandlers = Pick<
  AgentCallback,
  | 'onThinking'
  | 'onToolCall'
  | 'onToolResult'
  | 'onStep'
  | 'onMessage'
  | 'onMemoryTrigger'
  | 'onSkillTrigger'
  | 'onContextUsageEstimate'
  | 'onContextPrecompress'
  | 'onContextOverflow'
>;
export type CallbackControlHandlers = Pick<
  AgentCallback,
  | 'onError'
  | 'onRequestUserInput'
  | 'onConsumeRunningInput'
  | 'onRunningInputInserted'
  | 'onComplete'
  | 'isInAutoLoop'
  | 'requestAutoLoopExit'
>;

export type ResolvedUserPromptResult = {
  ok: true;
  effectivePrompt: string;
  historyUserPrompt?: string;
  displayPrompt: string;
  profileInjectionMode?: 'initial' | 'switch' | 'none';
  agentInjectionStateUpdate?: Partial<NonNullable<ContextNamespaceMeta['agentInjectionState']>>;
  planningState?: SessionPlanningState;
  promptRef?: string;
  hasSystemPromptInjection: boolean;
  activeAgent?: {
    source: 'workspace' | 'global' | 'bundled';
    name: string;
    path: string;
  };
  agentRuntimeOverrides?: AgentRuntimeOverrides;
} | {
  ok: false;
  error: string;
};

export interface PreparedChatExecution {
  request: ChatRequest;
  ownerWs: WebSocket;
  context: ContextRef;
  runId: string;
  workspaceDir: string;
  llmSelection?: SessionLlmSelection;
  llmRuntime: ResolvedLlmRuntimeConfig;
  externalMcpServers?: MCPServerConfig[];
  effectivePrompt: string;
  historyUserPrompt?: string;
  agentInjectionStateUpdate?: Partial<NonNullable<ContextNamespaceMeta['agentInjectionState']>>;
  displayPrompt?: string;
  promptRef?: string;
  hasSystemPromptInjection?: boolean;
  callback: AgentCallback;
  planningState?: SessionPlanningState;
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  runOrigin: SessionOrigin;
  dispatcher: CallbackEventDispatcher;
  autoLoopController?: AutoLoopController;
}

export interface SessionRuntime {
  agent: DPAgent;
  workspaceDir: string;
  runtimeKey: string;
  llmRuntime: ResolvedLlmRuntimeConfig;
  externalMcpServers?: MCPServerConfig[];
  lastUsedAt: string;
  configDirty?: boolean;
  cleanupPromise?: Promise<void>;
}

export interface ActiveRunState {
  runId: string;
  runFamilyId?: string;
  draftId?: string;
  context: ContextRef;
  startedAt: string;
  lastActivityAt: string;
  currentStep: number;
  maxSteps?: number;
  owner: RunOwner;
  origin: SessionOrigin;
  interactionState: SessionInteractionState;
  llmRuntime?: Pick<ResolvedLlmRuntimeConfig, 'profileId' | 'provider' | 'model' | 'reasoningPreset'>;
  runningInputQueue?: RunningInputQueueItem[];
}

export interface TrackedRunInput {
  prompt: string;
  rawUserPrompt?: string;
  historyUserPrompt?: string;
  effectivePrompt?: string;
  agentInjectionStateUpdate?: Partial<NonNullable<ContextNamespaceMeta['agentInjectionState']>>;
  llmSelectionUpdate?: SessionLlmSelection;
  planningState?: SessionPlanningState;
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  promptReference?: string;
  hasSystemPromptInjection?: boolean;
  runFamilyId?: string;
  callback: AgentCallback;
  workspaceDir?: string;
  includeWorkspaceDir?: boolean;
  runOrigin?: SessionOrigin;
}

export interface TrackedRunExecution {
  runId: string;
  ownerWs?: WebSocket;
  context: ContextRef;
  dispatcher: CallbackEventDispatcher;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  runOrigin?: SessionOrigin;
  refreshCatalogOnFinish?: boolean;
  stopControllerOnError?: AutoLoopController;
  resolveRunInput: () => TrackedRunInput | null;
}

export interface ScheduledCallbackContinuationScaffold {
  runId: string;
  ownerWs: WebSocket;
  dispatcher: CallbackEventDispatcher;
}

export interface TrackedRunInputBuilderInput {
  effectivePrompt: string;
  historyUserPrompt?: string;
  agentInjectionStateUpdate?: Partial<NonNullable<ContextNamespaceMeta['agentInjectionState']>>;
  llmSelectionUpdate?: SessionLlmSelection;
  planningState?: SessionPlanningState;
  agentRuntimeOverrides?: AgentRuntimeOverrides;
  callback: AgentCallback;
  displayPrompt?: string;
  promptRef?: string;
  hasSystemPromptInjection?: boolean;
  workspaceDir?: string;
  includeWorkspaceDir?: boolean;
  runOrigin?: SessionOrigin;
}

export type ScheduledCallbackContinuationInputResolution =
  | {
      ok: true;
      runInput: TrackedRunInput;
    }
  | {
      ok: false;
      error: string;
    };
