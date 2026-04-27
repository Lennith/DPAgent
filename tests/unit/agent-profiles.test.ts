import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildPromptWithAgentProfileReference,
  buildPromptWithAgentProfile,
  resolveAgentPool,
  loadWorkspaceAgentProfile,
  parseAgentProfilePrompt,
  parseLeadingAgentMention,
  scanGlobalAgentProfiles,
} from '../../src/agents/AgentProfiles.js';

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function testScanGlobalProfilesAndDuplicateOverride(): void {
  const root = createTempDir('agent-profiles-global-');
  try {
    writeFile(path.join(root, 'Coder', 'AGENTS.md'), '# Coder\nFocus on coding');
    writeFile(path.join(root, 'Reviewer', 'AGENTS.md'), 'Review for risk');
    writeFile(path.join(root, 'NoProfile', 'README.md'), 'ignored');

    const result = scanGlobalAgentProfiles(root);
    assert.equal(result.profiles.length, 2);
    const names = result.profiles.map((item) => item.name).sort();
    assert.deepEqual(names, ['Coder', 'Reviewer']);

    const coder = result.profiles.find((item) => item.normalizedName === 'coder');
    assert.ok(coder);
    assert.equal(coder?.description, 'Coder');
    assert.equal(result.duplicateOverrides.length, 0);
  } finally {
    cleanup(root);
  }
}

function testFrontmatterSummaryPriorityAndDelimiterIgnored(): void {
  const root = createTempDir('agent-profiles-frontmatter-');
  try {
    writeFile(
      path.join(root, 'Alpha', 'AGENTS.md'),
      [
        '---',
        'name: alpha',
        'summary: |',
        '  职责：负责代码实现。何时用：需要落地功能。别用：仅做需求讨论。',
        'description: |',
        '  This description should not win.',
        '---',
        '# Alpha Heading',
        'content',
      ].join('\n')
    );
    writeFile(
      path.join(root, 'Beta', 'AGENTS.md'),
      [
        '---',
        'name: beta',
        'description: |',
        '  Beta Description First Line',
        '  Beta Description Second Line',
        '---',
        '# Beta Heading',
      ].join('\n')
    );
    writeFile(
      path.join(root, 'Delta', 'AGENTS.md'),
      [
        '---',
        'name: delta',
        'version: 1.0.0',
        '---',
        '# Delta Heading',
      ].join('\n')
    );

    const result = scanGlobalAgentProfiles(root);
    const alpha = result.profiles.find((item) => item.normalizedName === 'alpha');
    const beta = result.profiles.find((item) => item.normalizedName === 'beta');
    const delta = result.profiles.find((item) => item.normalizedName === 'delta');

    assert.ok(alpha);
    assert.ok(beta);
    assert.ok(delta);
    assert.equal(alpha?.description, '职责：负责代码实现。何时用：需要落地功能。别用：仅做需求讨论。');
    assert.equal(beta?.description, 'Beta Description First Line');
    assert.equal(delta?.description, 'Delta Heading');
    assert.notEqual(delta?.description, '---');
  } finally {
    cleanup(root);
  }
}

function testFrontmatterSummaryLengthLimitInRepo(): void {
  const agentsDir = path.resolve(process.cwd(), 'agents');
  if (!fs.existsSync(agentsDir)) {
    return;
  }
  const catalog = scanGlobalAgentProfiles(agentsDir);
  for (const item of catalog.profiles) {
    if (item.name === 'Me') {
      continue;
    }
    assert.equal(item.description.length <= 150, true, `summary too long for ${item.name}`);
  }
}

function testWorkspaceProfileLoad(): void {
  const root = createTempDir('agent-profiles-workspace-');
  try {
    writeFile(path.join(root, 'AGENTS.md'), '# Workspace Agent\nUse local repo rules');
    const profile = loadWorkspaceAgentProfile(root);
    assert.ok(profile);
    assert.equal(profile?.source, 'workspace');
    assert.equal(profile?.description, 'Workspace Agent');
  } finally {
    cleanup(root);
  }
}

