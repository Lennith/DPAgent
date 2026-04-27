import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { SubAgentManager } from '../../src/subagent/SubAgentManager.js';
import type { ContextRef, SubAgentLifecycleStatus, SubAgentProviderConfig } from '../../src/types.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask } from '../../src/subagent/types.js';
import type { SubAgentTurnRunner } from '../../src/subagent/SubAgentTurnRunner.js';

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

  async runTask(task: SubAgentQueuedTask): Promise<SubAgentExecutionOutput> {
    this.startedTaskIds.push(task.taskId);
    this.startedTasks.push({
      ...task,
      allowedTools: task.allowedTools ? [...task.allowedTools] : undefined,
    });
    return await new Promise<SubAgentExecutionOutput>((resolve) => {
      this.pendingResolvers.set(task.taskId, resolve);
    });
  }

  cancelTask(taskId: string): boolean {
    const resolver = this.pendingResolvers.get(taskId);
    if (!resolver) {
      return false;
    }
    this.pendingResolvers.delete(taskId);
    resolver({
      status: 'canceled',
      summary: 'Sub-agent canceled.',
      artifacts: { files: [], commands: [], notes: ['canceled'] },
      error: 'cancel_requested',
      startedAt: nowIso(),
      completedAt: nowIso(),
    });
    return true;
  }

  complete(taskId: string, status: SubAgentLifecycleStatus = 'succeeded', summary = 'done'): void {
    const resolver = this.pendingResolvers.get(taskId);
    if (!resolver) {
      throw new Error(`No pending task: ${taskId}`);
    }
    this.pendingResolvers.delete(taskId);
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
}

function createHarness(
  name: string,
  options?: {
    resolveAllowedTools?: (input: {
      parentContext: ContextRef;
      workspaceDir?: string;
      allowedTools?: string[];
    }) => string[] | undefined;
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
  const runner = new FakeRunner();
  const globalAgentsDir = path.join(tempDir, 'agents');
  fs.mkdirSync(path.join(globalAgentsDir, 'Coder'), { recursive: true });
  fs.writeFileSync(path.join(globalAgentsDir, 'Coder', 'AGENTS.md'), '# Coder\nFocus on coding.', 'utf-8');
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
    getMaxParallelPerParent: () => 4,
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

async function testListAgentsPool(): Promise<void> {
  const harness = createHarness('agents-pool');
  try {
    const agents = harness.manager.listAgents(harness.tempDir);
    assert.equal(agents.some((item) => item.name === 'Coder' && item.source === 'global'), true);
    assert.equal(agents.some((item) => item.name === 'workspace' && item.source === 'workspace'), true);
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

async function runAll(): Promise<void> {
  await testQueueAndFifo();
  await testResultWaitAndContextWriteback();
  await testCancelRunningAndQueued();
  await testProviderUnavailableFailsFast();
  await testListAgentsPool();
  await testGlobalParallelLimit();
  await testRegistryHardCut();
  await testCheckpointValidationDoesNotFalsePositive();
  await testQueuedTaskAllowedToolsRefreshAfterPolicyChange();
  console.log('subagent-manager tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});

