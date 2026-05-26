import {
  isMiniMaxContextWindowExceededError,
  isMiniMaxToolResultIdNotFoundError,
  type LLMRuntime,
} from '../llm/index.js';
import { agentLogger } from '../utils/logger.js';
import { resolveForcedTrimChars } from '../runtime/context-reduction-policy.js';
import { tokensToCharHint } from '../shared/context-token-estimation.js';
import type {
  AgentCallback,
  ContextOverflowEvent,
  ContextWindowTrimOptions,
  LLMResponse,
  MaxTokensRecoveryEvent,
  Message,
  ResolvedContextBudget,
  TokenUsage,
  ToolSchema,
} from '../types.js';
import {
  DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS,
  decideContextOverflowRecovery,
  isRetriableTransportError,
  shouldRetryTransportBeforeVisibleOutput,
} from './TurnRecoveryPolicy.js';
import type { AgentRunResult, PreparedInputUsageEstimateResult } from './agent-contracts.js';
import {
  estimateAgentMessagesChars,
  formatProviderErrorDiagnostics,
  formatTokenUsage,
} from './agent-message-utils.js';
import { applyInputHookModified } from './AgentHookEffectApplier.js';
import { completeAgentTurn } from './AgentTurnCompletionService.js';
import type { HookContext, HookExecutionResult, HookRunner } from '../hooks/index.js';

type LlmAttemptSnapshotStage = 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim';

export interface AgentLlmAttemptHost {
  llm: LLMRuntime;
  tools: { getSchemas(): ToolSchema[] };
  callback?: AgentCallback;
  hookRunner?: HookRunner;
  abortController: AbortController;
  sessionId: string | null;
  contextBudget: ResolvedContextBudget;
  contextOverflowMaxErrorsBeforeTrim: number;
  contextPrecompressKeepLlmRounds: number;
  contextPrecompressAggressiveKeepLlmRoundsCap: number;
  prepareLlmInput(options?: {
    precompressMode?: 'light' | 'aggressive' | 'disabled';
    forcePrecompress?: boolean;
    keepLlmRoundsOverride?: number;
  }): Promise<{
    systemPrompt?: string;
    contentMessages: Message[];
    precompressEvent: {
      mode?: string;
      applied?: boolean;
      phase?: string;
      totalCharsAfter?: number;
      providerPayloadTokensAfter?: number;
      keepLlmRoundsApplied?: number;
      chunkCount?: number;
      retryCount?: number;
      failureReason?: string;
    };
    profileRuntime: {
      sourceName?: string;
      sourcePath?: string;
      failureReason?: string;
    };
  }>;
  buildNormalTrimOptions(): ContextWindowTrimOptions;
  buildForcedTrimOptions(): ContextWindowTrimOptions;
  buildPreparedInputUsageEstimate(
    contentMessages: Message[],
    systemPrompt: string,
    options: { snapshotStage: string }
  ): PreparedInputUsageEstimateResult;
  emitContextUsageEstimate(estimate: unknown, stage: string): Promise<void>;
  executeHookPoint(event: string, context: HookContext): Promise<HookExecutionResult>;
  completeCancelledRun(input: {
    step: number;
    usage?: TokenUsage;
    recoveredFromMaxTokens: boolean;
    maxTokensRecoveryAttempt: number;
    maxTokensEvents: MaxTokensRecoveryEvent[];
  }): AgentRunResult;
  saveInterruptedStreamCheckpoint(input: { step: number; content: string }): Promise<boolean>;
  emitContextOverflowEvent(event: ContextOverflowEvent): Promise<void>;
  applyForcedTrimToMessages(): {
    beforeMessageCount: number;
    beforeChars: number;
    afterMessageCount: number;
    afterChars: number;
  };
  turnRecoveryOrchestrator: {
    handleToolCallProtocolRecovery(input: {
      errorRaw: string;
      consecutiveFailureCount: number;
    }): { nextCount: number; escalationError?: Error; recovered: boolean };
  };
}

