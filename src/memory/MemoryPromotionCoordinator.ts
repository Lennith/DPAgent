import * as path from 'node:path';
import type { LLMRuntime } from '../llm/index.js';
import type { GovernanceAuditStore } from '../governance/index.js';
import type { ContextEvent, ContextRef, MemoryPromotionState } from '../types.js';
import type { ContextManager } from '../context/index.js';
import {
  containsAnyPhrase,
  extractChecklistItems,
  extractCommandCandidates,
  looksLikeFailure,
  normalizeWorkflowText,
  tokenizeWorkflowText,
} from '../utils/workflow-signal.js';
import type { MemoryEntry, MemoryScope } from './MemoryStore.js';
import { MemoryStore } from './MemoryStore.js';

const DEFAULT_BATCH_TURNS = 3;
const DEFAULT_IDLE_FLUSH_MS = 120_000;
const MEMORY_CLASSIFIER_MAX_TURNS = 8;
const MEMORY_CLASSIFIER_MAX_CONTENT_CHARS = 360;

type MemoryMutationAction = 'add' | 'replace' | 'remove';
type MemoryOrganizeReason = 'batch_threshold' | 'idle_flush' | 'manual';

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

interface MemoryPromotionCoordinatorOptions {
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  governanceAuditStore: GovernanceAuditStore;
  getLlmClient: () => LLMRuntime | null;
  batchTurns?: number;
  idleFlushMs?: number;
}

interface SessionTurnRecord {
  turnId: string;
  ordinal: number;
  prompt: string;
  finalOutput: string;
  committedAt: string;
  workspaceDir?: string;
}

interface SessionTurnAccumulator {
  prompt?: string;
  finalOutput?: string;
  workspaceDir?: string;
}

interface MemoryCandidate {
  turnId: string;
  decision: 'discard' | 'session_only' | 'memory_candidate';
  scope?: MemoryScope;
  title?: string;
  content?: string;
  reason?: string;
  stability?: 'stable' | 'tentative' | 'temporary';
  conflictHints?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

function normalizeState(state: MemoryPromotionState | undefined): MemoryPromotionState {
  return {
    lastProcessedContextVersion: Math.max(0, Math.floor(state?.lastProcessedContextVersion ?? 0)),
    lastQueuedContextVersion: Math.max(0, Math.floor(state?.lastQueuedContextVersion ?? 0)),
    pendingTurnCount: Math.max(0, Math.floor(state?.pendingTurnCount ?? 0)),
    lastActivityAt: state?.lastActivityAt ?? nowIso(),
    lastProcessedAt: state?.lastProcessedAt,
    status: state?.status ?? 'idle',
    lastError: state?.lastError,
  };
}

function normalizeWorkspacePathKey(workspaceDir: string | undefined): string {
  if (!workspaceDir) {
    return '';
  }
  const resolved = path.resolve(workspaceDir).replace(/\//g, path.sep);
  if (process.platform !== 'win32') {
    return resolved;
  }
  return resolved.toLowerCase();
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end < start) {
    return null;
  }
  return withoutFence.slice(start, end + 1);
}

function normalizeConflictHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length > 0)
        .slice(0, 6)
    )
  );
}

