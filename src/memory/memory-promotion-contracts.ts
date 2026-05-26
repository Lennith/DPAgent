import type { LLMRuntime } from '../llm/index.js';
import type { GovernanceAuditStore } from '../governance/AuditStore.js';
import type { ContextManager } from '../context/index.js';
import type { MemoryEntry, MemoryScope } from './memory-store-contracts.js';
import type { MemoryStore } from './MemoryStore.js';

export const DEFAULT_BATCH_TURNS = 3;
export const DEFAULT_IDLE_FLUSH_MS = 120_000;
export const MEMORY_CLASSIFIER_MAX_TURNS = 8;
export const MEMORY_CLASSIFIER_MAX_CONTENT_CHARS = 360;

export type MemoryMutationAction = 'add' | 'replace' | 'remove';
export type MemoryOrganizeReason = 'batch_threshold' | 'idle_flush' | 'manual';

export interface MemoryMutationInput {
  action: MemoryMutationAction;
  id?: string;
  scope?: MemoryScope;
  title?: string;
  content?: string;
  workspaceDir?: string;
  sessionId?: string;
  reason?: string;
  expiresAt?: string;
}

export interface MemoryMutationResult {
  action: MemoryMutationAction;
  entry?: MemoryEntry | null;
  removed?: boolean;
}

export interface MemoryOrganizeResult {
  sessionId: string;
  workspaceDir?: string;
  processedTurns: number;
  appliedCount: number;
  skippedCount: number;
  pendingTurnCount: number;
  processedContextVersion: number;
  reason: MemoryOrganizeReason;
  status: 'ok' | 'noop';
}

export interface MemoryPromotionCoordinatorOptions {
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  governanceAuditStore: GovernanceAuditStore;
  getLlmClient: () => LLMRuntime | null;
  batchTurns?: number;
  idleFlushMs?: number;
}

export interface SessionTurnRecord {
  turnId: string;
  ordinal: number;
  prompt: string;
  finalOutput: string;
  committedAt: string;
  workspaceDir?: string;
}

export interface SessionTurnAccumulator {
  prompt?: string;
  finalOutput?: string;
  workspaceDir?: string;
}

export interface MemoryCandidate {
  turnId: string;
  decision: 'discard' | 'session_only' | 'memory_candidate';
  scope?: MemoryScope;
  title?: string;
  content?: string;
  reason?: string;
  stability?: 'stable' | 'tentative' | 'temporary';
  conflictHints?: string[];
}
