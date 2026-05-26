import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { SubAgentManager } from '../../src/subagent/SubAgentManager.js';
import { DEFAULT_TASK_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS, REGISTRY_VERSION } from '../../src/subagent/subagent-manager-contracts.js';
import type { ContextRef, SubAgentLifecycleStatus, SubAgentProviderConfig } from '../../src/types.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask } from '../../src/subagent/types.js';
import type { SubAgentProgressUpdate, SubAgentTurnRunner } from '../../src/subagent/SubAgentTurnRunner.js';

function nowIso(): string {
  return new Date().toISOString();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await wait(10);
  }
}

class FakeRunner {
  public startedTaskIds: string[] = [];
  public startedTasks: SubAgentQueuedTask[] = [];
  private pendingResolvers = new Map<string, (output: SubAgentExecutionOutput) => void>();
  private progressCallbacks = new Map<string, (update: SubAgentProgressUpdate) => void>();
  constructor(private readonly resolveOnCancel = true) {}

  async runTask(
    task: SubAgentQueuedTask,
    onProgress?: (update: SubAgentProgressUpdate) => void
  ): Promise<SubAgentExecutionOutput> {
    this.startedTaskIds.push(task.taskId);
    this.startedTasks.push({
      ...task,
      allowedTools: task.allowedTools ? [...task.allowedTools] : undefined,
    });
    if (onProgress) {
      this.progressCallbacks.set(task.taskId, onProgress);
      onProgress({
        type: 'heartbeat',
        timestamp: nowIso(),
        elapsedMs: 0,
      });
    }
    return await new Promise<SubAgentExecutionOutput>((resolve) => {
      this.pendingResolvers.set(task.taskId, resolve);
    });
  }

  cancelTask(taskId: string): boolean {
    const resolver = this.pendingResolvers.get(taskId);
    if (!resolver) {
      return false;
    }
    if (this.resolveOnCancel) {
      this.pendingResolvers.delete(taskId);
      this.progressCallbacks.delete(taskId);
      resolver({
        status: 'canceled',
        summary: 'Sub-agent canceled.',
        artifacts: { files: [], commands: [], notes: ['canceled'] },
        error: 'cancel_requested',
        startedAt: nowIso(),
        completedAt: nowIso(),
      });
    }
    return true;
  }

  complete(taskId: string, status: SubAgentLifecycleStatus = 'succeeded', summary = 'done'): void {
    const resolver = this.pendingResolvers.get(taskId);
    if (!resolver) {
      throw new Error(`No pending task: ${taskId}`);
    }
    this.pendingResolvers.delete(taskId);
    this.progressCallbacks.delete(taskId);
    resolver({
      status,
      summary,
      artifacts: {
        files: ['workspace/result.txt'],
        commands: ['echo done'],
        notes: ['ok'],
      },
      startedAt: nowIso(),
      completedAt: nowIso(),
    });
  }

  emitDeadlineWarning(taskId: string, timeoutMs: number): void {
    const callback = this.progressCallbacks.get(taskId);
    if (!callback) {
      throw new Error(`No progress callback: ${taskId}`);
    }
    callback({
      type: 'timeout_warning',
      timestamp: nowIso(),
      elapsedMs: timeoutMs,
      timeoutWarning: {
        threshold: 1,
        elapsedMs: timeoutMs,
        message: 'deadline exceeded but still running',
      },
    });
  }
}

