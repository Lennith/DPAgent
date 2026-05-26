import * as path from 'path';
import * as fs from 'fs';
import { type LLMRuntime } from '../llm/index.js';
import { ToolRegistry, Tool } from '../tools/index.js';
import { agentLogger } from '../utils/logger.js';
import { ContextCompressor } from '../compression/index.js';
import { ContextPayloadProjector } from '../context/ContextPayloadProjector.js';
import {
  type PreparedInputUsageSnapshot,
} from '../runtime/context-window-budget.js';
import {
  DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS as TURN_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS,
  DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS as TURN_TRANSPORT_RETRY_MAX_ATTEMPTS,
} from './TurnRecoveryPolicy.js';
import {
  buildPromptWithAgentProfileReference,
  parseAgentProfilePrompt,
  type AgentProfileReference,
} from '../agents/AgentProfiles.js';
import type {
  Message,
  AgentCallback,
  Session,
  TokenUsage,
  MaxTokensRecoveryEvent,
  SummaryApplyRequest,
  SummaryCheckpoint,
  ContextPrecompressEvent,
  ContextOverflowEvent,
  ContextUsageEstimate,
  ContextUsageEstimateEvent,
  ResolvedContextBudget,
} from '../types.js';
import type {
  AgentOptions,
  AgentRunResult,
  PreparedInputUsageEstimateResult,
} from './agent-contracts.js';
import { isTurnCompleteFinishReason } from './agent-progress-recovery.js';
import { ContextBudgetService } from './ContextBudgetService.js';
import { ContextOverflowHandler } from './ContextOverflowHandler.js';
import {
  applyPrecompressIfNeeded as applyPrecompressIfNeededImpl,
  buildCompressionChunk as buildCompressionChunkImpl,
  chunkMessagesForCompression as chunkMessagesForCompressionImpl,
  compressChunksWithRetry as compressChunksWithRetryImpl,
  emitContextPrecompress as emitContextPrecompressImpl,
  refreshLastPrecompressValidation as refreshLastPrecompressValidationImpl,
  resolveAdaptiveCompressionChunks as resolveAdaptiveCompressionChunksImpl,
  splitMessagesForPrecompress as splitMessagesForPrecompressImpl,
  type LlmInputPreparatorHost,
} from './LlmInputPreparator.js';
import { MaxTokensRecoveryService } from './MaxTokensRecoveryService.js';
import { MessageStore } from './MessageStore.js';
import { ToolResultMaterializer } from './ToolResultMaterializer.js';
import { TurnRecoveryOrchestrator } from './TurnRecoveryOrchestrator.js';
import { runAgentLlmAttemptLoop, type AgentLlmAttemptHost } from './AgentLlmAttemptService.js';
import { executeAgentToolCallsForTurn, type AgentToolCallHost } from './AgentToolCallService.js';
import {
  completeAgentCancelledRun,
  completeAgentTurn,
  completeAgentTurnDetached,
  type AgentTurnCompletionHost,
} from './AgentTurnCompletionService.js';
import { HookRunner, HookRegistry, type HookEvent, type HookContext, type HookExecutionResult } from '../hooks/index.js';

export type { AgentOptions, AgentRunResult } from './agent-contracts.js';

type AgentAttemptSnapshotStage = 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim';

function normalizeAgentAttemptSnapshotStage(value: string): AgentAttemptSnapshotStage | undefined {
  if (
    value === 'initial' ||
    value === 'overflow_retry_after_compress' ||
    value === 'overflow_retry_after_forced_trim'
  ) {
    return value;
  }
  return undefined;
}

export class Agent {
  private static readonly DEFAULT_SUMMARY_CHECKPOINT_LIMIT = 50;
  private static readonly DEFAULT_OVERFLOW_MAX_ERRORS_BEFORE_TRIM = 2;
  private static readonly DEFAULT_OVERFLOW_AGGRESSIVE_KEEP_LLM_ROUNDS = 3;
  private static readonly DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS = TURN_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS;
  private static readonly DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS = TURN_TRANSPORT_RETRY_MAX_ATTEMPTS;
  private llm: LLMRuntime;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private maxSteps: number;
  private contextBudget: ResolvedContextBudget;
  private contextOverflowMaxErrorsBeforeTrim: number;
  private contextPrecompressKeepLlmRounds: number;
  private readonly contextPrecompressAggressiveKeepLlmRoundsCap =
    Agent.DEFAULT_OVERFLOW_AGGRESSIVE_KEEP_LLM_ROUNDS;
  private contextPrecompressChunkChars: number;
  private contextPrecompressRetry: number;
  private workspaceDir: string;
  private callback?: AgentCallback;
  private mcpToolDescriptions?: string;
  private toolResultMaterializer: ToolResultMaterializer;
  private contextCompressor: ContextCompressor;
  private contextOverflowHandler: ContextOverflowHandler;
  private turnRecoveryOrchestrator: TurnRecoveryOrchestrator;
  private contextPayloadProjector = new ContextPayloadProjector();
  private maxTokensRecoveryMaxAttempts: number;
  private maxTokensRecoveryService: MaxTokensRecoveryService;
  private progressOnlyRecoveryEnabled: boolean;
  private contextBudgetService: ContextBudgetService;
  private messageStore: MessageStore;
  private lastCompletedPrecompressEvent: ContextPrecompressEvent | null = null;
  private lastCompressionInputTokens: number = 0;

  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private lastUsage: TokenUsage | undefined;
  private hookRunner?: HookRunner;
  private hookRegistry?: HookRegistry;

