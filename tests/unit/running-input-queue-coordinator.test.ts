import * as assert from 'node:assert/strict';
import { RunningInputQueueCoordinator } from '../../src/web/server/running-input-queue-coordinator.js';

function testQueuedItemsAreConsumedFifoOneTurnAtATime(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };

  const first = coordinator.enqueue({ context, runId: 'run-1', prompt: 'first queued turn' });
  const second = coordinator.enqueue({ context, runId: 'run-1', prompt: 'second queued turn' });

  assert.equal(coordinator.peekNext(context)?.id, first.id);
  assert.equal(coordinator.dequeueNext(context)?.id, first.id);
  assert.equal(coordinator.peekNext(context)?.id, second.id);
  assert.equal(coordinator.dequeueNext(context)?.id, second.id);
  assert.equal(coordinator.peekNext(context), null);
}

function testInsertRequestConsumesOnlyMatchingRun(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };
  const queued = coordinator.enqueue({ context, runId: 'run-1', prompt: 'insert this turn' });

  assert.equal(coordinator.requestInsert({ context, runId: 'run-2', itemId: queued.id })?.status, 'insert_requested');
  assert.equal(coordinator.requestInsert({ context, runId: 'run-1', itemId: queued.id }), null);

  const insertion = coordinator.consumeInsert(context, 'run-1');
  assert.equal(insertion, null);
  assert.deepEqual(coordinator.consumeInsert(context, 'run-2'), {
    itemId: queued.id,
    prompt: 'insert this turn',
  });
  assert.deepEqual(coordinator.list(context), []);
}

function testInsertRequestIsReleasedWhenRunEndsWithoutInsertion(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };
  const queued = coordinator.enqueue({ context, runId: 'run-1', prompt: 'wait for next turn' });

  coordinator.requestInsert({ context, runId: 'run-1', itemId: queued.id });
  assert.equal(coordinator.hasQueued(context), false);
  assert.equal(coordinator.releaseInsertRequestsForRun(context, 'run-1'), true);
  assert.equal(coordinator.hasQueued(context), true);
  assert.equal(coordinator.list(context)[0]?.insertRequestedAt, undefined);
}

function testQueuedItemCanBeRemovedBeforeItRuns(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };
  const queued = coordinator.enqueue({ context, runId: 'run-1', prompt: 'edit me later' });

  assert.equal(coordinator.remove(context, queued.id)?.prompt, 'edit me later');
  assert.equal(coordinator.remove(context, queued.id), null);
  assert.deepEqual(coordinator.list(context), []);
}

function testQueuedItemPreservesFileReferences(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };
  const queued = coordinator.enqueue({
    context,
    runId: 'run-1',
    prompt: 'read this',
    fileReferences: ['D:\\repo\\a.txt'],
  });

  assert.deepEqual(queued.fileReferences, ['D:\\repo\\a.txt']);
  assert.deepEqual(coordinator.dequeueNext(context)?.fileReferences, ['D:\\repo\\a.txt']);
}

function testDequeuedItemCanBeRequeuedAtFrontOnPrepareFailure(): void {
  const coordinator = new RunningInputQueueCoordinator();
  const context = { scope: 'session' as const, namespace: 'sess-1' };
  const first = coordinator.enqueue({ context, runId: 'run-1', prompt: 'first' });
  const second = coordinator.enqueue({ context, runId: 'run-1', prompt: 'second' });
  const dequeued = coordinator.dequeueNext(context);

  assert.equal(dequeued?.id, first.id);
  coordinator.requeueFront(context, dequeued!);
  assert.equal(coordinator.dequeueNext(context)?.id, first.id);
  assert.equal(coordinator.dequeueNext(context)?.id, second.id);
}

testQueuedItemsAreConsumedFifoOneTurnAtATime();
testInsertRequestConsumesOnlyMatchingRun();
testInsertRequestIsReleasedWhenRunEndsWithoutInsertion();
testQueuedItemCanBeRemovedBeforeItRuns();
testQueuedItemPreservesFileReferences();
testDequeuedItemCanBeRequeuedAtFrontOnPrepareFailure();

console.log('running-input-queue-coordinator test passed');
