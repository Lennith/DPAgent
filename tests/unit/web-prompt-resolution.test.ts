import * as assert from 'node:assert/strict';
import type { AgentProfile } from '../../src/agents/AgentProfiles.js';
import {
  buildFileReferencesPromptBlock,
  mergeAgentInjectionState,
  resolvePromptWithProfiles,
} from '../../src/web/server/prompt-resolution.js';
import { PLAN_MODE_PROMPT_PREFIX as RUNTIME_PLAN_MODE_PROMPT_PREFIX } from '../../src/web/server/web-server-shared.js';

const PLAN_MODE_PROMPT_PREFIX =
  [
    '[PLAN_MODE_REQUIRED]',
    'You MUST execute this turn in Plan Mode and follow this protocol strictly:',
    '1) If requirements are ambiguous or choices are needed, call `request_user_input` before finalizing.',
    '2) Final output MUST be produced via `finalize_plan` with executable steps and detection standards.',
    '3) Do NOT skip directly to a normal free-form answer.',
    'If any step cannot be completed, explain why in the finalized plan.',
    '[/PLAN_MODE_REQUIRED]',
  ].join('\n');

function createProfile(
  name: string,
  source: AgentProfile['source'],
  filePath: string,
  overrides: Partial<AgentProfile> = {}
): AgentProfile {
  return {
    name,
    normalizedName: name.toLowerCase(),
    description: `${name} profile`,
    mtime: new Date().toISOString(),
    path: filePath,
    content: `${name} content`,
    source,
    ...overrides,
  };
}

function createInput(overrides: Partial<Parameters<typeof resolvePromptWithProfiles>[0]> = {}) {
  const globalProfile = createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md');
  return {
    prompt: 'Implement login',
    selectedAgentName: '',
    planningState: 'normal' as const,
    currentAgentInjectionState: undefined,
    globalAgentProfilesByName: new Map([[globalProfile.normalizedName, globalProfile]]),
    loadWorkspaceProfile: () => null,
    planModePromptPrefix: PLAN_MODE_PROMPT_PREFIX,
    ...overrides,
  };
}

function testEmptyPromptRejected(): void {
  const result = resolvePromptWithProfiles(createInput({ prompt: '   ' }));
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'Prompt cannot be empty');
}

function testSelectedAgentInitialInjectionReturnsEffectiveAndHistoryPrompts(): void {
  const result = resolvePromptWithProfiles(createInput({ selectedAgentName: 'Coder' }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.displayPrompt, 'Implement login');
  assert.equal(result.profileInjectionMode, 'initial');
  assert.equal(result.activeAgent?.source, 'global');
  assert.equal(result.activeAgent?.name, 'Coder');
  assert.equal(result.effectiveUserPrompt, 'Implement login');
  assert.doesNotMatch(result.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
  assert.doesNotMatch(result.effectiveUserPrompt, /\[AGENT_PROFILE_REF/);
  assert.match(
    result.historyUserPrompt,
    /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]\n\[AGENT_PROFILE_REF_NOTE\][\s\S]*?\[\/AGENT_PROFILE_REF_NOTE\]\n\nImplement login$/
  );
  assert.equal(result.historyUserPrompt.includes('Coder content'), false);
  assert.equal(result.agentInjectionState.lastExplicitAgentName, 'Coder');
}

function testSelectedAgentReturnsRuntimeOverridesAndPromptAppend(): void {
  const profile = createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md', {
    config: {
      llmProfileId: 'kimi',
      llmModel: 'kimi-agent-model',
      reasoningPreset: 'high',
      loadGlobalSkills: false,
      promptAppend: 'Extra profile guidance.',
    },
  });
  const result = resolvePromptWithProfiles(
    createInput({
      selectedAgentName: 'Coder',
      globalAgentProfilesByName: new Map([[profile.normalizedName, profile]]),
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.deepEqual(result.agentRuntimeOverrides, {
    agentProfile: {
      source: 'global',
      name: 'Coder',
      path: 'D:/Agents/Coder/AGENTS.md',
    },
    llmProfileId: 'kimi',
    llmModel: 'kimi-agent-model',
    reasoningPreset: 'high',
    loadGlobalSkills: false,
  });
  assert.doesNotMatch(result.effectiveUserPrompt, /Extra profile guidance\./);
}

function testActiveAgentFollowUpKeepsRuntimeOverrides(): void {
  const profile = createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md', {
    config: {
      llmProfileId: 'kimi',
      llmModel: 'kimi-agent-model',
    },
  });
  const selected = resolvePromptWithProfiles(
    createInput({
      selectedAgentName: 'Coder',
      globalAgentProfilesByName: new Map([[profile.normalizedName, profile]]),
    })
  );
  assert.equal(selected.ok, true);
  if (!selected.ok) {
    throw new Error(selected.error);
  }
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: 'Follow up',
      selectedAgentName: 'Coder',
      currentAgentInjectionState: mergeAgentInjectionState(undefined, selected.agentInjectionState),
      globalAgentProfilesByName: new Map([[profile.normalizedName, profile]]),
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.profileInjectionMode, 'none');
  assert.deepEqual(result.agentRuntimeOverrides, {
    agentProfile: {
      source: 'global',
      name: 'Coder',
      path: 'D:/Agents/Coder/AGENTS.md',
    },
    llmProfileId: 'kimi',
    llmModel: 'kimi-agent-model',
  });
}