  private get sessionId(): string | null {
    return this.messageStore.sessionId;
  }

  private set sessionId(sessionId: string | null) {
    this.messageStore.sessionId = sessionId;
  }

  private get llmInputPreparatorHost(): LlmInputPreparatorHost {
    const agent = this;
    const host: LlmInputPreparatorHost = {
      get contextPrecompressChunkChars() {
        return agent.contextPrecompressChunkChars;
      },
      get contextPrecompressRetry() {
        return agent.contextPrecompressRetry;
      },
      get contextPrecompressKeepLlmRounds() {
        return agent.contextPrecompressKeepLlmRounds;
      },
      get contextPrecompressAggressiveKeepLlmRoundsCap() {
        return agent.contextPrecompressAggressiveKeepLlmRoundsCap;
      },
      get contextBudget() {
        return agent.contextBudget;
      },
      get contextPayloadProjector() {
        return agent.contextPayloadProjector;
      },
      get contextCompressor() {
        return agent.contextCompressor;
      },
      get messageStore() {
        return agent.messageStore;
      },
      get callback() {
        return agent.callback;
      },
      get lastCompletedPrecompressEvent() {
        return agent.lastCompletedPrecompressEvent;
      },
      set lastCompletedPrecompressEvent(value) {
        agent.lastCompletedPrecompressEvent = value;
      },
      get lastCompressionInputTokens() {
        return agent.lastCompressionInputTokens;
      },
      set lastCompressionInputTokens(value) {
        agent.lastCompressionInputTokens = value;
      },
      buildCompressionChunk(messages) {
        return buildCompressionChunkImpl.call(host, messages);
      },
      chunkMessagesForCompression(messages) {
        return chunkMessagesForCompressionImpl.call(host, messages);
      },
      resolveAdaptiveCompressionChunks(messages) {
        return resolveAdaptiveCompressionChunksImpl.call(host, messages);
      },
      compressChunksWithRetry(chunks, onChunkProgress) {
        return compressChunksWithRetryImpl.call(host, chunks, onChunkProgress);
      },
      emitContextPrecompress(event, phase, options) {
        return emitContextPrecompressImpl.call(host, event, phase, options);
      },
      splitMessagesForPrecompress(contentMessages, keepLlmRounds) {
        return splitMessagesForPrecompressImpl(contentMessages, keepLlmRounds);
      },
      withCheckpointMetadata(message, reason) {
        return agent.withCheckpointMetadata(message, reason);
      },
      buildPreparedInputUsageEstimate(messages, systemPrompt, options) {
        return agent.buildPreparedInputUsageEstimate(messages, systemPrompt, options);
      },
      buildNormalTrimOptions() {
        return agent.buildNormalTrimOptions();
      },
      buildProviderProjectionTrimOptions(maxTotalChars) {
        return agent.buildProviderProjectionTrimOptions(maxTotalChars);
      },
      contextCompactionConfigFingerprint() {
        return agent.contextBudgetService.contextCompactionConfigFingerprint();
      },
      clearPromptUsageAnchor() {
        agent.clearPromptUsageAnchor();
      },
    };
    return host;
  }

  private get turnCompletionHost(): AgentTurnCompletionHost {
    const agent = this;
    return {
      get sessionId() {
        return agent.sessionId;
      },
      get callback() {
        return agent.callback;
      },
      executeHookPoint(event, context) {
        return agent.executeHookPoint(event as HookEvent, context);
      },
    };
  }

