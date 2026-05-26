import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildAgentProfileSystemSegment,
  buildPromptWithAgentProfileReference,
  buildPromptWithAgentProfile,
  buildWorkspaceInstructionsSystemSegment,
  isAgentProfileVisibleToSubagentManager,
  resolveAgentPool,
  loadWorkspaceAgentProfile,
  parseAgentProfilePrompt,
  parseLeadingAgentMention,
  scanBundledAgentProfiles,
  scanGlobalAgentProfiles,
  normalizeAgentProfileConfig,
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

function testRepositoryAgentProfilesAreNativeAndBounded(): void {
  const agentsDir = path.resolve(process.cwd(), 'agents');
  if (!fs.existsSync(agentsDir)) {
    return;
  }
  const expectedNames = [
    'browser',
    'checkpoint',
    'coding',
    'design',
    'dpagent-assistant',
    'guard',
    'health',
    'investigate',
    'planner',
    'qa',
    'release',
    'report',
    'research',
    'review',
    'security',
  ];
  const catalog = scanBundledAgentProfiles(agentsDir);
  assert.deepEqual(catalog.profiles.map((item) => item.name), expectedNames);

  const forbidden = /\b(?:claude|gstack|AskUserQuestion|WebSearch)\b|\.claude|\.gstack|CLAUDE\.md/i;
  for (const profile of catalog.profiles) {
    assert.equal(profile.source, 'bundled');
    const content = fs.readFileSync(profile.path, 'utf-8');
    const lineCount = content.split(/\r?\n/).length;
    assert.equal(lineCount <= 500, true, `${profile.name} profile exceeds 500 lines`);
    assert.doesNotMatch(content, forbidden, `${profile.name} profile contains external AI ecosystem coupling`);
    assert.equal(profile.description.length <= 150, true, `description too long for ${profile.name}`);
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

function testAgentYamlConfigDescriptionWarningsAndPromptAppend(): void {
  const root = createTempDir('agent-profiles-config-');
  try {
    writeFile(path.join(root, 'Configured', 'AGENTS.md'), [
      '---',
      'summary: Frontmatter summary',
      '---',
      '# Markdown Title',
      'Base prompt.',
    ].join('\n'));
    writeFile(path.join(root, 'Configured', 'agent.yaml'), [
      'version: 1',
      'description: YAML description',
      'llmProfileId: kimi',
      'llmModel: kimi-agent-model',
      'reasoningPreset: high',
      'toolsetName: windows-safe',
      'allowedTools:',
      '  - read_file',
      '  - grep',
      'loadGlobalSkills: false',
      'exposeAsSubagent: true',
      'maxSteps: 30',
      'timeoutMs: 300000',
      'promptAppend: |',
      '  Extra system prompt.',
    ].join('\n'));
    writeFile(path.join(root, 'Invalid', 'AGENTS.md'), '# Invalid');
    writeFile(path.join(root, 'Invalid', 'agent.yaml'), 'version: 2\nallowedTools: nope\nloadGlobalSkills: nope\nmaxSteps: -1\n');

    const result = scanGlobalAgentProfiles(root);
    const configured = result.profiles.find((item) => item.name === 'Configured');
    const invalid = result.profiles.find((item) => item.name === 'Invalid');
    assert.ok(configured);
    assert.equal(configured?.description, 'YAML description');
    assert.equal(configured?.config?.llmProfileId, 'kimi');
    assert.equal(configured?.config?.llmModel, 'kimi-agent-model');
    assert.equal(configured?.config?.reasoningPreset, 'high');
    assert.equal(configured?.config?.toolsetName, 'windows-safe');
    assert.deepEqual(configured?.config?.allowedTools, ['read_file', 'grep']);
    assert.equal(configured?.config?.loadGlobalSkills, false);
    assert.equal(configured?.config?.exposeAsSubagent, true);
    assert.equal(configured?.config?.maxSteps, 30);
    assert.equal(configured?.config?.timeoutMs, 300000);
    const block = buildPromptWithAgentProfile('Do it', configured!);
    assert.match(block, /Base prompt\./);
    assert.match(block, /Extra system prompt\./);

    assert.ok(invalid);
    assert.match((invalid?.configWarnings ?? []).join(';'), /version must be 1/);
    assert.match((invalid?.configWarnings ?? []).join(';'), /allowedTools must be an array of strings/);
    assert.match((invalid?.configWarnings ?? []).join(';'), /loadGlobalSkills must be a boolean/);
    assert.match((invalid?.configWarnings ?? []).join(';'), /maxSteps must be a positive integer/);

    const normalized = normalizeAgentProfileConfig({ reasoningPreset: 'bad' });
    assert.match(normalized.warnings.join(';'), /reasoningPreset must be one of off, low, medium, high, xhigh, max/);
    const invalidRuntimeConfig = normalizeAgentProfileConfig({
      toolsetName: 1,
      maxSteps: 1.5,
      timeoutMs: -1,
    });
    assert.match(invalidRuntimeConfig.warnings.join(';'), /toolsetName must be a string/);
    assert.match(invalidRuntimeConfig.warnings.join(';'), /maxSteps must be a positive integer/);
    assert.match(invalidRuntimeConfig.warnings.join(';'), /timeoutMs must be a positive integer/);

    const coercedRuntimeConfig = normalizeAgentProfileConfig({
      maxSteps: true,
      timeoutMs: '3000',
    });
    assert.equal(coercedRuntimeConfig.config.maxSteps, undefined);
    assert.equal(coercedRuntimeConfig.config.timeoutMs, undefined);
    assert.match(coercedRuntimeConfig.warnings.join(';'), /maxSteps must be a positive integer/);
    assert.match(coercedRuntimeConfig.warnings.join(';'), /timeoutMs must be a positive integer/);
  } finally {
    cleanup(root);
  }
}

function testPromptInjectionReference(): void {
  const prompt = buildPromptWithAgentProfileReference('Implement login', {
    source: 'global',
    name: 'Coder',
    path: 'D:/Agents/Coder/AGENTS.md',
  });
  assert.match(prompt, /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]/);
  assert.match(prompt, /\[AGENT_PROFILE_REF_NOTE\]/);
  assert.match(prompt, /not the current workspace/);
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
    buildPromptWithAgentProfileReference('Fix bug', {
      source: 'workspace',
      name: 'workspace',
      path: 'D:/repo/AGENTS.md',
    })
  );
  assert.equal(fromReference.matched, true);
  assert.equal(fromReference.matchedKind, 'reference');
  assert.equal(fromReference.reference?.source, 'workspace');
  assert.equal(fromReference.reference?.path, 'D:/repo/AGENTS.md');
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

function testSystemSegmentsAreLineCapped(): void {
  const content = Array.from({ length: 155 }, (_, index) => `line ${index + 1}`).join('\n');
  const profile = {
    name: 'Coder',
    normalizedName: 'coder',
    description: 'Coding profile',
    mtime: new Date().toISOString(),
    path: 'D:/Agents/Coder/AGENTS.md',
    content,
    source: 'global' as const,
    config: {
      promptAppend: 'prompt append should be truncated when over the cap',
    },
  };
  const roleSegment = buildAgentProfileSystemSegment(profile);
  assert.match(roleSegment, /^## Active Agent Role/);
  assert.match(roleSegment, /line 150/);
  assert.doesNotMatch(roleSegment, /line 151/);
  assert.match(roleSegment, /Agent profile truncated after 150 lines/);
  assert.match(roleSegment, /D:\/Agents\/Coder\/AGENTS\.md/);

  const workspaceSegment = buildWorkspaceInstructionsSystemSegment({
    ...profile,
    name: 'workspace',
    normalizedName: 'workspace',
    source: 'workspace' as const,
    path: 'D:/Repo/AGENTS.md',
  });
  assert.match(workspaceSegment, /^## Workspace Instructions/);
  assert.match(workspaceSegment, /repository behavior/);
  assert.match(workspaceSegment, /do not define the assistant persona/i);
  assert.match(workspaceSegment, /line 150/);
  assert.doesNotMatch(workspaceSegment, /line 151/);
  assert.match(workspaceSegment, /Workspace instructions truncated after 150 lines/);
}

function testSubagentVisibilityRequiresExternalOptIn(): void {
  const root = createTempDir('agent-profiles-subagent-visibility-');
  try {
    const bundledDir = path.join(root, 'package-agents');
    const globalDir = path.join(root, 'external-agents');
    const workspaceDir = path.join(root, 'workspace');
    writeFile(path.join(bundledDir, 'review', 'AGENTS.md'), '# Review\nBundled review');
    writeFile(path.join(globalDir, 'Hidden', 'AGENTS.md'), '# Hidden\nExternal hidden');
    writeFile(path.join(globalDir, 'Visible', 'AGENTS.md'), '# Visible\nExternal visible');
    writeFile(path.join(globalDir, 'Visible', 'agent.yaml'), 'version: 1\nexposeAsSubagent: true\n');
    writeFile(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\nWorkspace agent');

    const mentionProfiles = resolveAgentPool({
      bundledAgentsDir: bundledDir,
      globalAgentsDir: globalDir,
      workspaceDir,
      includeWorkspace: true,
    });
    assert.equal(mentionProfiles.some((item) => item.name === 'Hidden' && item.source === 'global'), true);

    const subagentProfiles = mentionProfiles.filter(isAgentProfileVisibleToSubagentManager);
    assert.equal(subagentProfiles.some((item) => item.name === 'review' && item.source === 'bundled'), true);
    assert.equal(subagentProfiles.some((item) => item.name === 'workspace' && item.source === 'workspace'), true);
    assert.equal(subagentProfiles.some((item) => item.name === 'Visible' && item.source === 'global'), true);
    assert.equal(subagentProfiles.some((item) => item.name === 'Hidden'), false);
  } finally {
    cleanup(root);
  }
}

function testResolveAgentPoolLoadsBundledByDefaultAndExternalOverrides(): void {
  const root = createTempDir('agent-profiles-bundled-');
  try {
    const bundledDir = path.join(root, 'package-agents');
    const globalDir = path.join(root, 'external-agents');
    writeFile(path.join(bundledDir, 'coding', 'AGENTS.md'), '# Bundled Coding\nBundled prompt');
    writeFile(path.join(bundledDir, 'review', 'AGENTS.md'), '# Bundled Review\nReview prompt');
    writeFile(path.join(globalDir, 'coding', 'AGENTS.md'), '# External Coding\nExternal prompt');
    writeFile(path.join(globalDir, 'custom', 'AGENTS.md'), '# Custom\nCustom prompt');

    const profiles = resolveAgentPool({
      bundledAgentsDir: bundledDir,
      globalAgentsDir: globalDir,
      includeWorkspace: false,
    });

    assert.deepEqual(profiles.map((item) => `${item.name}:${item.source}`).sort(), [
      'coding:global',
      'custom:global',
      'review:bundled',
    ]);
    const coding = profiles.find((item) => item.name === 'coding');
    assert.equal(coding?.content.includes('External prompt'), true);
    assert.equal(coding?.source, 'global');
  } finally {
    cleanup(root);
  }
}

function testResolveAgentPoolDoesNotTreatBundledDirAsExternal(): void {
  const root = createTempDir('agent-profiles-bundled-same-dir-');
  try {
    const bundledDir = path.join(root, 'agents');
    writeFile(path.join(bundledDir, 'coding', 'AGENTS.md'), '# Bundled Coding\nBundled prompt');

    const profiles = resolveAgentPool({
      bundledAgentsDir: bundledDir,
      globalAgentsDir: bundledDir,
      includeWorkspace: false,
    });

    assert.deepEqual(profiles.map((item) => `${item.name}:${item.source}`), ['coding:bundled']);
  } finally {
    cleanup(root);
  }
}

function runAll(): void {
  testScanGlobalProfilesAndDuplicateOverride();
  testFrontmatterSummaryPriorityAndDelimiterIgnored();
  testFrontmatterSummaryLengthLimitInRepo();
  testRepositoryAgentProfilesAreNativeAndBounded();
  testWorkspaceProfileLoad();
  testMentionParsingRules();
  testPromptInjectionBlock();
  testSystemSegmentsAreLineCapped();
  testAgentYamlConfigDescriptionWarningsAndPromptAppend();
  testSubagentVisibilityRequiresExternalOptIn();
  testPromptInjectionReference();
  testParseAgentProfilePrompt();
  testResolveAgentPoolWithWorkspaceAndFallbackDescription();
  testResolveAgentPoolLoadsBundledByDefaultAndExternalOverrides();
  testResolveAgentPoolDoesNotTreatBundledDirAsExternal();
  console.log('agent-profiles tests passed');
}

runAll();