function createHarness(
  name: string,
  options?: {
    resolveAllowedTools?: (input: {
      parentContext: ContextRef;
      workspaceDir?: string;
      allowedTools?: string[];
    }) => string[] | undefined;
    resolveOnCancel?: boolean;
    maxParallelPerParent?: number;
  }
): {
  tempDir: string;
  parent: ContextRef;
  contextManager: ContextManager;
  runner: FakeRunner;
  manager: SubAgentManager;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `subagent-test-${name}-`));
  const contextDir = path.join(tempDir, 'contexts');
  const eventStore = new ContextEventStore(contextDir);
  const contextManager = new ContextManager(eventStore);
  const runner = new FakeRunner(options?.resolveOnCancel);
  const globalAgentsDir = path.join(tempDir, 'agents');
  fs.mkdirSync(path.join(globalAgentsDir, 'Coder'), { recursive: true });
  fs.writeFileSync(path.join(globalAgentsDir, 'Coder', 'AGENTS.md'), '# Coder\nFocus on coding.', 'utf-8');
  fs.writeFileSync(path.join(globalAgentsDir, 'Coder', 'agent.yaml'), 'version: 1\nexposeAsSubagent: true\n', 'utf-8');
  fs.mkdirSync(path.join(globalAgentsDir, 'Hidden'), { recursive: true });
  fs.writeFileSync(path.join(globalAgentsDir, 'Hidden', 'AGENTS.md'), '# Hidden\nNot exposed.', 'utf-8');
  fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Workspace\nUse workspace conventions.', 'utf-8');
  const providers: SubAgentProviderConfig[] = [
    {
      id: 'local-default',
      type: 'local',
      enabled: true,
    },
  ];

  const manager = new SubAgentManager({
    contextManager,
    turnRunner: runner as unknown as SubAgentTurnRunner,
    registryFilePath: path.join(tempDir, 'subagent_registry.json'),
    getDefaultWorkspaceDir: () => tempDir,
    getProviderConfigs: () => providers,
    getGlobalAgentsDir: () => globalAgentsDir,
    getMaxParallelPerParent: () => options?.maxParallelPerParent ?? 4,
    getGlobalMaxParallel: () => 10,
    resolveAllowedTools: options?.resolveAllowedTools,
  });

  return {
    tempDir,
    parent: { scope: 'session', namespace: 'parent-session' },
    contextManager,
    runner,
    manager,
  };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function testQueueAndFifo(): Promise<void> {
  const harness = createHarness('fifo');
  try {
    const created = Array.from({ length: 8 }, (_, idx) =>
      harness.manager.create({
        parentContext: harness.parent,
        prompt: `task-${idx + 1}`,
      })
    );

    for (let i = 0; i < 7; i += 1) {
      assert.equal(created[i]?.ok, true);
    }
    assert.equal(created[7]?.ok, false);
    if (!created[7]?.ok) {
      assert.equal(created[7].code, 'queue_full');
    }

    assert.equal(harness.runner.startedTaskIds.length, 4);

    for (let i = 0; i < 4; i += 1) {
      const item = created[i];
      assert.equal(item?.ok, true);
      if (!item?.ok) {
        continue;
      }
      const status = harness.manager.getStatus(harness.parent, item.status.subagentId);
      assert.equal(status?.status, 'running');
    }

    for (let i = 4; i < 7; i += 1) {
      const item = created[i];
      assert.equal(item?.ok, true);
      if (!item?.ok) {
        continue;
      }
      const status = harness.manager.getStatus(harness.parent, item.status.subagentId);
      assert.equal(status?.status, 'queued');
    }

    const initialRunning = harness.runner.startedTaskIds.slice(0, 4);
    for (let i = 0; i < initialRunning.length; i += 1) {
      harness.runner.complete(initialRunning[i], 'succeeded', `initial-${i}`);
    }
    await waitFor(() => harness.runner.startedTaskIds.length === 7);

    for (let i = 4; i < 7; i += 1) {
      harness.runner.complete(harness.runner.startedTaskIds[i], 'succeeded', `queued-${i}`);
    }
    await waitFor(() =>
      created.every((item) => !item?.ok || harness.manager.getStatus(harness.parent, item.status.subagentId)?.status === 'succeeded')
    );
    for (const item of created) {
      if (!item?.ok) {
        continue;
      }
      assert.doesNotMatch(
        harness.manager.getStatus(harness.parent, item.status.subagentId)?.lastError ?? '',
        /context_continuity_violation/
      );
    }
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testResultWaitAndContextWriteback(): Promise<void> {
  const harness = createHarness('result');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'please do work',
      agentName: 'Coder',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }

    const subagentId = created.status.subagentId;
    const firstTaskId = harness.runner.startedTaskIds[0];
    const waitPromise = harness.manager.getResult(harness.parent, subagentId, {
      wait: true,
      timeoutMs: 1500,
    });

    await wait(50);
    harness.runner.complete(firstTaskId, 'succeeded', 'completed with artifacts');

    const waited = await waitPromise;
    assert.ok(waited);
    assert.equal(waited?.timedOut, undefined);
    assert.equal(waited?.result?.status, 'succeeded');

    const projection = harness.contextManager.getProjection(harness.parent);
    const latestKey = `subagent.${subagentId}.latest`;
    assert.ok(projection.keyValues[latestKey]);
    assert.ok(projection.keyValues['subagent.index']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testParentPendingTurnBuffersSubagentWriteback(): Promise<void> {
  const harness = createHarness('parent-pending');
  try {
    const parentTurn = harness.contextManager.beginTurn(harness.parent, 'parent prompt');
    const created = harness.manager.create({
      parentContext: harness.parent,
      parentTurnId: parentTurn.turnId,
      prompt: 'please do work before parent commit',
      agentName: 'Coder',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    assert.equal(harness.contextManager.getEventStore().readEvents(harness.parent.scope, harness.parent.namespace).length, 0);

    const subagentId = created.status.subagentId;
    const firstTaskId = harness.runner.startedTaskIds[0];
    harness.runner.complete(firstTaskId, 'succeeded', 'completed while parent pending');

    await waitFor(() => harness.manager.getStatus(harness.parent, subagentId)?.status === 'succeeded');
    assert.equal(harness.contextManager.getEventStore().readEvents(harness.parent.scope, harness.parent.namespace).length, 0);

    harness.contextManager.commitTurn(parentTurn.turnId, {
      messages: [
        { role: 'user', content: 'parent prompt' },
        { role: 'assistant', content: 'parent complete' },
      ],
      finishReason: 'end_turn',
    });

    const projection = harness.contextManager.getProjection(harness.parent);
    const latestKey = `subagent.${subagentId}.latest`;
    assert.ok(projection.keyValues[latestKey]);
    assert.ok(projection.keyValues['subagent.index']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testParentCommittedTurnUsesImmediateSubagentWriteback(): Promise<void> {
  const harness = createHarness('parent-committed');
  try {
    const parentTurn = harness.contextManager.beginTurn(harness.parent, 'parent prompt');
    harness.contextManager.commitTurn(parentTurn.turnId, {
      messages: [
        { role: 'user', content: 'parent prompt' },
        { role: 'assistant', content: 'parent complete' },
      ],
      finishReason: 'end_turn',
    });
    const baseEventCount = harness.contextManager.getEventStore().readEvents(
      harness.parent.scope,
      harness.parent.namespace
    ).length;

    const created = harness.manager.create({
      parentContext: harness.parent,
      parentTurnId: parentTurn.turnId,
      prompt: 'please do work after parent commit',
      agentName: 'Coder',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const afterCreateEventCount = harness.contextManager.getEventStore().readEvents(
      harness.parent.scope,
      harness.parent.namespace
    ).length;
    assert.ok(afterCreateEventCount > baseEventCount);

    const subagentId = created.status.subagentId;
    harness.runner.complete(harness.runner.startedTaskIds[0], 'succeeded', 'completed after parent commit');
    await waitFor(() => harness.manager.getStatus(harness.parent, subagentId)?.status === 'succeeded');

    const projection = harness.contextManager.getProjection(harness.parent);
    const latestKey = `subagent.${subagentId}.latest`;
    assert.ok(projection.keyValues[latestKey]);
    assert.ok(projection.keyValues['subagent.index']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testDefaultTimeoutAndWaitTimeoutDoNotMutateLifecycle(): Promise<void> {
  const harness = createHarness('timeouts');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'long running work',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    assert.equal(created.status.status, 'running');
    assert.equal(harness.runner.startedTasks[0]?.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);

    const waited = await harness.manager.getResult(harness.parent, created.status.subagentId, {
      wait: true,
      timeoutMs: 20,
    });
    assert.equal(waited?.timedOut, true);
    assert.equal(waited?.status.status, 'running');
    assert.equal(harness.manager.getStatus(harness.parent, created.status.subagentId)?.status, 'running');

    harness.runner.complete(harness.runner.startedTaskIds[0]!, 'succeeded', 'completed after wait timeout');
    await waitFor(() => harness.manager.getStatus(harness.parent, created.status.subagentId)?.status === 'succeeded');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testAgentYamlConfigIsFrozenIntoTask(): Promise<void> {
  const harness = createHarness('agent-config', {
    resolveAllowedTools: ({ allowedTools }) => allowedTools,
  });
  try {
    fs.writeFileSync(
      path.join(harness.tempDir, 'agents', 'Coder', 'agent.yaml'),
      [
        'version: 1',
        'exposeAsSubagent: true',
        'llmProfileId: kimi',
        'llmModel: kimi-child-model',
        'reasoningPreset: medium',
        'toolsetName: windows-safe',
        'allowedTools:',
        '  - read_file',
        '  - grep',
        'timeoutMs: 12345',
        'maxSteps: 9',
        'promptAppend: |',
        '  Extra child prompt.',
      ].join('\n'),
      'utf-8'
    );
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'configured work',
      agentName: 'Coder',
      allowedTools: ['read_file', 'write_file'],
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const task = harness.runner.startedTasks[0];
    assert.equal(task?.agentConfig?.llmProfileId, 'kimi');
    assert.equal(task?.agentConfig?.llmModel, 'kimi-child-model');
    assert.equal(task?.agentConfig?.reasoningPreset, 'medium');
    assert.equal(task?.agentConfig?.promptAppend, 'Extra child prompt.');
    assert.equal(task?.agentConfig?.toolsetName, 'windows-safe');
    assert.deepEqual(task?.agentConfig?.allowedTools, ['read_file', 'grep']);
    assert.equal(task?.agentConfig?.timeoutMs, 12345);
    assert.equal(task?.agentConfig?.maxSteps, 9);
    assert.equal(created.status.agentConfig?.toolsetName, 'windows-safe');
    assert.equal(task?.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    assert.deepEqual(task?.allowedTools, ['read_file', 'write_file']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testExplicitTimeoutOverridesAgentYamlTimeout(): Promise<void> {
  const harness = createHarness('agent-timeout-override');
  try {
    fs.writeFileSync(
      path.join(harness.tempDir, 'agents', 'Coder', 'agent.yaml'),
      ['version: 1', 'exposeAsSubagent: true', 'timeoutMs: 30000'].join('\n'),
      'utf-8'
    );
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'configured work',
      agentName: 'Coder',
      timeoutMs: 2500,
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    assert.equal(harness.runner.startedTasks[0]?.timeoutMs, 2500);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testRetryQueueIsHistoricalAndDoesNotAutoRetry(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-retry-profile-'));
  try {
    const contextDir = path.join(tempDir, 'contexts');
    const eventStore = new ContextEventStore(contextDir);
    const contextManager = new ContextManager(eventStore);
    const runner = new FakeRunner();
    const parent: ContextRef = { scope: 'session', namespace: 'parent-session' };
    const parentKey = 'session:parent-session';
    const agentPath = path.join(tempDir, 'agents', 'Coder', 'AGENTS.md');
    const registryPath = path.join(tempDir, 'subagent_registry.json');
    const agentProfile = {
      name: 'Coder',
      source: 'global' as const,
      description: 'Coding specialist.',
      path: agentPath,
      mtime: 1,
      content: '# Coder\nCoding specialist.',
      config: {
        loadGlobalSkills: false,
        llmModel: 'kimi-child-model',
      },
    };
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    fs.writeFileSync(agentPath, agentProfile.content, 'utf-8');
    fs.writeFileSync(
      registryPath,
      JSON.stringify(
        {
          version: REGISTRY_VERSION,
          records: {},
          tasks: {},
          queues: {},
          retryQueue: [
            {
              subagentId: 'failed-1',
              parentContext: parent,
              parentKey,
              operation: 'create',
              prompt: 'retry configured work',
              providerId: 'local-default',
              agentName: 'Coder',
              agentProfile,
              agentConfig: agentProfile.config,
              allowedTools: ['read_file'],
              timeoutMs: 1234,
              workspaceDir: tempDir,
              retryCount: 1,
              lastFailedAt: new Date(Date.now() - 60_000).toISOString(),
              failureReason: 'transport',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const manager = new SubAgentManager({
      contextManager,
      turnRunner: runner as unknown as SubAgentTurnRunner,
      registryFilePath: registryPath,
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => [{ id: 'local-default', type: 'local', enabled: true }],
      getGlobalAgentsDir: () => path.join(tempDir, 'agents'),
      getMaxParallelPerParent: () => 4,
      getGlobalMaxParallel: () => 10,
    });
    try {
      const state = (manager as unknown as {
        state: {
          records: Record<string, { agentProfile?: typeof agentProfile }>;
          tasks: Record<string, SubAgentQueuedTask>;
        };
      }).state;
      assert.equal(Object.keys(state.tasks).length, 0);
      assert.equal(Object.keys(state.records).length, 0);
      assert.equal(Object.prototype.hasOwnProperty.call(state, 'retryQueue'), false);
    } finally {
      manager.shutdown();
    }
  } finally {
    cleanupHarness(tempDir);
  }
}

async function testHeartbeatStaleIsDiagnosticOnly(): Promise<void> {
  const harness = createHarness('heartbeat-stale');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'stale heartbeat work',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const record = (harness.manager as unknown as { state: { records: Record<string, { lastHeartbeatAt?: string }> } })
      .state.records[created.status.subagentId];
    assert.ok(record);
    record.lastHeartbeatAt = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS - 1000).toISOString();

    const status = harness.manager.getStatus(harness.parent, created.status.subagentId);
    assert.equal(status?.status, 'running');
    assert.equal(status?.running, true);
    assert.equal(status?.lifecycleDiagnostic, `heartbeat_stale:${HEARTBEAT_TIMEOUT_MS}`);
    assert.equal(harness.runner.startedTaskIds.length, 1);

    harness.runner.complete(harness.runner.startedTaskIds[0]!, 'succeeded', 'completed despite stale heartbeat');
    await waitFor(() => harness.manager.getStatus(harness.parent, created.status.subagentId)?.status === 'succeeded');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testTaskDeadlineDiagnosticDoesNotCancel(): Promise<void> {
  const harness = createHarness('deadline-diagnostic');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'long task',
      timeoutMs: 2500,
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const taskId = harness.runner.startedTaskIds[0]!;
    harness.runner.emitDeadlineWarning(taskId, 2500);

    const status = harness.manager.getStatus(harness.parent, created.status.subagentId);
    assert.equal(status?.status, 'running');
    assert.equal(status?.running, true);
    assert.equal(status?.lifecycleDiagnostic, 'task_deadline_exceeded:2500');

    harness.runner.complete(taskId, 'succeeded', 'completed after advisory deadline');
    await waitFor(() => harness.manager.getStatus(harness.parent, created.status.subagentId)?.status === 'succeeded');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testCancelRunningAndQueued(): Promise<void> {
  const harness = createHarness('cancel');
  try {
    const created = Array.from({ length: 5 }, (_, idx) =>
      harness.manager.create({
        parentContext: harness.parent,
        prompt: `cancel-task-${idx + 1}`,
      })
    );
    for (const item of created) {
      assert.equal(item.ok, true);
    }
    const [first, , , , queued] = created;
    if (!first?.ok || !queued?.ok) {
      return;
    }

    const cancelQueued = harness.manager.cancel(harness.parent, queued.status.subagentId);
    assert.equal(cancelQueued?.status, 'canceled');

    const cancelRunning = harness.manager.cancel(harness.parent, first.status.subagentId);
    assert.equal(cancelRunning?.status, 'canceled');

    const result = await harness.manager.getResult(harness.parent, first.status.subagentId, {
      wait: false,
    });
    assert.equal(result?.status.status, 'canceled');
    assert.equal(result?.result?.status, 'canceled');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testCancelContextCancelsRunningAndQueuedSubagents(): Promise<void> {
  const harness = createHarness('cancel-context', { maxParallelPerParent: 1 });
  try {
    const first = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'running',
    });
    const second = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'queued',
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }

    const canceledCount = harness.manager.cancelContext(harness.parent);
    assert.equal(canceledCount, 2);
    assert.equal(harness.manager.getStatus(harness.parent, first.status.subagentId)?.status, 'canceled');
    assert.equal(harness.manager.getStatus(harness.parent, second.status.subagentId)?.status, 'canceled');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testCancelRunningReleasesConcurrencySlotBeforeRunnerSettles(): Promise<void> {
  const harness = createHarness('cancel-release-slot', {
    maxParallelPerParent: 1,
    resolveOnCancel: false,
  });
  try {
    const first = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'running',
    });
    const second = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'queued',
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }

    const firstTaskId = harness.runner.startedTaskIds[0]!;
    const canceled = harness.manager.cancel(harness.parent, first.status.subagentId);
    assert.equal(canceled?.status, 'canceled');
    assert.equal(canceled?.running, false);

    await waitFor(() => harness.runner.startedTaskIds.length === 2);
    assert.equal(harness.manager.getStatus(harness.parent, second.status.subagentId)?.status, 'running');

    harness.runner.complete(firstTaskId, 'succeeded', 'late output from canceled task');
    await wait(50);
    assert.equal(harness.manager.getStatus(harness.parent, first.status.subagentId)?.status, 'canceled');
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testLateOutputDoesNotOverwriteTerminalCancel(): Promise<void> {
  const harness = createHarness('late-cancel', { resolveOnCancel: false });
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'cancel and ignore late output',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const subagentId = created.status.subagentId;
    const taskId = harness.runner.startedTaskIds[0]!;
    const canceled = harness.manager.cancel(harness.parent, subagentId);
    assert.equal(canceled?.status, 'canceled');

    let validationCalls = 0;
    const originalValidateCheckpoint = harness.contextManager.validateCheckpoint.bind(harness.contextManager);
    harness.contextManager.validateCheckpoint = ((...args: Parameters<ContextManager['validateCheckpoint']>) => {
      validationCalls += 1;
      return originalValidateCheckpoint(...args);
    }) as ContextManager['validateCheckpoint'];
    harness.runner.complete(taskId, 'succeeded', 'late success should not win');
    await wait(50);
    const finalStatus = harness.manager.getStatus(harness.parent, subagentId);
    assert.equal(finalStatus?.status, 'canceled');
    assert.equal(finalStatus?.latestResult?.status, 'canceled');
    assert.equal(finalStatus?.latestResult?.summary, 'Sub-agent canceled by request.');
    assert.equal(validationCalls, 0);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testProviderUnavailableFailsFast(): Promise<void> {
  const harness = createHarness('provider');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'use unavailable provider',
      providerId: 'missing-provider',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    assert.equal(created.status.status, 'failed');
    assert.ok(created.status.lastError?.includes('provider_unavailable'));
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testResumeProviderUnavailableFailsFastWithoutTask(): Promise<void> {
  const harness = createHarness('resume-provider');
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'initial task',
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const initialTaskId = harness.runner.startedTaskIds[0]!;
    harness.runner.complete(initialTaskId, 'succeeded', 'initial done');
    await waitFor(() => harness.manager.getStatus(harness.parent, created.status.subagentId)?.status === 'succeeded');

    const resumed = harness.manager.resume({
      parentContext: harness.parent,
      subagentId: created.status.subagentId,
      prompt: 'resume with unavailable provider',
      providerId: 'missing-provider',
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) {
      return;
    }
    assert.equal(resumed.status.status, 'failed');
    assert.equal(resumed.status.runSeq, 2);
    assert.equal(resumed.status.providerId, 'missing-provider');
    assert.equal(resumed.status.lastError, 'provider_unavailable:missing-provider');
    assert.equal(harness.runner.startedTaskIds.length, 1);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testListAgentsPool(): Promise<void> {
  const harness = createHarness('agents-pool');
  try {
    const agents = harness.manager.listAgents(harness.tempDir);
    assert.equal(agents.some((item) => item.name === 'Coder' && item.source === 'global'), true);
    assert.equal(agents.some((item) => item.name === 'Hidden'), false);
    assert.equal(agents.some((item) => item.name === 'workspace' && item.source === 'workspace'), true);
    assert.equal(agents.some((item) => item.name === 'coding' && item.source === 'bundled'), true);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testGlobalParallelLimit(): Promise<void> {
  const harness = createHarness('global');
  try {
    const parentA: ContextRef = { scope: 'session', namespace: 'parent-a' };
    const parentB: ContextRef = { scope: 'session', namespace: 'parent-b' };
    const parentC: ContextRef = { scope: 'session', namespace: 'parent-c' };

    for (const parent of [parentA, parentB, parentC]) {
      for (let i = 0; i < 4; i += 1) {
        const created = harness.manager.create({
          parentContext: parent,
          prompt: `${parent.namespace}-task-${i + 1}`,
        });
        assert.equal(created.ok, true);
      }
    }

    assert.equal(harness.runner.startedTaskIds.length, 10);

    const cItems = harness.manager.list(parentC);
    const cRunning = cItems.filter((item) => item.status === 'running').length;
    const cQueued = cItems.filter((item) => item.status === 'queued').length;
    assert.equal(cRunning, 2);
    assert.equal(cQueued, 2);

    const firstTask = harness.runner.startedTaskIds[0];
    harness.runner.complete(firstTask, 'succeeded', 'release one global slot');
    await waitFor(() => harness.runner.startedTaskIds.length === 11);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testRegistryHardCut(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-hardcut-'));
  try {
    const contextDir = path.join(tempDir, 'contexts');
    const eventStore = new ContextEventStore(contextDir);
    const contextManager = new ContextManager(eventStore);
    const runner = new FakeRunner();
    const registryPath = path.join(tempDir, 'subagent_registry.json');
    fs.writeFileSync(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          records: {},
          tasks: {},
          queues: {},
        },
        null,
        2
      ),
      'utf-8'
    );
    const manager = new SubAgentManager({
      contextManager,
      turnRunner: runner as unknown as SubAgentTurnRunner,
      registryFilePath: registryPath,
      getDefaultWorkspaceDir: () => tempDir,
      getProviderConfigs: () => [{ id: 'local-default', type: 'local', enabled: true }],
      getGlobalAgentsDir: () => path.join(tempDir, 'agents'),
      getMaxParallelPerParent: () => 4,
      getGlobalMaxParallel: () => 10,
    });

    assert.equal(fs.existsSync(registryPath), false);
    manager.shutdown();
  } finally {
    cleanupHarness(tempDir);
  }
}

async function testCheckpointValidationDoesNotFalsePositive(): Promise<void> {
  const harness = createHarness('checkpoint');
  try {
    const checkpoint = harness.contextManager.createCheckpoint(harness.parent, 'unit-checkpoint').checkpoint;
    const cleanValidation = harness.contextManager.validateCheckpoint(harness.parent, checkpoint, false);
    assert.equal(cleanValidation.valid, true);
    assert.equal(cleanValidation.rollbackPerformed, false);

    harness.contextManager.writeNow(harness.parent, 'checkpoint.test', 'changed');
    const changedValidation = harness.contextManager.validateCheckpoint(harness.parent, checkpoint, true);
    assert.equal(changedValidation.valid, false);
    assert.equal(changedValidation.rollbackPerformed, true);
    assert.equal(harness.contextManager.getProjection(harness.parent).keyValues['checkpoint.test'], undefined);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testQueuedTaskAllowedToolsRefreshAfterPolicyChange(): Promise<void> {
  let activeTools = ['read_file', 'memory_manage'];
  const harness = createHarness('tool-drift', {
    resolveAllowedTools: ({ allowedTools }) => {
      const next = allowedTools ?? activeTools;
      return next.filter((tool) => activeTools.includes(tool));
    },
  });
  try {
    const created = Array.from({ length: 5 }, (_, idx) =>
      harness.manager.create({
        parentContext: harness.parent,
        prompt: `policy-task-${idx + 1}`,
        allowedTools: ['read_file', 'memory_manage'],
      })
    );
    for (const item of created) {
      assert.equal(item.ok, true);
    }
    const queued = created[4];
    if (!queued?.ok) {
      return;
    }

    assert.deepEqual(harness.manager.getStatus(harness.parent, queued.status.subagentId)?.allowedTools, [
      'read_file',
      'memory_manage',
    ]);
    assert.deepEqual(harness.manager.getStatus(harness.parent, queued.status.subagentId)?.effectiveAllowedTools, [
      'read_file',
      'memory_manage',
    ]);

    activeTools = ['read_file'];
    assert.deepEqual(harness.manager.getStatus(harness.parent, queued.status.subagentId)?.allowedTools, [
      'read_file',
      'memory_manage',
    ]);
    assert.deepEqual(harness.manager.getStatus(harness.parent, queued.status.subagentId)?.effectiveAllowedTools, [
      'read_file',
    ]);

    for (const taskId of harness.runner.startedTaskIds.slice(0, 4)) {
      harness.runner.complete(taskId, 'succeeded', 'policy-updated');
    }
    await waitFor(() => harness.runner.startedTasks.length >= 5);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.tempDir, 'subagent_registry.json'), 'utf-8')
    ) as { tasks?: Record<string, { allowedTools?: string[] }> };
    assert.deepEqual(persisted.tasks?.[harness.runner.startedTaskIds[4] ?? '']?.allowedTools, [
      'read_file',
      'memory_manage',
    ]);
    assert.deepEqual(harness.runner.startedTasks[4]?.allowedTools, ['read_file']);
  } finally {
    harness.manager.shutdown();
    cleanupHarness(harness.tempDir);
  }
}

async function testListFallsBackToPersistedAllowedToolsWhenResolverUnavailable(): Promise<void> {
  const harness = createHarness('offline-list', {
    resolveAllowedTools: ({ allowedTools }) => allowedTools,
  });
  try {
    const created = harness.manager.create({
      parentContext: harness.parent,
      prompt: 'offline status',
      allowedTools: ['read_file', 'memory_manage'],
    });
    assert.equal(created.ok, true);
    harness.manager.shutdown();

    const offlineManager = new SubAgentManager({
      contextManager: harness.contextManager,
      turnRunner: harness.runner as unknown as SubAgentTurnRunner,
      registryFilePath: path.join(harness.tempDir, 'subagent_registry.json'),
      getDefaultWorkspaceDir: () => harness.tempDir,
      getProviderConfigs: () => [{ id: 'local-default', type: 'local', enabled: true }],
      getGlobalAgentsDir: () => path.join(harness.tempDir, 'agents'),
      getMaxParallelPerParent: () => 4,
      getGlobalMaxParallel: () => 10,
      resolveAllowedTools: () => {
        throw new Error('Tool registry not initialized');
      },
    });
    try {
      const items = offlineManager.list(harness.parent);
      assert.equal(items.length, 1);
      assert.deepEqual(items[0]?.allowedTools, ['read_file', 'memory_manage']);
      assert.deepEqual(items[0]?.effectiveAllowedTools, ['read_file', 'memory_manage']);
    } finally {
      offlineManager.shutdown();
    }
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testQueueAndFifo();
  await testResultWaitAndContextWriteback();
  await testParentPendingTurnBuffersSubagentWriteback();
  await testParentCommittedTurnUsesImmediateSubagentWriteback();
  await testDefaultTimeoutAndWaitTimeoutDoNotMutateLifecycle();
  await testAgentYamlConfigIsFrozenIntoTask();
  await testExplicitTimeoutOverridesAgentYamlTimeout();
  await testRetryQueueIsHistoricalAndDoesNotAutoRetry();
  await testHeartbeatStaleIsDiagnosticOnly();
  await testTaskDeadlineDiagnosticDoesNotCancel();
  await testCancelRunningAndQueued();
  await testCancelContextCancelsRunningAndQueuedSubagents();
  await testCancelRunningReleasesConcurrencySlotBeforeRunnerSettles();
  await testLateOutputDoesNotOverwriteTerminalCancel();
  await testProviderUnavailableFailsFast();
  await testResumeProviderUnavailableFailsFastWithoutTask();
  await testListAgentsPool();
  await testGlobalParallelLimit();
  await testRegistryHardCut();
  await testCheckpointValidationDoesNotFalsePositive();
  await testQueuedTaskAllowedToolsRefreshAfterPolicyChange();
  await testListFallsBackToPersistedAllowedToolsWhenResolverUnavailable();
  console.log('subagent-manager tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});

