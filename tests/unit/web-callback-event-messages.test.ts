import * as assert from 'node:assert/strict';
import { createCallbackEventMessageFactory } from '../../src/web/server/callback-event-messages.js';
import type { ContextRef, PlanInputRequest } from '../../src/types.js';

function createRequest(): PlanInputRequest {
  return {
    requestId: 'req-1',
    questions: [
      {
        header: 'Mode',
        id: 'mode',
        question: 'Pick a mode',
        options: [
          { label: 'Fast', description: 'Speed first' },
          { label: 'Safe', description: 'Risk first' },
        ],
      },
    ],
  };
}

function createFinalizePlanApprovalRequest(): PlanInputRequest & { planPreview: unknown } {
  return {
    ...createRequest(),
    source: 'finalize_plan_approval',
    planPreview: {
      planId: 'plan-1',
      title: 'Rendered Plan',
      summary: 'Show the final plan before approval.',
      markdown: '### Rendered Plan\n\n### Summary\nShow the final plan before approval.',
      steps: [
        {
          planStepId: 'step-001',
          work: 'Render the finalized plan.',
          detectionStandard: 'The approval card displays plan content.',
          priority: 'high',
          tags: ['ui'],
        },
      ],
      testPlan: ['Render approval card'],
      assumptions: ['Use existing plan mode flow'],
      notes: '',
    },
  };
}

function withoutCreatedAt(message: ReturnType<ReturnType<typeof createCallbackEventMessageFactory>['message']>) {
  const data = { ...(message.data as Record<string, unknown>) };
  delete data.createdAt;
  return {
    ...message,
    data,
  };
}

function testSimpleRunScopedMessagesReuseEnvelope(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const factory = createCallbackEventMessageFactory({ runId: 'run-1', context });

  assert.deepEqual(withoutCreatedAt(factory.thinking('plan first')), {
    type: 'thinking',
    data: {
      runId: 'run-1',
      context,
      thinking: 'plan first',
    },
  });

  assert.deepEqual(withoutCreatedAt(factory.toolCall('request_user_input', { questions: 1 })), {
    type: 'tool_call',
    data: {
      runId: 'run-1',
      context,
      name: 'request_user_input',
      args: { questions: 1 },
    },
  });

  assert.deepEqual(withoutCreatedAt(factory.toolResult('request_user_input', { success: true, content: 'done' })), {
    type: 'tool_result',
    data: {
      runId: 'run-1',
      context,
      name: 'request_user_input',
      result: { success: true, content: 'done' },
    },
  });

  assert.deepEqual(factory.step(2, 5), {
    type: 'step',
    data: {
      runId: 'run-1',
      context,
      step: 2,
      maxSteps: 5,
    },
  });

  assert.deepEqual(factory.error('run_error'), {
    type: 'error',
    data: {
      runId: 'run-1',
      context,
      error: 'run_error',
    },
  });

  assert.deepEqual(factory.memoryTrigger({ title: 'Workspace preference', content: 'Use PowerShell.', scope: 'workspace' }), {
    type: 'memory_trigger',
    data: {
      runId: 'run-1',
      context,
      title: 'Workspace preference',
      content: 'Use PowerShell.',
      scope: 'workspace',
    },
  });

  assert.deepEqual(factory.skillTrigger({ name: 'release-workflow', action: 'update', target: 'workspace', version: '3' }), {
    type: 'skill_trigger',
    data: {
      runId: 'run-1',
      context,
      name: 'release-workflow',
      action: 'update',
      target: 'workspace',
      version: '3',
    },
  });
}

function testStreamingMessagesExposeServerCreatedAt(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const factory = createCallbackEventMessageFactory({ runId: 'run-1', context });
  const messageTypes = [
    factory.thinking('plan first'),
    factory.toolCall('read_file', { path: 'README.md' }, 'tool-1'),
    factory.toolResult('read_file', { success: true, content: 'ok' }),
    factory.message('assistant', 'hello'),
    factory.complete('done'),
  ];

  for (const message of messageTypes) {
    const data = message.data as { createdAt?: string };
    assert.equal(typeof data.createdAt, 'string');
    assert.ok(Number.isFinite(Date.parse(data.createdAt ?? '')));
  }
}

