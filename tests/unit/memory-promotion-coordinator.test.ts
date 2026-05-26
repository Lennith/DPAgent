import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextEventStore, ContextManager } from '../../src/context/index.js';
import { GovernanceAuditStore } from '../../src/governance/AuditStore.js';
import type { LLMRuntime } from '../../src/llm/index.js';
import { MemoryPromotionCoordinator } from '../../src/memory/MemoryPromotionCoordinator.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';

interface Harness {
  tempDir: string;
  workspaceDir: string;
  sessionId: string;
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  coordinator: MemoryPromotionCoordinator;
}

function createHarness(getLlmClient: () => LLMRuntime | null): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-promotion-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const contextManager = new ContextManager(new ContextEventStore(path.join(tempDir, 'contexts')));
  const memoryStore = new MemoryStore(path.join(tempDir, 'memory'));
  const coordinator = new MemoryPromotionCoordinator({
    contextManager,
    memoryStore,
    governanceAuditStore: new GovernanceAuditStore(path.join(tempDir, 'audit')),
    getLlmClient,
    idleFlushMs: 60_000,
  });
  return {
    tempDir,
    workspaceDir,
    sessionId: 'sess-memory-promotion',
    contextManager,
    memoryStore,
    coordinator,
  };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function commitTurn(harness: Harness, index: number): void {
  const prompt = `Remember workflow step ${index}`;
  const finalOutput = `Checklist:\n- run command ${index}\n- validate output ${index}`;
  const started = harness.contextManager.beginTurn(
    { scope: 'session', namespace: harness.sessionId },
    prompt,
    harness.workspaceDir
  );
  harness.contextManager.record(started.turnId, 'assistant_message', { content: finalOutput });
  harness.contextManager.commitTurn(started.turnId, {
    messages: [],
    rawUserPrompt: prompt,
    finalOutputText: finalOutput,
    finishReason: 'end_turn',
  });
}

function commitBatch(harness: Harness): void {
  commitTurn(harness, 1);
  commitTurn(harness, 2);
  commitTurn(harness, 3);
}

async function testUnavailableClassifierDoesNotFallbackOrAdvanceWatermark(): Promise<void> {
  const harness = createHarness(() => null);
  try {
    commitBatch(harness);
    await assert.rejects(
      () => harness.coordinator.organizeSession({
        sessionId: harness.sessionId,
        workspaceDir: harness.workspaceDir,
        reason: 'manual',
      }),
      /classifier LLM is unavailable/
    );

    assert.equal(harness.memoryStore.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true }).length, 0);
    const state = harness.coordinator.getSessionState(harness.sessionId);
    assert.equal(state?.status, 'failed');
    assert.equal(state?.lastProcessedContextVersion, 0);
    assert.equal(state?.pendingTurnCount, 3);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testInvalidClassifierJsonDoesNotFallbackOrAdvanceWatermark(): Promise<void> {
  const llm = {
    generate: async () => ({ content: 'not-json' }),
  } as unknown as LLMRuntime;
  const harness = createHarness(() => llm);
  try {
    commitBatch(harness);
    await assert.rejects(
      () => harness.coordinator.organizeSession({
        sessionId: harness.sessionId,
        workspaceDir: harness.workspaceDir,
        reason: 'manual',
      }),
      /classifier response did not contain JSON/
    );

    assert.equal(harness.memoryStore.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true }).length, 0);
    const state = harness.coordinator.getSessionState(harness.sessionId);
    assert.equal(state?.status, 'failed');
    assert.equal(state?.lastProcessedContextVersion, 0);
    assert.equal(state?.pendingTurnCount, 3);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testWrongShapeClassifierJsonDoesNotFallbackOrAdvanceWatermark(): Promise<void> {
  const llm = {
    generate: async () => ({ content: '{}' }),
  } as unknown as LLMRuntime;
  const harness = createHarness(() => llm);
  try {
    commitBatch(harness);
    await assert.rejects(
      () => harness.coordinator.organizeSession({
        sessionId: harness.sessionId,
        workspaceDir: harness.workspaceDir,
        reason: 'manual',
      }),
      /classifier JSON was invalid/
    );

    assert.equal(harness.memoryStore.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true }).length, 0);
    const state = harness.coordinator.getSessionState(harness.sessionId);
    assert.equal(state?.status, 'failed');
    assert.equal(state?.lastProcessedContextVersion, 0);
    assert.equal(state?.pendingTurnCount, 3);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function testTruncationMarkerCandidateIsRejected(): Promise<void> {
  let candidateTurnId = 'missing-turn';
  const llm = {
    generate: async () => ({
      content: JSON.stringify({
        items: [
          {
            turnId: candidateTurnId,
            decision: 'memory_candidate',
            scope: 'workspace',
            title: 'Workflow',
            content: 'Use the workflow, then review ...(truncated)',
            reason: 'test',
            stability: 'stable',
            conflictHints: [],
          },
        ],
      }),
    }),
  } as unknown as LLMRuntime;
  const harness = createHarness(() => llm);
  try {
    commitBatch(harness);
    const firstTurn = harness.contextManager
      .getEventStore()
      .readEvents('session', harness.sessionId)
      .find((event) => event.type === 'turn_committed');
    assert.ok(firstTurn);
    candidateTurnId = firstTurn.turnId;

    const result = await harness.coordinator.organizeSession({
      sessionId: harness.sessionId,
      workspaceDir: harness.workspaceDir,
      reason: 'manual',
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.appliedCount, 0);
    assert.equal(harness.memoryStore.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true }).length, 0);
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testUnavailableClassifierDoesNotFallbackOrAdvanceWatermark();
  await testInvalidClassifierJsonDoesNotFallbackOrAdvanceWatermark();
  await testWrongShapeClassifierJsonDoesNotFallbackOrAdvanceWatermark();
  await testTruncationMarkerCandidateIsRejected();
  console.log('memory-promotion-coordinator tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
