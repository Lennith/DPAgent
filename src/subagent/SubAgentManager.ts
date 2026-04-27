import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { findAgentProfileByName, resolveAgentPool, type AgentProfile } from '../agents/index.js';
import { ContextManager } from '../context/index.js';
import type {
  ContextRef,
  SubAgentAssignedAgent,
  SubAgentAssignedAgentProfile,
  SubAgentArtifact,
  SubAgentCreateParams,
  SubAgentLifecycleStatus,
  SubAgentProviderConfig,
  SubAgentResult,
  SubAgentStatus,
} from '../types.js';
import { SubAgentTurnRunner } from './SubAgentTurnRunner.js';
import type {
  ParentQueueState,
  SubAgentQueuedTask,
  SubAgentRecord,
  SubAgentRegistryState,
  SubAgentResumeRequest,
} from './types.js';

const MAX_QUEUED_TASKS_PER_PARENT = 3;
const DEFAULT_TASK_TIMEOUT_MS = 300000;
const DEFAULT_RESULT_WAIT_TIMEOUT_MS = 300000;
const HEARTBEAT_TIMEOUT_MS = 180000;
const HEARTBEAT_PERSIST_TICK_MS = 2000;
const DEFAULT_MAX_PARALLEL_PER_PARENT = 4;
const DEFAULT_GLOBAL_MAX_PARALLEL = 10;
const REGISTRY_VERSION = 2;
// REQ-0027: Retry queue settings
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

interface WaitResult {
  status: SubAgentStatus;
  result?: SubAgentResult;
  timedOut?: boolean;
}

interface ResultWaiter {
  runSeq: number;
  resolve: (value: WaitResult) => void;
  timer: NodeJS.Timeout;
}

type SubAgentCreateOrResumeResult =
  | { ok: true; status: SubAgentStatus }
  | {
      ok: false;
      code:
        | 'invalid_prompt'
        | 'invalid_subagent_id'
        | 'subagent_not_found'
        | 'parent_mismatch'
        | 'subagent_busy'
        | 'agent_not_found'
        | 'queue_full';
      error: string;
      status?: SubAgentStatus;
    };

export interface SubAgentManagerOptions {
  contextManager: ContextManager;
  turnRunner: SubAgentTurnRunner;
  registryFilePath: string;
  getDefaultWorkspaceDir: () => string;
  getProviderConfigs: () => SubAgentProviderConfig[] | undefined;
  getGlobalAgentsDir: () => string | undefined;
  getMaxParallelPerParent: () => number;
  getGlobalMaxParallel: () => number;
  resolveAllowedTools?: (input: {
    parentContext: ContextRef;
    workspaceDir?: string;
    allowedTools?: string[];
  }) => string[] | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

function isTerminalStatus(status: SubAgentLifecycleStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'canceled' ||
    status === 'timeout'
  );
}

function emptyArtifacts(): SubAgentArtifact {
  return {
    files: [],
    commands: [],
    notes: [],
  };
}

export class SubAgentManager {
  private readonly options: SubAgentManagerOptions;
  private readonly registryFilePath: string;
  private readonly waiters = new Map<string, ResultWaiter[]>();
  private readonly state: SubAgentRegistryState;
  private readonly heartbeatPersistTimer: NodeJS.Timeout;
  private stateDirty = false;

  constructor(options: SubAgentManagerOptions) {
    this.options = options;
    this.registryFilePath = path.resolve(options.registryFilePath);
    this.state = this.loadState();
    this.heartbeatPersistTimer = setInterval(() => {
      this.flushDirtyState();
    }, HEARTBEAT_PERSIST_TICK_MS);
    this.heartbeatPersistTimer.unref?.();
    this.markPendingTasksAsFailedOnStartup();
    this.reconcileStaleTasks();
    this.processRetryQueue();
  }

  shutdown(): void {
    clearInterval(this.heartbeatPersistTimer);
    this.flushDirtyState();
  }

  create(request: SubAgentCreateParams): SubAgentCreateOrResumeResult {
    this.reconcileStaleTasks();
    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) {
      return {
        ok: false,
        code: 'invalid_prompt',
        error: 'prompt is required for create',
      };
    }

    const parentContext = this.normalizeContextRef(request.parentContext);

    // REQ-0009: Context integrity check before subagent spawn
    const integrityCheck = this.options.contextManager.checkContextIntegrity(parentContext);
    if (!integrityCheck.valid) {
      const jumpWarning = integrityCheck.versionChain;
      const warnMsg = `[SubAgentManager] Context version jump detected for ${parentContext?.scope}/${parentContext?.namespace} :: ` +
        `jump from v${jumpWarning?.previousVersion} to v${jumpWarning?.currentVersion} (size: ${jumpWarning?.gapSize}). ` +
        `Subagent spawn may have stale context. Proceeding with warning.`;
      console.warn(warnMsg);
    }

    // REQ-0004: Create context checkpoint before sub-agent invocation
    let checkpointId: string | undefined;
    try {
      const checkpointResult = this.options.contextManager.createCheckpoint(parentContext, 'subagent_create');
      checkpointId = checkpointResult.checkpoint.checkpointId;
      console.info(`[SubAgentManager] Created checkpoint ${checkpointId} before subagent spawn`);
    } catch (error) {
      const cpError = error instanceof Error ? error.message : String(error);
      console.warn(`[SubAgentManager] Failed to create checkpoint: ${cpError}. Proceeding without checkpoint.`);
    }

    const workspaceDir = this.resolveWorkspaceDir(request.workspaceDir);
    const selectedAgent = this.resolveAgentSelection(request.agentName, workspaceDir);
    if (!selectedAgent.ok) {
      return {
        ok: false,
        code: 'agent_not_found',
        error: selectedAgent.error,
      };
    }
    const parentKey = this.contextKey(parentContext);
    const queue = this.ensureQueue(parentKey);
    if (queue.queuedTaskIds.length >= MAX_QUEUED_TASKS_PER_PARENT) {
      return {
        ok: false,
        code: 'queue_full',
        error: `queue_full: parent context already has ${MAX_QUEUED_TASKS_PER_PARENT} queued sub-agent tasks`,
      };
    }