  private get llmAttemptHost(): AgentLlmAttemptHost {
    const agent = this;
    return {
      get llm() {
        return agent.llm;
      },
      get tools() {
        return agent.tools;
      },
      get callback() {
        return agent.callback;
      },
      get hookRunner() {
        return agent.hookRunner;
      },
      get abortController() {
        return agent.abortController!;
      },
      get sessionId() {
        return agent.sessionId;
      },
      get contextBudget() {
        return agent.contextBudget;
      },
      get contextOverflowMaxErrorsBeforeTrim() {
        return agent.contextOverflowMaxErrorsBeforeTrim;
      },
      get contextPrecompressKeepLlmRounds() {
        return agent.contextPrecompressKeepLlmRounds;
      },
      get contextPrecompressAggressiveKeepLlmRoundsCap() {
        return agent.contextPrecompressAggressiveKeepLlmRoundsCap;
      },
      get turnRecoveryOrchestrator() {
        return agent.turnRecoveryOrchestrator;
      },
      prepareLlmInput(options) {
        return agent.prepareLlmInput(options);
      },
      buildNormalTrimOptions() {
        return agent.buildNormalTrimOptions();
      },
      buildForcedTrimOptions() {
        return agent.buildForcedTrimOptions();
      },
      buildPreparedInputUsageEstimate(contentMessages, systemPrompt, options) {
        return agent.buildPreparedInputUsageEstimate(contentMessages, systemPrompt, {
          snapshotStage: normalizeAgentAttemptSnapshotStage(options.snapshotStage),
        });
      },
      emitContextUsageEstimate(estimate, stage) {
        return agent.emitContextUsageEstimate(
          estimate as PreparedInputUsageEstimateResult,
          stage as ContextUsageEstimateEvent['stage']
        );
      },
      executeHookPoint(event, context) {
        return agent.executeHookPoint(event as HookEvent, context);
      },
      completeCancelledRun(input) {
        return agent.completeCancelledRun(input);
      },
      saveInterruptedStreamCheckpoint(input) {
        return agent.saveInterruptedStreamCheckpoint(input);
      },
      emitContextOverflowEvent(event) {
        return agent.emitContextOverflowEvent(event);
      },
      applyForcedTrimToMessages() {
        return agent.applyForcedTrimToMessages();
      },
    };
  }

  private get toolCallHost(): AgentToolCallHost {
    const agent = this;
    return {
      get abortController() {
        return agent.abortController!;
      },
      get sessionId() {
        return agent.sessionId;
      },
      get hookRunner() {
        return agent.hookRunner;
      },
      get callback() {
        return agent.callback;
      },
      get tools() {
        return agent.tools;
      },
      get toolResultMaterializer() {
        return agent.toolResultMaterializer;
      },
      get messageStore() {
        return agent.messageStore;
      },
      executeHookPoint(event, context) {
        return agent.executeHookPoint(event as HookEvent, context);
      },
      completeCancelledRun(input) {
        return agent.completeCancelledRun(input);
      },
      getMessages() {
        return agent.getMessages();
      },
      applyPendingSummaryIfNeeded() {
        agent.applyPendingSummaryIfNeeded();
      },
      async consumeRunningInputAtCheckpoint(step) {
        await agent.consumeRunningInputAtCheckpoint(step);
      },
    };
  }

  private completeCancelledRun(input: {
    step: number;
    usage?: TokenUsage;
    recoveredFromMaxTokens?: boolean;
    maxTokensRecoveryAttempt?: number;
    maxTokensEvents?: MaxTokensRecoveryEvent[];
  }): AgentRunResult {
    return completeAgentCancelledRun(this.turnCompletionHost, {
      step: input.step,
      usage: input.usage,
      recoveredFromMaxTokens: input.recoveredFromMaxTokens,
      maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
      maxTokensEvents: input.maxTokensEvents,
    });
  }

