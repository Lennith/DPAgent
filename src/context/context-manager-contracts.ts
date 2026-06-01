import type {
  ContextEvent,
  ContextNamespaceMeta,
  ContextProjection,
  ContextRef,
  Message,
  RunTerminalCode,
  SideEffectLedgerEntry,
  ToolResultArtifactRef,
  TokenUsage,
} from '../types.js';

export interface PendingTurn {
  turnId: string;
  ref: ContextRef;
  startedAt: string;
  prompt: string;
  rawUserPrompt: string;
  historyUserPrompt: string;
  effectivePrompt: string;
  promptRef?: string;
  promptInjected: boolean;
  workspaceDir?: string;
  bufferedEvents: ContextEvent[];
  eventSequenceBase: number;
  draftId?: string;
  runId?: string;
  runFamilyId?: string;
  maxSteps?: number;
}

export interface ContextCheckpoint {
  checkpointId: string;
  turnId: string;
  ref: ContextRef;
  createdAt: string;
  hash: string;
  eventCount: number;
  semanticEventCount: number;
  messageCount: number;
}

export interface ContextCheckpointResult {
  checkpoint: ContextCheckpoint;
  projection: ContextProjection;
}

export interface ContextValidationResult {
  valid: boolean;
  checkpointId: string;
  expectedHash: string;
  actualHash: string;
  eventCountMatch: boolean;
  rollbackPerformed: boolean;
}

export interface LoadForTurnResult {
  context: ContextRef;
  projection: ContextProjection;
  systemSegment: string;
  meta?: ContextNamespaceMeta;
}

export interface BeginTurnResult {
  turnId: string;
  context: ContextRef;
  startedAt: string;
}

export interface BeginTurnInput {
  rawUserPrompt?: string;
  historyUserPrompt?: string;
  effectivePrompt?: string;
  promptRef?: string;
  promptInjected?: boolean;
  draftId?: string;
  runId?: string;
  runFamilyId?: string;
  maxSteps?: number;
}

export interface CommitTurnInput {
  messages: Message[];
  rawUserPrompt?: string;
  historyUserPrompt?: string;
  effectivePrompt?: string;
  promptRef?: string;
  promptInjected?: boolean;
  finalOutputText?: string;
  finishReason?: string;
  usage?: TokenUsage;
  workspaceTimeline?: {
    deltaId: string;
    revisionId: string;
    trustLevel: 'trusted' | 'git_observed' | 'observed_partial' | 'untrusted';
    changedFiles: string[];
    captureWarnings: string[];
    auditOnly: boolean;
  };
}

export interface TurnPromptState {
  rawUserPrompt: string;
  historyUserPrompt: string;
  effectivePrompt: string;
  promptRef?: string;
  promptInjected: boolean;
}

export interface CommitTurnResult {
  turnId: string;
  context: ContextRef;
  contextVersion: number;
  summary: string;
}

export interface ToolResultArtifactMaterialization {
  content: string;
  artifact?: ToolResultArtifactRef;
}

export interface FinalizeInterruptedTurnInput {
  terminalCode: Exclude<RunTerminalCode, 'completed'>;
  maxSteps: number;
  lastSafeStep: number;
  errorSummary?: string;
  previewMessages: Message[];
  sideEffectLedger: SideEffectLedgerEntry[];
}

export interface ContextVersionChain {
  contextRef: ContextRef;
  previousVersion: number;
  currentVersion: number;
  gapSize: number;
  turnId: string;
  isValid: boolean;
  jumpDetected: boolean;
  jumpSize: number;
}

export interface ContextTransaction {
  transactionId: string;
  ref: ContextRef;
  versionStamp: number;
  events: ContextEvent[];
  committed: boolean;
  createdAt: string;
}