    const createdAt = nowIso();
    const subagentId = this.generateSubAgentId();
    const providerSelection = this.selectProviderId({
      explicitProviderId: request.providerId,
      fallbackProviderId: undefined,
    });
    const record: SubAgentRecord = {
      id: subagentId,
      parentContext,
      parentKey,
      context: this.createSubAgentContextRef(parentContext, subagentId),
      status: 'queued',
      runSeq: 1,
      agent: selectedAgent.agent,
      createdAt,
      updatedAt: createdAt,
      lastHeartbeatAt: createdAt,
      providerId: providerSelection.providerId,
      prompt,
      agentName: selectedAgent.agent?.name,
      allowedTools: this.resolveEffectiveAllowedTools(parentContext, workspaceDir, request.allowedTools),
      timeoutMs: this.normalizeTimeoutMs(request.timeoutMs, DEFAULT_TASK_TIMEOUT_MS),
      workspaceDir,
      queuePosition: undefined,
      latestResult: undefined,
      lastError: undefined,
    };
    this.state.records[subagentId] = record;

    if (!providerSelection.available) {
      this.failRecordImmediately(record, `provider_unavailable:${providerSelection.providerId}`);
      return { ok: true, status: this.toStatusPayload(record) };
    }

    const task = this.buildTask({
      subagentId,
      operation: 'create',
      request,
      providerId: providerSelection.providerId,
      context: record.context,
      agentProfile: selectedAgent.profile,
      parentKey,
      parentContext,
      workspaceDir,
    });
    this.state.tasks[task.taskId] = task;

