import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillLoader } from '../../src/skills/SkillLoader.js';

function writeSkill(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: "${name}"`,
      `description: "${description}"`,
      'metadata:',
      '  platforms: ["windows"]',
      '---',
      '',
      `${description} body`,
      '',
    ].join('\n'),
    'utf-8'
  );
}

function createHarness(): {
  tempDir: string;
  workspaceDir: string;
  globalSkillsDir: string;
  teamPackOlderDir: string;
  teamPackNewerDir: string;
  workspacePackDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loader-precedence-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const globalSkillsDir = path.join(tempDir, 'global-skills');
  const teamPackOlderDir = path.join(tempDir, 'packs', 'team-old');
  const teamPackNewerDir = path.join(tempDir, 'packs', 'team-new');
  const workspacePackDir = path.join(tempDir, 'packs', 'workspace');
  writeSkill(path.join(globalSkillsDir, 'release-helper'), 'release-helper', 'global release helper');
  writeSkill(path.join(globalSkillsDir, 'web-access'), 'web-access', 'global web access override');
  writeSkill(path.join(teamPackOlderDir, 'release-helper'), 'release-helper', 'team pack older helper');
  writeSkill(path.join(teamPackNewerDir, 'release-helper'), 'release-helper', 'team pack newer helper');
  writeSkill(path.join(workspacePackDir, 'release-helper'), 'release-helper', 'workspace pack helper');
  writeSkill(path.join(workspaceDir, 'skills', 'release-helper'), 'release-helper', 'workspace local helper');
  writeSkill(path.join(workspaceDir, 'skills', 'web-access'), 'web-access', 'workspace web access override');
  return {
    tempDir,
    workspaceDir,
    globalSkillsDir,
    teamPackOlderDir,
    teamPackNewerDir,
    workspacePackDir,
  };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runAll(): void {
  const harness = createHarness();
  try {
    const loader = new SkillLoader();
    loader.loadCodexSkills(harness.globalSkillsDir);
    loader.setSupplementalDirectoriesResolver(() => [
      {
        dir: harness.teamPackOlderDir,
        source: 'team_pack',
        packName: 'team-pack-old',
        packVersion: '1',
        packUpdatedAt: '2026-04-12T00:00:00.000Z',
      },
      {
        dir: harness.teamPackNewerDir,
        source: 'team_pack',
        packName: 'team-pack-new',
        packVersion: '2',
        packUpdatedAt: '2026-04-12T01:00:00.000Z',
      },
      {
        dir: harness.workspacePackDir,
        source: 'workspace_pack',
        packName: 'workspace-pack',
        packVersion: '5',
        packUpdatedAt: '2026-04-12T02:00:00.000Z',
      },
    ]);

    const resolved = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      includeWorkspaceSkills: true,
      includePackSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.ok(resolved);
    assert.equal(resolved?.source, 'workspace');
    assert.equal(resolved?.description, 'workspace local helper');

    fs.rmSync(path.join(harness.workspaceDir, 'skills'), { recursive: true, force: true });
    const resolvedWithoutWorkspace = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      includeWorkspaceSkills: true,
      includePackSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.ok(resolvedWithoutWorkspace);
    assert.equal(resolvedWithoutWorkspace?.source, 'workspace_pack');
    assert.equal(resolvedWithoutWorkspace?.packName, 'workspace-pack');

    loader.setSupplementalDirectoriesResolver(() => [
      {
        dir: harness.teamPackOlderDir,
        source: 'team_pack',
        packName: 'team-pack-old',
        packVersion: '1',
        packUpdatedAt: '2026-04-12T00:00:00.000Z',
      },
      {
        dir: harness.teamPackNewerDir,
        source: 'team_pack',
        packName: 'team-pack-new',
        packVersion: '2',
        packUpdatedAt: '2026-04-12T01:00:00.000Z',
      },
    ]);
    const resolvedTeamPack = loader.getSkillByName('release-helper', {
      workspaceDir: harness.workspaceDir,
      includeWorkspaceSkills: true,
      includePackSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.ok(resolvedTeamPack);
    assert.equal(resolvedTeamPack?.source, 'team_pack');
    assert.equal(resolvedTeamPack?.packName, 'team-pack-new');
    assert.equal(resolvedTeamPack?.packVersion, '2');

    const nativeOnlyLoader = new SkillLoader();
    const nativeWebAccess = nativeOnlyLoader.getSkillByName('web-access', {
      toolsetName: 'windows-dev',
    });
    assert.ok(nativeWebAccess);
    assert.equal(nativeWebAccess?.source, 'native');

    const globalOverrideLoader = new SkillLoader();
    globalOverrideLoader.loadCodexSkills(harness.globalSkillsDir);
    const globalWebAccess = globalOverrideLoader.getSkillByName('web-access', {
      toolsetName: 'windows-dev',
    });
    assert.ok(globalWebAccess);
    assert.equal(globalWebAccess?.source, 'global');
    assert.equal(globalWebAccess?.description, 'global web access override');

    writeSkill(path.join(harness.workspaceDir, 'skills', 'web-access'), 'web-access', 'workspace web access override');
    const workspaceWebAccess = globalOverrideLoader.getSkillByName('web-access', {
      workspaceDir: harness.workspaceDir,
      includeWorkspaceSkills: true,
      toolsetName: 'windows-dev',
    });
    assert.ok(workspaceWebAccess);
    assert.equal(workspaceWebAccess?.source, 'workspace');
    assert.equal(workspaceWebAccess?.description, 'workspace web access override');

    console.log('skill-loader-precedence tests passed');
  } finally {
    cleanup(harness.tempDir);
  }
}

runAll();
