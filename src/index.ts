import * as path from 'path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import {
  estimateMessageCharacters,
  sanitizeMessagesForToolProtocol,
  type LLMRuntime,
  type PreparedMessagesSnapshot,
} from './llm/index.js';
import {
  mirrorLegacyApiUpdateToLlmProfiles,
  syncLegacyApiFromLlmProfiles,
} from './llm/provider-profiles.js';
import { Agent } from './agent/index.js';
import {
  ToolRegistry,
  ToolsetRegistry,
  createToolsetRegistry,
  PermissionManager,
} from './tools/index.js';
import { MCPConnector, SharedMcpRuntimePool, type SharedMcpRuntimeLease } from './mcp/index.js';
import { ConfigManager } from './config/index.js';
import {
  getCompletionMarkerRuleText,
  isCompletionMarkerEnforcementEnabled,
} from './completion-marker-policy.js';
import { ContextEventStore, ContextManager, ContextPayloadProjector } from './context/index.js';
import { GovernanceAuditStore, ToolsetPresetStore } from './governance/index.js';
import {
  buildPromptWithAgentProfileReference,
  parseAgentProfilePrompt,
  type AgentProfileReference,
} from './agents/index.js';
import {
  MemoryPromotionCoordinator,
  MemoryStore,
  SessionSearchIndex,
  type MemoryMutationInput,
  type MemoryMutationResult,
} from './memory/index.js';
import { SubAgentManager, SubAgentTurnRunner } from './subagent/index.js';
import { SkillDraftStore, SkillLoader, SkillPackStore } from './skills/index.js';
import { TodoStore } from './todo/index.js';
import { agentLogger } from './utils/logger.js';
import { ContextCompressor } from './compression/index.js';
import { createMiniMaxAgentCoreServices } from './runtime/minimax-agent-core-services.js';
import { getRuntimePlatformCapabilities } from './runtime-platform.js';
import { bootstrapMiniMaxRuntime } from './runtime/minimax-agent-bootstrap.js';
import {
  buildExecutionToolRegistry,
  type ExecutionToolRegistryOptions,
} from './runtime/minimax-agent-execution-tools.js';
import {
  buildInterruptedSideEffectSegment,
  buildSideEffectLedgerFromPreview,
  cloneMessage,
  hasCheckpointProgress,
  slicePreviewMessages,
} from './interrupted-turn-recovery.js';
import type {
  AgentCallback,
  AgentCompletionMeta,
  AgentConfig,
  ContextPrecompressEvent,
  ContextOverflowEvent,
  ContextNamespaceMeta,
  ContextRef,
  InterruptedArtifact,
  MCPServerRuntimeStatus,
  MCPStatusResponse,
  MaxTokensRecoveryEvent,
  Message,
  PersistedMessage,
  MiniMaxRunOptions,
  MiniMaxRunResult,
  ResolvedLlmRuntimeConfig,
  RunTerminalState,
  Session,
} from './types.js';

export interface MiniMaxAgentOptions {
  config?: Partial<AgentConfig>;
  configPath?: string;
  allowMissingApiKeyAtBoot?: boolean;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  workspaceDir?: string;
  runtimeDataDir?: string;
  contextDir?: string;
  skillListPath?: string;
  additionalDirs?: string[];
}

