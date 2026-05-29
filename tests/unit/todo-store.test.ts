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
      planId: 'plan-approved',
      items: [
        {
          work: 'Inspect current implementation',
          detectionStandard: 'Relevant files and current behavior are identified.',
          status: 'in_progress',
          planStepId: 'step-1',
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
    assert.equal(planned[0]?.planId, 'plan-approved');
    assert.equal(planned[0]?.planStepId, 'step-1');
    const initialPlanIds = planned.map((item) => item.id);

    const oldPlanForOverwrite = harness.store.setTodoPlan({
      sessionId: 'sess-overwrite',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-old',
      items: [
        {
          work: 'Old approved plan item',
          detectionStandard: 'Old plan item remains unfinished.',
          status: 'blocked',
          blockedReason: 'Waiting on old plan input.',
          planStepId: 'old-step',
        },
      ],
      sourceSessionId: 'sess-overwrite',
    })[0]!;
    const replacementPlan = harness.store.setTodoPlan({
      sessionId: 'sess-overwrite',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-new',
      items: [
        {
          work: 'Replacement approved plan item',
          detectionStandard: 'Replacement plan item becomes the only unfinished todo.',
          status: 'in_progress',
          planStepId: 'new-step',
        },
      ],
      sourceSessionId: 'sess-overwrite',
    });
    assert.equal(replacementPlan.length, 1);
    assert.equal(replacementPlan[0]?.work, 'Replacement approved plan item');
    assert.equal(replacementPlan[0]?.planId, 'plan-new');
    const overwriteState = harness.store.getProtocolState({
      sessionId: 'sess-overwrite',
      workspaceDir: harness.workspaceDir,
    });
    assert.deepEqual(overwriteState.unfinishedItems.map((item) => item.id), [replacementPlan[0]!.id]);
    assert.equal(overwriteState.items.some((item) => item.id === oldPlanForOverwrite.id), false);

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          planId: 'plan-approved',
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

    const blockedForDismiss = harness.store.setTodoPlan({
      sessionId: 'sess-dismiss',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-dismiss',
      items: [
        {
          work: 'Wait for external dependency',
          detectionStandard: 'External dependency is available.',
          status: 'blocked',
          blockedReason: 'External dependency is not ready.',
          planStepId: 'step-dismiss',
        },
      ],
      sourceSessionId: 'sess-dismiss',
    })[0]!;

    const dismissed = harness.store.dismissTodo(blockedForDismiss.id, {
      sessionId: 'sess-dismiss',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(dismissed?.status, 'dismissed');
    assert.equal(dismissed?.planId, 'plan-dismiss');
    assert.equal(dismissed?.planStepId, 'step-dismiss');
    assert.equal(dismissed?.blockedReason, 'External dependency is not ready.');
    const dismissedState = harness.store.getProtocolState({
      sessionId: 'sess-dismiss',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(dismissedState.hasUnfinished, false);
    assert.equal(dismissedState.blockedItem, null);
    assert.equal(dismissedState.unfinishedItems.length, 0);
    assert.equal(dismissedState.dismissedItems.length, 1);
    assert.doesNotMatch(
      harness.store.getPromptSegment({
        sessionId: 'sess-dismiss',
        workspaceDir: harness.workspaceDir,
      }),
      /Wait for external dependency/
    );
    const afterDismissReplan = harness.store.setTodoPlan({
      sessionId: 'sess-dismiss',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-dismiss-replacement',
      items: [
        {
          work: 'Replacement after dismissal',
          detectionStandard: 'Dismissed audit rows remain archived after replacement.',
        },
      ],
      sourceSessionId: 'sess-dismiss',
    });
    assert.equal(afterDismissReplan.length, 1);
    const afterDismissReplanState = harness.store.getProtocolState({
      sessionId: 'sess-dismiss',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(afterDismissReplanState.dismissedItems.some((item) => item.id === blockedForDismiss.id), true);

    const bulkDismissPlan = harness.store.setTodoPlan({
      sessionId: 'sess-bulk-dismiss',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-bulk-dismiss',
      items: [
        {
          work: 'Active bulk dismiss item',
          detectionStandard: 'Active item is dismissed by user cleanup.',
          status: 'in_progress',
          planStepId: 'bulk-active',
        },
        {
          work: 'Pending bulk dismiss item',
          detectionStandard: 'Pending item is dismissed by user cleanup.',
          status: 'pending',
          planStepId: 'bulk-pending',
        },
        {
          work: 'Blocked bulk dismiss item',
          detectionStandard: 'Blocked item is dismissed by user cleanup.',
          status: 'blocked',
          blockedReason: 'Stopped by user before blocker resolution.',
          planStepId: 'bulk-blocked',
        },
      ],
      sourceSessionId: 'sess-bulk-dismiss',
    });
    const completedBeforeBulkDismiss = harness.store.updateTodo(bulkDismissPlan[1]!.id, {
      sessionId: 'sess-bulk-dismiss',
      workspaceDir: harness.workspaceDir,
      status: 'completed',
      completionTaskId: bulkDismissPlan[1]!.id,
      evidence: ['pending item completed before cleanup'],
    });
    assert.equal(completedBeforeBulkDismiss?.status, 'completed');
    const bulkDismissed = harness.store.dismissUnfinishedTodos({
      sessionId: 'sess-bulk-dismiss',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(bulkDismissed.length, 2);
    assert.deepEqual(
      bulkDismissed.map((item) => item.status),
      ['dismissed', 'dismissed']
    );
    assert.equal(bulkDismissed.every((item) => item.planId === 'plan-bulk-dismiss'), true);
    const bulkDismissState = harness.store.getProtocolState({
      sessionId: 'sess-bulk-dismiss',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(bulkDismissState.hasUnfinished, false);
    assert.equal(bulkDismissState.unfinishedItems.length, 0);
    assert.equal(bulkDismissState.dismissedItems.length, 2);
    assert.equal(bulkDismissState.completedItems.length, 1);
    assert.equal(
      bulkDismissState.completedItems.some((item) => item.id === completedBeforeBulkDismiss?.id),
      true
    );
    assert.equal(
      harness.store.dismissUnfinishedTodos({
        sessionId: 'sess-bulk-dismiss',
        workspaceDir: harness.workspaceDir,
      }).length,
      0
    );

    const corruptCleanupHarness = createHarness();
    try {
      const bucketDir = path.join(corruptCleanupHarness.tempDir, 'todos', 'buckets', 'session');
      fs.mkdirSync(bucketDir, { recursive: true });
      fs.writeFileSync(
        path.join(bucketDir, 'cleanup-corrupt-sess.json'),
        JSON.stringify(
          {
            scope: 'session',
            namespace: 'cleanup-corrupt-sess',
            namespaceLabel: 'cleanup-corrupt-sess',
            items: [
              {
                id: 'todo-corrupt-completed',
                work: 'Corrupt completed row',
                detectionStandard: 'This row has no completion evidence.',
                status: 'completed',
                priority: 'medium',
                tags: [],
                createdAt: '2026-04-30T00:00:00.000Z',
                updatedAt: '2026-04-30T00:00:00.000Z',
              },
              {
                id: 'todo-cleanup-pending',
                work: 'Pending cleanup row',
                detectionStandard: 'This row should be dismissed.',
                status: 'pending',
                priority: 'medium',
                tags: [],
                createdAt: '2026-04-30T00:00:00.000Z',
                updatedAt: '2026-04-30T00:00:00.000Z',
              },
            ],
          },
          null,
          2
        ),
        'utf-8'
      );
      const dismissed = corruptCleanupHarness.store.dismissUnfinishedTodos({
        sessionId: 'cleanup-corrupt-sess',
        workspaceDir: corruptCleanupHarness.workspaceDir,
      });
      assert.deepEqual(dismissed.map((item) => item.id), ['todo-cleanup-pending']);
      const archived = corruptCleanupHarness.store.listTodos({
        sessionId: 'cleanup-corrupt-sess',
        workspaceDir: corruptCleanupHarness.workspaceDir,
        includeCompleted: true,
      });
      assert.equal(archived.find((item) => item.id === 'todo-corrupt-completed')?.status, 'completed');
      assert.equal(archived.find((item) => item.id === 'todo-cleanup-pending')?.status, 'dismissed');
    } finally {
      cleanupHarness(corruptCleanupHarness.tempDir);
    }

    const blockedForResume = harness.store.setTodoPlan({
      sessionId: 'sess-resume',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-resume',
      items: [
        {
          work: 'Retry after user fixes credentials',
          detectionStandard: 'Credential-dependent verification succeeds.',
          status: 'blocked',
          blockedReason: 'Missing credential.',
          planStepId: 'step-resume',
        },
      ],
      sourceSessionId: 'sess-resume',
    })[0]!;
    const resumed = harness.store.resumeTodo(blockedForResume.id, {
      sessionId: 'sess-resume',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(resumed?.status, 'pending');
    assert.equal(resumed?.blockedReason, undefined);
    assert.equal(resumed?.planId, 'plan-resume');
    assert.equal(resumed?.planStepId, 'step-resume');
    const resumedState = harness.store.getProtocolState({
      sessionId: 'sess-resume',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(resumedState.hasUnfinished, true);
    assert.equal(resumedState.pendingItems[0]?.id, blockedForResume.id);

    assert.throws(
      () =>
        harness.store.setTodoPlan({
          sessionId: 'sess-1',
          workspaceDir: harness.workspaceDir,
          planId: 'plan-approved',
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
          planId: 'plan-approved',
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
          planId: 'plan-approved',
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
      work: 'Review release checklist update',
      detectionStandard: 'Confirm the checklist is validated and decision is recorded.',
      priority: 'high',
      planId: 'plan-approved',
      planStepId: 'step\nreview',
    });
    assert.equal(created.status, 'pending');
    assert.equal(created.work, 'Review release checklist update');
    assert.equal('title' in created, false);
    assert.equal('details' in created, false);
    assert.equal(created.planStepId, 'step-review');
    const persistedCreatedBucket = JSON.parse(
      fs.readFileSync((harness.store as any).bucketFilePath('session', 'sess-1') as string, 'utf-8')
    ) as { items: Array<Record<string, unknown>> };
    const persistedCreated = persistedCreatedBucket.items.find((item) => item.id === created.id);
    assert.ok(persistedCreated);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedCreated, 'title'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persistedCreated, 'details'), false);

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
    assert.match(promptSegment, /approved_plan_id=plan-approved/);
    assert.match(promptSegment, /Review release checklist update/);
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
      planId: 'plan-approved',
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

    const unboundReplacementHarness = createHarness();
    try {
      const oldUnbound = unboundReplacementHarness.store.createTodo({
        sessionId: 'sess-unbound-overwrite',
        workspaceDir: unboundReplacementHarness.workspaceDir,
        work: 'Old unbound task',
        detectionStandard: 'Old unbound task remains unfinished.',
      });
      const planReplacement = unboundReplacementHarness.store.setTodoPlan({
        sessionId: 'sess-unbound-overwrite',
        workspaceDir: unboundReplacementHarness.workspaceDir,
        planId: 'plan-replacement',
        items: [
          {
            work: 'New plan replaces unbound queue',
            detectionStandard: 'The new plan is the only unfinished queue.',
            status: 'in_progress',
          },
        ],
        sourceSessionId: 'sess-unbound-overwrite',
      });
      const planReplacementState = unboundReplacementHarness.store.getProtocolState({
        sessionId: 'sess-unbound-overwrite',
        workspaceDir: unboundReplacementHarness.workspaceDir,
      });
      assert.equal(planReplacement.length, 1);
      assert.equal(planReplacement[0]?.planId, 'plan-replacement');
      assert.equal(planReplacementState.items.some((item) => item.id === oldUnbound.id), false);
      assert.deepEqual(planReplacementState.unfinishedItems.map((item) => item.id), [planReplacement[0]!.id]);
    } finally {
      cleanupHarness(unboundReplacementHarness.tempDir);
    }

    harness.store.updateTodo(blocked.id, {
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      status: 'completed',
      completionTaskId: blocked.id,
      evidence: ['credentials blocker was resolved outside the approved plan'],
    });

    const replanned = harness.store.setTodoPlan({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      planId: 'plan-approved',
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
    assert.equal(replannedState.completedItems.some((item) => item.id === blocked.id), true);

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
      planId: 'plan-approved',
      items: [],
      sourceSessionId: 'sess-1',
    });
    assert.equal(cleared.length, 0);

    const clearedState = harness.store.getProtocolState({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(clearedState.hasUnfinished, false);
    assert.equal(clearedState.completedItems.length, 3);
    assert.equal(
      harness.store.clearCompletedTodos({
        sessionId: 'sess-1',
        workspaceDir: harness.workspaceDir,
      }),
      3
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
        /cannot evict terminal history/i
      );
    } finally {
      cleanupHarness(overflowHarness.tempDir);
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

    const mixedAddHarness = createHarness();
    try {
      mixedAddHarness.store.createTodo({
        sessionId: 'mixed-add-sess',
        workspaceDir: mixedAddHarness.workspaceDir,
        work: 'Existing unbound work',
        detectionStandard: 'Existing unbound work remains unfinished.',
      });
      assert.throws(
        () =>
          mixedAddHarness.store.createTodo({
            sessionId: 'mixed-add-sess',
            workspaceDir: mixedAddHarness.workspaceDir,
            work: 'Approved plan correction',
            detectionStandard: 'Plan correction is tracked under the approved plan.',
            planId: 'plan-approved',
          }),
        /cannot mix active-plan todos and unbound todos/i
      );
    } finally {
      cleanupHarness(mixedAddHarness.tempDir);
    }

    const corruptCompletedHarness = createHarness();
    try {
      const bucketDir = path.join(corruptCompletedHarness.tempDir, 'todos', 'buckets', 'session');
      fs.mkdirSync(bucketDir, { recursive: true });
      fs.writeFileSync(
        path.join(bucketDir, 'corrupt-mix-sess.json'),
        JSON.stringify(
          {
            scope: 'session',
            namespace: 'corrupt-mix-sess',
            namespaceLabel: 'corrupt-mix-sess',
            items: [
              {
                id: 'todo-corrupt-completed',
                work: 'Corrupt completed row',
                detectionStandard: 'This row has no completion evidence.',
                status: 'completed',
                priority: 'medium',
                tags: [],
                createdAt: '2026-04-30T00:00:00.000Z',
                updatedAt: '2026-04-30T00:00:00.000Z',
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
          corruptCompletedHarness.store.createTodo({
            sessionId: 'corrupt-mix-sess',
            workspaceDir: corruptCompletedHarness.workspaceDir,
            work: 'Approved plan work',
            detectionStandard: 'The add must not mix with the incomplete completed row.',
            planId: 'plan-approved',
          }),
        /cannot mix active-plan todos and unbound todos/i
      );
    } finally {
      cleanupHarness(corruptCompletedHarness.tempDir);
    }

    console.log('todo-store tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