    this.enqueueTask(task, record);
    this.persistState();
    this.writeParentContextIndex(parentContext);
    this.processAllQueues();
    return { ok: true, status: this.toStatusPayload(record) };
  }

  resume(request: SubAgentResumeRequest): SubAgentCreateOrResumeResult {
    this.reconcileStaleTasks();
    const subagentId = String(request.subagentId ?? '').trim();
    if (!subagentId) {
      return {
        ok: false,
        code: 'invalid_subagent_id',
        error: 'subagent_id is required for resume',
      };
    }

    const record = this.state.records[subagentId];
    if (!record) {
      return {
        ok: false,
        code: 'subagent_not_found',
        error: `Sub-agent not found: ${subagentId}`,
      };
    }

    const parentContext = this.normalizeContextRef(request.parentContext);

    // REQ-0009: Context integrity check before subagent spawn
    const integrityCheck = this.options.contextManager.checkContextIntegrity(parentContext);
    if (!integrityCheck.valid) {
      const jumpWarning = integrityCheck.versionChain;
      const warnMsg = `[SubAgentManager] Context version jump detected for ${parentContext?.scope}/${parentContext?.namespace} :: ` +
        `jump from v${jumpWarning?.previousVersion} to v${jumpWarning?.currentVersion} (size: ${jumpWarning?.gapSize}). ` +
        `Subagent spawn may have stale context. Proceeding with warning.`;
      console.warn(warnMsg);
    }

    // REQ-0004: Create context checkpoint before sub-agent invocation
    let checkpointId: string | undefined;
    try {
      const checkpointResult = this.options.contextManager.createCheckpoint(parentContext, 'subagent_create');
      checkpointId = checkpointResult.checkpoint.checkpointId;
      console.info(`[SubAgentManager] Created checkpoint ${checkpointId} before subagent spawn`);
    } catch (error) {
      const cpError = error instanceof Error ? error.message : String(error);
      console.warn(`[SubAgentManager] Failed to create checkpoint: ${cpError}. Proceeding without checkpoint.`);
    }

    const workspaceDir = this.resolveWorkspaceDir(request.workspaceDir);
    const selectedAgent = this.resolveAgentSelection(request.agentName, workspaceDir);
    if (!selectedAgent.ok) {
      return {
        ok: false,
        code: 'agent_not_found',
        error: selectedAgent.error,
      };
    }
    const parentKey = this.contextKey(parentContext);
    if (record.parentKey !== parentKey) {
      return {
        ok: false,
        code: 'parent_mismatch',
        error: 'resume is only allowed within the same parent context',
      };
    }

    if (this.findPendingTaskIdBySubagent(subagentId)) {
      return {
        ok: false,
        code: 'subagent_busy',
        error: 'sub-agent already has a queued or running task',
        status: this.toStatusPayload(record),
      };
    }

    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) {
      return {
        ok: false,
        code: 'invalid_prompt',
        error: 'prompt is required for resume',
      };
    }

    const queue = this.ensureQueue(parentKey);
    if (queue.queuedTaskIds.length >= MAX_QUEUED_TASKS_PER_PARENT) {
      return {
        ok: false,
        code: 'queue_full',
        error: `queue_full: parent context already has ${MAX_QUEUED_TASKS_PER_PARENT} queued sub-agent tasks`,
      };
    }

    const nextRunSeq = record.runSeq + 1;
    const providerSelection = this.selectProviderId({
      explicitProviderId: request.providerId,
      fallbackProviderId: record.providerId,
    });

    record.runSeq = nextRunSeq;
    record.updatedAt = nowIso();
    record.lastHeartbeatAt = record.updatedAt;
    record.status = 'queued';
    record.queuePosition = undefined;
    record.latestResult = undefined;
    record.lastError = undefined;
    record.agent = selectedAgent.agent;
    record.providerId = providerSelection.providerId;
    record.prompt = prompt;
    record.agentName = selectedAgent.agent?.name;
    record.allowedTools = this.resolveEffectiveAllowedTools(parentContext, workspaceDir, request.allowedTools);
    record.timeoutMs = this.normalizeTimeoutMs(request.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    record.workspaceDir = workspaceDir;

    if (!providerSelection.available) {
      this.failRecordImmediately(record, `provider_unavailable:${providerSelection.providerId}`);
      return { ok: true, status: this.toStatusPayload(record) };
    }

    const task = this.buildTask({
      subagentId,
      operation: 'resume',
      request,
      providerId: providerSelection.providerId,
      context: record.context,
      agentProfile: selectedAgent.profile,
      parentKey,
      parentContext,
      workspaceDir,
    });
    this.state.tasks[task.taskId] = task;

    this.enqueueTask(task, record);
    this.persistState();
    this.writeParentContextIndex(parentContext);
    this.processAllQueues();
    return { ok: true, status: this.toStatusPayload(record) };
  }

  getStatus(parentContext: ContextRef, subagentId: string): SubAgentStatus | undefined {
    this.reconcileStaleTasks();
    const record = this.getOwnedRecord(parentContext, subagentId);
    if (!record) {
      return undefined;
    }
    return this.toStatusPayload(record);
  }

  list(parentContext: ContextRef): SubAgentStatus[] {
    this.reconcileStaleTasks();
    const parentKey = this.contextKey(parentContext);
    return Object.values(this.state.records)
      .filter((record) => record.parentKey === parentKey)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((record) => this.toStatusPayload(record));
  }

  listAgents(workspaceDir?: string): SubAgentAssignedAgent[] {
    this.reconcileStaleTasks();
    return this.resolveAvailableAgents(this.resolveWorkspaceDir(workspaceDir)).map((profile) =>
      this.toAssignedAgent(profile)
    );
  }

  cancel(parentContext: ContextRef, subagentId: string): SubAgentStatus | undefined {
    this.reconcileStaleTasks();
    const record = this.getOwnedRecord(parentContext, subagentId);
    if (!record) {
      return undefined;
    }

    if (isTerminalStatus(record.status) && !this.findPendingTaskIdBySubagent(subagentId)) {
      return this.toStatusPayload(record);
    }

    const pendingTaskId = this.findPendingTaskIdBySubagent(subagentId);
    const currentTime = nowIso();

    if (!pendingTaskId) {
      record.status = 'canceled';
      record.updatedAt = currentTime;
      record.lastHeartbeatAt = currentTime;
      record.lastError = 'cancel_requested';
      record.queuePosition = undefined;
      record.latestResult = this.createResultPayload({
        record,
        status: 'canceled',
        summary: 'Sub-agent canceled by request.',
        artifacts: emptyArtifacts(),
        error: 'cancel_requested',
        startedAt: record.latestResult?.startedAt,
        completedAt: currentTime,
      });
      this.persistState();
      this.writeParentContextResult(record.parentContext, record.latestResult);
      this.writeParentContextIndex(record.parentContext);
      this.resolveWaiters(record.id, record.runSeq);
      return this.toStatusPayload(record);
    }

    const queue = this.ensureQueue(record.parentKey);
    if (queue.runningTaskIds.includes(pendingTaskId)) {
      this.options.turnRunner.cancelTask(pendingTaskId);
      record.status = 'canceled';
      record.updatedAt = currentTime;
      record.lastHeartbeatAt = currentTime;
      record.lastError = 'cancel_requested';
      record.queuePosition = undefined;
      record.latestResult = this.createResultPayload({
        record,
        status: 'canceled',
        summary: 'Sub-agent canceled by request.',
        artifacts: emptyArtifacts(),
        error: 'cancel_requested',
        startedAt: record.latestResult?.startedAt,
        completedAt: currentTime,
      });
      this.persistState();
      this.writeParentContextResult(record.parentContext, record.latestResult);
      this.writeParentContextIndex(record.parentContext);
      this.resolveWaiters(record.id, record.runSeq);
      return this.toStatusPayload(record);
    }

    const nextQueued = queue.queuedTaskIds.filter((taskId) => taskId !== pendingTaskId);
    queue.queuedTaskIds = nextQueued;
    delete this.state.tasks[pendingTaskId];

    record.status = 'canceled';
    record.updatedAt = currentTime;
    record.lastHeartbeatAt = currentTime;
    record.lastError = 'cancel_requested';
    record.queuePosition = undefined;
    record.latestResult = this.createResultPayload({
      record,
      status: 'canceled',
      summary: 'Sub-agent canceled before execution.',
      artifacts: emptyArtifacts(),
      error: 'cancel_requested',
      startedAt: undefined,
      completedAt: currentTime,
    });

    this.updateQueuePositions(record.parentKey);
    this.persistState();
    this.writeParentContextResult(record.parentContext, record.latestResult);
    this.writeParentContextIndex(record.parentContext);
    this.resolveWaiters(record.id, record.runSeq);
    this.processAllQueues();

    return this.toStatusPayload(record);
  }

  async getResult(
    parentContext: ContextRef,
    subagentId: string,
    options: { wait?: boolean; timeoutMs?: number } = {}
  ): Promise<WaitResult | undefined> {
    this.reconcileStaleTasks();
    const record = this.getOwnedRecord(parentContext, subagentId);
    if (!record) {
      return undefined;
    }

    const runSeq = record.runSeq;
    const status = this.toStatusPayload(record);
    const latest = record.latestResult;
    if (latest && latest.runSeq === runSeq && isTerminalStatus(status.status)) {
      return {
        status,
        result: latest,
      };
    }

    if (!options.wait) {
      return {
        status,
      };
    }

    const timeoutMs = this.normalizeTimeoutMs(options.timeoutMs, DEFAULT_RESULT_WAIT_TIMEOUT_MS);
    return await new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(subagentId, runSeq, resolve);
        const latestRecord = this.state.records[subagentId];
        if (!latestRecord) {
          resolve({
            status,
            timedOut: true,
          });
          return;
        }
        resolve({
          status: this.toStatusPayload(latestRecord),
          result:
            latestRecord.latestResult && latestRecord.latestResult.runSeq === runSeq
              ? latestRecord.latestResult
              : undefined,
          timedOut: true,
        });
      }, timeoutMs);

      const entry: ResultWaiter = {
        runSeq,
        resolve,
        timer,
      };
      const list = this.waiters.get(subagentId) ?? [];
      list.push(entry);
      this.waiters.set(subagentId, list);
    });
  }

  private markPendingTasksAsFailedOnStartup(): void {
    const pendingTaskIds = Object.keys(this.state.tasks);
    if (pendingTaskIds.length === 0) {
      return;
    }

    const parentContexts = new Map<string, ContextRef>();
    for (const taskId of pendingTaskIds) {
      const task = this.state.tasks[taskId];
      const record = this.state.records[task.subagentId];
      if (!record) {
        continue;
      }
      record.status = 'failed';
      record.queuePosition = undefined;
      record.updatedAt = nowIso();
      record.lastHeartbeatAt = record.updatedAt;
      record.lastError = 'process_restart';
      record.latestResult = this.createResultPayload({
        record,
        status: 'failed',
        summary: 'Sub-agent execution failed because the service restarted before completion.',
        artifacts: emptyArtifacts(),
        error: 'process_restart',
        startedAt: undefined,
        completedAt: nowIso(),
      });
      parentContexts.set(record.parentKey, record.parentContext);
    }

    this.state.tasks = {};
    for (const queue of Object.values(this.state.queues)) {
      queue.runningTaskIds = [];
      queue.queuedTaskIds = [];
    }
    this.persistState();

    for (const context of parentContexts.values()) {
      const relatedRecords = Object.values(this.state.records).filter(
        (record) => record.parentKey === this.contextKey(context) && record.latestResult
      );
      for (const record of relatedRecords) {
        if (record.latestResult) {
          this.writeParentContextResult(context, record.latestResult);
        }
      }
      this.writeParentContextIndex(context);
    }
  }

  private reconcileStaleTasks(): void {
    const now = Date.now();
    const staleTaskIds: string[] = [];
    for (const [taskId, task] of Object.entries(this.state.tasks)) {
      const queue = this.ensureQueue(task.parentKey);
      if (!queue.runningTaskIds.includes(taskId)) {
        continue;
      }
      const record = this.state.records[task.subagentId];
      const heartbeatRaw = String(record?.lastHeartbeatAt ?? record?.updatedAt ?? task.createdAt ?? '').trim();
      const heartbeatAt = new Date(heartbeatRaw).getTime();
      if (!Number.isFinite(heartbeatAt)) {
        continue;
      }
      if (now - heartbeatAt <= HEARTBEAT_TIMEOUT_MS) {
        continue;
      }
      staleTaskIds.push(taskId);
    }
    if (staleTaskIds.length === 0) {
      return;
    }

    const touchedParentKeys = new Set<string>();
    for (const taskId of staleTaskIds) {
      const task = this.state.tasks[taskId];
      if (!task) {
        continue;
      }
      const record = this.state.records[task.subagentId];
      touchedParentKeys.add(task.parentKey);
      this.options.turnRunner.cancelTask(taskId);

      const queue = this.ensureQueue(task.parentKey);
      queue.runningTaskIds = queue.runningTaskIds.filter((runningId) => runningId !== taskId);
      queue.queuedTaskIds = queue.queuedTaskIds.filter((queuedId) => queuedId !== taskId);
      delete this.state.tasks[taskId];

      if (!record) {
        continue;
      }
      if (isTerminalStatus(record.status)) {
        continue;
      }
      const completedAt = nowIso();
      record.status = 'timeout';
      record.queuePosition = undefined;
      record.updatedAt = completedAt;
      record.lastHeartbeatAt = completedAt;
      record.lastError = `subagent_heartbeat_timeout:${HEARTBEAT_TIMEOUT_MS}`;
      record.latestResult = this.createResultPayload({
        record,
        status: 'timeout',
        summary: `Sub-agent heartbeat timed out after ${HEARTBEAT_TIMEOUT_MS}ms (manager reconciliation).`,
        artifacts: emptyArtifacts(),
        error: `subagent_heartbeat_timeout:${HEARTBEAT_TIMEOUT_MS}`,
        startedAt: task.createdAt,
        completedAt,
      });
      this.writeParentContextResult(record.parentContext, record.latestResult);
      this.writeParentContextIndex(record.parentContext);
      this.resolveWaiters(record.id, record.runSeq);
    }

    for (const parentKey of touchedParentKeys) {
      this.updateQueuePositions(parentKey);
    }
    this.processAllQueues();
    this.persistState();
  }


  // REQ-0027: Retry queue management
  private addToRetryQueue(record: SubAgentRecord, failureReason: string): void {
    if ((record.retryCount ?? 0) >= MAX_RETRY_ATTEMPTS) {
      console.info(`[SubAgentManager] Max retries (${MAX_RETRY_ATTEMPTS}) reached for ${record.id}, not adding to retry queue`);
      return;
    }
    record.retryCount = (record.retryCount ?? 0) + 1;
    const existingIndex = this.state.retryQueue.findIndex((entry) => entry.subagentId === record.id);
    if (existingIndex >= 0) {
      this.state.retryQueue[existingIndex].retryCount = record.retryCount;
      this.state.retryQueue[existingIndex].lastFailedAt = nowIso();
      this.state.retryQueue[existingIndex].failureReason = failureReason;
      this.state.retryQueue[existingIndex].providerId = record.providerId;
    } else {
      const task = Object.values(this.state.tasks).find((t) => t.subagentId === record.id);
      this.state.retryQueue.push({
        subagentId: record.id,
        parentContext: record.parentContext,
        parentKey: record.parentKey,
        operation: task?.operation ?? 'create',
        prompt: task?.prompt ?? record.prompt ?? '',
        providerId: task?.providerId ?? record.providerId,
        agentName: task?.agentName,
        allowedTools: task?.allowedTools,
        timeoutMs: task?.timeoutMs,
        workspaceDir: task?.workspaceDir,
        retryCount: record.retryCount,
        lastFailedAt: nowIso(),
        failureReason,
      });
    }
    console.info(`[SubAgentManager] Added ${record.id} to retry queue (attempt ${record.retryCount}/${MAX_RETRY_ATTEMPTS})`);
    this.persistState();
  }




  private processRetryQueue(): void {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const entry of this.state.retryQueue) {
      if (entry.retryCount >= MAX_RETRY_ATTEMPTS) {
        toRemove.push(entry.subagentId);
        console.warn(`[SubAgentManager] Retry entry ${entry.subagentId} exceeded max attempts, removing`);
        continue;
      }
      const lastFailedMs = now - new Date(entry.lastFailedAt).getTime();
      if (lastFailedMs < RETRY_DELAY_MS) {
        continue;
      }
      // Retry: create a new task
      console.info(`[SubAgentManager] Retrying subagent ${entry.subagentId} (attempt ${entry.retryCount + 1}/${MAX_RETRY_ATTEMPTS})`);
      const newTaskId = this.generateTaskId();
      const createdAt = nowIso();
      const newSubagentId = this.generateSubAgentId();
      const newRecord: SubAgentRecord = {
        id: newSubagentId,
        parentContext: entry.parentContext,
        parentKey: entry.parentKey,
        context: this.createSubAgentContextRef(entry.parentContext, newSubagentId),
        status: 'queued',
        runSeq: 1,
        providerId: entry.providerId,
        prompt: entry.prompt,
        agentName: entry.agentName,
        allowedTools: entry.allowedTools,
        timeoutMs: entry.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        workspaceDir: entry.workspaceDir,
        createdAt,
        updatedAt: createdAt,
        lastHeartbeatAt: createdAt,
      };
      const newTask: SubAgentQueuedTask = {
        taskId: newTaskId,
        subagentId: newSubagentId,
        parentKey: entry.parentKey,
        parentContext: entry.parentContext,
        subagentContext: newRecord.context,
        operation: entry.operation,
        prompt: entry.prompt,
        agentName: entry.agentName,
        providerId: entry.providerId,
        allowedTools: entry.allowedTools,
        timeoutMs: entry.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
        workspaceDir: entry.workspaceDir,
        createdAt,
      };
      this.state.records[newSubagentId] = newRecord;
      this.state.tasks[newTaskId] = newTask;
      this.state.retryQueue = this.state.retryQueue.filter((e) => e.subagentId !== entry.subagentId);
      toRemove.push(entry.subagentId);
      this.enqueueTask(newTask, newRecord);
    }
    if (toRemove.length > 0) {
      this.state.retryQueue = this.state.retryQueue.filter((e) => !toRemove.includes(e.subagentId));
      this.persistState();
    }
  }



  private executeTaskSchedulingError(task: SubAgentQueuedTask, reason: string): void {
    this.removeTaskFromQueue(task.parentKey, task.taskId);
    delete this.state.tasks[task.taskId];
    const record = this.state.records[task.subagentId];
    if (!record) {
      this.updateQueuePositions(task.parentKey);
      this.persistState();
      return;
    }
    record.status = 'failed';
    record.queuePosition = undefined;
    record.updatedAt = nowIso();
    record.lastHeartbeatAt = record.updatedAt;
    record.lastError = reason;
    record.latestResult = this.createResultPayload({
      record,
      status: 'failed',
      summary: `Sub-agent failed: ${truncate(reason, 300)}`,
      artifacts: emptyArtifacts(),
      error: reason,
      startedAt: nowIso(),
      completedAt: nowIso(),
    });
    this.persistState();
    this.writeParentContextResult(record.parentContext, record.latestResult);
    this.writeParentContextIndex(record.parentContext);
    this.resolveWaiters(record.id, record.runSeq);
  }

  private enqueueTask(task: SubAgentQueuedTask, record: SubAgentRecord): void {
    const queue = this.ensureQueue(task.parentKey);
    const current = nowIso();
    record.updatedAt = current;
    record.lastHeartbeatAt = current;
    record.queuePosition = queue.queuedTaskIds.length + 1;
    record.lastError = undefined;
    record.status = 'queued';
    queue.queuedTaskIds.push(task.taskId);
    this.updateQueuePositions(task.parentKey);
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = this.state.tasks[taskId];
    if (!task) {
      return;
    }

    const record = this.state.records[task.subagentId];
    if (!record) {
      this.removeTaskFromQueue(task.parentKey, taskId);
      delete this.state.tasks[taskId];
      this.updateQueuePositions(task.parentKey);
      this.persistState();
      this.processAllQueues();
      return;
    }
    this.touchHeartbeat(task.subagentId);
    const executionTask: SubAgentQueuedTask = {
      ...task,
      allowedTools: this.resolveEffectiveAllowedTools(task.parentContext, task.workspaceDir, task.allowedTools),
    };
    const shouldValidateContextContinuity = this.getParentRunningCount(task.parentKey) <= 1;

    // REQ-0004: Create context checkpoint before sub-agent execution
    // This guards against silent context loss during sub-agent execution
    let checkpointResult: import('../context/ContextManager.js').ContextCheckpointResult | undefined;
    try {
      checkpointResult = this.options.contextManager.createCheckpoint(
        task.parentContext,
        `subagent:${task.subagentId}:${task.operation}:runSeq${record.runSeq}`
      );
    } catch (err) {
      // Log but don't block task execution if checkpoint fails
      console.error(`[SubAgentManager] Failed to create checkpoint for task ${task.taskId}:`, err);
    }

    let output:
      | {
          status: SubAgentLifecycleStatus;
          summary: string;
          artifacts: SubAgentArtifact;
          finishReason?: string;
          usage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
          error?: string;
          startedAt: string;
          completedAt: string;
        }
      | undefined;

    try {
      output = await this.options.turnRunner.runTask(executionTask, () => {
        this.touchHeartbeat(task.subagentId);
      });
    } catch (error) {
      output = {
        status: 'failed',
        summary: `Sub-agent failed: ${truncate(error instanceof Error ? error.message : String(error), 320)}`,
        artifacts: emptyArtifacts(),
        error: error instanceof Error ? error.message : String(error),
        startedAt: nowIso(),
        completedAt: nowIso(),
      };
    }
    // REQ-0005: Validate context continuity after sub-agent execution
    // If validation fails, perform rollback to checkpoint state
    if (
      checkpointResult?.checkpoint &&
      shouldValidateContextContinuity &&
      output.status !== 'canceled' &&
      this.getParentRunningCount(task.parentKey) <= 1
    ) {
      try {
        const validation = this.options.contextManager.validateCheckpoint(
          task.parentContext,
          checkpointResult.checkpoint,
          true // perform rollback on mismatch
        );
        if (!validation.valid) {
          console.warn(
            `[SubAgentManager] Context jump detected for task ${task.taskId}: ` +
            `expected hash ${validation.expectedHash}, got ${validation.actualHash}. ` +
            `Rollback ${validation.rollbackPerformed ? 'performed' : 'failed'}.`
          );
          // Emit a context continuity event for monitoring
          record.lastError = `context_continuity_violation:${validation.expectedHash}:${validation.actualHash}`;
        }
      } catch (err) {
        console.error(`[SubAgentManager] Failed to validate checkpoint for task ${task.taskId}:`, err);
      }
    }


    const latestRecord = this.state.records[task.subagentId];
    if (!latestRecord) {
      this.removeTaskFromQueue(task.parentKey, taskId);
      delete this.state.tasks[taskId];
      this.updateQueuePositions(task.parentKey);
      this.persistState();
      this.processAllQueues();
      return;
    }

    const canceledByUser = latestRecord.status === 'canceled' && latestRecord.lastError === 'cancel_requested';
    if (!canceledByUser) {
      latestRecord.status = output.status;
      latestRecord.queuePosition = undefined;
      latestRecord.updatedAt = nowIso();
      latestRecord.lastHeartbeatAt = latestRecord.updatedAt;
      latestRecord.lastError = output.error;
      latestRecord.latestResult = this.createResultPayload({
        record: latestRecord,
        status: output.status,
        summary: output.summary,
        artifacts: output.artifacts,
        finishReason: output.finishReason,
        usage: output.usage,
        error: output.error,
        startedAt: output.startedAt,
        completedAt: output.completedAt,
      });
    } else {
      latestRecord.queuePosition = undefined;
      latestRecord.updatedAt = nowIso();
      latestRecord.lastHeartbeatAt = latestRecord.updatedAt;
      if (!latestRecord.latestResult || latestRecord.latestResult.runSeq !== latestRecord.runSeq) {
        latestRecord.latestResult = this.createResultPayload({
          record: latestRecord,
          status: 'canceled',
          summary: 'Sub-agent canceled by request.',
          artifacts: output.artifacts,
          finishReason: output.finishReason,
          usage: output.usage,
          error: 'cancel_requested',
          startedAt: output.startedAt,
          completedAt: output.completedAt,
        });
      }
    }

    this.removeTaskFromQueue(task.parentKey, taskId);
    delete this.state.tasks[taskId];

    this.updateQueuePositions(task.parentKey);
    this.persistState();

    if (latestRecord.latestResult) {
      this.writeParentContextResult(latestRecord.parentContext, latestRecord.latestResult);
    }
    this.writeParentContextIndex(latestRecord.parentContext);
    this.resolveWaiters(latestRecord.id, latestRecord.runSeq);

    this.processAllQueues();
  }

  private touchHeartbeat(subagentId: string): void {
    const record = this.state.records[subagentId];
    if (!record || isTerminalStatus(record.status)) {
      return;
    }
    const current = nowIso();
    record.lastHeartbeatAt = current;
    record.updatedAt = current;
    this.markStateDirty();
  }

  private processParentQueue(parentKey: string): void {
    const queue = this.ensureQueue(parentKey);
    queue.runningTaskIds = queue.runningTaskIds.filter((taskId) => Boolean(this.state.tasks[taskId]));
    const startedTaskIds: string[] = [];
    const startedParentContexts: ContextRef[] = [];

    while (queue.queuedTaskIds.length > 0 && this.canStartMoreForParent(parentKey)) {
      const nextTaskId = queue.queuedTaskIds.shift();
      if (!nextTaskId) {
        continue;
      }
      const nextTask = this.state.tasks[nextTaskId];
      if (!nextTask) {
        continue;
      }

      queue.runningTaskIds.push(nextTaskId);
      const nextRecord = this.state.records[nextTask.subagentId];
      if (nextRecord) {
        nextRecord.status = 'running';
        nextRecord.queuePosition = undefined;
        const current = nowIso();
        nextRecord.updatedAt = current;
        nextRecord.lastHeartbeatAt = current;
      }
      if (!nextRecord) {
        this.executeTaskSchedulingError(nextTask, 'subagent_record_missing');
      } else {
        startedTaskIds.push(nextTaskId);
        startedParentContexts.push(nextRecord.parentContext);
      }
    }

    this.updateQueuePositions(parentKey);
    this.persistState();

    const indexed = new Set<string>();
    for (const context of startedParentContexts) {
      const key = this.contextKey(context);
      if (indexed.has(key)) {
        continue;
      }
      this.writeParentContextIndex(context);
      indexed.add(key);
    }
    for (const startedTaskId of startedTaskIds) {
      void this.executeTask(startedTaskId);
    }
  }

  private processAllQueues(): void {
    const parentKeys = Object.keys(this.state.queues);
    for (const parentKey of parentKeys) {
      if (this.getGlobalRunningCount() >= this.getGlobalMaxParallel()) {
        break;
      }
      this.processParentQueue(parentKey);
    }
  }

  private failRecordImmediately(record: SubAgentRecord, reason: string): void {
    record.status = 'failed';
    record.queuePosition = undefined;
    record.updatedAt = nowIso();
    record.lastHeartbeatAt = record.updatedAt;
    record.lastError = reason;
    record.latestResult = this.createResultPayload({
      record,
      status: 'failed',
      summary: `Sub-agent failed before execution: ${reason}`,
      artifacts: emptyArtifacts(),
      error: reason,
      startedAt: nowIso(),
      completedAt: nowIso(),
    });
    this.persistState();
    if (record.latestResult) {
      this.writeParentContextResult(record.parentContext, record.latestResult);
    }
    this.writeParentContextIndex(record.parentContext);
    this.resolveWaiters(record.id, record.runSeq);
  }

  private selectProviderId(input: {
    explicitProviderId?: string;
    fallbackProviderId?: string;
  }): { providerId: string; available: boolean } {
    const explicit = String(input.explicitProviderId ?? '').trim();
    if (explicit) {
      return { providerId: explicit, available: this.isProviderAvailable(explicit) };
    }

    const fallback = String(input.fallbackProviderId ?? '').trim();
    const providerId = fallback || 'local-default';
    return { providerId, available: this.isProviderAvailable(providerId) };
  }

  private isProviderAvailable(providerId: string): boolean {
    const normalized = providerId.trim();
    if (!normalized) {
      return false;
    }

    const providers = this.options.getProviderConfigs() ?? [];
    if (providers.length === 0 && normalized === 'local-default') {
      return true;
    }
    const matched = providers.find((item) => item.id === normalized);
    if (!matched) {
      return false;
    }
    return matched.enabled !== false;
  }

  private buildTask(input: {
    subagentId: string;
    operation: 'create' | 'resume';
    request: SubAgentCreateParams;
    workspaceDir: string;
    providerId: string;
    context: ContextRef;
    agentProfile?: SubAgentAssignedAgentProfile;
    parentKey: string;
    parentContext: ContextRef;
  }): SubAgentQueuedTask {
    const timeoutMs = this.normalizeTimeoutMs(input.request.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    return {
      taskId: this.generateTaskId(),
      subagentId: input.subagentId,
      parentKey: input.parentKey,
      parentContext: input.parentContext,
      subagentContext: input.context,
      operation: input.operation,
      prompt: String(input.request.prompt ?? '').trim(),
      agentName: String(input.request.agentName ?? '').trim() || undefined,
      agentProfile: input.agentProfile,
      providerId: input.providerId,
      allowedTools: this.resolveEffectiveAllowedTools(input.parentContext, input.workspaceDir, input.request.allowedTools),
      timeoutMs,
      workspaceDir: input.workspaceDir,
      createdAt: nowIso(),
    };
  }

  private resolveWorkspaceDir(value?: string): string {
    const workspace = String(value ?? '').trim();
    if (workspace.length > 0) {
      return workspace;
    }
    return this.options.getDefaultWorkspaceDir();
  }

  private resolveAvailableAgents(workspaceDir: string): AgentProfile[] {
    return resolveAgentPool({
      globalAgentsDir: this.options.getGlobalAgentsDir(),
      workspaceDir,
      includeWorkspace: true,
    });
  }

  private toAssignedAgent(profile: Pick<AgentProfile, 'name' | 'source' | 'description' | 'path' | 'mtime'>): SubAgentAssignedAgent {
    return {
      name: profile.name,
      source: profile.source,
      description: profile.description,
      path: profile.path,
      mtime: profile.mtime,
    };
  }

  private toAssignedAgentProfile(profile: AgentProfile): SubAgentAssignedAgentProfile {
    return {
      ...this.toAssignedAgent(profile),
      content: profile.content,
    };
  }

  private resolveAgentSelection(
    agentName: string | undefined,
    workspaceDir: string
  ): { ok: true; agent?: SubAgentAssignedAgent; profile?: SubAgentAssignedAgentProfile } | { ok: false; error: string } {
    const normalizedAgentName = String(agentName ?? '').trim();
    if (!normalizedAgentName) {
      return { ok: true };
    }
    const available = this.resolveAvailableAgents(workspaceDir);
    const matched = findAgentProfileByName(available, normalizedAgentName);
    if (!matched) {
      return {
        ok: false,
        error: `agent_not_found: ${normalizedAgentName}`,
      };
    }
    return {
      ok: true,
      agent: this.toAssignedAgent(matched),
      profile: this.toAssignedAgentProfile(matched),
    };
  }

  private toStatusPayload(record: SubAgentRecord): SubAgentStatus {
    const queue = this.ensureQueue(record.parentKey);
    const running = queue.runningTaskIds.some((taskId) => this.state.tasks[taskId]?.subagentId === record.id);
    const effectiveAllowedTools = this.resolveEffectiveAllowedTools(
      record.parentContext,
      record.workspaceDir,
      record.allowedTools
    );
    return {
      subagentId: record.id,
      parentContext: record.parentContext,
      context: record.context,
      status: record.status,
      runSeq: record.runSeq,
      agent: record.agent,
      queuePosition: record.queuePosition,
      queuedCount: queue.queuedTaskIds.length,
      running,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastHeartbeatAt: record.lastHeartbeatAt,
      latestResult: record.latestResult,
      lastError: record.lastError,
      prompt: record.prompt,
      providerId: record.providerId,
      allowedTools: record.allowedTools,
      effectiveAllowedTools,
      workspaceDir: record.workspaceDir,
    };
  }

  private createResultPayload(input: {
    record: SubAgentRecord;
    status: SubAgentLifecycleStatus;
    summary: string;
    artifacts: SubAgentArtifact;
    finishReason?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }): SubAgentResult {
    return {
      subagentId: input.record.id,
      runSeq: input.record.runSeq,
      status: input.status,
      summary: truncate(input.summary.trim() || '(empty summary)', 800),
      agent: input.record.agent,
      artifacts: {
        files: input.artifacts.files.slice(0, 20).map((value) => truncate(value, 260)),
        commands: input.artifacts.commands.slice(0, 20).map((value) => truncate(value, 260)),
        notes: input.artifacts.notes.slice(0, 20).map((value) => truncate(value, 260)),
      },
      finishReason: input.finishReason,
      usage: input.usage,
      error: input.error ? truncate(input.error, 420) : undefined,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    };
  }

  private writeParentContextResult(parentContext: ContextRef, result: SubAgentResult): void {
    const key = `subagent.${result.subagentId}.latest`;
    const value = JSON.stringify({
      subagentId: result.subagentId,
      runSeq: result.runSeq,
      status: result.status,
      summary: result.summary,
      agent: result.agent ?? null,
      artifacts: result.artifacts,
      finishReason: result.finishReason,
      error: result.error ?? null,
      startedAt: result.startedAt ?? null,
      completedAt: result.completedAt ?? null,
    });
    this.safeWriteContext(parentContext, key, value);
  }

  private writeParentContextIndex(parentContext: ContextRef): void {
    const parentKey = this.contextKey(parentContext);
    const entries = Object.values(this.state.records)
      .filter((record) => record.parentKey === parentKey)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30)
      .map((record) => ({
        subagentId: record.id,
        status: record.status,
        runSeq: record.runSeq,
        agent: record.agent ?? null,
        updatedAt: record.updatedAt,
        queuePosition: record.queuePosition ?? null,
        latestSummary: record.latestResult?.summary ?? null,
      }));

    const value = JSON.stringify({
      updatedAt: nowIso(),
      total: entries.length,
      subagents: entries,
    });
    this.safeWriteContext(parentContext, 'subagent.index', value);
  }

  private safeWriteContext(parentContext: ContextRef, key: string, value: string): void {
    try {
      this.options.contextManager.writeNow(parentContext, key, truncate(value, 8000));
    } catch {
      // ignore writeback errors to keep scheduler path stable
    }
  }

  private resolveWaiters(subagentId: string, runSeq: number): void {
    const waiters = this.waiters.get(subagentId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    const record = this.state.records[subagentId];
    if (!record || !record.latestResult || record.latestResult.runSeq !== runSeq || !isTerminalStatus(record.status)) {
      return;
    }

    const resolved: ResultWaiter[] = [];
    const kept: ResultWaiter[] = [];
    for (const waiter of waiters) {
      if (waiter.runSeq <= runSeq) {
        resolved.push(waiter);
      } else {
        kept.push(waiter);
      }
    }
    if (kept.length > 0) {
      this.waiters.set(subagentId, kept);
    } else {
      this.waiters.delete(subagentId);
    }

    const statusPayload = this.toStatusPayload(record);
    for (const waiter of resolved) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        status: statusPayload,
        result: record.latestResult,
      });
    }
  }

  private removeWaiter(subagentId: string, runSeq: number, resolver: ResultWaiter['resolve']): void {
    const waiters = this.waiters.get(subagentId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    const next = waiters.filter((waiter) => !(waiter.runSeq === runSeq && waiter.resolve === resolver));
    if (next.length > 0) {
      this.waiters.set(subagentId, next);
      return;
    }
    this.waiters.delete(subagentId);
  }

  private updateQueuePositions(parentKey: string): void {
    const queue = this.ensureQueue(parentKey);
    queue.runningTaskIds = queue.runningTaskIds.filter((taskId) => Boolean(this.state.tasks[taskId]));
    const queuedPositionMap = new Map<string, number>();
    for (let i = 0; i < queue.queuedTaskIds.length; i += 1) {
      const task = this.state.tasks[queue.queuedTaskIds[i]];
      if (!task) {
        continue;
      }
      if (!queuedPositionMap.has(task.subagentId)) {
        queuedPositionMap.set(task.subagentId, i + 1);
      }
    }

    const runningSubagentIds = new Set(
      queue.runningTaskIds
        .map((taskId) => this.state.tasks[taskId]?.subagentId)
        .filter((value): value is string => typeof value === 'string')
    );
    for (const record of Object.values(this.state.records)) {
      if (record.parentKey !== parentKey) {
        continue;
      }
      if (runningSubagentIds.has(record.id)) {
        record.queuePosition = undefined;
        continue;
      }
      if (record.status === 'queued') {
        record.queuePosition = queuedPositionMap.get(record.id);
      } else {
        record.queuePosition = undefined;
      }
    }
  }

  private getOwnedRecord(parentContext: ContextRef, subagentId: string): SubAgentRecord | undefined {
    const normalizedId = String(subagentId ?? '').trim();
    if (!normalizedId) {
      return undefined;
    }
    const record = this.state.records[normalizedId];
    if (!record) {
      return undefined;
    }
    const parentKey = this.contextKey(parentContext);
    if (record.parentKey !== parentKey) {
      return undefined;
    }
    return record;
  }

  private findPendingTaskIdBySubagent(subagentId: string): string | undefined {
    for (const [taskId, task] of Object.entries(this.state.tasks)) {
      if (task.subagentId === subagentId) {
        return taskId;
      }
    }
    return undefined;
  }

  private normalizeAllowedTools(allowedTools?: string[]): string[] | undefined {
    if (!allowedTools || allowedTools.length === 0) {
      return undefined;
    }
    const normalized = Array.from(
      new Set(
        allowedTools
          .map((value) => String(value ?? '').trim().toLowerCase())
          .filter((value) => value.length > 0 && value !== 'context_manage' && value !== 'subagent_manage')
      )
    );
    return normalized.length > 0 ? normalized : undefined;
  }

  private resolveEffectiveAllowedTools(
    parentContext: ContextRef,
    workspaceDir: string | undefined,
    allowedTools?: string[]
  ): string[] | undefined {
    const normalized = this.normalizeAllowedTools(allowedTools);
    const resolved = this.options.resolveAllowedTools?.({
      parentContext,
      workspaceDir,
      allowedTools: normalized,
    });
    if (resolved === undefined) {
      return normalized;
    }
    return Array.from(
      new Set(
        resolved
          .map((value) => String(value ?? '').trim().toLowerCase())
          .filter((value) => value.length > 0 && value !== 'context_manage' && value !== 'subagent_manage')
      )
    );
  }

  private normalizeTimeoutMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.floor(value);
    if (rounded <= 0) {
      return fallback;
    }
    return Math.min(rounded, 60 * 60 * 1000);
  }

  private normalizeContextRef(ref: ContextRef): ContextRef {
    const scope = ref.scope;
    if (scope !== 'session' && scope !== 'workspace' && scope !== 'global') {
      throw new Error(`Invalid context scope: ${String(scope)}`);
    }
    const namespace = String(ref.namespace ?? '').trim();
    if (!namespace) {
      throw new Error('context.namespace cannot be empty');
    }
    return { scope, namespace };
  }

  private contextKey(ref: ContextRef): string {
    const normalized = this.normalizeContextRef(ref);
    return `${normalized.scope}:${normalized.namespace}`;
  }

  private createSubAgentContextRef(parentContext: ContextRef, subagentId: string): ContextRef {
    return {
      scope: 'global',
      namespace: `sub:${parentContext.namespace}:${subagentId}`,
    };
  }

  private getMaxParallelPerParent(): number {
    return this.normalizePositiveInteger(this.options.getMaxParallelPerParent(), DEFAULT_MAX_PARALLEL_PER_PARENT);
  }

  private getGlobalMaxParallel(): number {
    return this.normalizePositiveInteger(this.options.getGlobalMaxParallel(), DEFAULT_GLOBAL_MAX_PARALLEL);
  }

  private normalizePositiveInteger(value: number, fallback: number): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    const normalized = Math.floor(value);
    if (normalized <= 0) {
      return fallback;
    }
    return normalized;
  }

  private canStartMoreForParent(parentKey: string): boolean {
    return (
      this.getParentRunningCount(parentKey) < this.getMaxParallelPerParent() &&
      this.getGlobalRunningCount() < this.getGlobalMaxParallel()
    );
  }

  private getParentRunningCount(parentKey: string): number {
    const queue = this.ensureQueue(parentKey);
    queue.runningTaskIds = queue.runningTaskIds.filter((taskId) => Boolean(this.state.tasks[taskId]));
    return queue.runningTaskIds.length;
  }

  private getGlobalRunningCount(): number {
    let count = 0;
    for (const queue of Object.values(this.state.queues)) {
      queue.runningTaskIds = queue.runningTaskIds.filter((taskId) => Boolean(this.state.tasks[taskId]));
      count += queue.runningTaskIds.length;
    }
    return count;
  }

  private removeTaskFromQueue(parentKey: string, taskId: string): void {
    const queue = this.ensureQueue(parentKey);
    queue.runningTaskIds = queue.runningTaskIds.filter((runningId) => runningId !== taskId);
    queue.queuedTaskIds = queue.queuedTaskIds.filter((queuedId) => queuedId !== taskId);
  }

  private markStateDirty(): void {
    this.stateDirty = true;
  }

  private flushDirtyState(): void {
    if (!this.stateDirty) {
      return;
    }
    this.persistState();
  }

  private ensureQueue(parentKey: string): ParentQueueState {
    const existing = this.state.queues[parentKey];
    if (existing) {
      existing.runningTaskIds = Array.isArray(existing.runningTaskIds) ? existing.runningTaskIds : [];
      existing.queuedTaskIds = Array.isArray(existing.queuedTaskIds) ? existing.queuedTaskIds : [];
      return existing;
    }
    const created: ParentQueueState = {
      runningTaskIds: [],
      queuedTaskIds: [],
    };
    this.state.queues[parentKey] = created;
    return created;
  }

  private persistState(): void {
    const dir = path.dirname(this.registryFilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.registryFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    this.stateDirty = false;
  }

  private loadState(): SubAgentRegistryState {
    if (!fs.existsSync(this.registryFilePath)) {
      return this.createEmptyState();
    }
    try {
      const raw = fs.readFileSync(this.registryFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!this.isValidLoadedState(parsed)) {
        this.resetRegistryFile();
        return this.createEmptyState();
      }
      return {
        version: REGISTRY_VERSION,
        records: parsed.records ?? {},
        tasks: parsed.tasks ?? {},
        queues: parsed.queues ?? {},
        retryQueue: parsed.retryQueue ?? [],
      };
    } catch {
      this.resetRegistryFile();
      return this.createEmptyState();
    }
  }

  private isValidLoadedState(value: unknown): value is SubAgentRegistryState {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const parsed = value as Partial<SubAgentRegistryState>;
    if (parsed.version !== REGISTRY_VERSION) {
      return false;
    }
    if (!parsed.records || typeof parsed.records !== 'object') {
      return false;
    }
    if (!parsed.tasks || typeof parsed.tasks !== 'object') {
      return false;
    }
    if (!parsed.queues || typeof parsed.queues !== 'object') {
      return false;
    }
    if (!Array.isArray(parsed.retryQueue)) {
      return false;
    }
    for (const queue of Object.values(parsed.queues)) {
      if (!queue || typeof queue !== 'object') {
        return false;
      }
      if (!Array.isArray((queue as Partial<ParentQueueState>).runningTaskIds)) {
        return false;
      }
      if (!Array.isArray((queue as Partial<ParentQueueState>).queuedTaskIds)) {
        return false;
      }
    }
    return true;
  }

  private resetRegistryFile(): void {
    try {
      fs.rmSync(this.registryFilePath, { force: true });
    } catch {
      // ignore hard-cut cleanup failures
    }
  }

  private createEmptyState(): SubAgentRegistryState {
    return {
      version: REGISTRY_VERSION,
      records: {},
      tasks: {},
      queues: {},
      retryQueue: [],
    };
  }

  private generateSubAgentId(): string {
    return `suba-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  }

  private generateTaskId(): string {
    return `subtask-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }
}