  constructor(options: AgentOptions) {
    this.llm = options.llmClient;
    this.tools = options.toolRegistry;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 100;
    this.contextBudget = options.contextBudget;
    this.contextOverflowMaxErrorsBeforeTrim = Math.max(
      1,
      Math.floor(options.contextOverflowMaxErrorsBeforeTrim ?? Agent.DEFAULT_OVERFLOW_MAX_ERRORS_BEFORE_TRIM)
    );
    this.contextPrecompressKeepLlmRounds = Math.max(
      1,
      Math.floor(options.contextBudget.precompressKeepLlmRounds)
    );
    this.contextPrecompressChunkChars = Math.max(
      4000,
      Math.floor(options.contextBudget.precompressChunkChars)
    );
    this.contextPrecompressRetry = Math.max(
      0,
      Math.floor(options.contextBudget.precompressRetry)
    );
    this.workspaceDir = path.resolve(options.workspaceDir ?? './workspace');
    this.callback = options.callback;
    this.mcpToolDescriptions = options.mcpToolDescriptions;
    this.toolResultMaterializer = new ToolResultMaterializer({
      materializeToolResultArtifact: options.materializeToolResultArtifact,
    });
    this.contextCompressor = new ContextCompressor(this.llm);
    this.contextOverflowHandler = new ContextOverflowHandler({
      contextBudget: this.contextBudget,
      contextCompressor: this.contextCompressor,
      getCallback: () => this.callback,
    });
    this.messageStore = new MessageStore({
      systemPrompt: this.systemPrompt,
      getWorkspaceDir: () => this.workspaceDir,
      getMcpToolDescriptions: () => this.mcpToolDescriptions,
      getCallback: () => this.callback,
      getLlmRuntime: () => this.llm.getRuntimeConfig?.(),
      clearPromptUsageAnchor: () => this.clearPromptUsageAnchor(),
    });
    this.progressOnlyRecoveryEnabled = options.progressOnlyRecoveryEnabled !== false;
    this.turnRecoveryOrchestrator = new TurnRecoveryOrchestrator({
      messageStore: this.messageStore,
      getCallback: () => this.callback,
      progressOnlyRecoveryEnabled: this.progressOnlyRecoveryEnabled,
      progressOnlyMaxAttempts: Agent.DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS,
    });
    this.maxTokensRecoveryMaxAttempts = Math.max(0, Math.floor(options.maxTokensRecoveryMaxAttempts ?? 2));
    this.maxTokensRecoveryService = new MaxTokensRecoveryService({
      messageStore: this.messageStore,
      contextOverflowHandler: this.contextOverflowHandler,
      clearPromptUsageAnchor: () => this.clearPromptUsageAnchor(),
      maxAttempts: this.maxTokensRecoveryMaxAttempts,
    });
    this.contextBudgetService = new ContextBudgetService({
      llm: this.llm,
      tools: this.tools,
      contextBudget: this.contextBudget,
      contextUsageCalibrationStore: options.contextUsageCalibrationStore,
      getCallback: () => this.callback,
      compactionFingerprint: {
        keepLlmRounds: this.contextPrecompressKeepLlmRounds,
        chunkChars: this.contextPrecompressChunkChars,
        retry: this.contextPrecompressRetry,
      },
    });

    this.ensureWorkspace();
    this.initializeMessages();
  }

  private ensureWorkspace(): void {
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  private initializeMessages(): void {
    this.messageStore.initializeMessages();
  }

  private withCheckpointMetadata(
    message: Message,
    reason: 'user_prompt' | 'assistant_toolcall' | 'summary_anchor'
  ): Message {
    return this.messageStore.withCheckpointMetadata(message, reason);
  }

  private async saveInterruptedStreamCheckpoint(input: {
    step: number;
    content: string;
  }): Promise<boolean> {
    return this.messageStore.saveInterruptedStreamCheckpoint(input);
  }

  private async consumeRunningInputAtCheckpoint(step: number): Promise<boolean> {
    const insertion = await Promise.resolve(
      this.callback?.onConsumeRunningInput?.({
        step,
      })
    );
    const prompt = String(insertion?.prompt ?? '').trim();
    if (!insertion || !prompt) {
      return false;
    }
    this.addUserMessage(prompt);
    await Promise.resolve(
      this.callback?.onRunningInputInserted?.({
        itemId: insertion.itemId,
        step,
      })
    );
    await Promise.resolve(
      this.callback?.onReplayCheckpoint?.({
        observedAt: new Date().toISOString(),
        step,
        messages: this.getMessages().filter((message) => message.role !== 'system'),
      })
    );
    return true;
  }

  setCallback(callback: AgentCallback): void {
    this.callback = callback;
  }


  setHooks(runner: HookRunner, registry: HookRegistry): void {
    this.hookRunner = runner;
    this.hookRegistry = registry;
  }

  private async executeHookPoint(
    event: HookEvent,
    ctx: HookContext
  ): Promise<HookExecutionResult> {
    if (!this.hookRunner || !this.hookRegistry) {
      return { blocked: false };
    }
    return this.hookRunner.executeHook(
      event,
      ctx,
      this.hookRegistry.getUserHooksForEvent(event),
      this.hookRegistry.getSystemHooksForEvent(event)
    );
  }

  addTool(tool: Tool): void {
    this.tools.register(tool);
  }

  removeTool(name: string): void {
    this.tools.unregister(name);
  }

  addUserMessage(content: string): void {
    this.messageStore.addUserMessage(content);
  }

  listSummaryCheckpoints(limit: number = Agent.DEFAULT_SUMMARY_CHECKPOINT_LIMIT): SummaryCheckpoint[] {
    return this.messageStore.listSummaryCheckpoints(limit);
  }

  enqueueSummaryApply(request: SummaryApplyRequest): {
    accepted: boolean;
    availableCheckpoints: number;
  } {
    return this.messageStore.enqueueSummaryApply(request);
  }

  getMessages(): Message[] {
    return this.messageStore.getMessages();
  }

  setMessages(messages: Message[]): void {
    this.messageStore.setMessages(messages);
  }

  getLastUsage(): TokenUsage | undefined {
    return this.lastUsage;
  }

  getSession(): Session {
    return this.messageStore.getSession();
  }

  setSession(session: Session): void {
    this.messageStore.setSession(session);
  }

  private applyPendingSummaryIfNeeded(): void {
    this.messageStore.applyPendingSummaryIfNeeded();
  }

  private normalizeAgentProfileMessagesInPlace(): {
    activeProfileRef?: AgentProfileReference;
    normalizedCount: number;
  } {
    let normalizedCount = 0;
    let activeProfileRef: AgentProfileReference | undefined;
    const next = [...this.messageStore.messages];
    const latestUserMessageIndex = (() => {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const message = next[i];
        if (message.role === 'user' && typeof message.content === 'string') {
          return i;
        }
      }
      return -1;
    })();
    for (let i = 0; i < next.length; i += 1) {
      const message = next[i];
      if (message.role !== 'user' || typeof message.content !== 'string') {
        continue;
      }
      const parsed = parseAgentProfilePrompt(message.content);
      if (!parsed.matched || !parsed.reference) {
        continue;
      }
      activeProfileRef = parsed.reference;
      const shouldPreserveBootstrap =
        i === latestUserMessageIndex && parsed.matchedKind === 'bootstrap';
      if (shouldPreserveBootstrap) {
        continue;
      }
      const canonical = buildPromptWithAgentProfileReference(parsed.strippedPrompt, parsed.reference);
      if (canonical !== message.content) {
        next[i] = {
          ...message,
          content: canonical,
        };
        normalizedCount += 1;
      }
    }
    if (normalizedCount > 0) {
      this.messageStore.messages = next;
      this.clearPromptUsageAnchor();
    }
    return { activeProfileRef, normalizedCount };
  }