function testContextMessagesPreserveProtocolFields(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const factory = createCallbackEventMessageFactory({ runId: 'run-1', context });

  assert.deepEqual(
    factory.contextUtilization({
      observedAt: '2026-04-05T00:00:00.000Z',
      ratio: 0.85,
      usedChars: 3400,
      limitChars: 4000,
      usedTokens: 1700,
      limitTokens: 2000,
      triggerRatio: 0.8,
      isWarning: true,
      message: 'Context approaching capacity - compression triggered',
    }),
    {
      type: 'context_utilization',
      data: {
        runId: 'run-1',
        context,
        observedAt: '2026-04-05T00:00:00.000Z',
        ratio: 0.85,
        utilizationRatio: 0.85,
        usedChars: 3400,
        limitChars: 4000,
        usedTokens: 1700,
        limitTokens: 2000,
        triggerRatio: 0.8,
        isWarning: true,
        message: 'Context approaching capacity - compression triggered',
      },
    }
  );

  assert.deepEqual(
    factory.contextPrecompress({
      phase: 'running',
      observedAt: '2026-04-05T00:00:30.000Z',
      ratio: 0.82,
      usedChars: 3280,
      limitChars: 4000,
      usedTokens: 1640,
      limitTokens: 2000,
      checkpointId: null,
      failureReason: 'compress_timeout',
      willRetriggerNextTurn: false,
      providerPayloadCharsAfter: 3200,
      providerPayloadTokensAfter: 1600,
    }),
    {
      type: 'context_precompress',
      data: {
        runId: 'run-1',
        context,
        phase: 'running',
        observedAt: '2026-04-05T00:00:30.000Z',
        ratio: 0.82,
        usedChars: 3280,
        limitChars: 4000,
        usedTokens: 1640,
        limitTokens: 2000,
        checkpointId: null,
        failureReason: 'compress_timeout',
        willRetriggerNextTurn: false,
        providerPayloadCharsAfter: 3200,
        providerPayloadTokensAfter: 1600,
      },
    }
  );

  assert.deepEqual(
    factory.contextOverflow({
      observedAt: '2026-04-05T00:01:00.000Z',
      error: 'max_tokens',
      stage: 'overflow_detected',
      checkpointId: 'snap-1',
      usedTokens: 1950,
      limitTokens: 2000,
    }),
    {
      type: 'context_overflow',
      data: {
        runId: 'run-1',
        context,
        observedAt: '2026-04-05T00:01:00.000Z',
        error: 'max_tokens',
        stage: 'overflow_detected',
        checkpointId: 'snap-1',
        usedTokens: 1950,
        limitTokens: 2000,
      },
    }
  );
}

function testPlanInputAndCompletionMessagesPreserveSpecialFields(): void {
  const sessionContext: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const sessionFactory = createCallbackEventMessageFactory({ runId: 'run-1', context: sessionContext });

  assert.deepEqual(sessionFactory.planInputRequested(createRequest()), {
    type: 'plan_input_requested',
    data: {
      runId: 'run-1',
      context: sessionContext,
      requestId: 'req-1',
      questions: createRequest().questions,
    },
  });

  const approvalRequest = createFinalizePlanApprovalRequest();
  assert.deepEqual(sessionFactory.planInputRequested(approvalRequest), {
    type: 'plan_input_requested',
    data: {
      runId: 'run-1',
      context: sessionContext,
      requestId: 'req-1',
      source: 'finalize_plan_approval',
      questions: approvalRequest.questions,
      planPreview: approvalRequest.planPreview,
    },
  });

  assert.deepEqual(withoutCreatedAt(sessionFactory.complete('done')), {
    type: 'complete',
    data: {
      runId: 'run-1',
      context: sessionContext,
      content: 'done',
      completionMarkerStats: null,
      sessionId: 'sess-1',
    },
  });

  const workspaceContext: ContextRef = { scope: 'workspace', namespace: 'repo' };
  const workspaceFactory = createCallbackEventMessageFactory({ runId: 'run-2', context: workspaceContext });
  assert.deepEqual(withoutCreatedAt(workspaceFactory.complete('done')), {
    type: 'complete',
    data: {
      runId: 'run-2',
      context: workspaceContext,
      content: 'done',
      completionMarkerStats: null,
      sessionId: undefined,
    },
  });

  assert.deepEqual(
    sessionFactory.runTerminal(
      {
        runId: 'run-1',
        runFamilyId: 'family-1',
        draftId: 'draft-1',
        terminalCode: 'error',
        lastSafeStep: 12,
        maxSteps: 100,
        replayCutoffKind: 'checkpoint',
        errorSummary: 'read ECONNRESET',
        createdAt: '2026-04-26T10:00:00.000Z',
        artifact: {
          artifactId: 'artifact-1',
          context: sessionContext,
          draftId: 'draft-1',
          turnId: 'turn-1',
          runId: 'run-1',
          runFamilyId: 'family-1',
          terminalCode: 'error',
          replayCutoffKind: 'checkpoint',
          lastSafeStep: 12,
          maxSteps: 100,
          errorSummary: 'read ECONNRESET',
          createdAt: '2026-04-26T10:00:00.000Z',
          updatedAt: '2026-04-26T10:00:00.000Z',
          previewMessages: [],
          sideEffectLedger: [],
        },
      },
    ),
    {
      type: 'run_terminal',
      data: {
        runId: 'run-1',
        context: sessionContext,
        runFamilyId: 'family-1',
        draftId: 'draft-1',
        terminalCode: 'error',
        lastSafeStep: 12,
        maxSteps: 100,
        replayCutoffKind: 'checkpoint',
        errorSummary: 'read ECONNRESET',
        createdAt: '2026-04-26T10:00:00.000Z',
        artifact: {
          artifactId: 'artifact-1',
          context: sessionContext,
          draftId: 'draft-1',
          turnId: 'turn-1',
          runId: 'run-1',
          runFamilyId: 'family-1',
          terminalCode: 'error',
          replayCutoffKind: 'checkpoint',
          lastSafeStep: 12,
          maxSteps: 100,
          errorSummary: 'read ECONNRESET',
          createdAt: '2026-04-26T10:00:00.000Z',
          updatedAt: '2026-04-26T10:00:00.000Z',
          previewMessages: [],
          sideEffectLedger: [],
        },
        sessionId: 'sess-1',
      },
    }
  );
}