export type AgentLlmAttemptLoopResult =
  | {
      kind: 'terminal';
      result: AgentRunResult;
      consecutiveToolCallProtocolFailures: number;
    }
  | {
      kind: 'response';
      response: LLMResponse;
      recoveredToolProtocol: boolean;
      activeSystemPrompt: string;
      latestPreparedInputEstimate:
        | ReturnType<AgentLlmAttemptHost['buildPreparedInputUsageEstimate']>
        | undefined;
      consecutiveToolCallProtocolFailures: number;
    };

export async function runAgentLlmAttemptLoop(
  host: AgentLlmAttemptHost,
  input: {
    step: number;
    lastUsage?: TokenUsage;
    consecutiveToolCallProtocolFailures: number;
    recoveredFromMaxTokens: boolean;
    maxTokensRecoveryAttempt: number;
    maxTokensEvents: MaxTokensRecoveryEvent[];
  }
): Promise<AgentLlmAttemptLoopResult> {
  let response: LLMResponse | undefined;
  let recoveredToolProtocol = false;
  let overflowCountInTurn = 0;
  let pendingPreparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>> | null = null;
  let pendingPrecompressMode: 'light' | 'aggressive' | 'disabled' = 'light';
  let pendingForcePrecompress = false;
  let pendingKeepLlmRoundsOverride: number | undefined = undefined;
  let snapshotStage: LlmAttemptSnapshotStage = 'initial';
  let trimOptions = host.buildNormalTrimOptions();
  let llmAttempt = 0;
  let transportRetryCount = 0;
  let activeSystemPrompt = '';
  let latestPreparedInputEstimate: ReturnType<AgentLlmAttemptHost['buildPreparedInputUsageEstimate']> | undefined;
  let consecutiveToolCallProtocolFailures = input.consecutiveToolCallProtocolFailures;

  while (!response) {
    const preparedInput =
      pendingPreparedInput ??
      (await host.prepareLlmInput({
        precompressMode: pendingPrecompressMode,
        forcePrecompress: pendingForcePrecompress,
        keepLlmRoundsOverride: pendingKeepLlmRoundsOverride,
      }));
    pendingPreparedInput = null;
    pendingPrecompressMode = 'disabled';
    pendingForcePrecompress = false;
    pendingKeepLlmRoundsOverride = undefined;

    let systemPrompt = preparedInput.systemPrompt;
    activeSystemPrompt = systemPrompt ?? '';
    let contentMessages = preparedInput.contentMessages;
    const beforeChars = estimateAgentMessagesChars(contentMessages) + (systemPrompt?.length ?? 0);
    const beforeMessageCount = contentMessages.length;
    const preparedInputEstimate = host.buildPreparedInputUsageEstimate(contentMessages, activeSystemPrompt, {
      snapshotStage,
    });
    latestPreparedInputEstimate = preparedInputEstimate;
    const staticEstimatedInputTokens = preparedInputEstimate.staticEstimate.inputTokens;
    const estimatedInputTokens = preparedInputEstimate.effectiveEstimate.inputTokens;
    await host.emitContextUsageEstimate(preparedInputEstimate, 'preflight');
    llmAttempt += 1;
    let streamedVisibleOutput = false;
    let streamedTextBuffer = '';

    try {
      const turnRuntime = host.llm.getRuntimeConfig?.();
      agentLogger.info(
        `[DPAgent] LLM turn start: step=${input.step + 1} attempt=${llmAttempt} profile=${turnRuntime?.profileId ?? 'unknown'} provider=${turnRuntime?.provider ?? 'unknown'} model=${turnRuntime?.model ?? 'unknown'} reasoning=${turnRuntime?.reasoningPreset ?? 'unknown'}`
      );
      agentLogger.info(
        `[DPAgent] LLM input budget: step=${input.step + 1} attempt=${llmAttempt} snapshotStage=${snapshotStage} beforeChars=${beforeChars} staticEstimatedInputTokens=${staticEstimatedInputTokens} calibratedEstimatedInputTokens=${preparedInputEstimate.calibratedEstimate.inputTokens} anchorPromptTokens=${preparedInputEstimate.anchorPromptTokens ?? 0} deltaEstimatedTokens=${preparedInputEstimate.deltaEstimatedTokens ?? 0} effectiveEstimatedInputTokens=${estimatedInputTokens} calibrationMultiplier=${preparedInputEstimate.calibrationMultiplier.toFixed(3)} contextWindowTokens=${host.contextBudget.contextWindowTokens} safeInputTokens=${host.contextBudget.safeInputTokens} triggerTokens=${host.contextBudget.compressionTriggerTokens} precompressMode=${preparedInput.precompressEvent.mode} precompressApplied=${preparedInput.precompressEvent.applied} precompressPhase=${preparedInput.precompressEvent.phase ?? 'idle'} precompressAfterChars=${preparedInput.precompressEvent.totalCharsAfter}`
      );
      if (systemPrompt) {
        agentLogger.debug(`Prepared system prompt, length: ${systemPrompt.length}`);
      }
      const inputCtx = { event: 'onInputToLLM' as const, sessionId: host.sessionId ?? '', step: input.step, systemPrompt, contentMessages, precompressApplied: preparedInput.precompressEvent.applied };
      const inputResult = await host.executeHookPoint('onInputToLLM', inputCtx as HookContext);
      if (inputResult.blocked) {
        const msg = host.hookRunner?.buildBlockedResponse(inputResult, 'onInputToLLM') ?? 'Input blocked by hook';
        return {
          kind: 'terminal',
          result: await completeAgentTurn(host, {
            content: msg,
            finishReason: 'hook_blocked',
            step: input.step + 1,
          }),
          consecutiveToolCallProtocolFailures,
        };
      }
      const modifiedInput = applyInputHookModified({
        modified: inputResult.modified,
        systemPrompt,
        contentMessages,
      });
      systemPrompt = modifiedInput.systemPrompt;
      activeSystemPrompt = systemPrompt ?? '';
      contentMessages = modifiedInput.contentMessages;
      response = await host.llm.generatePreparedWithCallbacks(
        contentMessages,
        {
          onThinking: (thinking) => {
            streamedVisibleOutput = true;
            agentLogger.llmStreamEvent('thinking', thinking);
            host.callback?.onThinking?.(thinking);
          },
          onText: (text) => {
            streamedVisibleOutput = true;
            streamedTextBuffer += text;
            agentLogger.llmStreamEvent('text', text);
            host.callback?.onMessage?.('assistant', text);
          },
          onToolUse: (_id, name, _input) => {
            streamedVisibleOutput = true;
            agentLogger.llmStreamEvent('tool_use', `Tool: ${name}`);
          },
          onComplete: () => {
            agentLogger.debug('LLM onComplete');
          },
        },
        host.tools.getSchemas(),
        systemPrompt,
        {
          trimOptions,
          snapshotStage,
          signal: host.abortController.signal,
        }
      );
      agentLogger.debug('generateWithCallbacks returned');
      consecutiveToolCallProtocolFailures = 0;
      agentLogger.info(
        `[DPAgent] LLM response usage: step=${input.step + 1} attempt=${llmAttempt} usage=${formatTokenUsage(response?.usage)}`
      );
    } catch (error) {
      const recovery = await handleLlmAttemptError({
        host,
        error,
        input,
        llmAttempt,
        streamedVisibleOutput,
        streamedTextBuffer,
        transportRetryCount,
        consecutiveToolCallProtocolFailures,
        overflowCountInTurn,
        snapshotStage,
        beforeChars,
        beforeMessageCount,
        staticEstimatedInputTokens,
        estimatedInputTokens,
        preparedInputEstimate,
        preparedInput,
      });
      if (recovery.kind === 'terminal') {
        return {
          kind: 'terminal',
          result: recovery.result,
          consecutiveToolCallProtocolFailures,
        };
      }
      if (recovery.kind === 'transport_retry') {
        transportRetryCount = recovery.transportRetryCount;
        continue;
      }
      if (recovery.kind === 'tool_protocol_recovered') {
        consecutiveToolCallProtocolFailures = recovery.consecutiveToolCallProtocolFailures;
        recoveredToolProtocol = true;
        break;
      }
      if (recovery.kind === 'forced_compress') {
        overflowCountInTurn = recovery.overflowCountInTurn;
        pendingPreparedInput = recovery.pendingPreparedInput;
        pendingPrecompressMode = 'disabled';
        snapshotStage = 'overflow_retry_after_compress';
        trimOptions = host.buildNormalTrimOptions();
        continue;
      }
      if (recovery.kind === 'forced_trim') {
        overflowCountInTurn = recovery.overflowCountInTurn;
        pendingPreparedInput = recovery.pendingPreparedInput;
        pendingPrecompressMode = 'disabled';
        snapshotStage = 'overflow_retry_after_forced_trim';
        trimOptions = host.buildForcedTrimOptions();
        continue;
      }
    }
  }

  if (recoveredToolProtocol) {
    return {
      kind: 'response',
      response: response as LLMResponse,
      recoveredToolProtocol,
      activeSystemPrompt,
      latestPreparedInputEstimate,
      consecutiveToolCallProtocolFailures,
    };
  }

  if (!response) {
    throw new Error('LLM response is unavailable after overflow recovery attempts.');
  }
  return {
    kind: 'response',
    response,
    recoveredToolProtocol,
    activeSystemPrompt,
    latestPreparedInputEstimate,
    consecutiveToolCallProtocolFailures,
  };
}