  private buildRuntimeProfileSystemPrompt(reference?: AgentProfileReference): {
    sourceName?: string;
    sourcePath?: string;
  } {
    if (!reference) {
      return {};
    }
    return {
      sourceName: reference.name,
      sourcePath: path.resolve(reference.path),
    };
  }

  private async applyPrecompressIfNeeded(
    effectiveSystemPrompt: string,
    profileNormalizedCount: number,
    profileRuntime?: { sourceName?: string; sourcePath?: string; failureReason?: string },
    options?: {
      mode?: 'light' | 'aggressive' | 'disabled';
      forced?: boolean;
      keepLlmRoundsOverride?: number;
    }
  ): Promise<ContextPrecompressEvent> {
    return applyPrecompressIfNeededImpl.call(
      this.llmInputPreparatorHost,
      effectiveSystemPrompt,
      profileNormalizedCount,
      profileRuntime,
      options
    );
  }

  private async refreshLastPrecompressValidation(effectiveSystemPrompt: string): Promise<void> {
    return refreshLastPrecompressValidationImpl.call(this.llmInputPreparatorHost, effectiveSystemPrompt);
  }
  private clearPromptUsageAnchor(): void {
    this.contextBudgetService.clearPromptUsageAnchor();
  }

  private buildPreparedInputUsageEstimate(
    messages: Message[],
    systemPrompt: string | undefined,
    options?: { snapshotStage?: 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim' }
  ): PreparedInputUsageEstimateResult {
    return this.contextBudgetService.buildPreparedInputUsageEstimate(messages, systemPrompt, options);
  }

  private async emitContextUsageEstimate(
    estimate: PreparedInputUsageEstimateResult,
    stage: ContextUsageEstimateEvent['stage']
  ): Promise<void> {
    await this.contextBudgetService.emitContextUsageEstimate(estimate, stage);
  }

  private async emitProviderUsageAnchorEstimate(
    snapshot: PreparedInputUsageEstimateResult['snapshot'],
    usage?: TokenUsage
  ): Promise<void> {
    await this.contextBudgetService.emitProviderUsageAnchorEstimate(snapshot, usage);
  }

  private recordCalibrationObservation(estimate: ContextUsageEstimate, usage?: TokenUsage): void {
    this.contextBudgetService.recordCalibrationObservation(estimate, usage);
  }

  private updatePromptUsageAnchor(
    snapshot: PreparedInputUsageSnapshot,
    estimate: ContextUsageEstimate,
    usage?: TokenUsage
  ): void {
    this.contextBudgetService.updatePromptUsageAnchor(snapshot, estimate, usage);
  }

  private async prepareLlmInput(options?: {
    precompressMode?: 'light' | 'aggressive' | 'disabled';
    forcePrecompress?: boolean;
    keepLlmRoundsOverride?: number;
  }): Promise<{
    systemPrompt: string | undefined;
    contentMessages: Message[];
    precompressEvent: ContextPrecompressEvent;
    profileRuntime: {
      sourceName?: string;
      sourcePath?: string;
      failureReason?: string;
    };
    profileNormalizedCount: number;
  }> {
    const profileNormalization = this.normalizeAgentProfileMessagesInPlace();
    const hasSystem = this.messageStore.messages.length > 0 && this.messageStore.messages[0]?.role === 'system';
    const baseSystemPrompt =
      hasSystem && typeof this.messageStore.messages[0]?.content === 'string' ? this.messageStore.messages[0].content : undefined;
    const runtimeProfile = this.buildRuntimeProfileSystemPrompt(profileNormalization.activeProfileRef);
    const systemPrompt = baseSystemPrompt;

    const precompressEvent = await this.applyPrecompressIfNeeded(
      systemPrompt ?? '',
      profileNormalization.normalizedCount,
      {
        sourceName: runtimeProfile.sourceName,
        sourcePath: runtimeProfile.sourcePath,
      },
      {
        mode: options?.precompressMode ?? 'light',
        forced: options?.forcePrecompress ?? false,
        keepLlmRoundsOverride: options?.keepLlmRoundsOverride,
      }
    );
    if (precompressEvent.phase || precompressEvent.applied) {
      await Promise.resolve(this.callback?.onContextPrecompress?.(precompressEvent));
    }

    const contentMessages = hasSystem ? this.messageStore.messages.slice(1) : [...this.messageStore.messages];
    const payloadProjection = this.contextPayloadProjector.projectForProvider(contentMessages, {
      systemPrompt: systemPrompt ?? '',
      trimOptions: this.buildProviderProjectionTrimOptions(),
    });
    if (
      payloadProjection.metrics.toolResultRefReplacements > 0 ||
      payloadProjection.metrics.oversizedInlineToolTruncations > 0 ||
      payloadProjection.metrics.trimRemovedCount > 0 ||
      payloadProjection.metrics.trimTruncatedCount > 0 ||
      payloadProjection.metrics.protocolCorrectionCount > 0
    ) {
      agentLogger.info(
        `[DPAgent] Provider payload projected: originalChars=${payloadProjection.metrics.originalChars} projectedChars=${payloadProjection.metrics.projectedChars} preparedChars=${payloadProjection.metrics.preparedChars} toolRefs=${payloadProjection.metrics.toolResultRefReplacements} inlineToolTruncations=${payloadProjection.metrics.oversizedInlineToolTruncations} trimRemoved=${payloadProjection.metrics.trimRemovedCount} trimTruncated=${payloadProjection.metrics.trimTruncatedCount} protocolCorrections=${payloadProjection.metrics.protocolCorrectionCount}`
      );
    }

    return {
      systemPrompt,
      contentMessages: payloadProjection.messages,
      precompressEvent,
      profileRuntime: {
        sourceName: runtimeProfile.sourceName,
        sourcePath: runtimeProfile.sourcePath,
      },
      profileNormalizedCount: profileNormalization.normalizedCount,
    };
  }

  private buildNormalTrimOptions(): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    return this.contextOverflowHandler.buildNormalTrimOptions();
  }

