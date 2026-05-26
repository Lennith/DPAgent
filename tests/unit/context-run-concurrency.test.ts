import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore } from '../../src/context/ContextEventStore.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import {
  isContextEventVersionConflictError,
  parseContextEventVersionConflictError,
} from '../../src/shared/context-version-conflict.js';
import type { Message } from '../../src/types.js';
import { cleanupHarness, createAgent, createHarness } from './helpers/context-history-replay-harness.js';

class BlockingLLMClient {
  public called = false;
  public callCount = 0;
  public releaseCount = 0;
  private release!: () => void;
  private gate = this.createGate();

  private createGate(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async generatePreparedWithCallbacks(
    messages: Message[],
    callbacks: {
      onText?: (text: string) => void;
      onComplete?: (result: unknown) => void;
    }
  ): Promise<{ content: string; finishReason: string }> {
    void messages;
    this.called = true;
    this.callCount += 1;
    await this.gate;
    this.gate = this.createGate();
    callbacks.onText?.('first done');
    callbacks.onComplete?.({ content: 'first done', finishReason: 'end_turn' });
    return { content: 'first done', finishReason: 'end_turn' };
  }

  async generateWithCallbacks(
    ...args: Parameters<BlockingLLMClient['generatePreparedWithCallbacks']>
  ): ReturnType<BlockingLLMClient['generatePreparedWithCallbacks']> {
    return this.generatePreparedWithCallbacks(...args);
  }

  async generate(): Promise<{ content: string; finishReason: string }> {
    return { content: 'compressed', finishReason: 'end_turn' };
  }

  unblock(): void {
    this.releaseCount += 1;
    this.release();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for predicate.');
}

function testCommitRejectsWhenEventCountChangedAfterBeginTurn(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-run-conflict-'));
  try {
    const manager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
    const context = { scope: 'session' as const, namespace: 'conflict-session' };
    const turn = manager.beginTurn(context, 'first prompt');
    manager.writeNow(context, 'external', 'write');
    assert.throws(
      () =>
        manager.commitTurn(turn.turnId, {
          messages: [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'first answer' },
          ],
          finishReason: 'end_turn',
        }),
      /Context event version conflict/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testContextEventVersionConflictParser(): void {
  const message = 'Context event version conflict for session:sess-1779173834055-ac259517: expected 71, found 115';
  assert.deepEqual(parseContextEventVersionConflictError(message), {
    scope: 'session',
    namespace: 'sess-1779173834055-ac259517',
    expected: 71,
    found: 115,
  });
  assert.equal(isContextEventVersionConflictError(message), true);
  assert.equal(isContextEventVersionConflictError(new Error(message)), true);
  assert.equal(isContextEventVersionConflictError('ordinary runtime failure'), false);
}

async function testDPAgentRejectsConcurrentRunForSameContext(): Promise<void> {
  const harness = createHarness('run-lease');
  const llm = new BlockingLLMClient();
  const agent = createAgent(harness, llm as never);
  const context = { scope: 'session' as const, namespace: 'same-session' };
  try {
    const firstRun = agent.runWithResult({ context, prompt: 'first' });
    await waitFor(() => llm.called);
    await assert.rejects(
      () => agent.runWithResult({ context, prompt: 'second', runId: 'second-run' }),
      /already has an active run/
    );
    llm.unblock();
    const firstResult = await firstRun;
    assert.equal(firstResult.content, 'first done');
    const thirdRun = agent.runWithResult({ context, prompt: 'third', runId: 'third-run' });
    await waitFor(() => llm.callCount === 2);
    llm.unblock();
    const thirdResult = await thirdRun;
    assert.equal(thirdResult.content, 'first done');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function run(): Promise<void> {
  testContextEventVersionConflictParser();
  testCommitRejectsWhenEventCountChangedAfterBeginTurn();
  await testDPAgentRejectsConcurrentRunForSameContext();
}

run()
  .then(() => {
    console.log('context run concurrency tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