async function handleLlmAttemptError(input: {
  host: AgentLlmAttemptHost;
  error: unknown;
  input: {
    step: number;
    lastUsage?: TokenUsage;
    recoveredFromMaxTokens: boolean;
    maxTokensRecoveryAttempt: number;
    maxTokensEvents: MaxTokensRecoveryEvent[];
  };
  llmAttempt: number;
  streamedVisibleOutput: boolean;
  streamedTextBuffer: string;
  transportRetryCount: number;
  consecutiveToolCallProtocolFailures: number;
  overflowCountInTurn: number;
  snapshotStage: LlmAttemptSnapshotStage;
  beforeChars: number;
  beforeMessageCount: number;
  staticEstimatedInputTokens: number;
  estimatedInputTokens: number;
  preparedInputEstimate: ReturnType<AgentLlmAttemptHost['buildPreparedInputUsageEstimate']>;
  preparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>>;
}): Promise<
  | { kind: 'terminal'; result: AgentRunResult }
  | { kind: 'transport_retry'; transportRetryCount: number }
  | { kind: 'tool_protocol_recovered'; consecutiveToolCallProtocolFailures: number }
  | {
      kind: 'forced_compress' | 'forced_trim';
      overflowCountInTurn: number;
      pendingPreparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>>;
    }
