import * as assert from 'node:assert/strict';
import {
  resolveChatInputInteractivity,
  resolveComposerPlanModeButtonClick,
  resolveComposerPlanningAction,
} from '../../src/web/client/components/chat/chat-input-interactivity.js';

function testPlanModeIntentIsLocalUntilSend(): void {
  assert.deepEqual(
    resolveComposerPlanModeButtonClick({
      planningState: 'normal',
      planModeIntent: false,
      disabled: false,
    }),
    { kind: 'set_plan_mode_intent', enabled: true }
  );
  assert.deepEqual(
    resolveComposerPlanModeButtonClick({
      planningState: 'normal',
      planModeIntent: true,
      disabled: false,
    }),
    { kind: 'set_plan_mode_intent', enabled: false }
  );
  assert.equal(resolveComposerPlanningAction('normal', false), undefined);
  assert.equal(resolveComposerPlanningAction('normal', true), 'enter_drafting');
}

function testRealPlanStatesKeepServerSideActions(): void {
  assert.deepEqual(
    resolveComposerPlanModeButtonClick({
      planningState: 'plan_drafting',
      planModeIntent: false,
      disabled: false,
    }),
    { kind: 'exit_plan_draft' }
  );
  assert.deepEqual(
    resolveComposerPlanModeButtonClick({
      planningState: 'plan_executing',
      planModeIntent: false,
      disabled: false,
    }),
    { kind: 'exit_plan_execution' }
  );
  assert.equal(resolveComposerPlanningAction('plan_drafting', false), 'enter_drafting');
  assert.equal(resolveComposerPlanningAction('plan_executing', true), undefined);
}

function testActiveWebRunAllowsDraftAndSettingsButNotSubmit(): void {
  const activeRun = resolveChatInputInteractivity({
    isRunning: true,
    isInteractionLocked: true,
    isCanceling: false,
    observeOnly: false,
    hasDraftContent: false,
  });

  assert.equal(activeRun.draftInputDisabled, false);
  assert.equal(activeRun.settingsDisabled, false);
  assert.equal(activeRun.canSubmitMessage, false);
  assert.equal(activeRun.sendButtonMode, 'stop');
}

function testActiveWebRunSendsDraftToRunningQueue(): void {
  const activeRun = resolveChatInputInteractivity({
    isRunning: true,
    isInteractionLocked: true,
    isCanceling: false,
    observeOnly: false,
    hasDraftContent: true,
  });

  assert.equal(activeRun.draftInputDisabled, false);
  assert.equal(activeRun.settingsDisabled, false);
  assert.equal(activeRun.canSubmitMessage, true);
  assert.equal(activeRun.sendButtonMode, 'send');
}

function testObserveOnlyAndCancelingRemainReadOnly(): void {
  const observeOnly = resolveChatInputInteractivity({
    isRunning: true,
    isInteractionLocked: true,
    isCanceling: false,
    observeOnly: true,
    hasDraftContent: true,
  });
  assert.equal(observeOnly.draftInputDisabled, true);
  assert.equal(observeOnly.settingsDisabled, true);
  assert.equal(observeOnly.canSubmitMessage, false);
  assert.equal(observeOnly.sendButtonMode, 'stop');

  const canceling = resolveChatInputInteractivity({
    isRunning: false,
    isInteractionLocked: true,
    isCanceling: true,
    observeOnly: false,
    hasDraftContent: true,
  });
  assert.equal(canceling.draftInputDisabled, true);
  assert.equal(canceling.settingsDisabled, true);
  assert.equal(canceling.canSubmitMessage, false);
}

function testHydratingActiveRunRemainsReadOnly(): void {
  const hydrating = resolveChatInputInteractivity({
    isRunning: true,
    isInteractionLocked: true,
    isHydrating: true,
    observeOnly: false,
    hasDraftContent: true,
  });

  assert.equal(hydrating.draftInputDisabled, true);
  assert.equal(hydrating.settingsDisabled, true);
  assert.equal(hydrating.canSubmitMessage, false);
  assert.equal(hydrating.sendButtonMode, 'stop');
}

testPlanModeIntentIsLocalUntilSend();
testRealPlanStatesKeepServerSideActions();
testActiveWebRunAllowsDraftAndSettingsButNotSubmit();
testActiveWebRunSendsDraftToRunningQueue();
testObserveOnlyAndCancelingRemainReadOnly();
testHydratingActiveRunRemainsReadOnly();

console.log('chat-input-interactivity tests passed');
