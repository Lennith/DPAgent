import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillLoader } from '../../src/skills/index.js';

function createHarness(): { tempDir: string; workspaceDir: string; skillsDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-progressive-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const skillsDir = path.join(tempDir, 'global-skills');
  fs.mkdirSync(path.join(workspaceDir, 'skills', 'release-helper'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'power-shell'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'skills', 'release-helper', 'SKILL.md'),
    [
      '---',
      'name: "release-helper"',
      'description: "Workspace release helper"',
      'metadata:',
      '  tags: ["release", "workspace"]',
      '  platforms: ["windows"]',
      '  toolsets: ["windows-dev", "research"]',
      '---',
      '',
      'Body with detailed release steps that should not be injected into the catalog prompt.',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(skillsDir, 'power-shell', 'SKILL.md'),
    [
      '---',
      'name: "power-shell"',
      'description: "PowerShell workflow"',
      'metadata:',
      '  tags: ["powershell"]',
      '  platforms: ["windows"]',
      '---',
      '',
      'Detailed PowerShell body.',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.mkdirSync(path.join(workspaceDir, 'skills', 'deprecated-helper'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'skills', 'deprecated-helper', 'SKILL.md'),
    [
      '---',
      'name: "deprecated-helper"',
      'description: "Deprecated helper"',
      'metadata:',
      '  reviewStatus: "deprecated"',
      '  platforms: ["windows"]',
      '---',
      '',
      'Deprecated body.',
      '',
    ].join('\n'),
    'utf-8'
  );
  return { tempDir, workspaceDir, skillsDir };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runAll(): void {
  const harness = createHarness();
  try {
    const loader = new SkillLoader();
    loader.loadCodexSkills(harness.skillsDir);

    const prompt = loader.generateSkillCatalogPrompt({
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
      capabilities: {
        canListOrViewSkills: true,
        canManageSkills: true,
      },
    });
    assert.match(prompt, /release-helper/);
    assert.match(prompt, /power-shell/);
    assert.match(prompt, /Inspect candidate skills before inventing a workflow\./);
    assert.match(prompt, /skill_manage/);
    assert.equal(prompt.includes('Detailed PowerShell body.'), false);
    assert.equal(prompt.includes('Body with detailed release steps'), false);
    assert.equal(prompt.includes('reusable procedures, not durable facts'), false);
    assert.equal(prompt.includes('Capture verified, reusable workflows as skill drafts'), false);

    const readOnlyPrompt = loader.generateSkillCatalogPrompt({
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-safe',
      capabilities: {
        canListOrViewSkills: true,
        canManageSkills: false,
      },
    });
    assert.match(readOnlyPrompt, /Approved skills are available as on-demand references\./);
    assert.doesNotMatch(readOnlyPrompt, /\bskill_manage\b|create draft|\bapprove\b/i);

    const skill = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
    });
    assert.ok(skill);
    assert.match(skill?.content ?? '', /detailed release steps/i);

    const filteredOut = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-safe',
    });
    assert.equal(filteredOut, undefined);

    const hiddenDeprecated = loader.getSkillByName('deprecated-helper', {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
    });
    assert.equal(hiddenDeprecated, undefined);
    const visibleDeprecated = loader.getSkillByName('deprecated-helper', {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
      includeDeprecated: true,
    });
    assert.ok(visibleDeprecated);
    assert.equal(visibleDeprecated?.reviewStatus, 'deprecated');

    const emptyLoader = new SkillLoader();
    const emptyReadOnlyPrompt = emptyLoader.generateSkillCatalogPrompt({
      capabilities: {
        canListOrViewSkills: true,
        canManageSkills: false,
      },
    });
    assert.match(emptyReadOnlyPrompt, /No approved skills are currently available\./);
    assert.doesNotMatch(emptyReadOnlyPrompt, /skill_manage/i);

    console.log('skill-loader-progressive tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