function testSelectedAgentSameAsCurrentActiveSkipsReinjection(): void {
  const selected = resolvePromptWithProfiles(createInput({ selectedAgentName: 'Coder' }));
  assert.equal(selected.ok, true);
  if (!selected.ok) {
    throw new Error(selected.error);
  }
  const currentState = mergeAgentInjectionState(undefined, selected.agentInjectionState);
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: 'Follow up',
      selectedAgentName: 'Coder',
      currentAgentInjectionState: currentState,
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.profileInjectionMode, 'none');
  assert.equal(result.displayPrompt, 'Follow up');
  assert.equal(result.effectiveUserPrompt, 'Follow up');
  assert.equal(result.historyUserPrompt, 'Follow up');
  assert.equal(result.promptRef, undefined);
}

function testMentionedGlobalAgentStripsMentionAndInjectsRoleOnce(): void {
  const workspaceProfile = createProfile('workspace', 'workspace', 'D:/Repo/AGENTS.md');
  const workspaceResolved = resolvePromptWithProfiles(
    createInput({
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(workspaceResolved.ok, true);
  if (!workspaceResolved.ok) {
    throw new Error(workspaceResolved.error);
  }
  const currentState = mergeAgentInjectionState(undefined, workspaceResolved.agentInjectionState);
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: '@Coder fix the bug',
      currentAgentInjectionState: currentState,
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.displayPrompt, 'fix the bug');
  assert.equal(result.profileInjectionMode, 'initial');
  assert.equal(result.effectiveUserPrompt, 'fix the bug');
  assert.doesNotMatch(result.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
  assert.match(
    result.historyUserPrompt,
    /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]\n\[AGENT_PROFILE_REF_NOTE\][\s\S]*?\[\/AGENT_PROFILE_REF_NOTE\]\n\nfix the bug$/
  );
  assert.equal(result.agentInjectionState.lastExplicitAgentName, 'Coder');
}

function testMentionOnlyErrors(): void {
  const result = resolvePromptWithProfiles(createInput({ prompt: '@Coder' }));
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('expected error');
  }
  assert.equal(result.error, 'Please enter a message after @Coder');
}

function testWorkspaceProfileDoesNotBecomeActiveAgent(): void {
  const workspaceProfile = createProfile('workspace', 'workspace', 'D:/Repo/AGENTS.md');
  const first = resolvePromptWithProfiles(
    createInput({
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(first.ok, true);
  if (!first.ok) {
    throw new Error(first.error);
  }
  assert.equal(first.profileInjectionMode, 'none');
  assert.equal(first.activeAgent, undefined);
  assert.equal(first.effectiveUserPrompt, 'Implement login');
  assert.equal(first.historyUserPrompt, 'Implement login');

  const currentState = mergeAgentInjectionState(undefined, first.agentInjectionState);
  const second = resolvePromptWithProfiles(
    createInput({
      prompt: 'plain follow-up',
      currentAgentInjectionState: currentState,
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(second.ok, true);
  if (!second.ok) {
    throw new Error(second.error);
  }
  assert.equal(second.profileInjectionMode, 'none');
  assert.equal(second.activeAgent, undefined);
  assert.equal(second.effectiveUserPrompt, 'plain follow-up');
  assert.equal(second.historyUserPrompt, 'plain follow-up');
}

function testClearingExplicitSelectionReturnsToDefaultRoleState(): void {
  const workspaceProfile = createProfile('workspace', 'workspace', 'D:/Repo/AGENTS.md');
  const selected = resolvePromptWithProfiles(createInput({ selectedAgentName: 'Coder' }));
  assert.equal(selected.ok, true);
  if (!selected.ok) {
    throw new Error(selected.error);
  }
  const currentState = mergeAgentInjectionState(undefined, selected.agentInjectionState);
  const cleared = resolvePromptWithProfiles(
    createInput({
      prompt: 'Check repo status',
      currentAgentInjectionState: currentState,
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(cleared.ok, true);
  if (!cleared.ok) {
    throw new Error(cleared.error);
  }
  assert.equal(cleared.profileInjectionMode, 'none');
  assert.equal(cleared.activeAgent, undefined);
  assert.equal(cleared.effectiveUserPrompt, 'Check repo status');
  assert.doesNotMatch(cleared.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
  const merged = mergeAgentInjectionState(currentState, cleared.agentInjectionState);
  assert.equal(merged.lastExplicitAgentName, undefined);
  assert.equal(merged.lastProfileSource, undefined);

  const clearedInPlanMode = resolvePromptWithProfiles(
    createInput({
      prompt: 'Plan the default follow-up',
      currentAgentInjectionState: currentState,
      planningState: 'plan_drafting',
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(clearedInPlanMode.ok, true);
  if (!clearedInPlanMode.ok) {
    throw new Error(clearedInPlanMode.error);
  }
  assert.equal(clearedInPlanMode.activeAgent, undefined);
  assert.match(clearedInPlanMode.effectiveUserPrompt, /^\[PLAN_MODE_REQUIRED\]/);
  assert.match(clearedInPlanMode.promptRef ?? '', /reason=cleared_agent/);
  assert.match(clearedInPlanMode.promptRef ?? '', /plan_mode=true/);
}

function testUnknownMentionWithoutWorkspaceStaysPlainText(): void {
  const result = resolvePromptWithProfiles(createInput({ prompt: '@Unknown fix the bug' }));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.displayPrompt, '@Unknown fix the bug');
  assert.equal(result.activeAgent, undefined);
  assert.equal(result.profileInjectionMode, 'none');
  assert.equal(result.effectiveUserPrompt, '@Unknown fix the bug');
  assert.equal(result.historyUserPrompt, '@Unknown fix the bug');
}

function testFileDirectiveMentionNeverRoutesAsAgent(): void {
  const fileAgent = createProfile('file', 'global', 'D:/Agents/File/AGENTS.md');
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: '@file D:\\repo\\README.md',
      globalAgentProfilesByName: new Map([
        ['coder', createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md')],
        ['file', fileAgent],
      ]),
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.displayPrompt, '@file D:\\repo\\README.md');
  assert.equal(result.profileInjectionMode, 'none');
  assert.equal(result.activeAgent, undefined);
  assert.equal(result.effectiveUserPrompt, '@file D:\\repo\\README.md');
  assert.equal(result.historyUserPrompt, '@file D:\\repo\\README.md');
}

function testMultiAgentResolutionSequenceKeepsBodiesOutOfUserPrompt(): void {
  const coder = createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md');
  const reviewer = createProfile('Reviewer', 'global', 'D:/Agents/Reviewer/AGENTS.md', {
    content: 'Reviewer content',
  });
  const profiles = new Map([
    [coder.normalizedName, coder],
    [reviewer.normalizedName, reviewer],
  ]);

  const selected = resolvePromptWithProfiles(
    createInput({
      prompt: 'Implement login',
      selectedAgentName: 'Coder',
      globalAgentProfilesByName: profiles,
    })
  );
  assert.equal(selected.ok, true);
  if (!selected.ok) {
    throw new Error(selected.error);
  }
  assert.equal(selected.effectiveUserPrompt, 'Implement login');
  assert.doesNotMatch(selected.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
  assert.equal(selected.activeAgent?.name, 'Coder');

  const selectedState = mergeAgentInjectionState(undefined, selected.agentInjectionState);
  const selectedFollowUp = resolvePromptWithProfiles(
    createInput({
      prompt: 'Continue implementation',
      selectedAgentName: 'Coder',
      currentAgentInjectionState: selectedState,
      globalAgentProfilesByName: profiles,
    })
  );
  assert.equal(selectedFollowUp.ok, true);
  if (!selectedFollowUp.ok) {
    throw new Error(selectedFollowUp.error);
  }
  assert.equal(selectedFollowUp.profileInjectionMode, 'none');
  assert.equal(selectedFollowUp.activeAgent?.name, 'Coder');
  assert.deepEqual(selectedFollowUp.agentRuntimeOverrides?.agentProfile, {
    source: 'global',
    name: 'Coder',
    path: 'D:/Agents/Coder/AGENTS.md',
  });
  assert.doesNotMatch(selectedFollowUp.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);

  const mentionedReviewer = resolvePromptWithProfiles(
    createInput({
      prompt: '@Reviewer review the patch',
      currentAgentInjectionState: mergeAgentInjectionState(selectedState, selectedFollowUp.agentInjectionState),
      globalAgentProfilesByName: profiles,
    })
  );
  assert.equal(mentionedReviewer.ok, true);
  if (!mentionedReviewer.ok) {
    throw new Error(mentionedReviewer.error);
  }
  assert.equal(mentionedReviewer.displayPrompt, 'review the patch');
  assert.equal(mentionedReviewer.effectiveUserPrompt, 'review the patch');
  assert.equal(mentionedReviewer.activeAgent?.name, 'Reviewer');
  assert.doesNotMatch(mentionedReviewer.effectiveUserPrompt, /Reviewer content/);

  const cleared = resolvePromptWithProfiles(
    createInput({
      prompt: 'Back to default',
      currentAgentInjectionState: mergeAgentInjectionState(selectedState, mentionedReviewer.agentInjectionState),
      globalAgentProfilesByName: profiles,
    })
  );
  assert.equal(cleared.ok, true);
  if (!cleared.ok) {
    throw new Error(cleared.error);
  }
  assert.equal(cleared.activeAgent, undefined);
  assert.equal(cleared.agentRuntimeOverrides, undefined);
  assert.equal(cleared.effectiveUserPrompt, 'Back to default');
  assert.match(cleared.promptRef ?? '', /reason=cleared_agent/);
  assert.doesNotMatch(cleared.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
}

function testPlanModeWithoutAgentKeepsPromptPlainAndAnnotated(): void {
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: 'Plan the next change',
      planningState: 'plan_drafting',
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.profileInjectionMode, 'none');
  assert.match(result.effectiveUserPrompt, /^\[PLAN_MODE_REQUIRED\]/);
  assert.equal(result.historyUserPrompt, 'Plan the next change');
  assert.match(result.promptRef ?? '', /^\[PROMPT_REF reason=plan_mode /);
}

function testRuntimePlanModePromptEncouragesConversationalClarification(): void {
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /Keep asking until/i);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /You SHOULD ask many questions/);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /product requirements/i);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /complex project/i);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /subagents/i);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /request_user_input/);
  assert.match(RUNTIME_PLAN_MODE_PROMPT_PREFIX, /finalize_plan/);
}

function testFileReferencesOnlyAffectEffectivePrompt(): void {
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: 'Summarize',
      fileReferences: ['D:\\repo\\README.md', 'D:\\repo\\"quoted"&<tag>.md'],
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  assert.equal(result.displayPrompt, 'Summarize');
  assert.equal(result.historyUserPrompt, 'Summarize');
  assert.match(result.effectiveUserPrompt, /^<refs_file_for_this_turn>/);
  assert.match(result.effectiveUserPrompt, /<file path="D:\\repo\\README\.md" \/>/);
  assert.match(result.effectiveUserPrompt, /&quot;quoted&quot;&amp;&lt;tag&gt;/);
}

function testBuildFileReferencesPromptBlockDedupesReferences(): void {
  assert.equal(
    buildFileReferencesPromptBlock(['D:\\repo\\README.md', 'd:\\repo\\readme.md']),
    '<refs_file_for_this_turn>\n  <file path="D:\\repo\\README.md" />\n</refs_file_for_this_turn>'
  );
}

function runAll(): void {
  testEmptyPromptRejected();
  testSelectedAgentInitialInjectionReturnsEffectiveAndHistoryPrompts();
  testSelectedAgentReturnsRuntimeOverridesAndPromptAppend();
  testActiveAgentFollowUpKeepsRuntimeOverrides();
  testSelectedAgentSameAsCurrentActiveSkipsReinjection();
  testMentionedGlobalAgentStripsMentionAndInjectsRoleOnce();
  testMentionOnlyErrors();
  testWorkspaceProfileDoesNotBecomeActiveAgent();
  testClearingExplicitSelectionReturnsToDefaultRoleState();
  testUnknownMentionWithoutWorkspaceStaysPlainText();
  testFileDirectiveMentionNeverRoutesAsAgent();
  testMultiAgentResolutionSequenceKeepsBodiesOutOfUserPrompt();
  testPlanModeWithoutAgentKeepsPromptPlainAndAnnotated();
  testRuntimePlanModePromptEncouragesConversationalClarification();
  testFileReferencesOnlyAffectEffectivePrompt();
  testBuildFileReferencesPromptBlockDedupesReferences();
  console.log('web-prompt-resolution tests passed');
}

runAll();