function testAutoLoopAndChatStartedMessagesKeepRunScope(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };
  const factory = createCallbackEventMessageFactory({ runId: 'run-9', context });

  assert.deepEqual(factory.autoLoopStopped('done', 3), {
    type: 'auto_loop_stopped',
    data: {
      runId: 'run-9',
      context,
      reason: 'done',
      totalRounds: 3,
    },
  });

  assert.deepEqual(factory.autoLoopRound(4, 'Continue'), {
    type: 'auto_loop_round',
    data: {
      runId: 'run-9',
      context,
      round: 4,
      prompt: 'Continue',
    },
  });

  assert.deepEqual(factory.chatStarted('2026-04-05T00:02:00.000Z'), {
    type: 'chat_started',
    data: {
      runId: 'run-9',
      context,
      startedAt: '2026-04-05T00:02:00.000Z',
    },
  });

  assert.deepEqual(
    factory.chatStarted('2026-04-05T00:03:00.000Z', {
      profileId: 'profile-kimi',
      provider: 'anthropic',
      apiKey: 'sk-test',
      apiBase: 'https://api.kimi.com/coding/',
      model: 'kimi-for-coding',
      maxOutputTokens: 32768,
      reasoningPreset: 'off',
      capabilities: {
        reasoningEffort: false,
        thinkingBudget: true,
      },
    }),
    {
      type: 'chat_started',
      data: {
        runId: 'run-9',
        context,
        startedAt: '2026-04-05T00:03:00.000Z',
        llmRuntime: {
          profileId: 'profile-kimi',
          provider: 'anthropic',
          model: 'kimi-for-coding',
          reasoningPreset: 'off',
        },
      },
    }
  );

  const cliFactory = createCallbackEventMessageFactory({
    runId: 'run-cli',
    context,
    origin: 'cli',
    owner: 'cli',
    interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
  });
  assert.deepEqual(cliFactory.chatStarted('2026-04-05T00:04:00.000Z'), {
    type: 'chat_started',
    data: {
      runId: 'run-cli',
      context,
      startedAt: '2026-04-05T00:04:00.000Z',
      origin: 'cli',
      owner: 'cli',
      interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
    },
  });
}

function runAll(): void {
  testSimpleRunScopedMessagesReuseEnvelope();
  testStreamingMessagesExposeServerCreatedAt();
  testContextMessagesPreserveProtocolFields();
  testPlanInputAndCompletionMessagesPreserveSpecialFields();
  testAutoLoopAndChatStartedMessagesKeepRunScope();
  console.log('web-callback-event-messages tests passed');
}

runAll();
