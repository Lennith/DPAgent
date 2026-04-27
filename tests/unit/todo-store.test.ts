import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TodoStore } from '../../src/todo/index.js';

function createHarness(): { tempDir: string; workspaceDir: string; store: TodoStore } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-store-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return {
    tempDir,
    workspaceDir,
    store: new TodoStore(path.join(tempDir, 'todos')),
  };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runAll(): void {
  const harness = createHarness();
  try {
    const planned = harness.store.setTodoPlan({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      items: [
        {
          work: 'Inspect current implementation',
          detectionStandard: 'Relevant files and current behavior are identified.',
          status: 'in_progress',
        },
        {
          work: 'Patch todo protocol',
          detectionStandard: 'Todo tool accepts plan_set and store state matches the new plan.',
          priority: 'high',
        },
      ],
      sourceSessionId: 'sess-1',
    });
    assert.equal(planned.length, 2);
    assert.equal(planned.filter((item) => item.status === 'in_progress').length, 1);
    assert.equal(planned[0]?.status, 'in_progress');
    const initialPlanIds = planned.map((item) => item.id);

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          items: [
            {
              work: 'First active item',
              detectionStandard: 'first',
              status: 'in_progress',
            },
            {
              work: 'Second active item',
              detectionStandard: 'second',
              status: 'in_progress',
            },
          ],
      }),
      /at most one in_progress/i
    );
    assert.deepEqual(
      harness.store
        .getProtocolState({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
        })
        .items.map((item) => item.id),
      initialPlanIds
    );

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          items: [
            {
              work: 'Blocked item without reason',
              detectionStandard: 'should fail',
              status: 'blocked',
            },
          ],
      }),
      /blockedReason/i
    );
    assert.deepEqual(
      harness.store
        .getProtocolState({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
        })
        .items.map((item) => item.id),
      initialPlanIds
    );

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          items: [
            {
              work: 'Completed item should be rejected',
              detectionStandard: 'should fail',
              status: 'completed',
            },
          ],
      }),
      /does not accept completed/i
    );
    assert.deepEqual(
      harness.store
        .getProtocolState({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
        })
        .items.map((item) => item.id),
      initialPlanIds
    );

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          items: [],
        }),
      /cannot clear unfinished todos/i
    );
    assert.deepEqual(
      harness.store
        .getProtocolState({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
        })
        .items.map((item) => item.id),
      initialPlanIds
    );

    const created = harness.store.createTodo({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      work: 'Review pending skill draft',
      detectionStandard: 'Confirm the draft is validated and decision is recorded.',
      priority: 'high',
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.work, 'Review pending skill draft');
    assert.equal(created.title, created.work);

    const updated = harness.store.updateTodo(created.id, {
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      status: 'in_progress',
    });
    assert.ok(updated);
    assert.equal(updated?.status, 'in_progress');

    const promptSegment = harness.store.getPromptSegment({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.match(promptSegment, /Todo Snapshot/);
    assert.match(promptSegment, /Review pending skill draft/);
    assert.match(promptSegment, /detection_standard=/i);

    assert.throws(
      () =>
        harness.store.updateTodo(created.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          status: 'completed',
        }),
      /completionTaskId and evidence/i
    );

    const completed = harness.store.updateTodo(created.id, {
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      status: 'completed',
      completionTaskId: 'task-1',
      evidence: ['validated in workspace', 'result recorded'],
    });
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.completionTaskId, 'task-1');
    assert.equal(completed?.evidence?.length, 2);
    assert.throws(
      () =>
        harness.store.updateTodo(created.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          status: 'completed',
          work: 'Rewrite while completing',
          completionTaskId: 'task-rewrite',
          evidence: ['should fail'],
        }),
      /completed todos are immutable once completion evidence is recorded/i
    );
    assert.throws(
      () =>
        harness.store.updateTodo(created.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          work: 'Rewritten after completion',
        }),
      /completed todos are immutable once completion evidence is recorded/i
    );
    assert.throws(
      () =>
        harness.store.updateTodo(created.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          status: 'completed',
          completionTaskId: 'task-2',
          evidence: ['replacement evidence'],
        }),
      /completed todos are immutable once completion evidence is recorded/i
    );
    assert.throws(
      () =>
        harness.store.updateTodo(created.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          status: 'pending',
        }),
      /completed todos are immutable once completion evidence is recorded/i
    );

    const blocked = harness.store.createTodo({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      work: 'Need user credentials',
      detectionStandard: 'Credentials are present and login succeeds.',
    });

    assert.throws(
      () =>
        harness.store.updateTodo(blocked.id, {
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          status: 'blocked',
        }),
      /blockedReason/i
    );

    const blockedUpdated = harness.store.updateTodo(blocked.id, {
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      status: 'blocked',
      blockedReason: 'Waiting for user to provide credentials.',
    });
    assert.equal(blockedUpdated?.blockedReason, 'Waiting for user to provide credentials.');

    const protocol = harness.store.getProtocolState({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(protocol.hasUnfinished, true);
    assert.equal(protocol.blockedItem?.id, blocked.id);
    assert.equal(protocol.completedItems.length, 1);

    const replanned = harness.store.setTodoPlan({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      items: [
        {
          work: 'Finalize release notes',
          detectionStandard: 'Release notes reflect the new protocol and review outcome.',
          status: 'in_progress',
        },
      ],
      sourceSessionId: 'sess-1',
    });
    assert.equal(replanned.length, 1);
    assert.equal(replanned[0]?.work, 'Finalize release notes');

    const replannedState = harness.store.getProtocolState({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(replannedState.completedItems.some((item) => item.id === created.id), true);
    assert.equal(replannedState.items.some((item) => item.id === blocked.id), false);

    const replannedCompleted = harness.store.updateTodo(replanned[0]!.id, {
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      status: 'completed',
      completionTaskId: 'task-2',
      evidence: ['release notes updated', 'review outcome recorded'],
    });
    assert.equal(replannedCompleted?.status, 'completed');

    const cleared = harness.store.setTodoPlan({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      items: [],
      sourceSessionId: 'sess-1',
    });
    assert.equal(cleared.length, 0);

    const clearedState = harness.store.getProtocolState({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(clearedState.hasUnfinished, false);
    assert.equal(clearedState.completedItems.length, 2);
    assert.equal(
      harness.store.clearCompletedTodos({
        sessionId: 'sess-1',
        workspaceDir: harness.workspaceDir,
      }),
      2
    );
    const clearedArchiveState = harness.store.getProtocolState({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(clearedArchiveState.items.length, 0);
    assert.equal(clearedArchiveState.completedItems.length, 0);

    const overflowHarness = createHarness();
    try {
      const archived = overflowHarness.store.createTodo({
        sessionId: 'overflow-sess',
        workspaceDir: overflowHarness.workspaceDir,
        work: 'Archive existing evidence',
        detectionStandard: 'Evidence is captured before replanning.',
      });
      overflowHarness.store.updateTodo(archived.id, {
        sessionId: 'overflow-sess',
        workspaceDir: overflowHarness.workspaceDir,
        status: 'completed',
        completionTaskId: 'overflow-task',
        evidence: ['archive created'],
      });
      assert.throws(
        () =>
          overflowHarness.store.setTodoPlan({
            sessionId: 'overflow-sess',
            workspaceDir: overflowHarness.workspaceDir,
            items: Array.from({ length: 128 }, (_, index) => ({
              work: `Overflow plan item ${index + 1}`,
              detectionStandard: `Overflow plan item ${index + 1} is captured.`,
            })),
            sourceSessionId: 'overflow-sess',
          }),
        /cannot evict completed history/i
      );
    } finally {
      cleanupHarness(overflowHarness.tempDir);
    }

    const legacyHarness = createHarness();
    try {
      const namespace = legacyHarness.store.resolveSessionNamespace('legacy-sess');
      const filePath = (legacyHarness.store as any).bucketFilePath('session', namespace.namespace) as string;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            scope: 'session',
            namespace: namespace.namespace,
            namespaceLabel: namespace.namespaceLabel,
            items: [
              {
                id: 'legacy-completed',
                scope: 'session',
                namespace: namespace.namespace,
                namespaceLabel: namespace.namespaceLabel,
                work: 'Legacy completed todo',
                detectionStandard: 'Legacy evidence should be repaired before replanning.',
                title: 'Legacy completed todo',
                details: 'Legacy evidence should be repaired before replanning.',
                status: 'completed',
                priority: 'medium',
                tags: [],
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          null,
          2
        ),
        'utf-8'
      );
      assert.throws(
        () =>
          legacyHarness.store.setTodoPlan({
            sessionId: 'legacy-sess',
            workspaceDir: legacyHarness.workspaceDir,
            items: [
              {
                work: 'Repair legacy completed evidence',
                detectionStandard: 'Legacy completed todos are repaired before replanning.',
              },
            ],
            sourceSessionId: 'legacy-sess',
          }),
        /missing completion evidence/i
      );
      assert.throws(
        () =>
          legacyHarness.store.clearCompletedTodos({
            sessionId: 'legacy-sess',
            workspaceDir: legacyHarness.workspaceDir,
          }),
        /missing completion evidence/i
      );
    } finally {
      cleanupHarness(legacyHarness.tempDir);
    }

    const addOverflowHarness = createHarness();
    try {
      const archived = addOverflowHarness.store.createTodo({
        sessionId: 'add-overflow-sess',
        workspaceDir: addOverflowHarness.workspaceDir,
        work: 'Keep completed evidence',
        detectionStandard: 'Completed evidence remains preserved.',
      });
      addOverflowHarness.store.updateTodo(archived.id, {
        sessionId: 'add-overflow-sess',
        workspaceDir: addOverflowHarness.workspaceDir,
        status: 'completed',
        completionTaskId: 'archived-task',
        evidence: ['completed evidence preserved'],
      });
      for (let index = 0; index < 127; index += 1) {
        addOverflowHarness.store.createTodo({
          sessionId: 'add-overflow-sess',
          workspaceDir: addOverflowHarness.workspaceDir,
          work: `Overflow add item ${index + 1}`,
          detectionStandard: `Overflow add item ${index + 1} is tracked.`,
        });
      }
      assert.throws(
        () =>
          addOverflowHarness.store.createTodo({
            sessionId: 'add-overflow-sess',
            workspaceDir: addOverflowHarness.workspaceDir,
            work: 'One item too many',
            detectionStandard: 'The store rejects silent history eviction.',
          }),
        /todo capacity reached/i
      );
      assert.equal(
        addOverflowHarness
          .store
          .getProtocolState({
            sessionId: 'add-overflow-sess',
            workspaceDir: addOverflowHarness.workspaceDir,
          })
          .completedItems.some((item) => item.id === archived.id),
        true
      );
    } finally {
      cleanupHarness(addOverflowHarness.tempDir);
    }

    console.log('todo-store tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
