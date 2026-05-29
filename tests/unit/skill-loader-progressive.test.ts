import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillLoader } from '../../src/skills/SkillLoader.js';

function createHarness(): {
  tempDir: string;
  workspaceDir: string;
  skillsDir: string;
  agentSkillDir: string;
  otherAgentSkillDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-progressive-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const skillsDir = path.join(tempDir, 'global-skills');
  const agentSkillDir = path.join(tempDir, 'agents', 'browser', 'skill');
  const otherAgentSkillDir = path.join(tempDir, 'agents', 'coding', 'skill');
  fs.mkdirSync(path.join(workspaceDir, 'skills', 'release-helper'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'power-shell'), { recursive: true });
  fs.mkdirSync(path.join(agentSkillDir, 'browser-evidence'), { recursive: true });
  fs.mkdirSync(path.join(otherAgentSkillDir, 'coding-only'), { recursive: true });
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
  fs.writeFileSync(
    path.join(agentSkillDir, 'browser-evidence', 'SKILL.md'),
    [
      '---',
      'name: "browser-evidence"',
      'description: "Agent browser evidence workflow"',
      'metadata:',
      '  tags: ["browser", "agent"]',
      '  platforms: ["windows"]',
      '---',
      '',
      'Agent-scoped browser evidence body.',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(otherAgentSkillDir, 'coding-only', 'SKILL.md'),
    [
      '---',
      'name: "coding-only"',
      'description: "Other agent skill"',
      'metadata:',
      '  platforms: ["windows"]',
      '---',
      '',
      'Other agent body.',
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
  return { tempDir, workspaceDir, skillsDir, agentSkillDir, otherAgentSkillDir };
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
      agentSkillDir: harness.agentSkillDir,
      toolsetName: 'windows-dev',
      capabilities: {
        canListOrViewSkills: true,
        canManageSkills: true,
      },
    });
    assert.match(prompt, /release-helper/);
    assert.match(prompt, /power-shell/);
    assert.match(prompt, /browser-evidence/);
    assert.match(prompt, /Inspect candidate skills before inventing a workflow\./);
    assert.match(prompt, /workspace skills are project-local/i);
    assert.match(prompt, /agent skills are bundled with the selected agent profile/i);
    assert.match(prompt, /global skills are shared/i);
    assert.match(prompt, /native skills are package-bundled read-only baselines/i);
    assert.match(prompt, /web-access/);
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
    assert.match(readOnlyPrompt, /workspace skills are project-local/i);
    assert.match(readOnlyPrompt, /agent skills are bundled with the selected agent profile/i);
    assert.match(readOnlyPrompt, /native skills are package-bundled read-only baselines/i);
    assert.doesNotMatch(readOnlyPrompt, /\bskill_manage\b|create draft|\bapprove\b/i);

    const skill = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      includeWorkspaceSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.ok(skill);
    assert.match(skill?.content ?? '', /detailed release steps/i);

    const filteredOut = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      includeWorkspaceSkills: true,
      toolsetName: 'windows-safe',
    });
    assert.equal(filteredOut, undefined);

    const hiddenDeprecated = loader.getSkillByName('deprecated-helper', {
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      includeWorkspaceSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.equal(hiddenDeprecated, undefined);
    const visibleDeprecated = loader.getSkillByName('deprecated-helper', {
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      includeWorkspaceSkills: true,
      toolsetName: 'windows-dev',
      includeDeprecated: true,
    });
    assert.ok(visibleDeprecated);
    assert.equal(visibleDeprecated?.reviewStatus, 'deprecated');

    const agentSkill = loader.getSkillByName('browser-evidence', {
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      toolsetName: 'windows-dev',
    });
    assert.ok(agentSkill);
    assert.equal(agentSkill?.source, 'agent');
    assert.match(agentSkill?.content ?? '', /Agent-scoped browser evidence body/);

    const agentOnlyCatalog = loader.getSkillCatalog({
      workspaceDir: harness.workspaceDir,
      agentSkillDir: harness.agentSkillDir,
      includeGlobalSkills: false,
      toolsetName: 'windows-dev',
    });
    assert.equal(agentOnlyCatalog.some((entry) => entry.name === 'browser-evidence'), true);
    assert.equal(agentOnlyCatalog.some((entry) => entry.name === 'power-shell'), false);
    assert.equal(agentOnlyCatalog.some((entry) => entry.name === 'release-helper'), true);
    assert.equal(agentOnlyCatalog.some((entry) => entry.name === 'coding-only'), false);

    const nativeOnlyLoader = new SkillLoader();
    const nativeOnlyReadOnlyPrompt = nativeOnlyLoader.generateSkillCatalogPrompt({
      capabilities: {
        canListOrViewSkills: true,
        canManageSkills: false,
      },
    });
    assert.match(nativeOnlyReadOnlyPrompt, /Approved skills are available as on-demand references\./);
    assert.match(nativeOnlyReadOnlyPrompt, /web-access/);
    assert.doesNotMatch(nativeOnlyReadOnlyPrompt, /skill_manage/i);

    console.log('skill-loader-progressive tests passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runAll();
