import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { createContextManageTool } from '../../src/tools/index.js';
import type { ContextRef, ToolResult } from '../../src/types.js';

function createHarness(): {
  tempDir: string;
  contextManager: ContextManager;
  sessionContext: ContextRef;
  workspaceContext: ContextRef;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-manage-tool-'));
  const eventStore = new ContextEventStore(path.join(tempDir, 'contexts'));
  return {
    tempDir,
    contextManager: new ContextManager(eventStore),
    sessionContext: { scope: 'session', namespace: 'sess-1' },
    workspaceContext: { scope: 'workspace', namespace: 'workspace-main' },
  };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function parseJsonResult(result: ToolResult): Record<string, unknown> {
  assert.equal(result.success, true, result.error ?? result.content);
  return JSON.parse(result.content) as Record<string, unknown>;
}

async function runAll(): Promise<void> {
  const harness = createHarness();
  try {
    harness.contextManager.writeNow(harness.sessionContext, 'existing', 'committed value');
    harness.contextManager.updateNamespaceMeta(harness.sessionContext, {
      workspaceDir: 'D:\\repo',
      toolsetName: 'windows-dev',
      memoryPromotionState: {
        lastProcessedContextVersion: 1,
        lastQueuedContextVersion: 2,
        pendingTurnCount: 3,
        lastActivityAt: new Date('2026-04-13T12:00:00.000Z').toISOString(),
        status: 'queued',
      },
      compressedHistoryContext: {
        sealedRoundCount: 4,
        sealedPrefixHash: 'hash-1',
        summary: 'older summary',
        updatedAt: new Date('2026-04-13T12:01:00.000Z').toISOString(),
        formatVersion: 1,
        configFingerprint: 'cfg-1',
      },
      autoLoopConfig: {
        enabled: false,
        prompt: 'continue',
        maxRounds: 8,
        maxDurationMinutes: 20,
        similarityThreshold: 0.7,
        compareRounds: 3,
      },
      agentInjectionState: {
        lastProfileName: 'review',
        lastProfilePath: 'D:\\repo\\AGENTS.md',
        lastProfileSource: 'workspace',
        updatedAt: new Date('2026-04-13T12:02:00.000Z').toISOString(),
      },
    });

    const activeTurn = harness.contextManager.beginTurn(harness.sessionContext, 'inspect state', 'D:\\repo');
    const tool = createContextManageTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => harness.sessionContext,
      resolveActiveTurnId: () => activeTurn.turnId,
    });

    const bufferedWrite = parseJsonResult(
      await tool.execute({ action: 'write', key: 'draft', value: 'pending value' })
    );
    assert.equal(bufferedWrite.mode, 'buffered');

    const readPending = parseJsonResult(await tool.execute({ action: 'read', key: 'draft' }));
    assert.equal(readPending.found, true);
    assert.equal(readPending.value, 'pending value');
    assert.equal(readPending.sourceStatus, 'pending_override');
    assert.equal(readPending.committedValue, null);

    const readFull = parseJsonResult(await tool.execute({ action: 'read' }));
    assert.equal((readFull.structuredContext as Record<string, unknown>).existing, 'committed value');
    assert.equal((readFull.structuredContext as Record<string, unknown>).draft, 'pending value');
    assert.equal((readFull.committedStructuredContext as Record<string, unknown>).existing, 'committed value');
    assert.equal((readFull.pendingOverlay as { patchCount?: number }).patchCount, 1);
    assert.equal((readFull.meta as { toolsetName?: string }).toolsetName, 'windows-dev');
    assert.equal(
      ((readFull.meta as { compressedHistoryContext?: { sealedRoundCount?: number } }).compressedHistoryContext
        ?.sealedRoundCount as number),
      4
    );
    assert.match(String(readFull.summary ?? ''), /Structured context:/);
    assert.match(String(readFull.summary ?? ''), /draft=pending value/);

    const bufferedDelete = parseJsonResult(await tool.execute({ action: 'delete', key: 'existing' }));
    assert.equal(bufferedDelete.mode, 'buffered');

    const readDeleted = parseJsonResult(await tool.execute({ action: 'read', key: 'existing' }));
    assert.equal(readDeleted.found, false);
    assert.equal(readDeleted.value, null);
    assert.equal(readDeleted.sourceStatus, 'pending_delete');
    assert.equal(readDeleted.committedValue, 'committed value');

    const summarized = parseJsonResult(await tool.execute({ action: 'summarize' }));
    assert.match(String(summarized.summary ?? ''), /Structured context:/);
    assert.match(String(summarized.summary ?? ''), /Pending overlay:/);
    assert.match(String(summarized.summary ?? ''), /Toolset: windows-dev/);
    assert.match(String(summarized.summary ?? ''), /Compressed older-session context is available/i);

    const readOnlyWrite = await tool.execute({
      action: 'write',
      key: 'compressedHistoryContext',
      value: 'should fail',
    });
    assert.equal(readOnlyWrite.success, false);
    assert.match(String(readOnlyWrite.error ?? ''), /read-only runtime context state/i);

    harness.contextManager.writeNow(harness.workspaceContext, 'workspaceKey', 'workspaceValue');
    const listTool = createContextManageTool({
      contextManager: harness.contextManager,
      resolveActiveContext: () => null,
      resolveActiveTurnId: () => null,
    });
    const listed = parseJsonResult(await listTool.execute({ action: 'list', scope: 'session' }));
    assert.equal(Array.isArray(listed.namespaces), true);
    assert.equal(
      (listed.namespaces as Array<{ namespace?: string }>).some((item) => item.namespace === harness.sessionContext.namespace),
      true
    );

    console.log('context-manage-tool tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
