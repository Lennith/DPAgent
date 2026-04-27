import * as assert from 'node:assert/strict';
import type { AgentProfile } from '../../src/agents/AgentProfiles.js';
import {
  mergeAgentInjectionState,
  resolvePromptWithProfiles,
} from '../../src/web/server/prompt-resolution.js';

const PLAN_MODE_PROMPT_PREFIX =
  [
    '[PLAN_MODE_REQUIRED]',
    'You MUST execute this turn in Plan Mode and follow this protocol strictly:',
    '1) First tool call MUST be `update_plan` with an actionable step list.',
    '2) If requirements are ambiguous or choices are needed, call `request_user_input` before implementation.',
    '3) Keep plan status updated with `update_plan` while executing.',
    '4) Final output MUST be produced via `finalize_plan` (Markdown only).',
    '5) Do NOT skip directly to a normal free-form answer.',
    'If any step cannot be completed, explain why in the finalized plan.',
    '[/PLAN_MODE_REQUIRED]',
  ].join('\n');

function createProfile(
  name: string,
  source: AgentProfile['source'],
  filePath: string
): AgentProfile {
  return {
    name,
    normalizedName: name.toLowerCase(),
    description: `${name} profile`,
    mtime: new Date().toISOString(),
    path: filePath,
    content: `${name} content`,
    source,
  };
}

function createInput(overrides: Partial<Parameters<typeof resolvePromptWithProfiles>[0]> = {}) {
  const globalProfile = createProfile('Coder', 'global', 'D:/Agents/Coder/AGENTS.md');
  return {
    prompt: 'Implement login',
    selectedAgentName: '',
    usePlanMode: false,
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
  assert.match(result.effectiveUserPrompt, /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]/);
  assert.match(result.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]\nCoder content\n\[AGENT_PROFILE_BODY_END\]/);
  assert.match(result.historyUserPrompt, /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]\n\nImplement login$/);
  assert.equal(result.historyUserPrompt.includes('Coder content'), false);
  assert.equal(result.agentInjectionState.lastExplicitAgentName, 'Coder');
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

function testMentionedGlobalAgentStripsMentionAndSwitchesOnce(): void {
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
  assert.equal(result.profileInjectionMode, 'switch');
  assert.match(result.historyUserPrompt, /^\[AGENT_PROFILE_REF source=global name=Coder path=D:\/Agents\/Coder\/AGENTS\.md\]\n\nfix the bug$/);
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

function testWorkspaceProfileInjectsOnlyOnInitialTurn(): void {
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
  assert.equal(first.profileInjectionMode, 'initial');
  assert.match(first.historyUserPrompt, /^\[AGENT_PROFILE_REF source=workspace name=workspace path=D:\/Repo\/AGENTS\.md\]\n\nImplement login$/);

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
  assert.equal(second.effectiveUserPrompt, 'plain follow-up');
  assert.equal(second.historyUserPrompt, 'plain follow-up');
}

function testClearingExplicitSelectionFallsBackToWorkspaceOnce(): void {
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
  assert.equal(cleared.profileInjectionMode, 'switch');
  assert.equal(cleared.activeAgent?.source, 'workspace');
  const merged = mergeAgentInjectionState(currentState, cleared.agentInjectionState);
  assert.equal(merged.lastExplicitAgentName, undefined);
  assert.equal(merged.lastProfileSource, 'workspace');
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

function testPlanModeWithoutAgentKeepsPromptPlainAndAnnotated(): void {
  const workspaceProfile = createProfile('workspace', 'workspace', 'D:/Repo/AGENTS.md');
  const initial = resolvePromptWithProfiles(
    createInput({
      loadWorkspaceProfile: () => workspaceProfile,
    })
  );
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    throw new Error(initial.error);
  }
  const currentState = mergeAgentInjectionState(undefined, initial.agentInjectionState);
  const result = resolvePromptWithProfiles(
    createInput({
      prompt: 'Plan the next change',
      usePlanMode: true,
      currentAgentInjectionState: currentState,
      loadWorkspaceProfile: () => workspaceProfile,
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

function runAll(): void {
  testEmptyPromptRejected();
  testSelectedAgentInitialInjectionReturnsEffectiveAndHistoryPrompts();
  testSelectedAgentSameAsCurrentActiveSkipsReinjection();
  testMentionedGlobalAgentStripsMentionAndSwitchesOnce();
  testMentionOnlyErrors();
  testWorkspaceProfileInjectsOnlyOnInitialTurn();
  testClearingExplicitSelectionFallsBackToWorkspaceOnce();
  testUnknownMentionWithoutWorkspaceStaysPlainText();
  testPlanModeWithoutAgentKeepsPromptPlainAndAnnotated();
  console.log('web-prompt-resolution tests passed');
}

runAll();