> {
  const { host, error } = input;
  const errorRaw = error instanceof Error ? error.message : String(error);
  if (host.abortController.signal.aborted) {
    return {
      kind: 'terminal',
      result: host.completeCancelledRun({
        step: input.input.step,
        usage: input.input.lastUsage,
        recoveredFromMaxTokens: input.input.recoveredFromMaxTokens,
        maxTokensRecoveryAttempt: input.input.maxTokensRecoveryAttempt,
        maxTokensEvents: input.input.maxTokensEvents,
      }),
    };
  }
  if (isMiniMaxToolResultIdNotFoundError(error)) {
    const protocolRecovery = host.turnRecoveryOrchestrator.handleToolCallProtocolRecovery({
      errorRaw,
      consecutiveFailureCount: input.consecutiveToolCallProtocolFailures,
    });
    if (protocolRecovery.escalationError) {
      throw protocolRecovery.escalationError;
    }
    return {
      kind: 'tool_protocol_recovered',
      consecutiveToolCallProtocolFailures: protocolRecovery.nextCount,
    };
  }

  if (!isMiniMaxContextWindowExceededError(error)) {
    if (
      shouldRetryTransportBeforeVisibleOutput({
        streamedVisibleOutput: input.streamedVisibleOutput,
        error,
        transportRetryCount: input.transportRetryCount,
        maxAttempts: DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS,
      })
    ) {
      const transportRetryCount = input.transportRetryCount + 1;
      agentLogger.warn(
        `[DPAgent] Retrying LLM transport before first visible output: step=${input.input.step + 1} attempt=${input.llmAttempt} retry=${transportRetryCount} error=${errorRaw}`
      );
      return { kind: 'transport_retry', transportRetryCount };
    }
    if (input.streamedVisibleOutput && isRetriableTransportError(error)) {
      const checkpointSaved = await host.saveInterruptedStreamCheckpoint({
        step: input.input.step + 1,
        content: input.streamedTextBuffer,
      });
      if (checkpointSaved) {
        agentLogger.warn(
          `[DPAgent] Saved interrupted stream checkpoint after transport error: step=${input.input.step + 1} attempt=${input.llmAttempt} error=${errorRaw}`
        );
      }
    }
    throw error;
  }

  return await handleContextOverflow(input, errorRaw);
}