function testMentionParsingRules(): void {
  const case1 = parseLeadingAgentMention('@Coder fix the bug');
  assert.equal(case1.mentionName, 'Coder');
  assert.equal(case1.strippedPrompt, 'fix the bug');

  const case2 = parseLeadingAgentMention('hello @Coder fix the bug');
  assert.equal(case2.mentionName, undefined);
  assert.equal(case2.strippedPrompt, 'hello @Coder fix the bug');

  const case3 = parseLeadingAgentMention('@Unknown');
  assert.equal(case3.mentionName, 'Unknown');
  assert.equal(case3.strippedPrompt, '');
}

function testPromptInjectionBlock(): void {
  const prompt = buildPromptWithAgentProfile('Implement login', {
    name: 'Coder',
    normalizedName: 'coder',
    description: 'Coding profile',
    mtime: new Date().toISOString(),
    path: 'D:/Agents/Coder/AGENTS.md',
    content: 'You are Coder profile.',
    source: 'global',
  });
  assert.match(prompt, /\[AGENT_PROFILE_BEGIN source=global name=Coder path=D:\/Agents\/Coder\/AGENTS.md\]/);
  assert.match(prompt, /\[AGENT_PROFILE_END\]/);
  assert.match(prompt, /Implement login$/);
}

function testPromptInjectionReference(): void {
  const prompt = buildPromptWithAgentProfileReference('Implement login', {
    source: 'global',
    name: 'Coder',
    path: 'D:/Agents/Coder/AGENTS.md',
  });
  assert.match(prompt, /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]/);
  assert.match(prompt, /Implement login$/);
}

function testParseAgentProfilePrompt(): void {
  const fromBlock = parseAgentProfilePrompt(
    '[AGENT_PROFILE_BEGIN source=global name=Coder path=D:/Agents/Coder/AGENTS.md]\nrule\n[AGENT_PROFILE_END]\n\nDo work'
  );
  assert.equal(fromBlock.matched, true);
  assert.equal(fromBlock.matchedKind, 'block');
  assert.equal(fromBlock.reference?.path, 'D:/Agents/Coder/AGENTS.md');
  assert.equal(fromBlock.strippedPrompt, 'Do work');

  const fromReference = parseAgentProfilePrompt(
    '[AGENT_PROFILE_REF source=workspace name=workspace path=D:/repo/AGENTS.md]\n\nFix bug'
  );
  assert.equal(fromReference.matched, true);
  assert.equal(fromReference.matchedKind, 'reference');
  assert.equal(fromReference.reference?.source, 'workspace');
  assert.equal(fromReference.strippedPrompt, 'Fix bug');

  const plain = parseAgentProfilePrompt('normal prompt');
  assert.equal(plain.matched, false);
  assert.equal(plain.strippedPrompt, 'normal prompt');
}

function testResolveAgentPoolWithWorkspaceAndFallbackDescription(): void {
  const root = createTempDir('agent-profiles-pool-');
  try {
    const globalDir = path.join(root, 'agents');
    const workspaceDir = path.join(root, 'workspace');
    writeFile(path.join(globalDir, 'NoDesc', 'AGENTS.md'), '');
    writeFile(path.join(workspaceDir, 'AGENTS.md'), '');
    const profiles = resolveAgentPool({
      globalAgentsDir: globalDir,
      workspaceDir,
      includeWorkspace: true,
    });
    assert.equal(profiles.some((item) => item.name === 'NoDesc' && item.description === 'Agent profile: NoDesc'), true);
    assert.equal(profiles.some((item) => item.name === 'workspace' && item.description === 'Agent profile: workspace'), true);
  } finally {
    cleanup(root);
  }
}

function runAll(): void {
  testScanGlobalProfilesAndDuplicateOverride();
  testFrontmatterSummaryPriorityAndDelimiterIgnored();
  testFrontmatterSummaryLengthLimitInRepo();
  testWorkspaceProfileLoad();
  testMentionParsingRules();
  testPromptInjectionBlock();
  testPromptInjectionReference();
  testParseAgentProfilePrompt();
  testResolveAgentPoolWithWorkspaceAndFallbackDescription();
  console.log('agent-profiles tests passed');
}

runAll();
