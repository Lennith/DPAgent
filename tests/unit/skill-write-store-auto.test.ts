import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillWriteStore } from '../../src/skills/SkillWriteStore.js';
import { parseSkillMarkdown } from '../../src/skills/skill-markdown.js';

function createHarness(): {
  tempDir: string;
  workspaceDir: string;
  globalSkillsDir: string;
  store: SkillWriteStore;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-store-auto-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const globalSkillsDir = path.join(tempDir, 'global-skills');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(globalSkillsDir, { recursive: true });
  return {
    tempDir,
    workspaceDir,
    globalSkillsDir,
    store: new SkillWriteStore(path.join(tempDir, 'runtime-skills')),
  };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runAll(): void {
  const harness = createHarness();
  try {
    const first = harness.store.observeSuccessfulTurn({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable workspace release workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish to the internal registry'].join('\n'),
      globalSkillsDir: harness.globalSkillsDir,
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.equal(first, null);

    const second = harness.store.observeSuccessfulTurn({
      sessionId: 'sess-1',
      workspaceDir: harness.workspaceDir,
      prompt: 'Create a repeatable workspace release workflow',
      finalOutput: ['1. `npm run build:web`', '2. `npm test`', '3. Publish to the internal registry'].join('\n'),
      globalSkillsDir: harness.globalSkillsDir,
      toolsetName: 'full-access',
      platform: 'win32',
    });
    assert.ok(second);
    assert.equal(second?.status, 'applied');
    assert.equal((second?.triggerCount ?? 0) >= 2, true);
    assert.equal(fs.existsSync(second?.targetPath ?? ''), true);
    const records = harness.store.listWriteRecords({
      status: 'applied',
      workspaceDir: harness.workspaceDir,
      reason: 'repeated_success_pattern',
    });
    assert.equal(records.some((record) => record.id === second?.id), true);
    const skillContent = fs.readFileSync(String(second?.targetPath), 'utf-8');
    const parsed = parseSkillMarkdown(skillContent);
    assert.equal(parsed.metadata.generatedBy, 'auto-observe-turn');
    assert.equal(parsed.metadata.generationReason, 'repeated_success_pattern');
    assert.deepEqual(parsed.metadata.toolsets, ['full-access']);
    assert.deepEqual(parsed.metadata.platforms, ['win32']);

    const failure = harness.store.observeSuccessfulTurn({
      sessionId: 'sess-2',
      workspaceDir: harness.workspaceDir,
      prompt: 'Do something broken',
      finalOutput: 'Error: publish failed because the registry is unavailable',
      globalSkillsDir: harness.globalSkillsDir,
    });
    assert.equal(failure, null);

    console.log('skill-write-store-auto tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