async function handleContextOverflow(
  input: Parameters<typeof handleLlmAttemptError>[0],
  errorRaw: string
): Promise<
  | {
      kind: 'forced_compress' | 'forced_trim';
      overflowCountInTurn: number;
      pendingPreparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>>;
    }
> {
  const host = input.host;
  const overflowCountInTurn = input.overflowCountInTurn + 1;
  const decision = decideContextOverflowRecovery({
    overflowCountInTurn,
    maxErrorsBeforeTrim: host.contextOverflowMaxErrorsBeforeTrim,
  });
  agentLogger.warn(
    `[DPAgent] Context overflow diagnostics: step=${input.input.step + 1} attempt=${input.llmAttempt} snapshotStage=${input.snapshotStage} beforeChars=${input.beforeChars} staticEstimatedInputTokens=${input.staticEstimatedInputTokens} calibratedEstimatedInputTokens=${input.preparedInputEstimate.calibratedEstimate.inputTokens} anchorPromptTokens=${input.preparedInputEstimate.anchorPromptTokens ?? 0} deltaEstimatedTokens=${input.preparedInputEstimate.deltaEstimatedTokens ?? 0} effectiveEstimatedInputTokens=${input.estimatedInputTokens} calibrationMultiplier=${input.preparedInputEstimate.calibrationMultiplier.toFixed(3)} contextWindowTokens=${host.contextBudget.contextWindowTokens} safeInputTokens=${host.contextBudget.safeInputTokens} triggerTokens=${host.contextBudget.compressionTriggerTokens} errorMeta=${formatProviderErrorDiagnostics(input.error)}`
  );
  await emitOverflowDetected(input, overflowCountInTurn, decision, errorRaw);

  if (decision === 'retry_with_forced_compress') {
    return await handleForcedCompress(input, overflowCountInTurn, errorRaw);
  }
  if (decision === 'retry_with_forced_trim') {
    return await handleForcedTrim(input, overflowCountInTurn, errorRaw);
  }
  await emitOverflowAbort(input, overflowCountInTurn, errorRaw);
  throw input.error;
}

