import * as fs from 'fs';
import * as path from 'path';
import {
  findAgentProfileByName,
  isAgentProfileVisibleToSubagentManager,
  resolveAgentPool,
  toAgentProfileConfigView,
  type AgentProfile,
} from '../agents/AgentProfiles.js';
import { createStateId, JsonStateStore, nowIso } from '../storage/index.js';
import { intersectAllowedToolNames, normalizeAllowedToolNames } from '../tools/CapabilityCatalog.js';
import type {
  AgentProfileConfig,
  ContextRef,
  SubAgentAssignedAgent,
  SubAgentAssignedAgentProfile,
  SubAgentArtifact,
  SubAgentCreateParams,
  SubAgentLifecycleStatus,
  SubAgentResult,
  SubAgentStatus,
} from '../types.js';
import type {
  ParentQueueState,
  SubAgentExecutionOutput,
  SubAgentQueuedTask,
  SubAgentRecord,
  SubAgentRegistryState,
  SubAgentResumeRequest,
} from './types.js';
import {
  applySubAgentHeartbeat,
  applySubAgentRunningTransition,
  applySubAgentTerminalTransition,
  isTerminalSubAgentStatus as isTerminalStatus,
} from './SubAgentLifecycleReducer.js';
import { ManagedInterval, ManagedTimeout } from '../runtime/async-primitives.js';
import {
  DEFAULT_GLOBAL_MAX_PARALLEL,
  DEFAULT_MAX_PARALLEL_PER_PARENT,
  DEFAULT_RESULT_WAIT_TIMEOUT_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  HEARTBEAT_PERSIST_TICK_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_QUEUED_TASKS_PER_PARENT,
  REGISTRY_VERSION,
  type ResultWaiter,
  type SubAgentCreateOrResumeResult,
  type SubAgentManagerOptions,
  type WaitResult,
} from './subagent-manager-contracts.js';
import { emptyArtifacts, truncate } from './subagent-manager-utils.js';
import {
  createSubAgentContextRef,
  normalizeSubAgentContextRef,
  subAgentContextKey,
} from './subagent-context-utils.js';
import type { SubAgentProgressUpdate } from './SubAgentTurnRunner.js';
import { SubAgentTaskSettlementService } from './SubAgentTaskSettlementService.js';

export type { SubAgentManagerOptions } from './subagent-manager-contracts.js';

export class SubAgentManager {
  private readonly options: SubAgentManagerOptions;
  private readonly registryFilePath: string;
  private readonly waiters = new Map<string, ResultWaiter[]>();
  private readonly stateStore: JsonStateStore<SubAgentRegistryState>;
  private readonly state: SubAgentRegistryState;
  private readonly taskSettlementService: SubAgentTaskSettlementService;
  private readonly heartbeatPersistTimer = new ManagedInterval();
  private stateDirty = false;