  private buildProviderProjectionTrimOptions(maxTotalChars?: number): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    return this.contextOverflowHandler.buildProviderProjectionTrimOptions(maxTotalChars);
  }

  private buildForcedTrimOptions(): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    return this.contextOverflowHandler.buildForcedTrimOptions();
  }

  private applyForcedTrimToMessages(): {
    beforeMessageCount: number;
    beforeChars: number;
    afterMessageCount: number;
    afterChars: number;
  } {
    const trimResult = this.contextOverflowHandler.applyForcedTrim(this.messageStore.messages);
    this.messageStore.messages = trimResult.messages;
    this.clearPromptUsageAnchor();
    return {
      beforeMessageCount: trimResult.beforeMessageCount,
      beforeChars: trimResult.beforeChars,
      afterMessageCount: trimResult.afterMessageCount,
      afterChars: trimResult.afterChars,
    };
  }

  private async emitContextOverflowEvent(event: ContextOverflowEvent): Promise<void> {
    await this.contextOverflowHandler.emitContextOverflowEvent(event);
  }

  async run(prompt: string, sessionId?: string): Promise<string> {
    const result = await this.runWithResult(prompt, sessionId);
    return result.content;
  }

  async runWithResult(prompt: string, sessionId?: string): Promise<AgentRunResult> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.messageStore.resetRunState();
    this.contextOverflowHandler.resetOverflowSnapshots();
    this.lastCompletedPrecompressEvent = null;
    this.clearPromptUsageAnchor();

    if (sessionId) {
      this.messageStore.sessionId = sessionId;
    }

    // Check API Key before processing
    if (!this.llm) {
      this.isRunning = false;
      return {
        content: '鈿狅笍 API Key not configured.\n\nPlease configure your MiniMax API Key in the settings (鈿欙笍 icon) and try again.\n\nYou can get your API Key from: https://platform.minimaxi.com',
        step: 0,
      };
    }

    this.addUserMessage(prompt);

    let step = 0;
    let lastResult = '';
    let lastUsage: TokenUsage | undefined;
    let consecutiveToolCallProtocolFailures = 0;
    let consecutiveProgressOnlyTurnStops = 0;
    let maxTokensRecoveryAttempt = 0;
    let recoveredFromMaxTokens = false;
    const maxTokensEvents: MaxTokensRecoveryEvent[] = [];

    try {
      while (step < this.maxSteps) {
        // Hook: onTurnStart
        const turnStartCtx = { event: 'onTurnStart' as const, sessionId: this.sessionId ?? '', step, messages: this.getMessages() };
        const turnStartResult = await this.executeHookPoint('onTurnStart', turnStartCtx as HookContext);
        if (turnStartResult.blocked) {
          const msg = this.hookRunner?.buildBlockedResponse(turnStartResult, 'onTurnStart') ?? 'Turn blocked by hook';
          return completeAgentTurnDetached(this.turnCompletionHost, {
            content: msg,
            finishReason: 'hook_blocked',
            step: step + 1,
          });
        }
        if (this.abortController.signal.aborted) {
          return this.completeCancelledRun({
            step,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          });
        }

        this.callback?.onStep?.(step + 1, this.maxSteps);

        const llmAttemptResult = await runAgentLlmAttemptLoop(
          this.llmAttemptHost,
          {
            step,
            lastUsage,
            consecutiveToolCallProtocolFailures,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          }
        );
        consecutiveToolCallProtocolFailures = llmAttemptResult.consecutiveToolCallProtocolFailures;
        if (llmAttemptResult.kind === 'terminal') {
          return llmAttemptResult.result;
        }
        if (llmAttemptResult.recoveredToolProtocol) {
          step++;
          continue;
        }
        const response = llmAttemptResult.response;
        const activeSystemPrompt = llmAttemptResult.activeSystemPrompt;
        const latestPreparedInputEstimate = llmAttemptResult.latestPreparedInputEstimate;

        if (response.usage) {
          lastUsage = response.usage;
          this.lastUsage = response.usage;
        }
        if (latestPreparedInputEstimate) {
          this.recordCalibrationObservation(latestPreparedInputEstimate.staticEstimate, response.usage);
          this.updatePromptUsageAnchor(
            latestPreparedInputEstimate.snapshot,
            latestPreparedInputEstimate.staticEstimate,
            response.usage
          );
          await this.emitProviderUsageAnchorEstimate(latestPreparedInputEstimate.snapshot, response.usage);
        }

        agentLogger.info(
          `[DPAgent] LLM response received: finishReason=${response.finishReason ?? 'unknown'} toolCalls=${response.toolCalls?.length ?? 0} contentChars=${response.content.length} thinkingChars=${response.thinking?.length ?? 0} step=${step + 1}`
        );

        const llmRuntime = this.llm.getRuntimeConfig?.();
        // Hook: onLLMResponse
        const llmRespCtx = { event: 'onLLMResponse' as const, sessionId: this.sessionId ?? '', step, response: response! };
        await this.executeHookPoint('onLLMResponse', llmRespCtx as HookContext);
        const assistantMsg: Message = {
          role: 'assistant',
          content: response.content,
          thinking: response.thinking,
          thinkingSignature: response.thinkingSignature,
          toolCalls: response.toolCalls,
          metadata: llmRuntime
            ? {
                llmProviderProfileId: llmRuntime.profileId,
                llmProvider: llmRuntime.provider,
                llmModel: llmRuntime.model,
                thinkingComplete: String(response.thinking ?? '').trim().length > 0 && response.finishReason !== 'max_tokens',
              }
            : undefined,
        };
        let persistedAssistantMsg: Message | null = null;
        if (response.toolCalls && response.toolCalls.length > 0) {
          persistedAssistantMsg = this.withCheckpointMetadata(assistantMsg, 'assistant_toolcall');
          this.messageStore.messages.push(persistedAssistantMsg);
        } else {
          persistedAssistantMsg = assistantMsg;
          this.messageStore.messages.push(assistantMsg);
          await Promise.resolve(
            this.callback?.onReplayCheckpoint?.({
              observedAt: new Date().toISOString(),
              step: step + 1,
              messages: this.getMessages().filter((message) => message.role !== 'system'),
            })
          );
        }

        // Note: onThinking and onMessage are already called via streaming callbacks above
        if (response.content) {
          lastResult = response.content;
        }

        const toolCallResult = await executeAgentToolCallsForTurn(
          this.toolCallHost,
          {
            response,
            persistedAssistantMsg,
            step,
            lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          }
        );
        if (toolCallResult.kind === 'terminal') {
          return toolCallResult.result;
        }
        const forcedTurnCompletion = toolCallResult.forcedTurnCompletion;
        await this.refreshLastPrecompressValidation(activeSystemPrompt);
        const currentStep = step + 1;

        if (forcedTurnCompletion) {
          lastResult = forcedTurnCompletion.content;
          agentLogger.info(
            `[DPAgent] Completing turn after approved finalize_plan: finishReason=${forcedTurnCompletion.finishReason} step=${currentStep}`
          );
          return await completeAgentTurn(this.turnCompletionHost, {
            content: lastResult,
            finishReason: forcedTurnCompletion.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          });
        }

        if (response.finishReason === 'max_tokens') {
          consecutiveProgressOnlyTurnStops = 0;
          const recovery = await this.maxTokensRecoveryService.handleMaxTokensRecovery({
            step: currentStep,
            usage: lastUsage,
            previousAttempt: maxTokensRecoveryAttempt,
          });
          maxTokensEvents.push(recovery.event);
          await Promise.resolve(this.callback?.onMaxTokensRecovery?.(recovery.event));
          maxTokensRecoveryAttempt = recovery.attempt;
          if (recovery.recovered) {
            recoveredFromMaxTokens = true;
            step = currentStep;
            continue;
          }

          return await completeAgentTurn(this.turnCompletionHost, {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          });
        }

        const progressOnlyRecovery = this.turnRecoveryOrchestrator.handleProgressOnlyRecovery({
          response,
          consecutiveStopCount: consecutiveProgressOnlyTurnStops,
        });
        if (progressOnlyRecovery.kind === 'stall') {
          lastResult = progressOnlyRecovery.content;
          return await completeAgentTurn(this.turnCompletionHost, {
            content: lastResult,
            finishReason: 'protocol_stall',
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          });
        }
        if (progressOnlyRecovery.kind === 'continue') {
          consecutiveProgressOnlyTurnStops = progressOnlyRecovery.nextCount;
          step = currentStep;
          continue;
        }

        consecutiveProgressOnlyTurnStops = 0;

        if (isTurnCompleteFinishReason(response.finishReason)) {
          agentLogger.info(
            `[DPAgent] Completing turn: finishReason=${response.finishReason} step=${currentStep} contentChars=${lastResult.length}`
          );
          return await completeAgentTurn(this.turnCompletionHost, {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          });
        }

        if (response.finishReason !== 'tool_use') {
          agentLogger.info(
            `[DPAgent] Continue turn because finishReason=${response.finishReason ?? 'unknown'} is not end_turn`
          );
        }

        step = currentStep;
      }

      if (step >= this.maxSteps) {
        lastResult = `Task couldn't be completed after ${this.maxSteps} steps.`;
      }

      return await completeAgentTurn(this.turnCompletionHost, {
        content: lastResult,
        finishReason: 'max_steps',
        step,
        turnEndStep: step + 1,
        usage: lastUsage,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.callback?.onError?.(err);
      throw err;
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  async runWithAssert(
    prompt: string,
    assertFn: (result: string) => boolean | Promise<boolean>,
    maxRetries: number = 3,
    sessionId?: string
  ): Promise<string> {
    let lastResult = '';
    let retries = 0;

    while (retries < maxRetries) {
      lastResult = await this.run(prompt, sessionId);

      const passed = await assertFn(lastResult);
      if (passed) {
        return lastResult;
      }

      retries++;

      if (retries < maxRetries) {
        this.addUserMessage(
          `The previous result did not meet the requirements. Please try again. Attempt ${retries + 1}/${maxRetries}.`
        );
      }
    }

    return lastResult;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  reset(): void {
    this.messageStore.messages = [];
    this.messageStore.sessionId = null;
    this.messageStore.resetRunState();
    this.contextOverflowHandler.resetOverflowSnapshots();
    this.clearPromptUsageAnchor();
    this.initializeMessages();
  }

  setWorkspaceDir(dir: string): void {
    this.workspaceDir = path.resolve(dir);
    this.ensureWorkspace();
    this.initializeMessages();
  }
}