async function emitOverflowDetected(
  input: Parameters<typeof handleLlmAttemptError>[0],
  overflowCountInTurn: number,
  decision: ReturnType<typeof decideContextOverflowRecovery>,
  errorRaw: string
): Promise<void> {
  const host = input.host;
  await host.emitContextOverflowEvent({
    observedAt: new Date().toISOString(),
    step: input.input.step + 1,
    attempt: input.llmAttempt,
    overflowCountInTurn,
    stage: 'overflow_detected',
    decision,
    errorRaw,
    contextWindowChars: tokensToCharHint(host.contextBudget.contextWindowTokens),
    contextWindowTokens: host.contextBudget.contextWindowTokens,
    precompressTriggerRatio: host.contextBudget.compressionTriggerRatio,
    precompressTriggerThresholdChars: tokensToCharHint(host.contextBudget.compressionTriggerTokens),
    precompressTriggerThresholdTokens: host.contextBudget.compressionTriggerTokens,
    forcedTrimChars: resolveForcedTrimChars(host.contextBudget),
    maxErrorsBeforeTrim: host.contextOverflowMaxErrorsBeforeTrim,
    beforeMessageCount: input.beforeMessageCount,
    beforeChars: input.beforeChars,
    beforeTokens: input.estimatedInputTokens,
    profileRuntimeSource: input.preparedInput.profileRuntime.sourceName,
    profileRuntimePath: input.preparedInput.profileRuntime.sourcePath,
    profileRuntimeFailureReason: input.preparedInput.profileRuntime.failureReason,
    notes: `snapshot_stage=${input.snapshotStage}`,
  });
}

async function handleForcedCompress(
  input: Parameters<typeof handleLlmAttemptError>[0],
  overflowCountInTurn: number,
  errorRaw: string
): Promise<{
  kind: 'forced_compress';
  overflowCountInTurn: number;
  pendingPreparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>>;
}> {
  const host = input.host;
  const aggressiveKeepRounds = Math.max(
    1,
    Math.min(host.contextPrecompressKeepLlmRounds, host.contextPrecompressAggressiveKeepLlmRoundsCap)
  );
  const forcedCompressed = await host.prepareLlmInput({
    precompressMode: 'aggressive',
    forcePrecompress: true,
    keepLlmRoundsOverride: aggressiveKeepRounds,
  });
  const forcedEvent = forcedCompressed.precompressEvent;
  await host.emitContextOverflowEvent({
    observedAt: new Date().toISOString(),
    step: input.input.step + 1,
    attempt: input.llmAttempt,
    overflowCountInTurn,
    stage: 'forced_compress',
    decision: 'retry_with_forced_compress',
    errorRaw,
    contextWindowChars: tokensToCharHint(host.contextBudget.contextWindowTokens),
    contextWindowTokens: host.contextBudget.contextWindowTokens,
    precompressTriggerRatio: host.contextBudget.compressionTriggerRatio,
    precompressTriggerThresholdChars: tokensToCharHint(host.contextBudget.compressionTriggerTokens),
    precompressTriggerThresholdTokens: host.contextBudget.compressionTriggerTokens,
    forcedTrimChars: resolveForcedTrimChars(host.contextBudget),
    maxErrorsBeforeTrim: host.contextOverflowMaxErrorsBeforeTrim,
    beforeMessageCount: input.beforeMessageCount,
    beforeChars: input.beforeChars,
    beforeTokens: input.estimatedInputTokens,
    afterMessageCount: forcedCompressed.contentMessages.length,
    afterChars: forcedEvent.totalCharsAfter,
    afterTokens: forcedEvent.providerPayloadTokensAfter,
    tailRoundsKept: forcedEvent.keepLlmRoundsApplied,
    chunkCount: forcedEvent.chunkCount,
    retryCount: forcedEvent.retryCount,
    profileRuntimeSource: forcedCompressed.profileRuntime.sourceName,
    profileRuntimePath: forcedCompressed.profileRuntime.sourcePath,
    profileRuntimeFailureReason: forcedCompressed.profileRuntime.failureReason,
    notes: forcedEvent.failureReason,
  });
  return { kind: 'forced_compress', overflowCountInTurn, pendingPreparedInput: forcedCompressed };
}

