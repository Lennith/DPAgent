import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/memory/MemoryStore.js';

function createHarness(): { tempDir: string; workspaceDir: string; store: MemoryStore } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const store = new MemoryStore(path.join(tempDir, 'memory'));
  return { tempDir, workspaceDir, store };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runAll(): void {
  const harness = createHarness();
  try {
    const firstWrite = harness.store.writeMemory({
      scope: 'workspace',
      title: 'Build command',
      content: 'Use npm run build:web before publish.',
      workspaceDir: harness.workspaceDir,
      sourceSessionId: 'sess-1',
    });
    assert.equal(firstWrite.version, 1);

    const entries = harness.store.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, 1);
    assert.match(harness.store.getPromptSegment(harness.workspaceDir), /npm run build:web/);

    const duplicateWrite = harness.store.writeMemory({
      scope: 'workspace',
      title: 'Build command',
      content: 'Use npm run build:web before publish.',
      workspaceDir: harness.workspaceDir,
    });
    assert.equal(duplicateWrite.version, 1);

    const secondWrite = harness.store.writeMemory({
      scope: 'workspace',
      title: 'Build command',
      content: 'Use npm run build:web and npm test before publish.',
      workspaceDir: harness.workspaceDir,
      sourceSessionId: 'sess-2',
    });
    assert.equal(secondWrite.version, 2);

    const activeEntries = harness.store.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true });
    assert.equal(activeEntries.length, 1);
    assert.match(activeEntries[0].content, /npm test/);

    const history = harness.store.getHistory({ id: activeEntries[0].id, workspaceDir: harness.workspaceDir, includeUser: true });
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 2);
    assert.equal(history[1].status, 'superseded');

    const expired = harness.store.expireEntry(activeEntries[0].id, { workspaceDir: harness.workspaceDir, includeUser: true });
    assert.ok(expired);
    assert.equal(harness.store.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true }).length, 0);

    const search = harness.store.search('build:web publish', { workspaceDir: harness.workspaceDir, maxResults: 5 });
    assert.equal(search.length, 0);

    const workflowSuggestionA = harness.store.maybeSuggestFromTurn({
      sessionId: 'sess-3',
      workspaceDir: harness.workspaceDir,
      prompt: 'Remember the release flow for this repo.',
      finalOutput: 'Use `npm run build:web` and then `npm test` before publish.',
    });
    const workflowSuggestionB = harness.store.maybeSuggestFromTurn({
      sessionId: 'sess-4',
      workspaceDir: harness.workspaceDir,
      prompt: 'Remember the deployment flow for this repo.',
      finalOutput: 'Use `npm run lint` and then `npm run smoke:ui` before release.',
    });
    assert.ok(workflowSuggestionA);
    assert.ok(workflowSuggestionB);
    assert.notEqual(workflowSuggestionA?.lineageId, workflowSuggestionB?.lineageId);

    const latestPending = harness.store.listPending({ workspaceDir: harness.workspaceDir });
    assert.equal(latestPending.length, 2);
    harness.store.approveSuggestion(latestPending[0].id);
    harness.store.approveSuggestion(latestPending[1].id);

    const coexistEntries = harness.store.listEntries({ workspaceDir: harness.workspaceDir, includeUser: true });
    assert.equal(coexistEntries.length, 2);

    const userMemory = harness.store.writeMemory({
      scope: 'user',
      title: 'User preference',
      content: 'Prefer concise release notes.',
    });
    assert.equal(
      harness.store.replaceEntry(userMemory.id, {
        workspaceDir: harness.workspaceDir,
        includeUser: false,
        content: 'Should not update through workspace-only replacement.',
      }),
      null
    );
    const unchangedUserMemory = harness.store.readEntry(userMemory.id, {
      workspaceDir: harness.workspaceDir,
      includeUser: true,
    });
    assert.equal(unchangedUserMemory?.content, 'Prefer concise release notes.');

    console.log('memory-store tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