function normalizeMaxOutputTokens(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

const INTERNAL_CONTEXT_MARKERS = [
  '[SUMMARY_MESSAGES_APPLIED',
  '[CONTEXT_PRECOMPRESSED',
  '[CONTEXT_COMPRESSED]',
  '[TOOL_HISTORY_COMPACTED]',
  '[MAX_TOKENS_RECOVERY]',
  '[TOOLCALL_FAILED]',
  '[EXECUTION_CONTINUE_REQUIRED]',
  '[CONTEXT_WINDOW_GUARD]',
  '[INTERRUPTED_TURN_RESUME]',
] as const;
const HISTORY_REPLAY_ROUNDS_HARD_CAP = 48;
const COMPRESSED_HISTORY_CHAR_HARD_MAX = 12000;

interface ReplayRound {
  messages: Message[];
  chars: number;
}

interface ContextReplayAssembly {
  replayMessages: Message[];
  compressedHistorySegment?: string;
  compressedHistoryContextUpdate?: ContextNamespaceMeta['compressedHistoryContext'] | null;
  compressedHistoryGenerated: boolean;
  compressedHistoryUsed: boolean;
  compressionCache: 'bypass' | 'hit' | 'miss';
  compressionCallCount: number;
  compressionDurationMs: number;
  sealedRoundCount: number;
  replayRoundCount: number;
  compressedPrefixChars: number;
}

interface TurnPromptEnvelope {
  effectivePrompt: string;
  rawUserPrompt: string;
  historyUserPrompt: string;
  additionalSystemPrompt: string;
  promptReference?: string;
  hasSystemPromptInjection: boolean;
}

export class MiniMaxAgent {
  private config: ConfigManager;
  private llmClient: LLMRuntime | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private permissionManager: PermissionManager | null = null;
  private mcpConnector: MCPConnector | null = null;
  private mcpRuntimeLease: SharedMcpRuntimeLease | null = null;
  private contextManager: ContextManager;
  private memoryStore: MemoryStore;
  private memoryPromotionCoordinator: MemoryPromotionCoordinator;
  private sessionSearchIndex: SessionSearchIndex;
  private subAgentTurnRunner: SubAgentTurnRunner;
  private subAgentManager: SubAgentManager;
  private skillLoader: SkillLoader;
  private skillDraftStore: SkillDraftStore;
  private skillPackStore: SkillPackStore;
  private todoStore: TodoStore;
  private toolsetRegistry: ToolsetRegistry;
  private toolsetPresetStore: ToolsetPresetStore;
  private governanceAuditStore: GovernanceAuditStore;
  private runtimeDataDir: string;
  private contextDir: string;
  private fullSystemPrompt = '';
  private mcpToolDescriptions = '';
  private defaultCallback?: AgentCallback;
  private initialized = false;
  private activeTurnAgents: Map<Agent, string> = new Map();
  private activeContextForLlmSnapshot: ContextRef | null = null;
  private activePrecompressSnapshot: ContextPrecompressEvent | null = null;
  private contextPayloadProjector = new ContextPayloadProjector();
  private allowMissingApiKeyAtBoot = false;
  private llmRuntime?: ResolvedLlmRuntimeConfig;
  
  private getExtraReadableDirs(cfg: AgentConfig): string[] {
    const dirs: string[] = [];
    const skillsDir = String(cfg.agent.skillsDir ?? '').trim();
    if (skillsDir) {
      dirs.push(skillsDir);
    }
    const globalAgentsDir = String(cfg.agent.globalAgentsDir ?? '').trim();
    if (globalAgentsDir) {
      dirs.push(globalAgentsDir);
    }
    return dirs;
  }

  constructor(options: MiniMaxAgentOptions = {}) {
    this.allowMissingApiKeyAtBoot = options.allowMissingApiKeyAtBoot === true;
    this.llmRuntime = options.llmRuntime;
    this.config = new ConfigManager(options.config);

    const resolvedConfigPath = options.configPath ?? path.join(process.cwd(), 'config.yaml');
    const shouldLoadFromFile = Boolean(options.configPath) || (!options.config && fsSync.existsSync(resolvedConfigPath));
    if (shouldLoadFromFile) {
      agentLogger.configLoad('config', resolvedConfigPath);
      this.config.loadFromYaml(resolvedConfigPath);
    } else if (!options.config) {
      throw new Error(
        `config.yaml not found at ${resolvedConfigPath}. Create config.yaml or pass MiniMaxAgentOptions.configPath.`
      );
    }
    if (options.workspaceDir) {
      this.config.setWorkspaceDir(options.workspaceDir);
    }
    if (options.runtimeDataDir) {
      this.config.setRuntimeDataDir(options.runtimeDataDir);
    }
    if (options.contextDir) {
      this.config.setContextDir(options.contextDir);
    }
    if (options.skillListPath) {
      this.config.setSkillListPath(options.skillListPath);
    }

    const cfg = this.config.get();
    this.assertStartupConfig(cfg, { requireApiKey: !this.allowMissingApiKeyAtBoot });
    this.runtimeDataDir = cfg.agent.runtimeDataDir ?? path.join(cfg.agent.workspaceDir, '.minimax', 'runtime');
    this.contextDir = cfg.agent.contextDir ?? path.join(cfg.agent.workspaceDir, '.minimax', 'contexts');
    const coreServices = createMiniMaxAgentCoreServices({
      contextDir: this.contextDir,
      runtimeDataDir: this.runtimeDataDir,
      getLlmClient: () => this.llmClient,
    });
    this.contextManager = coreServices.contextManager;
    this.memoryStore = coreServices.memoryStore;
    this.governanceAuditStore = coreServices.governanceAuditStore;
    this.memoryPromotionCoordinator = coreServices.memoryPromotionCoordinator;
    this.sessionSearchIndex = coreServices.sessionSearchIndex;
    this.toolsetPresetStore = coreServices.toolsetPresetStore;
    this.subAgentTurnRunner = new SubAgentTurnRunner({
      getLLMClient: () => this.llmClient,
      contextManager: this.contextManager,
      getMainToolRegistry: () => this.toolRegistry,
      getTaskToolRegistry: (task, turnId) =>
        this.createSubAgentExecutionToolRegistry(
          task.parentContext,
          turnId,
          task.workspaceDir ?? this.config.get().agent.workspaceDir,
          task.allowedTools
        ),
      getBaseSystemPrompt: () => this.fullSystemPrompt || this.config.getDefaultSystemPrompt(),
      getMcpToolDescriptions: () => this.mcpToolDescriptions,
      getMaxSteps: () => this.config.get().agent.maxSteps,
      getTokenLimit: () => this.config.get().agent.tokenLimit,
      getContextWindowChars: () => this.config.get().agent.contextWindowChars,
      getContextPrecompressTriggerRatio: () => this.config.get().agent.contextPrecompressTriggerRatio,
      getContextOverflowForcedTrimChars: () => this.config.get().agent.contextOverflowForcedTrimChars,
      getContextOverflowMaxErrorsBeforeTrim: () => this.config.get().agent.contextOverflowMaxErrorsBeforeTrim,
      getContextPrecompressKeepLlmRounds: () => this.config.get().agent.contextPrecompressKeepLlmRounds,
      getContextPrecompressChunkChars: () => this.config.get().agent.contextPrecompressChunkChars,
      getContextPrecompressRetry: () => this.config.get().agent.contextPrecompressRetry,
      getDefaultWorkspaceDir: () => this.config.get().agent.workspaceDir,
      getProviderConfigs: () => this.config.get().agentProviders,
    });
    this.subAgentManager = new SubAgentManager({
      contextManager: this.contextManager,
      turnRunner: this.subAgentTurnRunner,
      registryFilePath: path.join(this.contextDir, 'subagent_registry.json'),
      getDefaultWorkspaceDir: () => this.config.get().agent.workspaceDir,
      getProviderConfigs: () => this.config.get().agentProviders,
      getGlobalAgentsDir: () => this.config.get().agent.globalAgentsDir,
      getMaxParallelPerParent: () => this.config.get().agent.subAgentMaxParallelPerParent,
      getGlobalMaxParallel: () => this.config.get().agent.subAgentGlobalMaxParallel,
      resolveAllowedTools: ({ parentContext, workspaceDir, allowedTools }) =>
        this.resolveSubAgentAllowedTools(
          parentContext,
          workspaceDir ?? this.config.get().agent.workspaceDir,
          allowedTools
        ),
    });
    this.skillLoader = new SkillLoader();
    this.skillDraftStore = coreServices.skillDraftStore;
    this.skillPackStore = coreServices.skillPackStore;
    this.todoStore = coreServices.todoStore;
    this.toolsetRegistry = createToolsetRegistry(cfg.agent.defaultToolset);
    this.skillLoader.setSupplementalDirectoriesResolver((workspaceDir) =>
      this.skillPackStore.getActiveSkillDirectories(workspaceDir)
    );

    if (cfg.agent.skillListPath) {
      const skills = this.skillLoader.loadSkillList(cfg.agent.skillListPath);
      agentLogger.info(`[MiniMaxAgent] Loaded ${skills.length} skills from ${cfg.agent.skillListPath}`);
    }
    if (cfg.agent.skillsDir) {
      const codexSkills = this.skillLoader.loadCodexSkills(cfg.agent.skillsDir);
      agentLogger.info(`[MiniMaxAgent] Loaded ${codexSkills.length} Codex skills from ${cfg.agent.skillsDir}`);
    }
  }

  async initialize(callback?: AgentCallback): Promise<void> {
    this.defaultCallback = callback;
    if (this.initialized && this.llmClient && this.toolRegistry) {
      return;
    }
    const cfg = this.config.get();
    this.assertStartupConfig(cfg, { requireApiKey: !this.allowMissingApiKeyAtBoot });
    const maxOutputTokens = this.resolveConfiguredMaxOutputTokens(cfg);
    const runtimeBootstrap = await bootstrapMiniMaxRuntime({
      config: cfg,
      llmRuntime: this.llmRuntime,
      mcpRuntime: this.config.getMcpRuntimeConfig(),
      runtimeDataDir: this.runtimeDataDir,
      extraReadableDirs: this.getExtraReadableDirs(cfg),
      maxOutputTokens,
      onPreparedMessages: (snapshot) => {
        void this.persistPreparedMessagesSnapshot(snapshot);
      },
    });
    this.llmClient = runtimeBootstrap.llmClient;
    this.permissionManager = runtimeBootstrap.permissionManager;
    this.toolRegistry = runtimeBootstrap.toolRegistry;
    this.mcpConnector = runtimeBootstrap.mcpConnector;
    this.mcpRuntimeLease = runtimeBootstrap.mcpRuntimeLease;
    this.fullSystemPrompt = this.config.getDefaultSystemPrompt();
    this.mcpToolDescriptions = runtimeBootstrap.mcpToolDescriptions;

    const sessionContexts = this.contextManager.listNamespaces('session');
    this.sessionSearchIndex.pruneSessions(sessionContexts.map((item) => item.namespace));
    for (const item of sessionContexts) {
      this.refreshSessionSearchIndex({ scope: 'session', namespace: item.namespace }, item);
    }
    this.initialized = true;
  }

  async run(options: MiniMaxRunOptions): Promise<string> {
    const result = await this.runWithResult(options);
    return result.content;
  }

  async runWithResult(options: MiniMaxRunOptions): Promise<MiniMaxRunResult> {
    if (!options.context) {
      throw new Error('MiniMaxRunOptions.context is required');
    }
    if (!this.llmClient || !this.toolRegistry) {
      await this.initialize(options.callback ?? this.defaultCallback);
    }
    if (!this.llmClient || !this.toolRegistry) {
      throw new Error('Failed to initialize agent');
    }

    const context = this.normalizeContextRef(options.context);
    const contextKey = this.makeContextKey(context);
    const runId = String(options.runId ?? '').trim() || `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const interruptedContext = this.prepareInterruptedContextForTurnStart(context, {
      runId,
      runFamilyId: options.runFamilyId,
      resumeRequested: options.resumeRequested === true,
      resumeToken: options.resumeToken,
    });
    const baseCallback = options.callback ?? this.defaultCallback;
    let latestPrecompressEvent: ContextPrecompressEvent | null = null;
    const relayContextPrecompressEvent = async (event: ContextPrecompressEvent): Promise<void> => {
      latestPrecompressEvent = event;
      const activeContext = this.activeContextForLlmSnapshot;
      if (
        activeContext &&
        activeContext.scope === context.scope &&
        activeContext.namespace === context.namespace
      ) {
        this.activePrecompressSnapshot = event;
      }
      await Promise.resolve(baseCallback?.onContextPrecompress?.(event));
    };
    const persistedInterruptedSideEffects = this.contextManager.getInterruptedSideEffectLedger(context);
    const promptEnvelope = this.resolveTurnPromptEnvelope(options);
    const preLlmStartedAt = Date.now();
    const loadForTurnStartedAt = Date.now();
    const loaded = this.contextManager.loadForTurn(context);
    const loadForTurnMs = Date.now() - loadForTurnStartedAt;
    const historicalMessagesStartedAt = Date.now();
    const historicalMessages = this.contextManager.getConversationMessages(context, {
      preserveAgentProfileRefs: true,
      includeInterruptedCheckpoints: true,
    });
    const getConversationMessagesMs = Date.now() - historicalMessagesStartedAt;
    const replayMessagesStartedAt = Date.now();
    const replayAssembly = await this.buildContextReplayAssembly(context, historicalMessages, loaded.meta, {
      onContextPrecompress: relayContextPrecompressEvent,
    });
    const buildContextReplayMessagesMs = Date.now() - replayMessagesStartedAt;
    const preLlmTotalMs = Date.now() - preLlmStartedAt;
    agentLogger.info(
      `[MiniMaxAgent] Pre-LLM prepare: context=${context.scope}/${context.namespace} ` +
        `loadForTurnMs=${loadForTurnMs} getConversationMessagesMs=${getConversationMessagesMs} ` +
        `buildContextReplayMessagesMs=${buildContextReplayMessagesMs} preLlmTotalMs=${preLlmTotalMs} ` +
        `compressionCache=${replayAssembly.compressionCache} ` +
        `compressionCalls=${replayAssembly.compressionCallCount} ` +
        `compressionDurationMs=${replayAssembly.compressionDurationMs} ` +
        `compressedHistoryUsed=${replayAssembly.compressedHistoryUsed} ` +
        `compressedHistoryGenerated=${replayAssembly.compressedHistoryGenerated} ` +
        `compressedPrefixRounds=${replayAssembly.sealedRoundCount} ` +
        `compressedPrefixChars=${replayAssembly.compressedPrefixChars} ` +
        `replayRounds=${replayAssembly.replayRoundCount}`
    );
    if (replayAssembly.compressionDurationMs > 180_000) {
      agentLogger.warn(
        `[MiniMaxAgent] Replay compression exceeded guardrail: context=${context.scope}/${context.namespace} durationMs=${replayAssembly.compressionDurationMs}`
      );
    }
    const runWorkspaceDir =
      interruptedContext.artifact?.workspaceDir ??
      options.workspaceDir ??
      loaded.meta?.workspaceDir ??
      this.config.get().agent.workspaceDir;
    const snapshotContext = this.activeContextForLlmSnapshot;
    if (
      !snapshotContext ||
      (snapshotContext.scope === context.scope && snapshotContext.namespace === context.namespace)
    ) {
      this.activeContextForLlmSnapshot = context;
      this.activePrecompressSnapshot = null;
    }

    const maxTokensEvents: MaxTokensRecoveryEvent[] = [];
    const contextOverflowEvents: ContextOverflowEvent[] = [];
    let replayBaselineMessageCount = 0;
    const runCallback: AgentCallback = {
      ...baseCallback,
      onMaxTokensRecovery: async (event) => {
        const snapshotPath = await this.persistMaxTokensRecoverySnapshot(context, event);
        event.maxTokensSnapshotPath = snapshotPath;
        maxTokensEvents.push(event);
        await Promise.resolve(baseCallback?.onMaxTokensRecovery?.(event));
      },
      onContextPrecompress: async (event) => {
        await relayContextPrecompressEvent(event);
      },
      onContextOverflow: async (event) => {
        const snapshotPath = await this.persistContextOverflowSnapshot(context, event);
        event.contextOverflowSnapshotPath = snapshotPath;
        contextOverflowEvents.push(event);
        await Promise.resolve(baseCallback?.onContextOverflow?.(event));
      },
      onReplayCheckpoint: async (event) => {
        const turnMessages = this.collectCommittedMessagesFromSnapshot(event.messages, replayBaselineMessageCount);
        if (!hasCheckpointProgress(turnMessages)) {
          return;
        }
        this.contextManager.saveReplayCheckpoint(turn.turnId, {
          observedAt: event.observedAt,
          step: event.step,
          messages: turnMessages.map((message) => cloneMessage(message)),
        });
        await Promise.resolve(baseCallback?.onReplayCheckpoint?.(event));
      },
      onError: () => undefined,
      onComplete: () => undefined,
    };

    const turnSystemPrompt = this.buildTurnSystemPrompt({
      workspaceDir: runWorkspaceDir,
      context,
      additionalSystemPrompt: promptEnvelope.additionalSystemPrompt,
      compressedHistorySegment: replayAssembly.compressedHistorySegment,
      systemSegment: loaded.systemSegment,
      interruptedSideEffectSegment: buildInterruptedSideEffectSegment(persistedInterruptedSideEffects),
    });
    const replayPayloadProjection = this.contextPayloadProjector.projectForProvider(replayAssembly.replayMessages, {
      systemPrompt: turnSystemPrompt,
      trimOptions: this.buildProviderProjectionTrimOptions(),
    });
    if (
      replayPayloadProjection.metrics.toolResultRefReplacements > 0 ||
      replayPayloadProjection.metrics.oversizedInlineToolTruncations > 0 ||
      replayPayloadProjection.metrics.trimRemovedCount > 0 ||
      replayPayloadProjection.metrics.protocolCorrectionCount > 0
    ) {
      agentLogger.info(
        `[MiniMaxAgent] Context payload projected: context=${context.scope}/${context.namespace} ` +
          `originalChars=${replayPayloadProjection.metrics.originalChars} ` +
          `projectedChars=${replayPayloadProjection.metrics.projectedChars} ` +
          `preparedChars=${replayPayloadProjection.metrics.preparedChars} ` +
          `toolRefs=${replayPayloadProjection.metrics.toolResultRefReplacements} ` +
          `inlineToolTruncations=${replayPayloadProjection.metrics.oversizedInlineToolTruncations} ` +
          `trimRemoved=${replayPayloadProjection.metrics.trimRemovedCount} ` +
          `protocolCorrections=${replayPayloadProjection.metrics.protocolCorrectionCount}`
      );
    }
    const turn = this.contextManager.beginTurn(context, promptEnvelope.rawUserPrompt, runWorkspaceDir, {
      rawUserPrompt: promptEnvelope.rawUserPrompt,
      historyUserPrompt: promptEnvelope.historyUserPrompt,
      effectivePrompt: promptEnvelope.effectivePrompt,
      promptRef: promptEnvelope.promptReference,
      promptInjected: promptEnvelope.hasSystemPromptInjection,
      draftId: interruptedContext.draftId,
      runId,
      runFamilyId: interruptedContext.runFamilyId,
      maxSteps: this.config.get().agent.maxSteps,
    });
    const turnToolRegistry = this.createTurnToolRegistry(context, turn.turnId, runWorkspaceDir, runCallback);
    const turnAgent = new Agent({
      llmClient: this.llmClient,
      toolRegistry: turnToolRegistry,
      systemPrompt: turnSystemPrompt,
      maxSteps: this.config.get().agent.maxSteps,
      tokenLimit: this.config.get().agent.tokenLimit,
      contextWindowChars: this.config.get().agent.contextWindowChars,
      contextPrecompressTriggerRatio: this.config.get().agent.contextPrecompressTriggerRatio,
      contextOverflowForcedTrimChars: this.config.get().agent.contextOverflowForcedTrimChars,
      contextOverflowMaxErrorsBeforeTrim: this.config.get().agent.contextOverflowMaxErrorsBeforeTrim,
      contextPrecompressKeepLlmRounds: this.config.get().agent.contextPrecompressKeepLlmRounds,
      contextPrecompressChunkChars: this.config.get().agent.contextPrecompressChunkChars,
      contextPrecompressRetry: this.config.get().agent.contextPrecompressRetry,
      workspaceDir: runWorkspaceDir,
      callback: runCallback,
      mcpToolDescriptions: this.mcpToolDescriptions,
      materializeToolResultArtifact: (artifactInput) =>
        this.contextManager.materializeToolResultArtifact(context, artifactInput),
      maxTokensRecoveryMaxAttempts: 2,
      progressOnlyRecoveryEnabled: context.scope !== 'session',
    });
    if (replayPayloadProjection.messages.length > 0) {
      turnAgent.setMessages(replayPayloadProjection.messages);
    }
    const baselineMessageCount = turnAgent.getMessages().length;
    replayBaselineMessageCount = baselineMessageCount > 0 ? baselineMessageCount - 1 : 0;
    this.activeTurnAgents.set(turnAgent, contextKey);

    let content = '';
    let finishReason: string | undefined;
    let step: number | undefined;
    let usage = undefined;
    let recoveredFromMaxTokens = false;
    let maxTokensRecoveryAttempt = 0;
    let runMaxTokensEvents: MaxTokensRecoveryEvent[] = [];
    let terminalState: RunTerminalState | null = null;

    try {
      if (options.assert) {
        content = await turnAgent.runWithAssert(promptEnvelope.effectivePrompt, options.assert, 3, turn.turnId);
      } else {
        const result = await turnAgent.runWithResult(promptEnvelope.effectivePrompt, turn.turnId);
        content = result.content;
        finishReason = result.finishReason;
        step = result.step;
        usage = result.usage;
        recoveredFromMaxTokens = result.recoveredFromMaxTokens ?? false;
        maxTokensRecoveryAttempt = result.maxTokensRecoveryAttempt ?? 0;
        runMaxTokensEvents = result.maxTokensEvents ?? [];
      }

      const turnMessages = this.collectTurnMessages(turnAgent, baselineMessageCount);
      const effectiveMaxTokensEvents = runMaxTokensEvents.length > 0 ? runMaxTokensEvents : maxTokensEvents;
      const maxTokensSnapshotPaths = effectiveMaxTokensEvents
        .map((event) => event.maxTokensSnapshotPath)
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      const contextOverflowSnapshotPaths = contextOverflowEvents
        .map((event) => event.contextOverflowSnapshotPath)
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

      if (finishReason === 'cancelled') {
        const interrupted = this.finalizeInterruptedRun({
          context,
          turnId: turn.turnId,
          runId,
          runFamilyId: interruptedContext.runFamilyId,
          draftId: interruptedContext.draftId,
          maxSteps: this.config.get().agent.maxSteps,
          step: step ?? 0,
          terminalCode: 'cancelled',
          turnMessages,
        });
        terminalState = interrupted.terminalState;
        this.applyCompressedHistoryContextUpdate(context, replayAssembly.compressedHistoryContextUpdate);
        const updatedMeta = this.getContextNamespaceMeta(context);
        this.refreshSessionSearchIndex(context, updatedMeta);
        return {
          content,
          context,
          turnId: turn.turnId,
          contextVersion: interrupted.contextVersion,
          runId,
          runFamilyId: interruptedContext.runFamilyId,
          finishReason,
          step,
          usage,
          recoveredFromMaxTokens,
          maxTokensRecoveryAttempt,
          maxTokensEvents: effectiveMaxTokensEvents.length > 0 ? effectiveMaxTokensEvents : undefined,
          maxTokensSnapshotPath: maxTokensSnapshotPaths[maxTokensSnapshotPaths.length - 1],
          maxTokensSnapshotPaths: maxTokensSnapshotPaths.length > 0 ? maxTokensSnapshotPaths : undefined,
          contextOverflowSnapshotPath: contextOverflowSnapshotPaths[contextOverflowSnapshotPaths.length - 1],
          contextOverflowSnapshotPaths:
            contextOverflowSnapshotPaths.length > 0 ? contextOverflowSnapshotPaths : undefined,
          tokenLimit: this.config.get().agent.tokenLimit,
          maxOutputTokens: this.resolveConfiguredMaxOutputTokens(this.config.get()),
          terminalState,
        };
      }

      const commitResult = this.contextManager.commitTurn(turn.turnId, {
        messages: turnMessages,
        rawUserPrompt: promptEnvelope.rawUserPrompt,
        historyUserPrompt: promptEnvelope.historyUserPrompt,
        effectivePrompt: promptEnvelope.effectivePrompt,
        promptRef: promptEnvelope.promptReference,
        promptInjected: promptEnvelope.hasSystemPromptInjection,
        finalOutputText: content,
        finishReason,
        usage,
      });
      if (interruptedContext.artifact) {
        this.contextManager.clearInterruptedArtifact(context);
      }
      if (persistedInterruptedSideEffects.length > 0) {
        this.contextManager.clearInterruptedSideEffectLedger(context);
      }
      this.applyCompressedHistoryContextUpdate(context, replayAssembly.compressedHistoryContextUpdate);
      const updatedMeta = this.getContextNamespaceMeta(context);
      this.refreshSessionSearchIndex(context, updatedMeta);
      if (context.scope === 'session') {
        void this.memoryPromotionCoordinator.noteCommittedTurn({
          sessionId: context.namespace,
          workspaceDir: runWorkspaceDir,
          contextVersion: commitResult.contextVersion,
        });
        const skillDraft = this.skillDraftStore.observeSuccessfulTurn({
          sessionId: context.namespace,
          workspaceDir: runWorkspaceDir,
          prompt: promptEnvelope.rawUserPrompt,
          finalOutput: content,
          globalSkillsDir: this.config.get().agent.skillsDir,
          toolsetName: this.resolveToolsetName(context),
          platform: getRuntimePlatformCapabilities().platform,
        });
        if (skillDraft) {
          const autoApprovedSkill =
            (this.config.get().agent.skillWriteMode ?? 'confirm') === 'auto'
              ? this.approveSkillDraft(skillDraft.id)
              : null;
          const skillDetail =
            skillDraft.action === 'update'
              ? `v${skillDraft.baseVersion ?? 'unknown'} -> v${skillDraft.nextVersion ?? 'pending'}`
              : `v${skillDraft.nextVersion ?? '1'}`;
          this.governanceAuditStore.append({
            kind: 'skill_triggered',
            title: `Skill ${skillDraft.action} trigger: ${skillDraft.name}`,
            detail: skillDetail,
            sessionId: context.namespace,
            workspaceDir: runWorkspaceDir,
            entityType: 'skill',
            entityId: autoApprovedSkill?.targetPath ?? skillDraft.id,
            status: autoApprovedSkill ? 'success' : 'info',
            metadata: {
              action: skillDraft.action,
              baseVersion: skillDraft.baseVersion,
              nextVersion: skillDraft.nextVersion,
              autoApproved: Boolean(autoApprovedSkill),
              passSignal: skillDraft.action === 'update' ? 'skill_update_triggered' : 'skill_create_triggered',
            },
          });
          baseCallback?.onSkillTrigger?.({
            name: skillDraft.name,
            action: skillDraft.action,
            target: skillDraft.target,
            targetPath: autoApprovedSkill?.targetPath ?? skillDraft.targetPath,
            version: autoApprovedSkill?.nextVersion ?? skillDraft.nextVersion ?? '1',
            detail: skillDetail,
          });
        }
      }
      terminalState = this.buildRunTerminalState({
        runId,
        runFamilyId: interruptedContext.runFamilyId,
        draftId: interruptedContext.draftId,
        terminalCode: 'completed',
        replayCutoffKind: 'endturn',
        resumable: false,
        lastSafeStep: step ?? 0,
        maxSteps: this.config.get().agent.maxSteps,
      });

      const completionMeta: AgentCompletionMeta = {
        finishReason,
        usage,
        step: step ?? 0,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents: effectiveMaxTokensEvents.length > 0 ? effectiveMaxTokensEvents : undefined,
        maxTokensSnapshotPath: maxTokensSnapshotPaths[maxTokensSnapshotPaths.length - 1] ?? null,
      };
      baseCallback?.onComplete?.(content, finishReason, completionMeta);

      return {
        content,
        context,
        turnId: turn.turnId,
        contextVersion: commitResult.contextVersion,
        runId,
        runFamilyId: interruptedContext.runFamilyId,
        finishReason,
        step,
        usage,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents: effectiveMaxTokensEvents.length > 0 ? effectiveMaxTokensEvents : undefined,
        maxTokensSnapshotPath: maxTokensSnapshotPaths[maxTokensSnapshotPaths.length - 1],
        maxTokensSnapshotPaths: maxTokensSnapshotPaths.length > 0 ? maxTokensSnapshotPaths : undefined,
        contextOverflowSnapshotPath: contextOverflowSnapshotPaths[contextOverflowSnapshotPaths.length - 1],
        contextOverflowSnapshotPaths:
          contextOverflowSnapshotPaths.length > 0 ? contextOverflowSnapshotPaths : undefined,
        tokenLimit: this.config.get().agent.tokenLimit,
        maxOutputTokens: this.resolveConfiguredMaxOutputTokens(this.config.get()),
        terminalState,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const turnMessages = this.collectTurnMessages(turnAgent, baselineMessageCount);
      const interrupted = this.finalizeInterruptedRun({
        context,
        turnId: turn.turnId,
        runId,
        runFamilyId: interruptedContext.runFamilyId,
        draftId: interruptedContext.draftId,
        maxSteps: this.config.get().agent.maxSteps,
        step: step ?? 0,
        terminalCode: 'error',
        turnMessages,
        errorSummary: err.message,
      });
      terminalState = interrupted.terminalState;
      this.applyCompressedHistoryContextUpdate(context, replayAssembly.compressedHistoryContextUpdate);
      const updatedMeta = this.getContextNamespaceMeta(context);
      this.refreshSessionSearchIndex(context, updatedMeta);
      (err as Error & { terminalState?: RunTerminalState }).terminalState = terminalState;
      throw err;
    } finally {
      this.activeTurnAgents.delete(turnAgent);
      const snapshotContext = this.activeContextForLlmSnapshot;
      if (
        !snapshotContext ||
        (snapshotContext.scope === context.scope && snapshotContext.namespace === context.namespace)
      ) {
        this.activeContextForLlmSnapshot = null;
        this.activePrecompressSnapshot = latestPrecompressEvent;
      }
    }
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getSubAgentManager(): SubAgentManager {
    return this.subAgentManager;
  }

  getContextNamespaceMeta(ref: ContextRef): ContextNamespaceMeta | undefined {
    return this.contextManager
      .getEventStore()
      .loadMeta(ref.scope, ref.namespace);
  }

  private refreshSessionSearchIndex(ref: ContextRef, meta?: ContextNamespaceMeta): void {
    if (ref.scope !== 'session') {
      return;
    }
    const transcriptMessages = this.extractSessionSearchMessages(
      this.contextManager.getConversationMessages(ref, {
        preserveAgentProfileRefs: false,
      })
    );
    this.sessionSearchIndex.upsertSession(ref, meta, transcriptMessages);
  }

  private applyCompressedHistoryContextUpdate(
    ref: ContextRef,
    update: ContextReplayAssembly['compressedHistoryContextUpdate']
  ): void {
    if (update === undefined) {
      return;
    }
    this.contextManager.updateNamespaceMeta(ref, {
      compressedHistoryContext: update ?? undefined,
    });
  }

  resolveWorkspaceDirForContext(ref: ContextRef): string | undefined {
    const meta = this.getContextNamespaceMeta(ref);
    const workspaceDir = String(meta?.workspaceDir ?? '').trim();
    if (workspaceDir.length > 0) {
      return workspaceDir;
    }
    const artifactWorkspaceDir = String(this.contextManager.getInterruptedArtifact(ref)?.workspaceDir ?? '').trim();
    if (artifactWorkspaceDir.length > 0) {
      return artifactWorkspaceDir;
    }
    if (ref.scope === 'workspace') {
      const namespace = String(ref.namespace ?? '').trim();
      return namespace.length > 0 ? namespace : this.config.get().agent.workspaceDir;
    }
    return this.config.get().agent.workspaceDir;
  }

  updateContextNamespaceMeta(ref: ContextRef, updates: Partial<ContextNamespaceMeta>): ContextNamespaceMeta {
    return this.contextManager.updateNamespaceMeta(ref, updates);
  }

  getInterruptedArtifact(ref: ContextRef): InterruptedArtifact | undefined {
    return this.contextManager.getInterruptedArtifact(ref);
  }

  dismissInterruptedArtifact(ref: ContextRef): InterruptedArtifact | undefined {
    return this.contextManager.dismissInterruptedArtifact(ref);
  }

  getContextMessages(
    ref: ContextRef,
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): Message[] {
    return this.contextManager.getConversationMessages(ref, options);
  }

  cancel(): void {
    for (const turnAgent of this.activeTurnAgents.keys()) {
      turnAgent.cancel();
    }
  }

  cancelContext(context: ContextRef): number {
    const targetKey = this.makeContextKey(this.normalizeContextRef(context));
    let canceledCount = 0;
    for (const [turnAgent, contextKey] of this.activeTurnAgents.entries()) {
      if (contextKey !== targetKey) {
        continue;
      }
      turnAgent.cancel();
      canceledCount += 1;
    }
    return canceledCount;
  }

  reset(): void {
    this.activeContextForLlmSnapshot = null;
    this.activePrecompressSnapshot = null;
  }

  getConfig(): AgentConfig {
    return this.config.get();
  }

  getMcpStatus(): MCPStatusResponse {
    const runtime = this.config.getMcpRuntimeConfig();
    const defaultServerStatus: MCPServerRuntimeStatus = runtime.enabled ? 'idle' : 'disabled';
    const nowIso = new Date().toISOString();
    const snapshot = this.mcpConnector?.getStatusSnapshot() ?? SharedMcpRuntimePool.getSnapshot(runtime);

    if (!snapshot) {
      const servers = runtime.servers.map((server) => ({
        name: server.name,
        status: server.disabled ? 'disabled' : defaultServerStatus,
        toolCount: 0,
        retryCount: 0,
        lastError: undefined,
        updatedAt: nowIso,
        disabled: server.disabled === true || !runtime.enabled,
      }));
      return {
        enabled: runtime.enabled,
        summary: this.summarizeMcpServers(servers),
        servers,
      };
    }

    const statusByName = new Map(snapshot.servers.map((server) => [server.name, server]));
    const servers = runtime.servers.map((server) => {
      const status = statusByName.get(server.name);
      if (!status) {
        return {
          name: server.name,
          status: server.disabled ? 'disabled' : defaultServerStatus,
          toolCount: 0,
          retryCount: 0,
          lastError: undefined,
          updatedAt: nowIso,
          disabled: server.disabled === true || !runtime.enabled,
        };
      }
      return {
        name: status.name,
        status: server.disabled || !runtime.enabled ? 'disabled' : status.status,
        toolCount: status.toolCount,
        retryCount: status.retryCount,
        lastError: status.lastError,
        updatedAt: status.updatedAt,
        disabled: server.disabled === true || !runtime.enabled,
      };
    });

    return {
      enabled: runtime.enabled,
      summary: this.summarizeMcpServers(servers),
      servers,
    };
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    if (updates.api) {
      this.config['config'] = mirrorLegacyApiUpdateToLlmProfiles(this.config['config'], updates.api);
    }
    if (updates.llmProfiles) {
      this.config['config'].llmProfiles = updates.llmProfiles;
    }
    if (updates.agent) {
      if (typeof updates.agent.maxSteps === 'number') {
        this.config['config'].agent.maxSteps = updates.agent.maxSteps;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'skillsDir')) {
        this.config['config'].agent.skillsDir = updates.agent.skillsDir;
      }
      if (updates.agent.workspaceDir) this.config['config'].agent.workspaceDir = updates.agent.workspaceDir;
      if (typeof updates.agent.completionMarkerEnforcementEnabled === 'boolean') {
        this.config['config'].agent.completionMarkerEnforcementEnabled =
          updates.agent.completionMarkerEnforcementEnabled;
      }
      if (updates.agent.defaultToolset !== undefined) this.config['config'].agent.defaultToolset = updates.agent.defaultToolset;
      if (updates.agent.skillWriteMode !== undefined) this.config['config'].agent.skillWriteMode = updates.agent.skillWriteMode;
      if (typeof updates.agent.subAgentMaxParallelPerParent === 'number') {
        this.config['config'].agent.subAgentMaxParallelPerParent = updates.agent.subAgentMaxParallelPerParent;
      }
      if (typeof updates.agent.subAgentGlobalMaxParallel === 'number') {
        this.config['config'].agent.subAgentGlobalMaxParallel = updates.agent.subAgentGlobalMaxParallel;
      }
      if (typeof updates.agent.contextReplayMinRounds === 'number') {
        this.config['config'].agent.contextReplayMinRounds = updates.agent.contextReplayMinRounds;
      }
      if (typeof updates.agent.contextReplayMaxRounds === 'number') {
        this.config['config'].agent.contextReplayMaxRounds = updates.agent.contextReplayMaxRounds;
      }
      if (typeof updates.agent.contextReplayBudgetRatio === 'number') {
        this.config['config'].agent.contextReplayBudgetRatio = updates.agent.contextReplayBudgetRatio;
      }
      if (typeof updates.agent.contextCompressionMaxChars === 'number') {
        this.config['config'].agent.contextCompressionMaxChars = updates.agent.contextCompressionMaxChars;
      }
      if (typeof updates.agent.contextWindowChars === 'number') {
        this.config['config'].agent.contextWindowChars = updates.agent.contextWindowChars;
      }
      if (typeof updates.agent.contextPrecompressTriggerRatio === 'number') {
        this.config['config'].agent.contextPrecompressTriggerRatio = updates.agent.contextPrecompressTriggerRatio;
      }
      if (typeof updates.agent.contextOverflowForcedTrimChars === 'number') {
        this.config['config'].agent.contextOverflowForcedTrimChars = updates.agent.contextOverflowForcedTrimChars;
      }
      if (typeof updates.agent.contextOverflowMaxErrorsBeforeTrim === 'number') {
        this.config['config'].agent.contextOverflowMaxErrorsBeforeTrim = updates.agent.contextOverflowMaxErrorsBeforeTrim;
      }
      if (typeof updates.agent.contextPrecompressKeepLlmRounds === 'number') {
        this.config['config'].agent.contextPrecompressKeepLlmRounds = updates.agent.contextPrecompressKeepLlmRounds;
      }
      if (typeof updates.agent.contextPrecompressChunkChars === 'number') {
        this.config['config'].agent.contextPrecompressChunkChars = updates.agent.contextPrecompressChunkChars;
      }
      if (typeof updates.agent.contextPrecompressRetry === 'number') {
        this.config['config'].agent.contextPrecompressRetry = updates.agent.contextPrecompressRetry;
      }
      if (updates.agent.contextDir) this.config['config'].agent.contextDir = updates.agent.contextDir;
      if (updates.agent.runtimeDataDir) this.config['config'].agent.runtimeDataDir = updates.agent.runtimeDataDir;
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'globalAgentsDir')) {
        this.config['config'].agent.globalAgentsDir = updates.agent.globalAgentsDir;
      }
      if (this.permissionManager) {
        const cfg = this.config.get();
        this.permissionManager.setAdditionalReadableDirs(this.getExtraReadableDirs(cfg));
      }
    }
    if (updates.agentProviders) {
      this.config['config'].agentProviders = updates.agentProviders;
    }
    if (updates.subAgentPresets) {
      this.config['config'].subAgentPresets = updates.subAgentPresets;
    }
    this.config['config'] = syncLegacyApiFromLlmProfiles(this.config['config']);
    this.toolsetRegistry = createToolsetRegistry(this.config.get().agent.defaultToolset);
    const updatedConfig = this.config.get();
    agentLogger.info(
      `Config updated: ${JSON.stringify({
        api: {
          ...updatedConfig.api,
          apiKey: updatedConfig.api.apiKey ? '[redacted]' : '',
          hasApiKey: Boolean(updatedConfig.api.apiKey),
        },
        agent: updatedConfig.agent,
      })}`
    );
  }

  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  getLLMClient(): LLMRuntime | null {
    return this.llmClient;
  }

  getToolsetRegistry(): ToolsetRegistry {
    return this.toolsetRegistry;
  }

  resolveToolsetName(context: ContextRef): string {
    const meta = this.getContextNamespaceMeta(context);
    const preferred = String(meta?.toolsetName ?? '').trim();
    if (preferred.length > 0) {
      return this.toolsetRegistry.get(preferred).name;
    }
    const workspaceDir = this.resolveWorkspaceDirForContext(context);
    const workspacePreset = this.toolsetPresetStore.getWorkspacePreset(workspaceDir);
    if (workspacePreset?.toolsetName) {
      return this.toolsetRegistry.get(workspacePreset.toolsetName).name;
    }
    if (workspaceDir) {
      const seeded = this.toolsetPresetStore.setWorkspacePreset(workspaceDir, 'full-access');
      return this.toolsetRegistry.get(seeded.toolsetName).name;
    }
    return this.toolsetRegistry.get(this.config.get().agent.defaultToolset).name;
  }

  listToolsets(): ReturnType<ToolsetRegistry['list']> {
    return this.toolsetRegistry.list();
  }

  getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  getMemoryPromotionState(sessionId: string) {
    return this.memoryPromotionCoordinator.getSessionState(sessionId);
  }

  async organizeSessionMemory(input: { sessionId: string; workspaceDir?: string }) {
    return this.memoryPromotionCoordinator.organizeSession({
      sessionId: input.sessionId,
      workspaceDir: input.workspaceDir,
      reason: 'manual',
    });
  }

  getSessionSearchIndex(): SessionSearchIndex {
    return this.sessionSearchIndex;
  }

  getSkillDraftStore(): SkillDraftStore {
    return this.skillDraftStore;
  }

  getSkillPackStore(): SkillPackStore {
    return this.skillPackStore;
  }

  getTodoStore(): TodoStore {
    return this.todoStore;
  }

  getSkillLoader(): SkillLoader {
    return this.skillLoader;
  }

  getToolsetPresetStore(): ToolsetPresetStore {
    return this.toolsetPresetStore;
  }

  getGovernanceAuditStore(): GovernanceAuditStore {
    return this.governanceAuditStore;
  }

  listGovernanceAudit(filters: {
    sessionId?: string;
    workspaceDir?: string;
    limit?: number;
  } = {}) {
    return this.governanceAuditStore.list(filters);
  }

  listToolsetPresets(): ReturnType<ToolsetPresetStore['list']> {
    return this.toolsetPresetStore.list();
  }

  private resolveGovernanceWorkspaceDir(input: {
    sessionId?: string;
    workspaceDir?: string;
  }): string | undefined {
    const explicitWorkspaceDir = String(input.workspaceDir ?? '').trim();
    if (explicitWorkspaceDir.length > 0) {
      return path.resolve(explicitWorkspaceDir);
    }
    const sessionId = String(input.sessionId ?? '').trim();
    if (sessionId.length === 0) {
      return undefined;
    }
    return this.resolveWorkspaceDirForContext({
      scope: 'session',
      namespace: sessionId,
    });
  }

  setToolsetPreset(input: {
    scope: 'team' | 'workspace';
    toolsetName: string;
    workspaceDir?: string;
    sessionId?: string;
  }) {
    const resolvedName = this.toolsetRegistry.get(input.toolsetName).name;
    const auditWorkspaceDir = this.resolveGovernanceWorkspaceDir(input);
    const record =
      input.scope === 'team'
        ? this.toolsetPresetStore.setTeamPreset(resolvedName)
        : this.toolsetPresetStore.setWorkspacePreset(String(input.workspaceDir ?? ''), resolvedName);
    this.governanceAuditStore.append({
      kind: 'toolset_preset_updated',
      title: `${input.scope === 'team' ? 'Team' : 'Workspace'} toolset preset set to ${resolvedName}`,
      detail: input.scope === 'workspace' ? record.workspaceDir : undefined,
      sessionId: input.sessionId,
      workspaceDir: auditWorkspaceDir ?? record.workspaceDir,
      entityType: 'toolset',
      entityId: resolvedName,
      status: 'success',
      metadata: {
        scope: input.scope,
        toolsetName: resolvedName,
      },
    });
    return record;
  }

  clearToolsetPreset(input: {
    scope: 'team' | 'workspace';
    workspaceDir?: string;
    sessionId?: string;
  }): boolean {
    const success =
      input.scope === 'team'
        ? this.toolsetPresetStore.clearTeamPreset()
        : this.toolsetPresetStore.clearWorkspacePreset(String(input.workspaceDir ?? ''));
    if (success) {
      const auditWorkspaceDir = this.resolveGovernanceWorkspaceDir(input);
      this.governanceAuditStore.append({
        kind: 'toolset_preset_cleared',
        title: `${input.scope === 'team' ? 'Team' : 'Workspace'} toolset preset cleared`,
        sessionId: input.sessionId,
        workspaceDir: auditWorkspaceDir,
        entityType: 'toolset',
        status: 'warning',
        metadata: {
          scope: input.scope,
        },
      });
    }
    return success;
  }

  mutateMemory(input: MemoryMutationInput): Promise<MemoryMutationResult> {
    return this.memoryPromotionCoordinator.mutate(input);
  }

  approveSkillDraft(id: string) {
    const record = this.skillDraftStore.approveDraft(id);
    if (record) {
      this.reloadSkills();
      this.maybeAutoPublishGeneratedWorkspaceSkills(record.workspaceDir, record.sourceSessionId);
      this.governanceAuditStore.append({
        kind: 'skill_approved',
        title: `Skill ${record.action} approved: ${record.name}`,
        detail: record.nextVersion ? `v${record.nextVersion}` : undefined,
        sessionId: record.sourceSessionId,
        workspaceDir: record.workspaceDir,
        entityType: 'skill',
        entityId: record.targetPath,
        status: 'success',
        metadata: {
          action: record.action,
          baseVersion: record.baseVersion,
          nextVersion: record.nextVersion,
        },
      });
    }
    return record;
  }

  republishAutoGeneratedWorkspaceSkills(workspaceDir: string, sessionId?: string): void {
    this.maybeAutoPublishGeneratedWorkspaceSkills(workspaceDir, sessionId);
  }

  private maybeAutoPublishGeneratedWorkspaceSkills(workspaceDir?: string, sessionId?: string): void {
    if (!workspaceDir) {
      return;
    }
    try {
      const existingPack = this.skillPackStore
        .listPacks({ workspaceDir })
        .find((item) => item.scope === 'workspace' && item.name === 'workspace-generated');
      const nextVersion =
        existingPack?.versions.reduce((maxVersion, current) => {
          const parsed = Number.parseInt(current.version, 10);
          return Number.isFinite(parsed) ? Math.max(maxVersion, parsed) : maxVersion;
        }, 0) ?? 0;
      const skillNames = this.skillLoader
        .getSkillCatalog({
          workspaceDir,
        })
        .filter((item) => {
          if (item.source !== 'workspace') {
            return false;
          }
          return String(item.metadata?.generatedBy ?? '').trim() === 'auto-observe-turn';
        })
        .map((item) => item.name);
      if (skillNames.length === 0) {
        return;
      }
      this.publishSkillPack({
        name: 'workspace-generated',
        version: String(nextVersion + 1),
        scope: 'workspace',
        workspaceDir,
        skillNames,
        description: 'Auto-published generated workspace skills.',
        sessionId,
      });
    } catch (error) {
      agentLogger.warn(`[MiniMaxAgent] Failed to auto-publish generated workspace skill: ${String(error)}`);
    }
  }

  rejectSkillDraft(id: string, reviewNote?: string) {
    const record = this.skillDraftStore.rejectDraft(id, reviewNote);
    if (record) {
      this.governanceAuditStore.append({
        kind: 'skill_rejected',
        title: `Skill ${record.action} rejected: ${record.name}`,
        detail: reviewNote,
        sessionId: record.sourceSessionId,
        workspaceDir: record.workspaceDir,
        entityType: 'skill',
        entityId: record.id,
        status: 'warning',
        metadata: {
          action: record.action,
          baseVersion: record.baseVersion,
          nextVersion: record.nextVersion,
        },
      });
    }
    return record;
  }

  listSkillHistory(input: { name: string; workspaceDir?: string }) {
    const skill = this.skillLoader.getSkillByName(input.name, {
      workspaceDir: input.workspaceDir,
      includeDeprecated: true,
    });
    if (!skill) {
      return [];
    }
    return this.skillDraftStore.listHistory({
      targetPath: skill.path,
      workspaceDir: input.workspaceDir,
    });
  }

  rollbackSkill(input: {
    name: string;
    workspaceDir?: string;
    version?: string;
    sessionId?: string;
  }) {
    const skill = this.skillLoader.getSkillByName(input.name, {
      workspaceDir: input.workspaceDir,
      includeDeprecated: true,
    });
    if (!skill) {
      return null;
    }
    const result = this.skillDraftStore.rollbackSkill({
      targetPath: skill.path,
      workspaceDir: input.workspaceDir,
      version: input.version,
    });
    if (result) {
      this.reloadSkills();
      this.governanceAuditStore.append({
        kind: 'skill_rolled_back',
        title: `Skill rolled back: ${input.name}`,
        detail: result.restoredVersion ? `restored v${result.restoredVersion}` : undefined,
        sessionId: input.sessionId,
        workspaceDir: input.workspaceDir,
        entityType: 'skill',
        entityId: skill.path,
        status: 'success',
        metadata: {
          previousVersion: result.previousVersion,
          restoredVersion: result.restoredVersion,
        },
      });
    }
    return result;
  }

  publishSkillPack(input: {
    name: string;
    version: string;
    scope: 'team' | 'workspace';
    workspaceDir?: string;
    skillNames?: string[];
    description?: string;
    sessionId?: string;
  }) {
    const auditWorkspaceDir = this.resolveGovernanceWorkspaceDir(input);
    const skills = this.skillLoader
      .getSkillCatalog({
        workspaceDir: auditWorkspaceDir,
      })
      .filter((item) => item.source !== 'team_pack' && item.source !== 'workspace_pack');
    const selectedSkills =
      input.skillNames && input.skillNames.length > 0
        ? skills.filter((item) => input.skillNames?.includes(item.name))
        : skills;
    const record = this.skillPackStore.publishPack({
      name: input.name,
      version: input.version,
      description: input.description,
      scope: input.scope,
      workspaceDir: auditWorkspaceDir,
      skills: selectedSkills,
    });
    this.reloadSkills();
    this.governanceAuditStore.append({
      kind: 'skill_pack_published',
      title: `Skill pack published: ${record.name} v${record.activeVersion}`,
      detail: record.description,
      sessionId: input.sessionId,
      workspaceDir: auditWorkspaceDir,
      entityType: 'skill_pack',
      entityId: `${record.name}@${record.activeVersion ?? input.version}`,
      status: 'success',
      metadata: {
        scope: input.scope,
        skillCount: selectedSkills.length,
      },
    });
    return record;
  }

  activateSkillPack(input: {
    name: string;
    scope: 'team' | 'workspace';
    version: string;
    workspaceDir?: string;
    sessionId?: string;
  }) {
    const auditWorkspaceDir = this.resolveGovernanceWorkspaceDir(input);
    const record = this.skillPackStore.activatePackVersion({
      ...input,
      workspaceDir: auditWorkspaceDir,
    });
    if (record) {
      this.reloadSkills();
      this.governanceAuditStore.append({
        kind: 'skill_pack_activated',
        title: `Skill pack activated: ${record.name} v${input.version}`,
        sessionId: input.sessionId,
        workspaceDir: auditWorkspaceDir,
        entityType: 'skill_pack',
        entityId: `${record.name}@${input.version}`,
        status: 'success',
        metadata: {
          scope: input.scope,
        },
      });
    }
    return record;
  }

  rollbackSkillPack(input: {
    name: string;
    scope: 'team' | 'workspace';
    workspaceDir?: string;
    sessionId?: string;
  }) {
    const auditWorkspaceDir = this.resolveGovernanceWorkspaceDir(input);
    const record = this.skillPackStore.rollbackPack({
      ...input,
      workspaceDir: auditWorkspaceDir,
    });
    if (record) {
      this.reloadSkills();
      this.governanceAuditStore.append({
        kind: 'skill_pack_rolled_back',
        title: `Skill pack rolled back: ${record.name}`,
        detail: record.activeVersion ? `active v${record.activeVersion}` : undefined,
        sessionId: input.sessionId,
        workspaceDir: auditWorkspaceDir,
        entityType: 'skill_pack',
        entityId: `${record.name}@${record.activeVersion ?? 'unknown'}`,
        status: 'warning',
        metadata: {
          scope: input.scope,
        },
      });
    }
    return record;
  }

  getPermissionManager(): PermissionManager | null {
    return this.permissionManager;
  }

  reloadSkills(): void {
    const cfg = this.config.get();
    if (cfg.agent.skillListPath) {
      const skills = this.skillLoader.loadSkillList(cfg.agent.skillListPath);
      agentLogger.info(`[MiniMaxAgent] Reloaded ${skills.length} skills from ${cfg.agent.skillListPath}`);
    }
    if (cfg.agent.skillsDir) {
      const codexSkills = this.skillLoader.loadCodexSkills(cfg.agent.skillsDir);
      agentLogger.info(`[MiniMaxAgent] Reloaded ${codexSkills.length} Codex skills from ${cfg.agent.skillsDir}`);
    }
    if (this.permissionManager) {
      for (const dir of this.getExtraReadableDirs(cfg)) {
        this.permissionManager.addReadableDir(dir);
      }
    }
  }

  getSessionContext(sessionId: string): Session | undefined {
    const ref: ContextRef = { scope: 'session', namespace: sessionId };
    const meta = this.getContextNamespaceMeta(ref);
    if (!meta) {
      return undefined;
    }
    const messages = this.getContextMessages(ref);
    return {
      id: sessionId,
      messages,
      createdAt: new Date(meta.createdAt),
      updatedAt: new Date(meta.updatedAt),
      workspaceDir: meta.workspaceDir ?? this.config.get().agent.workspaceDir,
      additionalDirs: [],
    };
  }

  listSessionContexts(): string[] {
    return this.contextManager.listNamespaces('session').map((item) => item.namespace);
  }

  deleteSessionContext(sessionId: string): boolean {
    this.sessionSearchIndex.removeSession(sessionId);
    return this.contextManager.deleteNamespace({ scope: 'session', namespace: sessionId });
  }

  getSession(sessionId: string): Session | undefined {
    return this.getSessionContext(sessionId);
  }

  listSessions(): string[] {
    return this.listSessionContexts();
  }

  deleteSession(sessionId: string): boolean {
    return this.deleteSessionContext(sessionId);
  }

  async cleanup(): Promise<void> {
    await this.memoryPromotionCoordinator.cleanup();
    this.subAgentManager.shutdown();
    if (this.toolRegistry) {
      const shellTool = this.toolRegistry.get('shell_execute');
      if (shellTool) {
        const shellToolAny = shellTool as unknown as { cleanupAll?: () => void };
        if (typeof shellToolAny.cleanupAll === 'function') {
          shellToolAny.cleanupAll();
        }
      }
    }
    if (this.mcpRuntimeLease) {
      await this.mcpRuntimeLease.release();
      this.mcpRuntimeLease = null;
    } else if (this.mcpConnector) {
      await this.mcpConnector.disconnectAll();
    }
    this.mcpConnector = null;
    this.llmClient = null;
    this.toolRegistry = null;
    this.permissionManager = null;
    this.mcpToolDescriptions = '';
    this.fullSystemPrompt = '';
    this.initialized = false;
  }

  private summarizeMcpServers(servers: MCPStatusResponse['servers']): MCPStatusResponse['summary'] {
    const enabledServers = servers.filter((server) => !server.disabled);
    const connectedCount = enabledServers.filter((server) => server.status === 'connected').length;
    const totalEnabled = enabledServers.length;

    if (totalEnabled === 0) {
      return {
        state: 'disabled',
        connectedCount,
        totalEnabled,
      };
    }
    if (connectedCount > 0) {
      return {
        state: 'connected',
        connectedCount,
        totalEnabled,
      };
    }
    const hasNonIdle = enabledServers.some((server) =>
      server.status === 'failed' ||
      server.status === 'connecting' ||
      server.status === 'reconnecting'
    );
    return {
      state: hasNonIdle ? 'degraded' : 'idle',
      connectedCount,
      totalEnabled,
    };
  }

  private normalizeContextRef(context: ContextRef): ContextRef {
    const scope = context.scope;
    if (scope !== 'session' && scope !== 'workspace' && scope !== 'global') {
      throw new Error(`Invalid context.scope: ${String(scope)}`);
    }
    const namespace = (context.namespace ?? '').trim();
    if (!namespace) {
      throw new Error('context.namespace cannot be empty');
    }
    return { scope, namespace };
  }

  private makeContextKey(context: ContextRef): string {
    return `${context.scope}:${context.namespace}`;
  }

  private filterCommittedTurnMessages(messages: Message[]): Message[] {
    return messages.filter((message) => {
      const text = this.messageContentToText(message.content).trim();
      if (text.startsWith('[CONTEXT_PRECOMPRESSED')) {
        return true;
      }
      if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
        return false;
      }
      if (message.role === 'user' && !text) {
        return false;
      }
      return true;
    });
  }

  private collectCommittedMessagesFromSnapshot(messages: Message[], fallbackBaselineMessageCount: number): Message[] {
    const body = messages.filter((message) => message.role !== 'system').map((message) => cloneMessage(message));
    const firstCurrentTurnIndex = body.findIndex((message) => Boolean(message.metadata?.checkpointId));
    const rawTurnMessages =
      firstCurrentTurnIndex >= 0
        ? body.slice(firstCurrentTurnIndex)
        : body.slice(Math.max(0, fallbackBaselineMessageCount));
    return this.filterCommittedTurnMessages(rawTurnMessages);
  }

  private collectTurnMessages(turnAgent: Agent, baselineMessageCount: number): Message[] {
    return this.collectCommittedMessagesFromSnapshot(turnAgent.getMessages(), baselineMessageCount);
  }

  private buildRunTerminalState(input: {
    runId: string;
    runFamilyId: string;
    draftId: string;
    terminalCode: RunTerminalState['terminalCode'];
    replayCutoffKind: RunTerminalState['replayCutoffKind'];
    resumable: boolean;
    resumeToken?: string | null;
    lastSafeStep: number;
    maxSteps: number;
    errorSummary?: string | null;
    artifact?: InterruptedArtifact | null;
  }): RunTerminalState {
    return {
      runId: input.runId,
      runFamilyId: input.runFamilyId,
      draftId: input.draftId,
      terminalCode: input.terminalCode,
      resumable: input.resumable,
      resumeToken: input.resumeToken ?? null,
      lastSafeStep: Math.max(0, Math.floor(input.lastSafeStep)),
      maxSteps: Math.max(0, Math.floor(input.maxSteps)),
      replayCutoffKind: input.replayCutoffKind,
      errorSummary: input.errorSummary ?? null,
      createdAt: new Date().toISOString(),
      artifact: input.artifact ?? null,
    };
  }

  private prepareInterruptedContextForTurnStart(
    context: ContextRef,
    input: {
      runId: string;
      runFamilyId?: string;
      resumeRequested: boolean;
      resumeToken?: string;
    }
  ): {
    artifact?: InterruptedArtifact;
    draftId: string;
    runFamilyId: string;
  } {
    const artifact = this.contextManager.getInterruptedArtifact(context);
    if (!artifact) {
      return {
        artifact: undefined,
        draftId: `draft-${crypto.randomUUID()}`,
        runFamilyId: input.runFamilyId?.trim() || input.runId,
      };
    }
    if (input.resumeRequested) {
      const resumeToken = String(input.resumeToken ?? '').trim();
      if (!artifact.resumable || !resumeToken || resumeToken !== artifact.resumeToken) {
        throw new Error('Interrupted run resume token is invalid or expired.');
      }
      return {
        artifact,
        draftId: artifact.draftId,
        runFamilyId: artifact.runFamilyId,
      };
    }
    if (artifact.resumable) {
      this.contextManager.updateInterruptedArtifact(context, (current) => ({
        ...current,
        resumable: false,
        resumeToken: undefined,
        updatedAt: new Date().toISOString(),
      }));
    }
    return {
      artifact: this.contextManager.getInterruptedArtifact(context),
      draftId: `draft-${crypto.randomUUID()}`,
      runFamilyId: input.runFamilyId?.trim() || input.runId,
    };
  }

  private finalizeInterruptedRun(input: {
    context: ContextRef;
    turnId: string;
    runId: string;
    runFamilyId: string;
    draftId: string;
    maxSteps: number;
    step: number;
    terminalCode: 'cancelled' | 'error';
    turnMessages: Message[];
    errorSummary?: string;
  }): {
    artifact: InterruptedArtifact | null;
    terminalState: RunTerminalState;
    contextVersion: number;
  } {
    const draftRecord = this.contextManager.getDraftRecord(input.context);
    const checkpoint = draftRecord?.checkpoint;
    const safeMessages = checkpoint?.messages ?? [];
    const previewMessages = slicePreviewMessages(input.turnMessages, safeMessages);
    const sideEffectLedger = buildSideEffectLedgerFromPreview(previewMessages);
    const hasCarryForwardContextPatches = this.contextManager.hasCarryForwardContextPatchEvents(
      input.turnId,
      checkpoint?.bufferedEventCount ?? 1
    );
    const artifact =
      hasCheckpointProgress(safeMessages) ||
      hasCarryForwardContextPatches ||
      sideEffectLedger.length > 0 ||
      previewMessages.length > 0
        ? this.contextManager.finalizeInterruptedTurn(input.turnId, {
            terminalCode: input.terminalCode,
            maxSteps: input.maxSteps,
            lastSafeStep: checkpoint?.step ?? 0,
            errorSummary: input.errorSummary,
            previewMessages,
            sideEffectLedger,
            resumable: hasCheckpointProgress(safeMessages),
            resumeToken: hasCheckpointProgress(safeMessages) ? crypto.randomUUID() : undefined,
          })
        : (this.contextManager.abortTurn(input.turnId), null);
    const projection = this.contextManager.getProjection(input.context);
    return {
      artifact,
      terminalState: this.buildRunTerminalState({
        runId: input.runId,
        runFamilyId: input.runFamilyId,
        draftId: input.draftId,
        terminalCode: input.terminalCode,
        replayCutoffKind: artifact?.replayCutoffKind ?? 'none',
        resumable: artifact?.resumable === true,
        resumeToken: artifact?.resumeToken ?? null,
        lastSafeStep: artifact?.lastSafeStep ?? 0,
        maxSteps: input.maxSteps,
        errorSummary: artifact?.errorSummary ?? input.errorSummary ?? null,
        artifact,
      }),
      contextVersion: projection.version,
    };
  }

  private async buildContextReplayAssembly(
    context: ContextRef,
    conversationMessages: Message[],
    meta?: ContextNamespaceMeta,
    options?: {
      onContextPrecompress?: (event: ContextPrecompressEvent) => Promise<void> | void;
    }
  ): Promise<ContextReplayAssembly> {
    const durableCompactionSummary = this.extractDurableContextCompactionSummary(conversationMessages);
    const durableCompactionSegment = durableCompactionSummary
      ? this.buildDurableContextCompactionSystemSegment(durableCompactionSummary)
      : undefined;
    const replayMessages = this.extractReplayMessages(conversationMessages);
    if (replayMessages.length === 0) {
      return {
        replayMessages: [],
        compressedHistorySegment: durableCompactionSegment,
        compressedHistoryGenerated: false,
        compressedHistoryUsed: Boolean(durableCompactionSegment),
        compressionCache: 'bypass',
        compressionCallCount: 0,
        compressionDurationMs: 0,
        sealedRoundCount: 0,
        replayRoundCount: 0,
        compressedPrefixChars: 0,
      };
    }

    const normalizedReplay = sanitizeMessagesForToolProtocol(replayMessages);
    if (normalizedReplay.correctedCount > 0) {
      agentLogger.warn(
        `[MiniMaxAgent] Replay tool-protocol normalization applied: context=${context.scope}/${context.namespace} corrections=${normalizedReplay.correctedCount} orphan_tool_calls=${normalizedReplay.orphanToolCallFixed} orphan_tool_results=${normalizedReplay.orphanToolResultFixed}`
      );
    }

    const rounds = this.groupReplayRoundsByUser(normalizedReplay.messages);
    if (rounds.length === 0) {
      return {
        replayMessages: [],
        compressedHistoryGenerated: false,
        compressedHistoryUsed: false,
        compressionCache: 'bypass',
        compressionCallCount: 0,
        compressionDurationMs: 0,
        sealedRoundCount: 0,
        replayRoundCount: 0,
        compressedPrefixChars: 0,
      };
    }

    const triggerChars = this.resolveCompressedHistoryTriggerChars();
    const totalReplayChars = this.estimateReplayRoundsChars(rounds);
    const hadPersistedCompressedHistory = Boolean(meta?.compressedHistoryContext);
    let compressedHistoryContext = this.resolveCompressedHistoryContext(meta, rounds);
    let replayRounds = rounds.slice(compressedHistoryContext?.sealedRoundCount ?? 0);
    let compressedHistoryGenerated = false;
    let compressedHistoryContextUpdate: ContextReplayAssembly['compressedHistoryContextUpdate'];
    let compressionCache: ContextReplayAssembly['compressionCache'] = totalReplayChars > triggerChars ? 'miss' : 'bypass';
    let compressionCallCount = 0;
    let compressionDurationMs = 0;

    if (totalReplayChars <= triggerChars) {
      if (hadPersistedCompressedHistory) {
        compressedHistoryContextUpdate = null;
      }
      return {
        replayMessages: rounds.flatMap((round) => round.messages.map((message) => ({ ...message }))),
        compressedHistorySegment: durableCompactionSegment,
        compressedHistoryContextUpdate,
        compressedHistoryGenerated: false,
        compressedHistoryUsed: Boolean(durableCompactionSegment),
        compressionCache,
        compressionCallCount,
        compressionDurationMs,
        sealedRoundCount: 0,
        replayRoundCount: rounds.length,
        compressedPrefixChars: 0,
      };
    }

    if (compressedHistoryContext) {
      compressionCache = 'hit';
    }

    if (this.estimateReplayRoundsChars(replayRounds) > triggerChars) {
      const { olderRounds, recentRounds } = this.selectAdaptiveReplayWindow(replayRounds);
      if (olderRounds.length > 0) {
        const precompressSeed: ContextPrecompressEvent = {
          source: 'replay_prepare',
          phase: 'started',
          observedAt: new Date().toISOString(),
          triggerChars,
          triggerRatio: this.config.get().agent.contextPrecompressTriggerRatio,
          triggerThresholdChars: triggerChars,
          keepLlmRounds: 0,
          keepLlmRoundsApplied: 0,
          chunkChars: this.resolveContextCompressionMaxChars(),
          retryLimit: 0,
          totalCharsBefore: totalReplayChars,
          totalCharsAfter: totalReplayChars,
          systemPromptChars: 0,
          messageCharsBefore: totalReplayChars,
          messageCharsAfter: totalReplayChars,
          triggered: true,
          applied: false,
          chunkCount: 1,
          retryCount: 0,
          profileNormalizedCount: 0,
          progressPercent: 0,
          chunkIndex: 0,
          chunkTotal: 1,
        };
        await Promise.resolve(options?.onContextPrecompress?.(precompressSeed));
        const compressionStartedAt = Date.now();
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const nextCompressedHistoryContext = await this.buildNextCompressedHistoryContext({
            allRounds: rounds,
            currentCompressedHistoryContext: compressedHistoryContext,
            newlySealedRounds: olderRounds,
          });
          compressionCallCount = 1;
          compressionDurationMs = Date.now() - compressionStartedAt;
          compressedHistoryContext = nextCompressedHistoryContext;
          compressedHistoryContextUpdate = nextCompressedHistoryContext;
          replayRounds = recentRounds;
          compressedHistoryGenerated = true;
          compressionCache = 'miss';
          const replayCharsAfter = this.estimateReplayRoundsChars(replayRounds);
          await Promise.resolve(
            options?.onContextPrecompress?.({
              ...precompressSeed,
              phase: 'completed',
              observedAt: new Date().toISOString(),
              applied: true,
              durationMs: compressionDurationMs,
              progressPercent: 100,
              chunkIndex: 1,
              totalCharsAfter: replayCharsAfter,
              messageCharsAfter: replayCharsAfter,
              willRetriggerImmediately: replayCharsAfter >= triggerChars,
              willRetriggerNextTurn: replayCharsAfter >= triggerChars,
            })
          );
        } catch (error) {
          compressionDurationMs = Date.now() - compressionStartedAt;
          const failureReason = error instanceof Error ? error.message : String(error);
          await Promise.resolve(
            options?.onContextPrecompress?.({
              ...precompressSeed,
              phase: 'failed',
              observedAt: new Date().toISOString(),
              durationMs: compressionDurationMs,
              failureReason,
            })
          );
          throw error;
        }
      }
    }

    if (!compressedHistoryContext && hadPersistedCompressedHistory) {
      compressedHistoryContextUpdate = null;
    }

    const compressedPrefixChars = compressedHistoryContext
      ? this.estimateReplayRoundsChars(rounds.slice(0, compressedHistoryContext.sealedRoundCount))
      : 0;

    const compressedHistorySegment = compressedHistoryContext
      ? this.buildCompressedHistorySystemSegment(
          compressedHistoryContext.summary,
          compressedHistoryContext.sealedRoundCount,
          replayRounds.length
        )
      : undefined;

    return {
      replayMessages: replayRounds.flatMap((round) => round.messages.map((message) => ({ ...message }))),
      compressedHistorySegment: this.joinOptionalSegments(durableCompactionSegment, compressedHistorySegment),
      compressedHistoryContextUpdate,
      compressedHistoryGenerated,
      compressedHistoryUsed: Boolean(compressedHistoryContext?.summary || durableCompactionSegment),
      compressionCache,
      compressionCallCount,
      compressionDurationMs,
      sealedRoundCount: compressedHistoryContext?.sealedRoundCount ?? 0,
      replayRoundCount: replayRounds.length,
      compressedPrefixChars,
    };
  }

  private extractDurableContextCompactionSummary(conversationMessages: Message[]): string | undefined {
    let latest: string | undefined;
    for (const message of conversationMessages) {
      if (message.role !== 'assistant') {
        continue;
      }
      const text = this.messageContentToText(message.content).trim();
      if (this.isContextPrecompressedMarkerText(text)) {
        latest = text;
      }
    }
    return latest;
  }

  private buildDurableContextCompactionSystemSegment(summary: string): string {
    return [
      '## Durable In-Turn Context Compaction',
      'Use this compressed context as the canonical replacement for older history before the recent replay messages.',
      summary.trim(),
    ].join('\n');
  }

  private joinOptionalSegments(...segments: Array<string | undefined>): string | undefined {
    const normalized = segments.map((segment) => String(segment ?? '').trim()).filter((segment) => segment.length > 0);
    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
  }

  private isContextPrecompressedMarkerText(text: string): boolean {
    return text.trim().startsWith('[CONTEXT_PRECOMPRESSED');
  }

  private extractReplayMessages(conversationMessages: Message[]): Message[] {
    const replayMessages: Message[] = [];
    let activeProfileRef: AgentProfileReference | undefined;
    for (const message of conversationMessages) {
      if (message.role === 'tool') {
        replayMessages.push({ ...message });
        continue;
      }

      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      let text = this.messageContentToText(message.content).trim();
      const hasToolCalls = message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0;
      const hasThinking =
        message.role === 'assistant' &&
        (String(message.thinking ?? '').trim().length > 0 ||
          String(message.thinkingSignature ?? '').trim().length > 0);
      if (text.length === 0 && !hasToolCalls && !hasThinking) {
        continue;
      }
      if (this.isContextPrecompressedMarkerText(text)) {
        continue;
      }
      if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
        continue;
      }
      if (message.role === 'user') {
        const normalized = this.normalizeReplayUserPrompt(text, activeProfileRef);
        text = normalized.text;
        activeProfileRef = normalized.activeProfileRef;
        if (text.length === 0) {
          continue;
        }
      }
      if (message.role === 'assistant') {
        replayMessages.push({
          ...message,
          content: text,
        });
        continue;
      }

      replayMessages.push({
        role: message.role,
        content: text,
      });
    }
    return replayMessages;
  }

  private extractSessionSearchMessages(conversationMessages: Message[]): Message[] {
    const transcriptMessages: Message[] = [];
    for (const message of conversationMessages) {
      if (message.role !== 'user' && message.role !== 'assistant') {
        continue;
      }
      const text = this.messageContentToText(message.content).trim();
      if (text.length === 0) {
        continue;
      }
      if (INTERNAL_CONTEXT_MARKERS.some((marker) => text.startsWith(marker))) {
        continue;
      }
      transcriptMessages.push({
        role: message.role,
        content: text,
      });
    }
    return transcriptMessages;
  }

  private normalizeReplayUserPrompt(
    prompt: string,
    activeProfileRef?: AgentProfileReference
  ): {
    text: string;
    activeProfileRef?: AgentProfileReference;
  } {
    const parsed = parseAgentProfilePrompt(prompt);
    if (!parsed.matched || !parsed.reference) {
      return {
        text: prompt,
        activeProfileRef: undefined,
      };
    }

    const strippedPrompt = parsed.strippedPrompt.trim();
    const shouldKeepReference = !this.sameAgentProfileReference(activeProfileRef, parsed.reference);
    return {
      text: shouldKeepReference
        ? buildPromptWithAgentProfileReference(strippedPrompt, parsed.reference).trim()
        : strippedPrompt,
      activeProfileRef: parsed.reference,
    };
  }

  private sameAgentProfileReference(
    left: AgentProfileReference | undefined,
    right: AgentProfileReference | undefined
  ): boolean {
    if (!left || !right) {
      return false;
    }
    return left.source === right.source && left.name === right.name && left.path === right.path;
  }

  private groupReplayRoundsByUser(messages: Message[]): ReplayRound[] {
    const rounds: ReplayRound[] = [];
    let currentRound: ReplayRound | null = null;
    for (const message of messages) {
      if (message.role === 'user') {
        currentRound = {
          messages: [{ ...message }],
          chars: this.estimateReplayMessageChars(message),
        };
        rounds.push(currentRound);
        continue;
      }
      if (!currentRound) {
        continue;
      }
      currentRound.messages.push({ ...message });
      currentRound.chars += this.estimateReplayMessageChars(message);
    }
    return rounds;
  }

  private selectAdaptiveReplayWindow(rounds: ReplayRound[]): {
    olderRounds: ReplayRound[];
    recentRounds: ReplayRound[];
  } {
    const cfg = this.config.get().agent;
    const minRoundsCfg = Math.floor(cfg.contextReplayMinRounds ?? 6);
    const maxRoundsCfg = Math.floor(cfg.contextReplayMaxRounds ?? 12);
    const minRounds = Math.min(HISTORY_REPLAY_ROUNDS_HARD_CAP, Math.max(1, minRoundsCfg));
    const maxRounds = Math.min(HISTORY_REPLAY_ROUNDS_HARD_CAP, Math.max(minRounds, maxRoundsCfg));

    if (rounds.length <= minRounds) {
      return {
        olderRounds: [],
        recentRounds: rounds,
      };
    }

    const ratioRaw = cfg.contextReplayBudgetRatio ?? 0.55;
    const ratio = Math.max(0.1, Math.min(1, ratioRaw));
    const baseWindowChars = cfg.contextWindowChars ?? Math.max(60000, Math.floor(cfg.tokenLimit * 2));
    const replayBudgetChars = Math.max(2000, Math.floor(baseWindowChars * ratio));
    const cappedMaxRounds = Math.min(rounds.length, maxRounds);

    let start = Math.max(0, rounds.length - Math.min(minRounds, cappedMaxRounds));
    let keptRoundCount = rounds.length - start;
    let keptChars = 0;
    for (let i = start; i < rounds.length; i += 1) {
      keptChars += rounds[i].chars;
    }

    while (start > 0 && keptRoundCount < cappedMaxRounds) {
      const candidateChars = rounds[start - 1].chars;
      if (keptRoundCount >= minRounds && keptChars + candidateChars > replayBudgetChars) {
        break;
      }
      start -= 1;
      keptRoundCount += 1;
      keptChars += candidateChars;
    }

    return {
      olderRounds: rounds.slice(0, start),
      recentRounds: rounds.slice(start),
    };
  }

  private resolveCompressedHistoryTriggerChars(): number {
    const cfg = this.config.get().agent;
    const baseWindowChars = cfg.contextWindowChars ?? Math.max(60000, Math.floor(cfg.tokenLimit * 2));
    const ratioRaw = cfg.contextPrecompressTriggerRatio ?? 0.85;
    const ratio = Math.max(0.1, Math.min(1, ratioRaw));
    return Math.max(10000, Math.floor(baseWindowChars * ratio));
  }

  private buildProviderProjectionTrimOptions(): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    const cfg = this.config.get().agent;
    const contextWindowChars = cfg.contextWindowChars ?? Math.max(60000, Math.floor(cfg.tokenLimit * 2));
    return {
      maxTotalChars: Math.max(40000, contextWindowChars - 10000),
      keepLatestCount: 24,
      maxToolChars: 4000,
      maxNonToolChars: 12000,
    };
  }

  private resolveContextCompressionMaxChars(): number {
    const configuredChars = this.config.get().agent.contextCompressionMaxChars ?? 6000;
    return Math.max(800, Math.min(COMPRESSED_HISTORY_CHAR_HARD_MAX, Math.floor(configuredChars)));
  }

  private resolveCompressedHistoryContext(
    meta: ContextNamespaceMeta | undefined,
    rounds: ReplayRound[]
  ): NonNullable<ContextNamespaceMeta['compressedHistoryContext']> | undefined {
    const cached = meta?.compressedHistoryContext;
    if (!cached || typeof cached.summary !== 'string' || cached.summary.trim().length === 0) {
      return undefined;
    }

    const sealedRoundCount = Math.max(0, Math.floor(cached.sealedRoundCount ?? 0));
    if (sealedRoundCount <= 0 || sealedRoundCount > rounds.length) {
      return undefined;
    }

    const sealedPrefixHash = this.computeReplayRoundHash(rounds.slice(0, sealedRoundCount));
    if (sealedPrefixHash !== cached.sealedPrefixHash) {
      return undefined;
    }

    if (cached.configFingerprint !== this.resolveCompressedHistoryConfigFingerprint()) {
      return undefined;
    }

    return {
      ...cached,
      sealedRoundCount,
      sealedPrefixHash,
      summary: this.truncateReplayText(cached.summary.trim(), this.resolveContextCompressionMaxChars()),
      formatVersion: cached.formatVersion ?? 1,
    };
  }

  private estimateReplayRoundsChars(rounds: ReplayRound[]): number {
    return rounds.reduce((sum, round) => sum + round.chars, 0);
  }

  private resolveCompressedHistoryConfigFingerprint(): string {
    const payload = {
      formatVersion: 1,
      maxChars: this.resolveContextCompressionMaxChars(),
      provider: this.config.get().api.provider,
      model: this.config.get().api.model,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private async buildNextCompressedHistoryContext(input: {
    allRounds: ReplayRound[];
    currentCompressedHistoryContext?: NonNullable<ContextNamespaceMeta['compressedHistoryContext']>;
    newlySealedRounds: ReplayRound[];
  }): Promise<NonNullable<ContextNamespaceMeta['compressedHistoryContext']>> {
    const nextSealedRoundCount =
      (input.currentCompressedHistoryContext?.sealedRoundCount ?? 0) + input.newlySealedRounds.length;
    const sealedPrefixHash = this.computeReplayRoundHash(input.allRounds.slice(0, nextSealedRoundCount));
    const maxChars = this.resolveContextCompressionMaxChars();
    const generatedSummary = await this.generateCompressedHistorySummary(
      input.newlySealedRounds,
      input.currentCompressedHistoryContext?.summary,
      maxChars
    );
    const nextCompressedHistoryContext: NonNullable<ContextNamespaceMeta['compressedHistoryContext']> = {
      sealedRoundCount: nextSealedRoundCount,
      sealedPrefixHash,
      summary: generatedSummary.summary,
      updatedAt: new Date().toISOString(),
      formatVersion: 1,
      configFingerprint: this.resolveCompressedHistoryConfigFingerprint(),
    };
    return nextCompressedHistoryContext;
  }

  private async generateCompressedHistorySummary(
    rounds: ReplayRound[],
    previousSummary: string | undefined,
    maxChars: number
  ): Promise<{
    summary: string;
  }> {
    const compressedHistoryMessages = this.buildCompressedHistoryMessages(rounds);
    if (!this.llmClient) {
      return {
        summary: this.buildFallbackCompressedHistory(compressedHistoryMessages, previousSummary, maxChars),
      };
    }

    const compressor = new ContextCompressor(this.llmClient, 0.35);
    const result = await compressor.compressCompressedHistory(
      this.toPersistedMessages(compressedHistoryMessages),
      previousSummary
    );
    if (result.success && result.compressedContent && result.compressedContent.trim().length > 0) {
      return {
        summary: this.truncateReplayText(result.compressedContent.trim(), maxChars),
      };
    }

    agentLogger.warn(
      `[MiniMaxAgent] Compressed history fallback engaged: ${result.error ?? 'unknown_compressed_history_error'}`
    );
    return {
      summary: this.buildFallbackCompressedHistory(compressedHistoryMessages, previousSummary, maxChars),
    };
  }

  private buildCompressedHistoryMessages(rounds: ReplayRound[]): Message[] {
    return rounds.flatMap((round) =>
      round.messages.map((message) => {
        if (message.role !== 'user') {
          return { ...message };
        }
        return {
          ...message,
          content: this.sanitizeCompressedHistoryUserContent(message.content),
        };
      })
    );
  }

  private sanitizeCompressedHistoryUserContent(content: Message['content']): string {
    const normalized = this.normalizeReplayText(content);
    if (normalized.length === 0) {
      return normalized;
    }
    const parsed = parseAgentProfilePrompt(normalized);
    return parsed.matched ? parsed.strippedPrompt.trim() : normalized;
  }

  private buildFallbackCompressedHistory(
    messages: Message[],
    previousSummary: string | undefined,
    maxChars: number
  ): string {
    const lines: string[] = [];
    const normalizedPreviousSummary = String(previousSummary ?? '').trim();
    if (normalizedPreviousSummary) {
      lines.push(normalizedPreviousSummary);
    }
    const rounds = this.groupReplayRoundsByUser(messages);
    for (const round of rounds) {
      const userMessage = round.messages.find((message) => message.role === 'user');
      const assistantMessage =
        [...round.messages].reverse().find((message) => message.role === 'assistant') ??
        round.messages.find((message) => message.role === 'assistant');
      const userText = userMessage ? this.truncateReplayText(this.normalizeReplayText(userMessage.content), 180) : '';
      const assistantText = assistantMessage
        ? this.truncateReplayText(this.normalizeReplayText(assistantMessage.content), 220)
        : '';
      const parts = ['-'];
      if (userText) {
        parts.push(`User asked: ${userText}.`);
      }
      if (assistantText) {
        parts.push(`Assistant concluded: ${assistantText}.`);
      }
      const bullet = parts.join(' ').trim();
      if (bullet !== '-') {
        lines.push(bullet);
      }
      const nextSnapshot = lines.join('\n');
      if (nextSnapshot.length >= maxChars) {
        return this.truncateReplayText(nextSnapshot, maxChars);
      }
    }
    return this.truncateReplayText(lines.join('\n'), maxChars);
  }

  private buildCompressedHistorySystemSegment(
    summary: string,
    sealedRoundCount: number,
    replayRoundCount: number
  ): string {
    return [
      '## Compressed Earlier Session Context',
      `sealed_rounds=${sealedRoundCount}`,
      `recent_raw_rounds=${replayRoundCount}`,
      'Use this compressed context only for older-session continuity. The recent replay messages remain the canonical dialogue context.',
      summary.trim(),
    ].join('\n');
  }

  private computeReplayRoundHash(rounds: ReplayRound[]): string {
    const normalized = rounds
      .map((round, index) => {
        const payload = round.messages
          .map((message) => `${message.role}:${this.normalizeReplayText(message.content)}`)
          .join('\n');
        return `#${index + 1}\n${payload}`;
      })
      .join('\n---\n');
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  private toPersistedMessages(messages: Message[]): PersistedMessage[] {
    const timestamp = new Date().toISOString();
    return messages.map((message, index) => ({
      id: `replay-${index + 1}`,
      role: message.role,
      content: this.messageContentToText(message.content),
      timestamp,
      thinking: message.thinking,
      thinkingSignature: message.thinkingSignature,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      metadata: message.metadata,
    }));
  }

  private estimateReplayMessageChars(message: Message): number {
    return estimateMessageCharacters(message);
  }

  private normalizeReplayText(content: Message['content']): string {
    return this.messageContentToText(content).replace(/\s+/g, ' ').trim();
  }

  private truncateReplayText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
  }

  private messageContentToText(content: Message['content']): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .map((block) => {
        if (block.type === 'text') {
          return block.text ?? '';
        }
        if (block.type === 'tool_result') {
          return block.content ?? '';
        }
        if (block.type === 'tool_use') {
          return JSON.stringify(block.input ?? {});
        }
        return '';
      })
      .join('\n');
  }

  private resolveTurnPromptEnvelope(options: MiniMaxRunOptions): TurnPromptEnvelope {
    const effectivePrompt = String(options.effectivePrompt ?? options.prompt ?? '');
    const rawUserPrompt = String(options.rawUserPrompt ?? options.prompt ?? '');
    const historyUserPrompt = String(options.historyUserPrompt ?? rawUserPrompt);
    const additionalSystemPrompt = String(options.additionalSystemPrompt ?? '').trim();
    const providedPromptReference = this.normalizePromptReference(options.promptReference);
    const hasPromptMismatch = effectivePrompt !== rawUserPrompt || historyUserPrompt !== rawUserPrompt;
    const hasAdditionalSystemPrompt = additionalSystemPrompt.length > 0;
    const hasSystemPromptInjection =
      options.hasSystemPromptInjection === true ||
      Boolean(providedPromptReference) ||
      hasPromptMismatch ||
      hasAdditionalSystemPrompt;
    const promptReference = hasSystemPromptInjection
      ? providedPromptReference ??
        this.buildFallbackPromptReference({
          hasPromptMismatch,
          hasAdditionalSystemPrompt,
        })
      : undefined;
    return {
      effectivePrompt,
      rawUserPrompt,
      historyUserPrompt,
      additionalSystemPrompt,
      promptReference,
      hasSystemPromptInjection,
    };
  }

  private buildTurnSystemPrompt(input: {
    workspaceDir?: string;
    context: ContextRef;
    additionalSystemPrompt: string;
    compressedHistorySegment?: string;
    systemSegment: string;
    interruptedSideEffectSegment?: string;
  }): string {
    const activeToolset = this.resolveToolsetName(input.context);
    const activeToolsetDefinition = this.toolsetRegistry.get(activeToolset);
    const activeCapabilities = new Set(activeToolsetDefinition.capabilities.map((item) => item.toLowerCase()));
    const skillCatalogSegment = this.skillLoader.generateSkillCatalogPrompt({
      workspaceDir: input.workspaceDir,
      toolsetName: activeToolset,
      capabilities: {
        canListOrViewSkills: activeCapabilities.has('skills_catalog'),
        canManageSkills: activeCapabilities.has('skill_manage'),
      },
    });
    const memorySegment = this.memoryStore.getPromptSegment(input.workspaceDir);
    const todoSegment = this.todoStore.getPromptSegment({
      sessionId: input.context.scope === 'session' ? input.context.namespace : undefined,
      workspaceDir: input.workspaceDir,
    });
    const toolsetSummary = [
      '## Active Toolset',
      `name=${activeToolset}`,
      'Only tools in the active toolset are callable for this turn.',
    ].join('\n');
    const memoryProtocolSegment = [
      '## Context and Recall Protocol',
      '- Use context_manage to inspect or patch current structured context and selected runtime context state.',
      '- Use session_search only for raw prior-session transcript recall.',
      '- Use memory_manage only for durable facts worth carrying across sessions.',
      '- Do not store raw logs, temporary workarounds, one-off outputs, or facts already available through context_manage or recent session transcript recall.',
    ].join('\n');
    const todoProtocolSegment = [
      '## Todo Protocol',
      '- For multi-step, verifiable, or staged execution tasks with multiple milestones, call `todo` with `action="plan_set"` before proceeding.',
      '- `plan_set` must create the full remaining session plan in one call. Do not keep a single umbrella todo when multiple independent milestones remain.',
      '- Each todo must map to one verifiable milestone, and detection_standard must describe an external completion check instead of vague progress narration.',
      '- Keep at most one todo in progress at a time, but keep the rest of the plan as pending items instead of collapsing it into one active todo.',
      '- Use `set_status` to promote the next pending todo to `in_progress`, or to mark `blocked` / `completed` with the required fields.',
      '- Use `add` or `update` only for small manual corrections after the plan already exists.',
      '- Do not claim a task is complete until the corresponding todo is marked completed with task_id (the todo item id) and evidence.',
      '- If unfinished todos exist, keep executing against them unless the user paused the loop or the active todo is truly blocked.',
      '- When blocked, record the blocking reason clearly instead of silently stopping.',
    ].join('\n');
    const executionReminderSegment = [
      '## Execution Reminder',
      '- Apply `[MANDATORY_EXECUTION_RULES]` strictly in this turn.',
      '- Completed action plus checked result is required before you stop.',
      ...(() => {
        const completionMarkerRuleText = getCompletionMarkerRuleText(
          isCompletionMarkerEnforcementEnabled(this.config.get().agent)
        );
        if (!completionMarkerRuleText) {
          return [];
        }
        return [
          `- ${completionMarkerRuleText}`,
          '- If the tail marker is missing, the system will continue this run automatically.',
        ];
      })(),
      '- Stop only when the request is actually complete or you are truly blocked.',
    ].join('\n');
    const segments = [this.fullSystemPrompt];
    if (input.additionalSystemPrompt.length > 0) {
      segments.push(input.additionalSystemPrompt);
    }
    segments.push(toolsetSummary);
    segments.push(memoryProtocolSegment);
    segments.push(todoProtocolSegment);
    segments.push(executionReminderSegment);
    if (memorySegment.length > 0) {
      segments.push(memorySegment);
    }
    if (todoSegment.length > 0) {
      segments.push(todoSegment);
    }
    segments.push(skillCatalogSegment);
    segments.push(input.systemSegment);
    if (input.interruptedSideEffectSegment && input.interruptedSideEffectSegment.trim().length > 0) {
      segments.push(input.interruptedSideEffectSegment.trim());
    }
    if (input.compressedHistorySegment && input.compressedHistorySegment.trim().length > 0) {
      segments.push(input.compressedHistorySegment.trim());
    }
    return segments.join('\n\n');
  }

  private normalizePromptReference(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildFallbackPromptReference(input: {
    hasPromptMismatch: boolean;
    hasAdditionalSystemPrompt: boolean;
  }): string {
    const tags: string[] = [];
    if (input.hasPromptMismatch) {
      tags.push('effective_prompt_mismatch');
    }
    if (input.hasAdditionalSystemPrompt) {
      tags.push('additional_system_prompt');
    }
    if (tags.length === 0) {
      tags.push('system_injection');
    }
    return `[PROMPT_REF reason=system_injection source=runtime tags=${tags.join(',')}]`;
  }

  private createTurnToolRegistry(
    context: ContextRef,
    turnId: string,
    workspaceDir: string,
    callback?: AgentCallback
  ): ToolRegistry {
    return this.buildExecutionToolRegistry({
      context,
      turnId,
      workspaceDir,
      callback,
      includeContextManage: true,
      includeSubAgentManage: true,
    });
  }

  private createSubAgentExecutionToolRegistry(
    context: ContextRef,
    turnId: string,
    workspaceDir: string,
    allowedTools?: string[]
  ): ToolRegistry {
    const registry = this.buildExecutionToolRegistry({
      context,
      turnId,
      workspaceDir,
      includeContextManage: false,
      includeSubAgentManage: false,
      allowedTools,
    });
    registry.unregister('todo');
    return registry;
  }

  private resolveSubAgentAllowedTools(
    context: ContextRef,
    workspaceDir: string,
    allowedTools?: string[]
  ): string[] | undefined {
    const executableTools = this.createSubAgentExecutionToolRegistry(
      context,
      `subagent-policy:${context.scope}:${context.namespace}`,
      workspaceDir
    )
      .getAll()
      .map((tool) => tool.name);
    if (!allowedTools || allowedTools.length === 0) {
      return executableTools;
    }
    const executableMap = new Map(
      executableTools.map((toolName) => [toolName.trim().toLowerCase(), toolName] as const)
    );
    const resolved = allowedTools
      .map((toolName) => executableMap.get(toolName.trim().toLowerCase()))
      .filter((toolName): toolName is string => typeof toolName === 'string');
    return resolved;
  }

  private buildExecutionToolRegistry(input: ExecutionToolRegistryOptions): ToolRegistry {
    if (!this.toolRegistry) {
      throw new Error('Tool registry not initialized');
    }
    return buildExecutionToolRegistry({
      baseToolRegistry: this.toolRegistry,
      config: this.config.get(),
      runtimeDataDir: this.runtimeDataDir,
      extraReadableDirs: this.getExtraReadableDirs(this.config.get()),
      toolsetRegistry: this.toolsetRegistry,
      resolveToolsetName: (context) => this.resolveToolsetName(context),
      contextManager: this.contextManager,
      subAgentManager: this.subAgentManager,
      skillLoader: this.skillLoader,
      skillDraftStore: this.skillDraftStore,
      memoryStore: this.memoryStore,
      memoryPromotionCoordinator: this.memoryPromotionCoordinator,
      sessionSearchIndex: this.sessionSearchIndex,
      todoStore: this.todoStore,
      approveSkillDraft: (id) => this.approveSkillDraft(id),
      rejectSkillDraft: (id, reviewNote) => this.rejectSkillDraft(id, reviewNote),
      resolveSubAgentAllowedTools: () =>
        this.createSubAgentExecutionToolRegistry(input.context, input.turnId, input.workspaceDir)
          .getAll()
          .map((tool) => tool.name),
      input,
    });
  }

  private buildErrorFileTimeToken(now: Date): string {
    return now.toISOString().replace(/[:.]/g, '-');
  }

  private async persistMaxTokensRecoverySnapshot(
    context: ContextRef,
    event: MaxTokensRecoveryEvent
  ): Promise<string | null> {
    const namespacePath = this.contextManager.getEventStore().getNamespacePath(context);
    const capturedAt = new Date(event.observedAt);
    const timestamp = Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date();
    const filePath = path.join(namespacePath, `max_tokens_error_${this.buildErrorFileTimeToken(timestamp)}.json`);
    const latestPreparedPath = path.join(namespacePath, 'latest_llm_input_messages.json');
    const cfg = this.config.get();
    const payload = {
      capturedAt: timestamp.toISOString(),
      finishReason: event.finishReason,
      usage: event.usage ?? null,
      step: event.step,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      recovered: event.recovered,
      continuationInjected: event.continuationInjected,
      tokenLimit: cfg.agent.tokenLimit,
      maxOutputTokens: this.resolveConfiguredMaxOutputTokens(cfg),
      preCompress: {
        messageCount: event.preCompressMessageCount,
        chars: event.preCompressChars,
      },
      postCompress: {
        messageCount: event.postCompressMessageCount,
        chars: event.postCompressChars,
      },
      compactedToolCallChains: event.compactedToolCallChains,
      compactedToolMessages: event.compactedToolMessages,
      compressionMode: event.compressionMode,
      compressionError: event.compressionError ?? null,
      llmInputSnapshotPath: latestPreparedPath,
      llmInputSnapshotExists: false,
      context,
    };
    try {
      await fs.mkdir(namespacePath, { recursive: true });
      try {
        await fs.access(latestPreparedPath);
        payload.llmInputSnapshotExists = true;
      } catch {
        payload.llmInputSnapshotExists = false;
      }
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return filePath;
    } catch (error) {
      agentLogger.warn(
        `Failed to persist max_tokens snapshot for context=${context.scope}/${context.namespace}: ${String(error)}`
      );
      return null;
    }
  }

  private async persistContextOverflowSnapshot(
    context: ContextRef,
    event: ContextOverflowEvent
  ): Promise<string | null> {
    const namespacePath = this.contextManager.getEventStore().getNamespacePath(context);
    const capturedAt = new Date(event.observedAt);
    const timestamp = Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date();
    const filePath = path.join(namespacePath, `context_overflow_${this.buildErrorFileTimeToken(timestamp)}.json`);
    const latestPreparedPath = path.join(namespacePath, 'latest_llm_input_messages.json');
    event.llmInputSnapshotPath = latestPreparedPath;
    const payload = {
      context,
      capturedAt: timestamp.toISOString(),
      step: event.step,
      attempt: event.attempt,
      overflowCountInTurn: event.overflowCountInTurn,
      stage: event.stage,
      decision: event.decision,
      errorRaw: event.errorRaw,
      contextStrategy: {
        contextWindowChars: event.contextWindowChars,
        precompressTriggerRatio: event.precompressTriggerRatio,
        precompressTriggerThresholdChars: event.precompressTriggerThresholdChars,
        forcedTrimChars: event.forcedTrimChars,
        maxErrorsBeforeTrim: event.maxErrorsBeforeTrim,
      },
      before: {
        messageCount: event.beforeMessageCount,
        chars: event.beforeChars,
      },
      after:
        event.afterMessageCount !== undefined || event.afterChars !== undefined
          ? {
              messageCount: event.afterMessageCount ?? null,
              chars: event.afterChars ?? null,
            }
          : null,
      tailRoundsKept: event.tailRoundsKept ?? null,
      chunkCount: event.chunkCount ?? null,
      retryCount: event.retryCount ?? null,
      profileRuntime: {
        source: event.profileRuntimeSource ?? null,
        path: event.profileRuntimePath ?? null,
        failureReason: event.profileRuntimeFailureReason ?? null,
      },
      notes: event.notes ?? null,
      llmInputSnapshotPath: latestPreparedPath,
      llmInputSnapshotExists: false,
      llmInputSnapshot: null as unknown,
    };
    try {
      await fs.mkdir(namespacePath, { recursive: true });
      try {
        await fs.access(latestPreparedPath);
        payload.llmInputSnapshotExists = true;
        try {
          const snapshotRaw = await fs.readFile(latestPreparedPath, 'utf-8');
          payload.llmInputSnapshot = JSON.parse(snapshotRaw) as unknown;
        } catch {
          payload.llmInputSnapshot = null;
        }
      } catch {
        payload.llmInputSnapshotExists = false;
        payload.llmInputSnapshot = null;
      }
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return filePath;
    } catch (error) {
      agentLogger.warn(
        `[MiniMaxAgent] Failed to persist context_overflow snapshot for context=${context.scope}/${context.namespace}: ${String(
          error
        )}`
      );
      return null;
    }
  }

  private async persistPreparedMessagesSnapshot(snapshot: PreparedMessagesSnapshot): Promise<void> {
    const context = this.activeContextForLlmSnapshot;
    if (!context) {
      return;
    }
    const namespacePath = this.contextManager.getEventStore().getNamespacePath(context);
    const snapshotPath = path.join(namespacePath, 'latest_llm_input_messages.json');
    const payload = {
      context,
      ...snapshot,
      precompress: this.activePrecompressSnapshot
        ? {
            observedAt: this.activePrecompressSnapshot.observedAt,
            triggered: this.activePrecompressSnapshot.triggered,
            applied: this.activePrecompressSnapshot.applied,
            triggerRatio: this.activePrecompressSnapshot.triggerRatio,
            triggerThresholdChars: this.activePrecompressSnapshot.triggerThresholdChars,
            totalCharsBefore: this.activePrecompressSnapshot.totalCharsBefore,
            totalCharsAfter: this.activePrecompressSnapshot.totalCharsAfter,
            keepLlmRoundsApplied: this.activePrecompressSnapshot.keepLlmRoundsApplied,
            chunkCount: this.activePrecompressSnapshot.chunkCount,
            retryCount: this.activePrecompressSnapshot.retryCount,
            sourceDroppedMessageCount: this.activePrecompressSnapshot.sourceDroppedMessageCount,
            willRetriggerImmediately: this.activePrecompressSnapshot.willRetriggerImmediately,
            willRetriggerNextTurn: this.activePrecompressSnapshot.willRetriggerNextTurn,
            providerPayloadCharsAfter: this.activePrecompressSnapshot.providerPayloadCharsAfter,
            projectedCharsAfter: this.activePrecompressSnapshot.projectedCharsAfter,
            postCompactValidation: this.activePrecompressSnapshot.postCompactValidation,
            durationMs: this.activePrecompressSnapshot.durationMs,
            profileNormalizedCount: this.activePrecompressSnapshot.profileNormalizedCount,
            failureReason: this.activePrecompressSnapshot.failureReason,
            mode: this.activePrecompressSnapshot.mode,
            forced: this.activePrecompressSnapshot.forced,
          }
        : undefined,
    };
    try {
      await fs.mkdir(namespacePath, { recursive: true });
      await fs.writeFile(snapshotPath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (error) {
      agentLogger.warn(
        `[MiniMaxAgent] Failed to persist latest_llm_input_messages for context=${context.scope}/${context.namespace}: ${String(
          error
        )}`
      );
    }
  }

  private resolveConfiguredMaxOutputTokens(cfg: AgentConfig): number {
    const normalized = normalizeMaxOutputTokens(cfg.api.maxOutputTokens);
    if (normalized === undefined) {
      throw new Error('api.maxOutputTokens must be set in config.');
    }
    return normalized;
  }

  private assertStartupConfig(cfg: AgentConfig, options?: { requireApiKey?: boolean }): void {
    const requireApiKey = options?.requireApiKey !== false;
    if (requireApiKey && (!cfg.api.apiKey || cfg.api.apiKey.trim().length < 20)) {
      throw new Error('Invalid config: api.apiKey must be set in config.yaml.');
    }
    if (!cfg.api.apiBase || cfg.api.apiBase.trim().length === 0) {
      throw new Error('Invalid config: api.apiBase must be set in config.yaml.');
    }
    if (!cfg.api.model || cfg.api.model.trim().length === 0) {
      throw new Error('Invalid config: api.model must be set in config.yaml.');
    }
    if (!cfg.agent.workspaceDir || cfg.agent.workspaceDir.trim().length === 0) {
      throw new Error('Invalid config: agent.workspaceDir must be set in config.yaml.');
    }
    if (!Number.isFinite(cfg.agent.subAgentMaxParallelPerParent) || cfg.agent.subAgentMaxParallelPerParent <= 0) {
      throw new Error('Invalid config: agent.subAgentMaxParallelPerParent must be > 0.');
    }
    if (!Number.isFinite(cfg.agent.subAgentGlobalMaxParallel) || cfg.agent.subAgentGlobalMaxParallel <= 0) {
      throw new Error('Invalid config: agent.subAgentGlobalMaxParallel must be > 0.');
    }
    if (
      cfg.agent.contextReplayMinRounds !== undefined &&
      (!Number.isFinite(cfg.agent.contextReplayMinRounds) || cfg.agent.contextReplayMinRounds < 1)
    ) {
      throw new Error('Invalid config: agent.contextReplayMinRounds must be >= 1.');
    }
    if (
      cfg.agent.contextReplayMaxRounds !== undefined &&
      (!Number.isFinite(cfg.agent.contextReplayMaxRounds) || cfg.agent.contextReplayMaxRounds < 1)
    ) {
      throw new Error('Invalid config: agent.contextReplayMaxRounds must be >= 1.');
    }
    if (
      cfg.agent.contextReplayMinRounds !== undefined &&
      cfg.agent.contextReplayMaxRounds !== undefined &&
      cfg.agent.contextReplayMaxRounds < cfg.agent.contextReplayMinRounds
    ) {
      throw new Error('Invalid config: agent.contextReplayMaxRounds must be >= agent.contextReplayMinRounds.');
    }
    if (
      cfg.agent.contextReplayBudgetRatio !== undefined &&
      (!Number.isFinite(cfg.agent.contextReplayBudgetRatio) ||
        cfg.agent.contextReplayBudgetRatio <= 0 ||
        cfg.agent.contextReplayBudgetRatio > 1)
    ) {
      throw new Error('Invalid config: agent.contextReplayBudgetRatio must be within (0, 1].');
    }
    if (
      cfg.agent.contextCompressionMaxChars !== undefined &&
      (!Number.isFinite(cfg.agent.contextCompressionMaxChars) || cfg.agent.contextCompressionMaxChars < 400)
    ) {
      throw new Error('Invalid config: agent.contextCompressionMaxChars must be >= 400.');
    }
    if (
      cfg.agent.contextWindowChars !== undefined &&
      (!Number.isFinite(cfg.agent.contextWindowChars) || cfg.agent.contextWindowChars <= 50000)
    ) {
      throw new Error('Invalid config: agent.contextWindowChars must be > 50000.');
    }
    if (
      cfg.agent.contextPrecompressTriggerRatio !== undefined &&
      (!Number.isFinite(cfg.agent.contextPrecompressTriggerRatio) ||
        cfg.agent.contextPrecompressTriggerRatio <= 0 ||
        cfg.agent.contextPrecompressTriggerRatio > 1)
    ) {
      throw new Error('Invalid config: agent.contextPrecompressTriggerRatio must be within (0, 1].');
    }
    if (
      cfg.agent.contextOverflowForcedTrimChars !== undefined &&
      (!Number.isFinite(cfg.agent.contextOverflowForcedTrimChars) || cfg.agent.contextOverflowForcedTrimChars <= 0)
    ) {
      throw new Error('Invalid config: agent.contextOverflowForcedTrimChars must be > 0.');
    }
    if (
      cfg.agent.contextOverflowMaxErrorsBeforeTrim !== undefined &&
      (!Number.isFinite(cfg.agent.contextOverflowMaxErrorsBeforeTrim) ||
        cfg.agent.contextOverflowMaxErrorsBeforeTrim < 1)
    ) {
      throw new Error('Invalid config: agent.contextOverflowMaxErrorsBeforeTrim must be >= 1.');
    }
    if (
      cfg.agent.contextPrecompressKeepLlmRounds !== undefined &&
      (!Number.isFinite(cfg.agent.contextPrecompressKeepLlmRounds) || cfg.agent.contextPrecompressKeepLlmRounds <= 0)
    ) {
      throw new Error('Invalid config: agent.contextPrecompressKeepLlmRounds must be > 0.');
    }
    if (
      cfg.agent.contextPrecompressChunkChars !== undefined &&
      (!Number.isFinite(cfg.agent.contextPrecompressChunkChars) || cfg.agent.contextPrecompressChunkChars <= 0)
    ) {
      throw new Error('Invalid config: agent.contextPrecompressChunkChars must be > 0.');
    }
    if (
      cfg.agent.contextPrecompressRetry !== undefined &&
      (!Number.isFinite(cfg.agent.contextPrecompressRetry) || cfg.agent.contextPrecompressRetry < 0)
    ) {
      throw new Error('Invalid config: agent.contextPrecompressRetry must be >= 0.');
    }
    if (!cfg.agent.runtimeDataDir || cfg.agent.runtimeDataDir.trim().length === 0) {
      throw new Error('Invalid config: agent.runtimeDataDir must be set in config.yaml.');
    }
    if (!cfg.agent.contextDir || cfg.agent.contextDir.trim().length === 0) {
      throw new Error('Invalid config: agent.contextDir must be set in config.yaml.');
    }
  }
}

let defaultAgent: MiniMaxAgent | null = null;

export async function minimaxRun(options: MiniMaxRunOptions): Promise<MiniMaxRunResult> {
  if (!defaultAgent) {
    defaultAgent = new MiniMaxAgent();
  }
  return defaultAgent.runWithResult(options);
}

export function createAgent(options?: MiniMaxAgentOptions): MiniMaxAgent {
  return new MiniMaxAgent(options);
}

export function getSessionContext(sessionId: string): Session | undefined {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call minimaxRun first or use createAgent.');
  }
  return defaultAgent.getSessionContext(sessionId);
}

export function deleteSessionContext(sessionId: string): boolean {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call minimaxRun first or use createAgent.');
  }
  return defaultAgent.deleteSessionContext(sessionId);
}

export function listSessionContexts(): string[] {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call minimaxRun first or use createAgent.');
  }
  return defaultAgent.listSessionContexts();
}

export function getSession(sessionId: string): Session | undefined {
  return getSessionContext(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  return deleteSessionContext(sessionId);
}

export function listSessions(): string[] {
  return listSessionContexts();
}

export { ContextManager, ContextEventStore, SubAgentManager, SubAgentTurnRunner };