async function handleForcedTrim(
  input: Parameters<typeof handleLlmAttemptError>[0],
  overflowCountInTurn: number,
  errorRaw: string
): Promise<{
  kind: 'forced_trim';
  overflowCountInTurn: number;
  pendingPreparedInput: Awaited<ReturnType<AgentLlmAttemptHost['prepareLlmInput']>>;
}> {
  const host = input.host;
  const trimStats = host.applyForcedTrimToMessages();
  const preparedAfterTrim = await host.prepareLlmInput({
    precompressMode: 'disabled',
  });
  const preparedAfterTrimEstimate = host.buildPreparedInputUsageEstimate(
    preparedAfterTrim.contentMessages,
    preparedAfterTrim.systemPrompt ?? '',
    { snapshotStage: 'overflow_retry_after_forced_trim' }
  );
  await host.emitContextOverflowEvent({
    observedAt: new Date().toISOString(),
    step: input.input.step + 1,
    attempt: input.llmAttempt,
    overflowCountInTurn,
    stage: 'forced_trim',
    decision: 'retry_with_forced_trim',
    errorRaw,
    contextWindowChars: tokensToCharHint(host.contextBudget.contextWindowTokens),
    contextWindowTokens: host.contextBudget.contextWindowTokens,
    precompressTriggerRatio: host.contextBudget.compressionTriggerRatio,
    precompressTriggerThresholdChars: tokensToCharHint(host.contextBudget.compressionTriggerTokens),
    precompressTriggerThresholdTokens: host.contextBudget.compressionTriggerTokens,
    forcedTrimChars: resolveForcedTrimChars(host.contextBudget),
    maxErrorsBeforeTrim: host.contextOverflowMaxErrorsBeforeTrim,
    beforeMessageCount: trimStats.beforeMessageCount,
    beforeChars: trimStats.beforeChars,
    beforeTokens: input.estimatedInputTokens,
    afterMessageCount: trimStats.afterMessageCount,
    afterChars: trimStats.afterChars,
    afterTokens: preparedAfterTrimEstimate.effectiveEstimate.inputTokens,
    profileRuntimeSource: preparedAfterTrim.profileRuntime.sourceName,
    profileRuntimePath: preparedAfterTrim.profileRuntime.sourcePath,
    profileRuntimeFailureReason: preparedAfterTrim.profileRuntime.failureReason,
    notes: `forced_trim_max_total_chars=${resolveForcedTrimChars(host.contextBudget)}`,
  });
  return { kind: 'forced_trim', overflowCountInTurn, pendingPreparedInput: preparedAfterTrim };
}

async function emitOverflowAbort(
  input: Parameters<typeof handleLlmAttemptError>[0],
  overflowCountInTurn: number,
  errorRaw: string
): Promise<void> {
  const host = input.host;
  await host.emitContextOverflowEvent({
    observedAt: new Date().toISOString(),
    step: input.input.step + 1,
    attempt: input.llmAttempt,
    overflowCountInTurn,
    stage: 'forced_trim_failed',
    decision: 'abort',
    errorRaw,
    contextWindowChars: tokensToCharHint(host.contextBudget.contextWindowTokens),
    contextWindowTokens: host.contextBudget.contextWindowTokens,
    precompressTriggerRatio: host.contextBudget.compressionTriggerRatio,
    precompressTriggerThresholdChars: tokensToCharHint(host.contextBudget.compressionTriggerTokens),
    precompressTriggerThresholdTokens: host.contextBudget.compressionTriggerTokens,
    forcedTrimChars: resolveForcedTrimChars(host.contextBudget),
    maxErrorsBeforeTrim: host.contextOverflowMaxErrorsBeforeTrim,
    beforeMessageCount: input.beforeMessageCount,
    beforeChars: input.beforeChars,
    beforeTokens: input.estimatedInputTokens,
    profileRuntimeSource: input.preparedInput.profileRuntime.sourceName,
    profileRuntimePath: input.preparedInput.profileRuntime.sourcePath,
    profileRuntimeFailureReason: input.preparedInput.profileRuntime.failureReason,
    notes: `abort_after_overflow_count=${overflowCountInTurn}`,
  });
}