  constructor(options: SubAgentManagerOptions) {
    this.options = options;
    this.registryFilePath = path.resolve(options.registryFilePath);
    this.stateStore = new JsonStateStore<SubAgentRegistryState>(this.registryFilePath, {
      defaultValue: () => this.createEmptyState(),
      validate: (value): value is SubAgentRegistryState => this.isValidLoadedState(value),
      parseErrorPolicy: 'fallback',
      onInvalid: (filePath) => {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // keep the hard-cut fallback non-fatal
        }
      },
    });
    this.state = this.loadState();
    this.taskSettlementService = new SubAgentTaskSettlementService({
      getState: () => this.state,
      removeTaskFromQueue: (parentKey, taskId) => this.removeTaskFromQueue(parentKey, taskId),
      updateQueuePositions: (parentKey) => this.updateQueuePositions(parentKey),
      persistState: () => this.persistState(),
      applyTerminalRecord: (input) => this.applyTerminalRecord(input),
      writeParentContextResult: (parentContext, result, parentTurnId) =>
        this.writeParentContextResult(parentContext, result, parentTurnId),
      writeParentContextIndex: (parentContext, parentTurnId) =>
        this.writeParentContextIndex(parentContext, parentTurnId),
      resolveWaiters: (subagentId, runSeq) => this.resolveWaiters(subagentId, runSeq),
      processAllQueues: () => this.processAllQueues(),
    });
    this.heartbeatPersistTimer.start(() => {
      this.flushDirtyState();
    }, HEARTBEAT_PERSIST_TICK_MS, { unref: true });
    this.markPendingTasksAsFailedOnStartup();
    this.reconcileStaleTasks();
  }

  shutdown(): void {
    this.heartbeatPersistTimer.clear();
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

    const parentTurnId = this.normalizeParentTurnId(request.parentTurnId);
    const parentContext = this.prepareParentSpawnContext(request.parentContext, parentTurnId);

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
    const queueFull = this.rejectIfParentQueueFull(parentKey);
    if (queueFull) {
      return queueFull;
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
      ...(parentTurnId ? { parentTurnId } : {}),
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
      agentProfile: selectedAgent.profile,
      agentConfig: selectedAgent.profile?.config,
      allowedTools: this.resolveEffectiveAllowedTools(
        parentContext,
        workspaceDir,
        this.resolveAgentAllowedTools(request.allowedTools, selectedAgent.profile?.config)
      ),
      timeoutMs: this.resolveTaskTimeoutMs(request.timeoutMs, selectedAgent.profile?.config),
      workspaceDir,
      queuePosition: undefined,
      latestResult: undefined,
      lastError: undefined,
      lifecycleDiagnostic: undefined,
    };
    this.state.records[subagentId] = record;

    const providerUnavailable = this.failIfProviderUnavailable(record, providerSelection);
    if (providerUnavailable) {
      return providerUnavailable;
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
      parentTurnId,
      workspaceDir,
    });
    return this.enqueueBuiltTaskAndReturnStatus(task, record, parentContext);
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

    const parentTurnId = this.normalizeParentTurnId(request.parentTurnId);
    const parentContext = this.prepareParentSpawnContext(request.parentContext, parentTurnId);

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

    const queueFull = this.rejectIfParentQueueFull(parentKey);
    if (queueFull) {
      return queueFull;
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
    record.lifecycleDiagnostic = undefined;
    record.agent = selectedAgent.agent;
    record.providerId = providerSelection.providerId;
    if (parentTurnId) {
      record.parentTurnId = parentTurnId;
    } else {
      delete record.parentTurnId;
    }
    record.prompt = prompt;
    record.agentName = selectedAgent.agent?.name;
    record.agentProfile = selectedAgent.profile;
    record.agentConfig = selectedAgent.profile?.config;
    record.allowedTools = this.resolveEffectiveAllowedTools(
      parentContext,
      workspaceDir,
      this.resolveAgentAllowedTools(request.allowedTools, selectedAgent.profile?.config)
    );
    record.timeoutMs = this.resolveTaskTimeoutMs(request.timeoutMs, selectedAgent.profile?.config);
    record.workspaceDir = workspaceDir;

    const providerUnavailable = this.failIfProviderUnavailable(record, providerSelection);
    if (providerUnavailable) {
      return providerUnavailable;
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
      parentTurnId,
      workspaceDir,
    });
    return this.enqueueBuiltTaskAndReturnStatus(task, record, parentContext);
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
      const result = this.applyTerminalRecord({
        record,
        status: 'canceled',
        summary: 'Sub-agent canceled by request.',
        artifacts: emptyArtifacts(),
        error: 'cancel_requested',
        startedAt: record.latestResult?.startedAt,
        completedAt: currentTime,
      });
      this.persistState();
      this.writeParentContextResult(record.parentContext, result, record.parentTurnId);
      this.writeParentContextIndex(record.parentContext, record.parentTurnId);
      this.resolveWaiters(record.id, record.runSeq);
      return this.toStatusPayload(record);
    }

    const queue = this.ensureQueue(record.parentKey);
    if (queue.runningTaskIds.includes(pendingTaskId)) {
      this.options.turnRunner.cancelTask(pendingTaskId);
      this.removeTaskFromQueue(record.parentKey, pendingTaskId);
      delete this.state.tasks[pendingTaskId];
      const result = this.applyTerminalRecord({
        record,
        status: 'canceled',
        summary: 'Sub-agent canceled by request.',
        artifacts: emptyArtifacts(),
        error: 'cancel_requested',
        startedAt: record.latestResult?.startedAt,
        completedAt: currentTime,
      });
      this.updateQueuePositions(record.parentKey);
      this.persistState();
      this.writeParentContextResult(record.parentContext, result, record.parentTurnId);
      this.writeParentContextIndex(record.parentContext, record.parentTurnId);
      this.resolveWaiters(record.id, record.runSeq);
      this.processAllQueues();
      return this.toStatusPayload(record);
    }

    const nextQueued = queue.queuedTaskIds.filter((taskId) => taskId !== pendingTaskId);
    queue.queuedTaskIds = nextQueued;
    delete this.state.tasks[pendingTaskId];

    const result = this.applyTerminalRecord({
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
    this.writeParentContextResult(record.parentContext, result, record.parentTurnId);
    this.writeParentContextIndex(record.parentContext, record.parentTurnId);
    this.resolveWaiters(record.id, record.runSeq);
    this.processAllQueues();

    return this.toStatusPayload(record);
  }

  cancelContext(parentContext: ContextRef): number {
    this.reconcileStaleTasks();
    const parentKey = this.contextKey(parentContext);
    const pendingSubagentIds = Object.values(this.state.records)
      .filter((record) => record.parentKey === parentKey)
      .filter((record) => !isTerminalStatus(record.status) || Boolean(this.findPendingTaskIdBySubagent(record.id)))
      .map((record) => record.id);

    let canceledCount = 0;
    for (const subagentId of pendingSubagentIds) {
      const beforeStatus = this.state.records[subagentId]?.status;
      const status = this.cancel(parentContext, subagentId);
      if (status && beforeStatus !== 'canceled') {
        canceledCount += 1;
      }
    }
    return canceledCount;
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
      const timer = new ManagedTimeout().start(() => {
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
      this.applyTerminalRecord({
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
          this.writeParentContextResult(context, record.latestResult, record.parentTurnId);
        }
      }
      this.writeParentContextIndex(context, this.resolvePendingParentTurnId(context));
    }
  }

  private reconcileStaleTasks(): void {
    const now = Date.now();
    const heartbeatStaleDiagnostic = `heartbeat_stale:${HEARTBEAT_TIMEOUT_MS}`;
    let changed = false;
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
      if (isTerminalStatus(record.status)) {
        continue;
      }
      if (record.lifecycleDiagnostic !== heartbeatStaleDiagnostic) {
        record.lifecycleDiagnostic = heartbeatStaleDiagnostic;
        record.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) {
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
    this.writeParentContextResult(record.parentContext, record.latestResult, record.parentTurnId);
    this.writeParentContextIndex(record.parentContext, record.parentTurnId);
    this.resolveWaiters(record.id, record.runSeq);
  }

  private enqueueTask(task: SubAgentQueuedTask, record: SubAgentRecord): void {
    const queue = this.ensureQueue(task.parentKey);
    const current = nowIso();
    record.updatedAt = current;
    record.lastHeartbeatAt = current;
    record.queuePosition = queue.queuedTaskIds.length + 1;
    record.lastError = undefined;
    record.lifecycleDiagnostic = undefined;
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
      this.taskSettlementService.settleMissingTask(task, taskId);
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
    if (!this.isParentTurnPending(task.parentTurnId ?? record.parentTurnId)) {
      try {
        checkpointResult = this.options.contextManager.createCheckpoint(
          task.parentContext,
          `subagent:${task.subagentId}:${task.operation}:runSeq${record.runSeq}`
        );
      } catch (err) {
        // Log but don't block task execution if checkpoint fails
        console.error(`[SubAgentManager] Failed to create checkpoint for task ${task.taskId}:`, err);
      }
    }

    let output: SubAgentExecutionOutput | undefined;

    try {
      output = await this.options.turnRunner.runTask(executionTask, (update) => {
        this.handleTaskProgress(task.subagentId, update);
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
    const latestRecord = this.state.records[task.subagentId];
    if (!latestRecord) {
      this.taskSettlementService.settleMissingTask(task, taskId);
      return;
    }
    const alreadyTerminal = isTerminalStatus(latestRecord.status) &&
      latestRecord.latestResult?.runSeq === latestRecord.runSeq;

    // REQ-0005: Validate context continuity after sub-agent execution
    // If validation fails, perform rollback to checkpoint state
    if (
      checkpointResult?.checkpoint &&
      shouldValidateContextContinuity &&
      output.status !== 'canceled' &&
      !alreadyTerminal &&
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
          latestRecord.lastError = `context_continuity_violation:${validation.expectedHash}:${validation.actualHash}`;
        }
      } catch (err) {
        console.error(`[SubAgentManager] Failed to validate checkpoint for task ${task.taskId}:`, err);
      }
    }

    this.taskSettlementService.settleCompletedTask({
      task,
      taskId,
      record: latestRecord,
      output,
      alreadyTerminal,
    });
  }

  private handleTaskProgress(subagentId: string, update?: SubAgentProgressUpdate): void {
    if (update?.type === 'timeout_warning' && update.timeoutWarning?.threshold === 1) {
      const timeoutMs = this.state.records[subagentId]?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
      this.touchHeartbeat(subagentId, {
        lifecycleDiagnostic: `task_deadline_exceeded:${timeoutMs}`,
      });
      return;
    }
    this.touchHeartbeat(subagentId);
  }

  private touchHeartbeat(subagentId: string, options?: { lifecycleDiagnostic?: string }): void {
    const record = this.state.records[subagentId];
    if (!record || isTerminalStatus(record.status)) {
      return;
    }
    const current = nowIso();
    applySubAgentHeartbeat(record, current);
    if (options?.lifecycleDiagnostic) {
      record.lifecycleDiagnostic = options.lifecycleDiagnostic;
    } else if (record.lifecycleDiagnostic?.startsWith('heartbeat_stale:')) {
      record.lifecycleDiagnostic = undefined;
    }
    this.markStateDirty();
  }

  private processParentQueue(parentKey: string): void {
    const queue = this.ensureQueue(parentKey);
    queue.runningTaskIds = queue.runningTaskIds.filter((taskId) => Boolean(this.state.tasks[taskId]));
    const startedTaskIds: string[] = [];
    const startedParentContexts: Array<{ context: ContextRef; parentTurnId?: string }> = [];

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
        const current = nowIso();
        applySubAgentRunningTransition(nextRecord, current);
      }
      if (!nextRecord) {
        this.executeTaskSchedulingError(nextTask, 'subagent_record_missing');
      } else {
        startedTaskIds.push(nextTaskId);
        startedParentContexts.push({
          context: nextRecord.parentContext,
          parentTurnId: nextTask.parentTurnId ?? nextRecord.parentTurnId,
        });
      }
    }

    this.updateQueuePositions(parentKey);
    this.persistState();

    const indexed = new Set<string>();
    for (const startedParent of startedParentContexts) {
      const context = startedParent.context;
      const key = this.contextKey(context);
      if (indexed.has(key)) {
        continue;
      }
      this.writeParentContextIndex(context, startedParent.parentTurnId);
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
    const now = nowIso();
    const result = this.applyTerminalRecord({
      record,
      status: 'failed',
      summary: `Sub-agent failed before execution: ${reason}`,
      artifacts: emptyArtifacts(),
      error: reason,
      startedAt: now,
      completedAt: now,
    });
    this.taskSettlementService.settleImmediateResult(record, result);
  }

  private failIfProviderUnavailable(
    record: SubAgentRecord,
    providerSelection: { providerId: string; available: boolean }
  ): SubAgentCreateOrResumeResult | null {
    if (providerSelection.available) {
      return null;
    }
    this.failRecordImmediately(record, `provider_unavailable:${providerSelection.providerId}`);
    return { ok: true, status: this.toStatusPayload(record) };
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

  private prepareParentSpawnContext(parentContext: ContextRef, parentTurnId?: string): ContextRef {
    const normalizedParentContext = this.normalizeContextRef(parentContext);
    this.warnOnParentContextIntegrityJump(normalizedParentContext);
    if (!this.isParentTurnPending(parentTurnId)) {
      this.createParentSpawnCheckpoint(normalizedParentContext);
    }
    return normalizedParentContext;
  }

  private warnOnParentContextIntegrityJump(parentContext: ContextRef): void {
    // REQ-0009: Context integrity check before subagent spawn
    const integrityCheck = this.options.contextManager.checkContextIntegrity(parentContext);
    if (integrityCheck.valid) {
      return;
    }
    const jumpWarning = integrityCheck.versionChain;
    const warnMsg = `[SubAgentManager] Context version jump detected for ${parentContext?.scope}/${parentContext?.namespace} :: ` +
      `jump from v${jumpWarning?.previousVersion} to v${jumpWarning?.currentVersion} (size: ${jumpWarning?.gapSize}). ` +
      `Subagent spawn may have stale context. Proceeding with warning.`;
    console.warn(warnMsg);
  }

  private createParentSpawnCheckpoint(parentContext: ContextRef): void {
    // REQ-0004: Create context checkpoint before sub-agent invocation
    try {
      const checkpointResult = this.options.contextManager.createCheckpoint(parentContext, 'subagent_create');
      console.info(`[SubAgentManager] Created checkpoint ${checkpointResult.checkpoint.checkpointId} before subagent spawn`);
    } catch (error) {
      const cpError = error instanceof Error ? error.message : String(error);
      console.warn(`[SubAgentManager] Failed to create checkpoint: ${cpError}. Proceeding without checkpoint.`);
    }
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
    parentTurnId?: string;
  }): SubAgentQueuedTask {
    const agentConfig = input.agentProfile?.config;
    const timeoutMs = this.resolveTaskTimeoutMs(input.request.timeoutMs, agentConfig);
    return {
      taskId: this.generateTaskId(),
      subagentId: input.subagentId,
      parentKey: input.parentKey,
      parentContext: input.parentContext,
      ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
      subagentContext: input.context,
      operation: input.operation,
      prompt: String(input.request.prompt ?? '').trim(),
      agentName: String(input.request.agentName ?? '').trim() || undefined,
      agentProfile: input.agentProfile,
      agentConfig,
      providerId: input.providerId,
      allowedTools: this.resolveEffectiveAllowedTools(
        input.parentContext,
        input.workspaceDir,
        this.resolveAgentAllowedTools(input.request.allowedTools, agentConfig)
      ),
      timeoutMs,
      workspaceDir: input.workspaceDir,
      createdAt: nowIso(),
    };
  }

  private enqueueBuiltTaskAndReturnStatus(
    task: SubAgentQueuedTask,
    record: SubAgentRecord,
    parentContext: ContextRef
  ): SubAgentCreateOrResumeResult {
    this.state.tasks[task.taskId] = task;
    this.enqueueTask(task, record);
    this.persistState();
    this.writeParentContextIndex(parentContext, task.parentTurnId ?? record.parentTurnId);
    this.processAllQueues();
    return { ok: true, status: this.toStatusPayload(record) };
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
    }).filter(isAgentProfileVisibleToSubagentManager);
  }

  private toAssignedAgent(
    profile: Pick<AgentProfile, 'name' | 'source' | 'description' | 'path' | 'mtime' | 'config' | 'configWarnings' | 'configPath'>
  ): SubAgentAssignedAgent {
    return {
      name: profile.name,
      source: profile.source,
      description: profile.description,
      path: profile.path,
      mtime: profile.mtime,
      config: toAgentProfileConfigView(profile.config, profile.configWarnings, profile.configPath),
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
    const effectiveAllowedTools = this.resolveEffectiveAllowedToolsForStatus(
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
      lifecycleDiagnostic: record.lifecycleDiagnostic,
      prompt: record.prompt,
      providerId: record.providerId,
      agentConfig: record.agentConfig,
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

  private applyTerminalRecord(input: {
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
    if (!isTerminalStatus(input.status)) {
      throw new Error(`subagent_non_terminal_result:${input.status}`);
    }
    const completedAt = input.completedAt ?? nowIso();
    const result = this.createResultPayload({
      record: input.record,
      status: input.status,
      summary: input.summary,
      artifacts: input.artifacts,
      finishReason: input.finishReason,
      usage: input.usage,
      error: input.error,
      startedAt: input.startedAt,
      completedAt,
    });
    applySubAgentTerminalTransition(input.record, {
      status: input.status as Extract<SubAgentLifecycleStatus, 'succeeded' | 'failed' | 'canceled' | 'timeout'>,
      nowIso: completedAt,
      error: input.error,
      result,
    });
    return result;
  }

  private writeParentContextResult(parentContext: ContextRef, result: SubAgentResult, parentTurnId?: string): void {
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
    this.safeWriteContext(
      parentContext,
      key,
      value,
      parentTurnId ?? this.state.records[result.subagentId]?.parentTurnId
    );
  }

  private writeParentContextIndex(parentContext: ContextRef, parentTurnId?: string): void {
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
    this.safeWriteContext(
      parentContext,
      'subagent.index',
      value,
      parentTurnId ?? this.resolvePendingParentTurnId(parentContext)
    );
  }

  private safeWriteContext(parentContext: ContextRef, key: string, value: string, parentTurnId?: string): void {
    try {
      const truncated = truncate(value, 8000);
      const pendingParentTurnId = this.resolvePendingParentTurnId(parentContext, parentTurnId);
      if (pendingParentTurnId) {
        this.options.contextManager.recordContextPatch(pendingParentTurnId, {
          op: 'set',
          key,
          value: truncated,
          source: 'subagent',
        });
        return;
      }
      this.options.contextManager.writeNow(parentContext, key, truncated);
    } catch {
      // ignore writeback errors to keep scheduler path stable
    }
  }

  private normalizeParentTurnId(turnId: string | null | undefined): string | undefined {
    const normalized = String(turnId ?? '').trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private isParentTurnPending(turnId: string | null | undefined): boolean {
    return this.options.contextManager.hasPendingTurn(this.normalizeParentTurnId(turnId));
  }

  private resolvePendingParentTurnId(parentContext: ContextRef, preferredTurnId?: string): string | undefined {
    const normalizedPreferred = this.normalizeParentTurnId(preferredTurnId);
    if (this.isParentTurnPending(normalizedPreferred)) {
      return normalizedPreferred;
    }
    const parentKey = this.contextKey(parentContext);
    const pendingRecord = Object.values(this.state.records)
      .filter((record) => record.parentKey === parentKey && this.isParentTurnPending(record.parentTurnId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return this.normalizeParentTurnId(pendingRecord?.parentTurnId);
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
      waiter.timer.clear();
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
    if (allowedTools === undefined) {
      return undefined;
    }
    return normalizeAllowedToolNames(allowedTools, { preserveEmpty: true });
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
      new Set(normalizeAllowedToolNames(resolved, { preserveEmpty: true }) ?? [])
    );
  }

  private resolveEffectiveAllowedToolsForStatus(
    parentContext: ContextRef,
    workspaceDir: string | undefined,
    allowedTools?: string[]
  ): string[] | undefined {
    try {
      return this.resolveEffectiveAllowedTools(parentContext, workspaceDir, allowedTools);
    } catch {
      return this.normalizeAllowedTools(allowedTools);
    }
  }

  private resolveAgentAllowedTools(
    requestAllowedTools: string[] | undefined,
    agentConfig: AgentProfileConfig | undefined
  ): string[] | undefined {
    void agentConfig;
    return intersectAllowedToolNames(requestAllowedTools, undefined, { preserveEmpty: true });
  }

  private resolveTaskTimeoutMs(value: number | undefined, agentConfig: AgentProfileConfig | undefined): number {
    void agentConfig;
    return this.normalizeTimeoutMs(value, DEFAULT_TASK_TIMEOUT_MS);
  }

  private normalizeTimeoutMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.floor(value);
    if (rounded <= 0) {
      return fallback;
    }
    return Math.min(rounded, DEFAULT_TASK_TIMEOUT_MS);
  }

  private normalizeContextRef(ref: ContextRef): ContextRef {
    return normalizeSubAgentContextRef(ref);
  }

  private contextKey(ref: ContextRef): string {
    return subAgentContextKey(ref);
  }

  private createSubAgentContextRef(parentContext: ContextRef, subagentId: string): ContextRef {
    return createSubAgentContextRef(parentContext, subagentId);
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

  private rejectIfParentQueueFull(parentKey: string): SubAgentCreateOrResumeResult | null {
    const queue = this.ensureQueue(parentKey);
    if (queue.queuedTaskIds.length < MAX_QUEUED_TASKS_PER_PARENT) {
      return null;
    }
    return {
      ok: false,
      code: 'queue_full',
      error: `queue_full: parent context already has ${MAX_QUEUED_TASKS_PER_PARENT} queued sub-agent tasks`,
    };
  }

  private persistState(): void {
    this.stateStore.write(this.state);
    this.stateDirty = false;
  }

  private loadState(): SubAgentRegistryState {
    const parsed = this.stateStore.read();
    return {
      version: REGISTRY_VERSION,
      records: parsed.records ?? {},
      tasks: parsed.tasks ?? {},
      queues: parsed.queues ?? {},
    };
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

  private createEmptyState(): SubAgentRegistryState {
    return {
      version: REGISTRY_VERSION,
      records: {},
      tasks: {},
      queues: {},
    };
  }

  private generateSubAgentId(): string {
    return createStateId('suba', 3);
  }

  private generateTaskId(): string {
    return createStateId('subtask', 4);
  }
}