export class MemoryPromotionCoordinator {
  private readonly contextManager: ContextManager;
  private readonly memoryStore: MemoryStore;
  private readonly governanceAuditStore: GovernanceAuditStore;
  private readonly getLlmClient: () => LLMRuntime | null;
  private readonly batchTurns: number;
  private readonly idleFlushMs: number;
  private readonly storageQueues = new Map<string, Promise<void>>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: MemoryPromotionCoordinatorOptions) {
    this.contextManager = options.contextManager;
    this.memoryStore = options.memoryStore;
    this.governanceAuditStore = options.governanceAuditStore;
    this.getLlmClient = options.getLlmClient;
    this.batchTurns = Math.max(1, Math.floor(options.batchTurns ?? DEFAULT_BATCH_TURNS));
    this.idleFlushMs = Math.max(1_000, Math.floor(options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS));
  }

  async cleanup(): Promise<void> {
    for (const sessionId of Array.from(this.idleTimers.keys())) {
      this.clearIdleTimer(sessionId);
    }
    await this.waitForQueuesToDrain(30_000);
  }

  getSessionState(sessionId: string): MemoryPromotionState | null {
    const meta = this.contextManager.getEventStore().loadMeta('session', sessionId);
    return meta?.memoryPromotionState ? normalizeState(meta.memoryPromotionState) : null;
  }

  async noteCommittedTurn(input: {
    sessionId: string;
    workspaceDir?: string;
    contextVersion: number;
  }): Promise<void> {
    await this.enqueueSessionTask(input.sessionId, async () => {
      const ref: ContextRef = { scope: 'session', namespace: input.sessionId };
      const meta = this.contextManager.getEventStore().loadMeta(ref.scope, ref.namespace);
      const state = normalizeState(meta?.memoryPromotionState);
      const pendingTurnCount = Math.max(0, input.contextVersion - state.lastProcessedContextVersion);
      const shouldQueue = pendingTurnCount >= this.batchTurns && input.contextVersion > state.lastQueuedContextVersion;

      this.contextManager.updateNamespaceMeta(ref, {
        memoryPromotionState: {
          ...state,
          lastActivityAt: nowIso(),
          pendingTurnCount,
          lastQueuedContextVersion: shouldQueue ? input.contextVersion : state.lastQueuedContextVersion,
          status: shouldQueue ? 'queued' : state.status === 'failed' ? 'failed' : 'idle',
        },
      });

      if (shouldQueue) {
        this.clearIdleTimer(input.sessionId);
        this.governanceAuditStore.append({
          kind: 'memory_organize_queued',
          title: `Memory organize queued for ${input.sessionId}`,
          sessionId: input.sessionId,
          workspaceDir: input.workspaceDir,
          entityType: 'memory',
          status: 'info',
          metadata: {
            trigger: 'batch_threshold',
            pendingTurnCount,
            contextVersion: input.contextVersion,
          },
        });
        void this.organizeSession({
          sessionId: input.sessionId,
          workspaceDir: input.workspaceDir,
          reason: 'batch_threshold',
        }).catch(() => undefined);
        return;
      }

      if (pendingTurnCount > 0) {
        this.scheduleIdleFlush(input.sessionId, input.workspaceDir);
      } else {
        this.clearIdleTimer(input.sessionId);
      }
    });
  }

  async organizeSession(input: {
    sessionId: string;
    workspaceDir?: string;
    reason: MemoryOrganizeReason;
  }): Promise<MemoryOrganizeResult> {
    return this.enqueueSessionTask(input.sessionId, async () => this.runOrganizeSession(input));
  }

  async mutate(input: MemoryMutationInput): Promise<MemoryMutationResult> {
    const storageKey = this.resolveStorageQueueKeyForMutation(input);
    return this.enqueueStorageTask(storageKey, async () => {
      switch (input.action) {
        case 'add': {
          const scope = input.scope ?? (input.workspaceDir ? 'workspace' : 'user');
          const title = String(input.title ?? '').trim();
          const content = String(input.content ?? '').trim();
          if (!title || !content) {
            throw new Error('title and content are required for add');
          }
          const entry = this.memoryStore.writeMemory({
            scope,
            title,
            content,
            workspaceDir: input.workspaceDir,
            sourceSessionId: input.sessionId,
            reason: input.reason,
            expiresAt: input.expiresAt,
          });
          this.governanceAuditStore.append({
            kind: 'memory_written',
            title: `Memory written: ${entry.title}`,
            detail: entry.content,
            sessionId: input.sessionId,
            workspaceDir: entry.workspaceDir ?? input.workspaceDir,
            entityType: 'memory',
            entityId: entry.id,
            status: 'success',
            metadata: {
              action: 'add',
              scope: entry.scope,
              version: entry.version,
            },
          });
          return { action: 'add', entry };
        }
        case 'replace': {
          const id = String(input.id ?? '').trim();
          const content = String(input.content ?? '').trim();
          if (!id || !content) {
            throw new Error('id and content are required for replace');
          }
          const entry = this.memoryStore.replaceEntry(id, {
            title: String(input.title ?? '').trim() || undefined,
            content,
            workspaceDir: input.workspaceDir,
            sourceSessionId: input.sessionId,
            reason: input.reason,
            expiresAt: input.expiresAt,
          });
          if (!entry) {
            throw new Error(`memory not found: ${id}`);
          }
          this.governanceAuditStore.append({
            kind: 'memory_replaced',
            title: `Memory replaced: ${entry.title}`,
            detail: entry.content,
            sessionId: input.sessionId,
            workspaceDir: entry.workspaceDir ?? input.workspaceDir,
            entityType: 'memory',
            entityId: entry.id,
            status: 'success',
            metadata: {
              action: 'replace',
              scope: entry.scope,
              version: entry.version,
            },
          });
          return { action: 'replace', entry };
        }
        case 'remove': {
          const id = String(input.id ?? '').trim();
          if (!id) {
            throw new Error('id is required for remove');
          }
          const removed = this.memoryStore.deleteEntry(id, {
            workspaceDir: input.workspaceDir,
            includeUser: true,
          });
          this.governanceAuditStore.append({
            kind: 'memory_removed',
            title: removed ? `Memory removed: ${id}` : `Memory remove missed: ${id}`,
            sessionId: input.sessionId,
            workspaceDir: input.workspaceDir,
            entityType: 'memory',
            entityId: id,
            status: removed ? 'success' : 'warning',
            metadata: {
              action: 'remove',
            },
          });
          return { action: 'remove', removed };
        }
      }
    });
  }

  private async runOrganizeSession(input: {
    sessionId: string;
    workspaceDir?: string;
    reason: MemoryOrganizeReason;
  }): Promise<MemoryOrganizeResult> {
    this.clearIdleTimer(input.sessionId);
    const ref: ContextRef = { scope: 'session', namespace: input.sessionId };
    const meta = this.contextManager.getEventStore().loadMeta(ref.scope, ref.namespace);
    if (!meta) {
      return {
        sessionId: input.sessionId,
        workspaceDir: input.workspaceDir,
        processedTurns: 0,
        appliedCount: 0,
        skippedCount: 0,
        pendingTurnCount: 0,
        processedContextVersion: 0,
        reason: input.reason,
        status: 'noop',
      };
    }

    const workspaceDir = input.workspaceDir ?? meta.workspaceDir;
    const currentProjection = this.contextManager.getProjection(ref);
    const state = normalizeState(meta.memoryPromotionState);
    const turns = this.collectCommittedTurns(ref).filter(
      (turn) => turn.ordinal > state.lastProcessedContextVersion && turn.ordinal <= currentProjection.version
    );
    if (turns.length === 0) {
      this.contextManager.updateNamespaceMeta(ref, {
        memoryPromotionState: {
          ...state,
          pendingTurnCount: Math.max(0, currentProjection.version - state.lastProcessedContextVersion),
          status: 'idle',
          lastError: undefined,
        },
      });
      return {
        sessionId: input.sessionId,
        workspaceDir,
        processedTurns: 0,
        appliedCount: 0,
        skippedCount: 0,
        pendingTurnCount: Math.max(0, currentProjection.version - state.lastProcessedContextVersion),
        processedContextVersion: state.lastProcessedContextVersion,
        reason: input.reason,
        status: 'noop',
      };
    }

    this.contextManager.updateNamespaceMeta(ref, {
      memoryPromotionState: {
        ...state,
        pendingTurnCount: turns.length,
        status: 'processing',
        lastError: undefined,
      },
    });

    try {
      const candidates: MemoryCandidate[] = [];
      const turnWorkspaceById = new Map<string, string | undefined>();
      const groupedTurns = new Map<string, { workspaceDir?: string; turns: SessionTurnRecord[] }>();
      for (const turn of turns) {
        turnWorkspaceById.set(turn.turnId, turn.workspaceDir);
        const groupWorkspace = turn.workspaceDir ?? workspaceDir;
        const groupKey = normalizeWorkspacePathKey(groupWorkspace) || '__user_scope__';
        const group = groupedTurns.get(groupKey) ?? { workspaceDir: groupWorkspace, turns: [] };
        group.turns.push(turn);
        groupedTurns.set(groupKey, group);
      }
      for (const group of groupedTurns.values()) {
        const groupCandidates = await this.classifyTurns({
          workspaceDir: group.workspaceDir,
          turns: group.turns.slice(0, MEMORY_CLASSIFIER_MAX_TURNS),
        });
        candidates.push(...groupCandidates);
      }
      let appliedCount = 0;
      let skippedCount = 0;
      for (const candidate of candidates) {
        const candidateWorkspaceDir = turnWorkspaceById.get(candidate.turnId) ?? workspaceDir;
        if (await this.applyCandidate(candidate, input.sessionId, candidateWorkspaceDir)) {
          appliedCount += 1;
        } else {
          skippedCount += 1;
        }
      }

      const latestProjection = this.contextManager.getProjection(ref);
      const latestState = normalizeState(this.contextManager.getEventStore().loadMeta(ref.scope, ref.namespace)?.memoryPromotionState);
      const nextState: MemoryPromotionState = {
        ...latestState,
        lastProcessedContextVersion: currentProjection.version,
        lastQueuedContextVersion: Math.max(latestState.lastQueuedContextVersion, currentProjection.version),
        pendingTurnCount: Math.max(0, latestProjection.version - currentProjection.version),
        lastActivityAt: nowIso(),
        lastProcessedAt: nowIso(),
        status: 'idle',
        lastError: undefined,
      };
      this.contextManager.updateNamespaceMeta(ref, { memoryPromotionState: nextState });
      if (nextState.pendingTurnCount > 0) {
        this.scheduleIdleFlush(input.sessionId, workspaceDir);
      }
      this.governanceAuditStore.append({
        kind: 'memory_organized',
        title: `Memory organized for ${input.sessionId}`,
        sessionId: input.sessionId,
        workspaceDir,
        entityType: 'memory',
        status: appliedCount > 0 ? 'success' : 'info',
        metadata: {
          reason: input.reason,
          processedTurns: turns.length,
          appliedCount,
          skippedCount,
          processedContextVersion: currentProjection.version,
          pendingTurnCount: nextState.pendingTurnCount,
        },
      });
      return {
        sessionId: input.sessionId,
        workspaceDir,
        processedTurns: turns.length,
        appliedCount,
        skippedCount,
        pendingTurnCount: nextState.pendingTurnCount,
        processedContextVersion: currentProjection.version,
        reason: input.reason,
        status: 'ok',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.contextManager.updateNamespaceMeta(ref, {
        memoryPromotionState: {
          ...state,
          pendingTurnCount: Math.max(0, currentProjection.version - state.lastProcessedContextVersion),
          status: 'failed',
          lastError: message,
          lastActivityAt: nowIso(),
        },
      });
      this.governanceAuditStore.append({
        kind: 'memory_organize_failed',
        title: `Memory organize failed for ${input.sessionId}`,
        detail: message,
        sessionId: input.sessionId,
        workspaceDir,
        entityType: 'memory',
        status: 'warning',
        metadata: {
          reason: input.reason,
          processedContextVersion: currentProjection.version,
        },
      });
      throw error;
    }
  }

  private async applyCandidate(candidate: MemoryCandidate, sessionId: string, workspaceDir?: string): Promise<boolean> {
    if (candidate.decision !== 'memory_candidate') {
      return false;
    }
    if (candidate.stability !== 'stable') {
      return false;
    }
    const title = String(candidate.title ?? '').trim();
    const content = String(candidate.content ?? '').trim();
    const scope = candidate.scope ?? (workspaceDir ? 'workspace' : 'user');
    if (!title || !content) {
      return false;
    }
    const storageKey = this.resolveStorageQueueKeyForScope(scope, workspaceDir);
    return this.enqueueStorageTask(storageKey, async () => {
      const conflict = this.findConflictingEntry(candidate, workspaceDir);
      if (conflict) {
        this.governanceAuditStore.append({
          kind: 'memory_conflict_skipped',
          title: `Memory conflict skipped: ${title}`,
          detail: `Existing: ${conflict.title}`,
          sessionId,
          workspaceDir,
          entityType: 'memory',
          entityId: conflict.id,
          status: 'warning',
          metadata: {
            scope,
            conflictHints: candidate.conflictHints ?? [],
          },
        });
        return false;
      }
      const entry = this.memoryStore.writeMemory({
        scope,
        title,
        content,
        workspaceDir,
        sourceSessionId: sessionId,
        reason: candidate.reason,
      });
      this.governanceAuditStore.append({
        kind: 'memory_written',
        title: `Memory written: ${entry.title}`,
        detail: entry.content,
        sessionId,
        workspaceDir: entry.workspaceDir ?? workspaceDir,
        entityType: 'memory',
        entityId: entry.id,
        status: 'success',
        metadata: {
          action: 'organize',
          scope: entry.scope,
          version: entry.version,
        },
      });
      return true;
    });
  }

  private findConflictingEntry(candidate: MemoryCandidate, workspaceDir?: string): MemoryEntry | undefined {
    const hints = normalizeConflictHints(candidate.conflictHints);
    if (hints.length === 0) {
      return undefined;
    }
    const entries = this.memoryStore.listEntries({
      workspaceDir,
      includeUser: true,
      includeExpired: false,
      includeSuperseded: false,
    });
    return entries.find((entry) => {
      const normalizedTitle = normalizeWorkflowText(entry.title);
      return hints.some((hint) => hint === entry.id || normalizeWorkflowText(hint) === normalizedTitle);
    });
  }

  private async classifyTurns(input: {
    workspaceDir?: string;
    turns: SessionTurnRecord[];
  }): Promise<MemoryCandidate[]> {
    const llm = this.getLlmClient();
    if (!llm) {
      return input.turns.map((turn) => this.heuristicCandidate(turn, input.workspaceDir));
    }

    const activeMemory = this.memoryStore.listEntries({
      workspaceDir: input.workspaceDir,
      includeUser: true,
    });
    const payload = {
      activeMemory: activeMemory.slice(0, 10).map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        title: entry.title,
        content: truncate(entry.content, 220),
      })),
      turns: input.turns.map((turn) => ({
        turnId: turn.turnId,
        prompt: truncate(turn.prompt, 320),
        finalOutput: truncate(turn.finalOutput, MEMORY_CLASSIFIER_MAX_CONTENT_CHARS),
      })),
    };
    const systemPrompt = [
      'You classify conversation turns into durable memory or non-memory.',
      'Follow Hermes-style memory rules:',
      '- Save only stable, reusable facts, preferences, workspace conventions, commands, release steps, long-lived workarounds, or repeatable workflows.',
      '- Do not save transient task state, current TODOs, one-off debug logs, temporary paths, short-lived experiments, raw dumps, or content that is already recoverable from current structured context.',
      '- Use scope=user for stable user preferences or communication constraints.',
      '- Use scope=workspace for repo- or environment-specific workflow facts.',
      '- If the information is temporary, uncertain, or only useful for this task, use session_only.',
      '- If unsure, do not promote; prefer session_only or discard.',
      'Return JSON only with shape {"items":[...]} and no markdown fences.',
      'Each item must include turnId, decision, scope, title, content, reason, stability, conflictHints.',
      'Allowed decision values: discard, session_only, memory_candidate.',
      'Allowed stability values: stable, tentative, temporary.',
      'If a candidate contradicts existing active memory, put the exact conflicting title or id in conflictHints.',
      'Keep title concise. Keep content standalone and under 220 chars.',
    ].join('\n');
    const response = await llm.generate(
      [
        {
          role: 'user',
          content: `Classify these turns:\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      undefined,
      systemPrompt,
      {
        maxTokens: 1600,
        snapshotStage: 'initial',
      }
    );
    const parsed = extractJsonObject(response.content);
    if (!parsed) {
      return input.turns.map((turn) => this.heuristicCandidate(turn, input.workspaceDir));
    }
    try {
      const json = JSON.parse(parsed) as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(json.items) ? json.items : [];
      return items.map((item) => ({
        turnId: String(item.turnId ?? '').trim(),
        decision:
          item.decision === 'memory_candidate' || item.decision === 'session_only' ? item.decision : 'discard',
        scope: item.scope === 'user' || item.scope === 'workspace' ? item.scope : undefined,
        title: String(item.title ?? '').trim() || undefined,
        content: String(item.content ?? '').trim() || undefined,
        reason: String(item.reason ?? '').trim() || undefined,
        stability:
          item.stability === 'stable' || item.stability === 'temporary' ? item.stability : 'tentative',
        conflictHints: normalizeConflictHints(item.conflictHints),
      }));
    } catch {
      return input.turns.map((turn) => this.heuristicCandidate(turn, input.workspaceDir));
    }
  }

  private heuristicCandidate(turn: SessionTurnRecord, workspaceDir?: string): MemoryCandidate {
    const combined = `${turn.prompt}\n${turn.finalOutput}`.trim();
    if (!combined || looksLikeFailure(combined)) {
      return { turnId: turn.turnId, decision: 'discard', stability: 'tentative' };
    }
    if (containsAnyPhrase(combined, ['temporary', 'for now', 'today', 'this week', 'this sprint'])) {
      return { turnId: turn.turnId, decision: 'session_only', stability: 'temporary' };
    }
    const commands = extractCommandCandidates(combined);
    const checklist = extractChecklistItems(combined);
    const userSignals = containsAnyPhrase(combined, [
      'remember',
      'prefer',
      'default',
      'always',
      'format responses',
      'response style',
    ]);
    const workspaceSignals =
      containsAnyPhrase(combined, [
        'workspace',
        'repo',
        'project',
        'directory',
        'path',
        'workflow',
        'publish',
        'release',
        'deploy',
        'build',
        'command',
        'project convention',
      ]) ||
      commands.length > 0 ||
      checklist.length > 0;
    if (!userSignals && !workspaceSignals) {
      return { turnId: turn.turnId, decision: 'discard', stability: 'tentative' };
    }
    const scope: MemoryScope = userSignals && !workspaceSignals ? 'user' : workspaceDir ? 'workspace' : 'user';
    const title =
      scope === 'user'
        ? 'User preference'
        : commands.length > 0
          ? `Workflow: ${truncate(commands[0], 72)}`
          : checklist.length > 0
            ? `Workflow: ${truncate(checklist[0], 72)}`
            : `Workspace rule: ${truncate(tokenizeWorkflowText(turn.prompt).slice(0, 6).join(' '), 72)}`;
    const summarySource =
      commands.length > 0
        ? `Commands: ${commands.join('; ')}`
        : checklist.length > 0
          ? `Checklist: ${checklist.join('; ')}`
          : turn.finalOutput || turn.prompt;
    return {
      turnId: turn.turnId,
      decision: 'memory_candidate',
      scope,
      title,
      content: truncate(summarySource.replace(/\s+/g, ' ').trim(), 220),
      reason:
        scope === 'user' ? 'heuristic_user_preference_promotion' : 'heuristic_workspace_workflow_promotion',
      stability: 'stable',
      conflictHints: [],
    };
  }

  private collectCommittedTurns(ref: ContextRef): SessionTurnRecord[] {
    const events = this.contextManager.getEventStore().readEvents(ref.scope, ref.namespace);
    const turnMap = new Map<string, SessionTurnAccumulator>();
    const ordered: SessionTurnRecord[] = [];
    let ordinal = 0;
    for (const event of events) {
      const turn = turnMap.get(event.turnId) ?? {};
      turnMap.set(event.turnId, turn);
      this.applyEventToTurnAccumulator(turn, event);
      if (event.type === 'turn_committed') {
        ordinal += 1;
        ordered.push({
          turnId: event.turnId,
          ordinal,
          prompt: String(turn.prompt ?? '').trim(),
          finalOutput: String(turn.finalOutput ?? '').trim(),
          committedAt: event.timestamp,
          workspaceDir: turn.workspaceDir,
        });
      }
    }
    return ordered.filter((turn) => turn.prompt.length > 0 || turn.finalOutput.length > 0);
  }

  private applyEventToTurnAccumulator(target: SessionTurnAccumulator, event: ContextEvent): void {
    if (event.type === 'turn_started') {
      const rawUserPrompt = String(event.data.rawUserPrompt ?? event.data.prompt ?? '').trim();
      if (rawUserPrompt) {
        target.prompt = rawUserPrompt;
      }
      const workspaceDir = String(event.data.workspaceDir ?? '').trim();
      if (workspaceDir) {
        target.workspaceDir = workspaceDir;
      }
      return;
    }
    if (event.type === 'user_message') {
      const content = String(event.data.content ?? '').trim();
      if (content && !target.prompt) {
        target.prompt = content;
      }
      return;
    }
    if (event.type === 'turn_summary') {
      const finalOutput = String(event.data.finalOutput ?? '').trim();
      if (finalOutput) {
        target.finalOutput = finalOutput;
      }
      return;
    }
    if (event.type === 'assistant_message') {
      const content = String(event.data.content ?? '').trim();
      if (content) {
        target.finalOutput = content;
      }
    }
  }

  private scheduleIdleFlush(sessionId: string, workspaceDir?: string): void {
    this.clearIdleTimer(sessionId);
    const timer = setTimeout(() => {
      void this.organizeSession({
        sessionId,
        workspaceDir,
        reason: 'idle_flush',
      }).catch(() => undefined);
    }, this.idleFlushMs);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }

  private async waitForQueuesToDrain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const pending = [...this.sessionQueues.values(), ...this.storageQueues.values()];
      if (pending.length === 0) {
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return;
      }
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(remainingMs, 250));
        }),
      ]);
    }
  }

  private resolveStorageQueueKeyForMutation(input: MemoryMutationInput): string {
    if (input.action === 'add') {
      const scope = input.scope ?? (input.workspaceDir ? 'workspace' : 'user');
      return this.resolveStorageQueueKeyForScope(scope, input.workspaceDir);
    }
    const id = String(input.id ?? '').trim();
    if (!id) {
      return this.resolveStorageQueueKeyForScope(input.scope ?? (input.workspaceDir ? 'workspace' : 'user'), input.workspaceDir);
    }
    const existing = this.memoryStore.readEntry(id, {
      workspaceDir: input.workspaceDir,
      includeUser: true,
      includeExpired: true,
      includeSuperseded: true,
    });
    if (existing) {
      return this.resolveStorageQueueKeyForScope(existing.scope, existing.workspaceDir ?? input.workspaceDir);
    }
    return this.resolveStorageQueueKeyForScope(input.scope ?? (input.workspaceDir ? 'workspace' : 'user'), input.workspaceDir);
  }

  private resolveStorageQueueKeyForScope(scope: MemoryScope, workspaceDir?: string): string {
    if (scope === 'user') {
      return 'user:default';
    }
    const normalizedWorkspace = normalizeWorkspacePathKey(workspaceDir);
    return normalizedWorkspace ? `workspace:${normalizedWorkspace}` : 'user:default';
  }

  private enqueueStorageTask<T>(storageKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.storageQueues.get(storageKey) ?? Promise.resolve();
    let resolveTask!: (value: T) => void;
    let rejectTask!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveTask(await task());
        } catch (error) {
          rejectTask(error);
        }
      })
      .finally(() => {
        if (this.storageQueues.get(storageKey) === next) {
          this.storageQueues.delete(storageKey);
        }
      });
    this.storageQueues.set(storageKey, next);
    return result;
  }

  private enqueueSessionTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let resolveTask!: (value: T) => void;
    let rejectTask!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveTask(await task());
        } catch (error) {
          rejectTask(error);
        }
      })
      .finally(() => {
        if (this.sessionQueues.get(sessionId) === next) {
          this.sessionQueues.delete(sessionId);
        }
      });
    this.sessionQueues.set(sessionId, next);
    return result;
  }
}
