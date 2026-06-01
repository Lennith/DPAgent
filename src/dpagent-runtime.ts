import * as path from 'path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import {
  LLMClient,
  type LLMRuntime,
  type PreparedMessagesSnapshot,
} from './llm/index.js';
import { Agent } from './agent/Agent.js';
import {
  ToolRegistry,
  ToolsetRegistry,
  createToolsetRegistry,
  PermissionManager,
  type SendFileToUserLinkIssuer,
} from './tools/index.js';
import { MCPConnector, SharedMcpRuntimePool, type SharedMcpRuntimeLease } from './mcp/index.js';
import { ConfigManager } from './config/ConfigManager.js';
import { AutomationStore } from './automation/AutomationStore.js';
import { HookRegistry, HookRunner } from './hooks/index.js';
import { ContextEventStore } from './context/ContextEventStore.js';
import { ContextManager } from './context/ContextManager.js';
import { GovernanceAuditStore } from './governance/AuditStore.js';
import { ToolsetPresetStore } from './governance/ToolsetPresetStore.js';
import { MemoryPromotionCoordinator } from './memory/MemoryPromotionCoordinator.js';
import type { MemoryMutationInput, MemoryMutationResult } from './memory/memory-promotion-contracts.js';
import { MemoryStore } from './memory/MemoryStore.js';
import { SessionSearchIndex } from './memory/SessionSearchIndex.js';
import { SubAgentManager } from './subagent/SubAgentManager.js';
import { SubAgentTurnRunner } from './subagent/SubAgentTurnRunner.js';
import { SkillLoader } from './skills/SkillLoader.js';
import { SkillPackStore } from './skills/SkillPackStore.js';
import { SkillWriteStore } from './skills/SkillWriteStore.js';
import { readSkillVersion } from './skills/skill-markdown.js';
import { TodoStore } from './todo/TodoStore.js';
import { ArenaStore } from './arena/index.js';
import {
  normalizeWorkspaceTimelineConfig,
  TurnWorkspaceTransactionCoordinator,
  WorkspaceTimelineStore,
  type WorkspaceTurnHandle,
} from './workspace-timeline/index.js';
import { agentLogger } from './utils/logger.js';
import { createDPAgentCoreServices } from './runtime/dpagent-core-services.js';
import { getRuntimePlatformCapabilities } from './runtime-platform.js';
import { bootstrapDPAgentRuntime } from './runtime/dpagent-bootstrap.js';
import {
  DPAgentExecutionToolRegistryFactory,
} from './runtime/dpagent-execution-tools.js';
import {
  buildAgentProfileSystemSegment,
  buildWorkspaceInstructionsSystemSegment,
  loadWorkspaceAgentProfile,
  readAgentProfileConfig,
  type AgentProfileReference,
} from './agents/AgentProfiles.js';
import {
  ContextReplayAssembler,
  type ContextReplayAssembly,
} from './runtime/context-replay-assembly.js';
import {
  buildRunTerminalState,
  finalizeInterruptedRun,
  prepareInterruptedContextForTurnStart,
} from './runtime/interrupted-turn-lifecycle.js';
import {
  buildTurnSystemPrompt,
  resolveTurnPromptEnvelope,
} from './runtime/turn-prompt.js';
import { resolveContextBudget } from './runtime/context-window-budget.js';
import { ContextUsageCalibrationStore } from './runtime/context-usage-calibration-store.js';
import { resolveLlmRuntimeConfig, resolveModelRuntimeBudgetOptions } from './llm/provider-profiles.js';
import {
  buildInterruptedSideEffectSegment,
  cloneMessage,
  hasCheckpointProgress,
} from './interrupted-turn-recovery.js';
import {
  resolveDPAgentExtraReadableDirs,
} from './runtime/dpagent-readable-dirs.js';
import {
  assertDPAgentStartupConfig,
  resolveConfiguredMaxOutputTokens,
} from './runtime/dpagent-startup-config.js';
import {
  buildMcpStatusResponse,
} from './runtime/dpagent-mcp-status.js';
import {
  collectCommittedTurnMessagesFromSnapshot,
} from './runtime/dpagent-turn-messages.js';
import type {
  AgentCallback,
  AgentCompletionMeta,
  AgentConfig,
  AgentProfileConfig,
  ContextPrecompressEvent,
  ContextOverflowEvent,
  ContextNamespaceMeta,
  ContextRef,
  InterruptedArtifact,
  MCPStatusResponse,
  MaxTokensRecoveryEvent,
  Message,
  DPAgentRunOptions,
  DPAgentRunResult,
  ResolvedLlmRuntimeConfig,
  RunTerminalState,
  Session,
} from './types.js';
import type { DPAgentOptions } from './dpagent-contracts.js';

export type { DPAgentOptions } from './dpagent-contracts.js';

export interface CancelContextSummary {
  mainRunCount: number;
  subagentCount: number;
  totalCount: number;
}

interface AgentSkillRuntimeContext {
  agentSkillDir?: string;
  includeGlobalSkills: boolean;
}

export class DPAgent {
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
  private automationStore: AutomationStore;
  private arenaStore: ArenaStore;
  private workspaceTimelineStore: WorkspaceTimelineStore;
  private workspaceTransactionCoordinator: TurnWorkspaceTransactionCoordinator;
  private hookRegistry?: HookRegistry;
  private hookRunner?: HookRunner;
  private skillWriteStore: SkillWriteStore;
  private skillPackStore: SkillPackStore;

  getAutomationStore(): AutomationStore {
    return this.automationStore;
  }

  getArenaStore(): ArenaStore {
    return this.arenaStore;
  }

  getWorkspaceTimelineStore(): WorkspaceTimelineStore {
    return this.workspaceTimelineStore;
  }

  initHooks(workspaceDir: string): void {
    const registry = new HookRegistry();
    registry.loadFromWorkspace(workspaceDir);
    this.hookRunner = new HookRunner();
    this.hookRegistry = registry;
  }
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
  private activeTurnContextRefs: Map<Agent, ContextRef> = new Map();
  private activeContextRunLeases: Map<string, string> = new Map();
  private activeContextForLlmSnapshot: ContextRef | null = null;
  private activePrecompressSnapshot: ContextPrecompressEvent | null = null;
  private contextReplayAssembler: ContextReplayAssembler;
  private executionToolRegistryFactory!: DPAgentExecutionToolRegistryFactory;
  private allowMissingApiKeyAtBoot = false;
  private llmRuntime?: ResolvedLlmRuntimeConfig;
  private contextUsageCalibrationStore: ContextUsageCalibrationStore;
  private downloadLinkIssuer: SendFileToUserLinkIssuer | null = null;

  private getExtraReadableDirs(cfg: AgentConfig, context?: ContextRef): string[] {
    return resolveDPAgentExtraReadableDirs(cfg, context);
  }

  private resolveAgentSkillRuntimeContext(input: {
    runtimeProfile?: Pick<AgentProfileReference, 'source' | 'name' | 'path'>;
    config?: AgentProfileConfig;
  }): AgentSkillRuntimeContext {
    const profile = input.runtimeProfile;
    if (!profile || (profile.source !== 'global' && profile.source !== 'bundled')) {
      return { includeGlobalSkills: true };
    }
    const profilePath = String(profile.path ?? '').trim();
    if (!profilePath) {
      return { includeGlobalSkills: true };
    }
    const agentDir = path.dirname(path.resolve(profilePath));
    const fileConfig = input.config?.loadGlobalSkills === undefined
      ? readAgentProfileConfig(agentDir).config
      : undefined;
    const config = {
      ...(fileConfig ?? {}),
      ...(input.config ?? {}),
    };
    return {
      agentSkillDir: path.join(agentDir, 'skill'),
      includeGlobalSkills: config?.loadGlobalSkills !== false,
    };
  }

  private resolveActiveAgentRoleSystemSegment(
    runtimeProfile?: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
  ): string | undefined {
    if (!runtimeProfile || (runtimeProfile.source !== 'global' && runtimeProfile.source !== 'bundled')) {
      return undefined;
    }
    const profilePath = String(runtimeProfile.path ?? '').trim();
    if (!profilePath) {
      return undefined;
    }
    try {
      const resolvedPath = path.resolve(profilePath);
      if (!fsSync.existsSync(resolvedPath)) {
        return undefined;
      }
      const content = fsSync.readFileSync(resolvedPath, 'utf-8');
      const config = readAgentProfileConfig(path.dirname(resolvedPath)).config;
      return buildAgentProfileSystemSegment({
        source: runtimeProfile.source,
        name: runtimeProfile.name,
        path: resolvedPath,
        content,
        config,
      });
    } catch (error) {
      agentLogger.warn(
        `[DPAgent] Failed to load active agent role system segment: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private resolveWorkspaceInstructionsSystemSegment(workspaceDir: string): string | undefined {
    const profile = loadWorkspaceAgentProfile(workspaceDir);
    return profile ? buildWorkspaceInstructionsSystemSegment(profile) : undefined;
  }

  private acquireContextRunLease(contextKey: string, runId: string): () => void {
    const activeRunId = this.activeContextRunLeases.get(contextKey);
    if (activeRunId) {
      throw new Error(`Context ${contextKey} already has an active run (${activeRunId}). Wait for it to finish before starting another run.`);
    }
    this.activeContextRunLeases.set(contextKey, runId);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.activeContextRunLeases.get(contextKey) === runId) {
        this.activeContextRunLeases.delete(contextKey);
      }
    };
  }

  constructor(options: DPAgentOptions = {}) {
    this.allowMissingApiKeyAtBoot = options.allowMissingApiKeyAtBoot === true;
    this.llmRuntime = options.llmRuntime;
    this.config = new ConfigManager(options.config);
    this.contextReplayAssembler = new ContextReplayAssembler({
      getConfig: () => this.config.get(),
      getLlmClient: () => this.llmClient,
    });

    const resolvedConfigPath = options.configPath ?? path.join(process.cwd(), 'config.yaml');
    const shouldLoadFromFile = Boolean(options.configPath) || (!options.config && fsSync.existsSync(resolvedConfigPath));
    if (shouldLoadFromFile) {
      agentLogger.configLoad('config', resolvedConfigPath);
      this.config.loadFromYaml(resolvedConfigPath);
    } else if (!options.config) {
      throw new Error(
        `config.yaml not found at ${resolvedConfigPath}. Create config.yaml or pass DPAgentOptions.configPath.`
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

    const cfg = this.config.get();
    assertDPAgentStartupConfig(cfg, {
      requireApiKey: !this.allowMissingApiKeyAtBoot,
      llmRuntime: this.llmRuntime,
    });
    this.runtimeDataDir = cfg.agent.runtimeDataDir ?? path.join(cfg.agent.workspaceDir, '.dpagent', 'runtime');
    this.contextDir = cfg.agent.contextDir ?? path.join(cfg.agent.workspaceDir, '.dpagent', 'contexts');
    this.automationStore = new AutomationStore(path.join(this.runtimeDataDir, 'automations'));
    this.arenaStore = new ArenaStore(path.join(this.runtimeDataDir, 'arena'));
    this.workspaceTimelineStore = new WorkspaceTimelineStore({
      runtimeDataDir: this.runtimeDataDir,
      config: cfg.workspaceTimeline ?? {
        enabled: false,
        captureMode: 'advisory',
        retainedStageTurns: 5,
        gitPrivateRefs: false,
      },
    });
    this.contextUsageCalibrationStore = new ContextUsageCalibrationStore(this.runtimeDataDir);
    const coreServices = createDPAgentCoreServices({
      contextDir: this.contextDir,
      runtimeDataDir: this.runtimeDataDir,
      getLlmClient: () => this.llmClient,
    });
    this.contextManager = coreServices.contextManager;
    this.workspaceTransactionCoordinator = new TurnWorkspaceTransactionCoordinator({
      contextManager: this.contextManager,
      timelineStore: this.workspaceTimelineStore,
    });
    this.workspaceTransactionCoordinator.recoverPreparedCommits();
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
          task.allowedTools,
          undefined,
          this.resolveAgentSkillRuntimeContext({
            runtimeProfile: task.agentProfile,
            config: task.agentConfig,
          })
        ),
      getBaseSystemPrompt: () => this.fullSystemPrompt || this.config.getDefaultSystemPrompt(),
      getMcpToolDescriptions: () => this.mcpToolDescriptions,
      getMaxSteps: () => this.config.get().agent.maxSteps,
      getTokenLimit: () => this.config.get().agent.tokenLimit,
      getConfig: () => this.config.get(),
      getContextOverflowMaxErrorsBeforeTrim: () => this.config.get().agent.contextOverflowMaxErrorsBeforeTrim,
      getContextUsageCalibrationStore: () => this.contextUsageCalibrationStore,
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
    this.skillWriteStore = coreServices.skillWriteStore;
    this.skillPackStore = coreServices.skillPackStore;
    this.todoStore = coreServices.todoStore;
    this.toolsetRegistry = createToolsetRegistry(cfg.agent.defaultToolset, cfg.toolsets?.custom ?? []);
    this.skillLoader.setSupplementalDirectoriesResolver((workspaceDir) =>
      this.skillPackStore.getActiveSkillDirectories(workspaceDir)
    );
    this.executionToolRegistryFactory = new DPAgentExecutionToolRegistryFactory({
      getBaseToolRegistry: () => this.toolRegistry,
      getConfig: () => this.config.get(),
      getRuntimeDataDir: () => this.runtimeDataDir,
      getExtraReadableDirs: (context) => this.getExtraReadableDirs(this.config.get(), context),
      getToolsetRegistry: () => this.toolsetRegistry,
      resolveToolsetName: (context) => this.resolveToolsetName(context),
      getContextManager: () => this.contextManager,
      getSubAgentManager: () => this.subAgentManager,
      getSkillLoader: () => this.skillLoader,
      writeSkill: (payload) => this.writeSkill(payload),
      getMemoryStore: () => this.memoryStore,
      mutateMemory: (payload) => this.mutateMemory(payload),
      getSessionSearchIndex: () => this.sessionSearchIndex,
      getTodoStore: () => this.todoStore,
      getAutomationStore: () => this.automationStore,
      getArenaStore: () => this.arenaStore,
      getDownloadLinkIssuer: () => this.downloadLinkIssuer,
    });

    if (cfg.agent.skillsDir) {
      const globalSkills = this.skillLoader.loadCodexSkills(cfg.agent.skillsDir);
      agentLogger.info(`[DPAgent] Loaded ${globalSkills.length} global skills from ${cfg.agent.skillsDir}`);
    }
  }

  async initialize(callback?: AgentCallback): Promise<void> {
    this.defaultCallback = callback;
    if (this.initialized && this.llmClient && this.toolRegistry) {
      return;
    }
    const cfg = this.config.get();
    assertDPAgentStartupConfig(cfg, {
      requireApiKey: !this.allowMissingApiKeyAtBoot,
      llmRuntime: this.llmRuntime,
    });
    const defaultLlmRuntime = this.llmRuntime ?? resolveLlmRuntimeConfig({ llmProfiles: cfg.llmProfiles });
    const maxOutputTokens = resolveConfiguredMaxOutputTokens(defaultLlmRuntime);
    const runtimeBootstrap = await bootstrapDPAgentRuntime({
      config: cfg,
      llmRuntime: defaultLlmRuntime,
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

  async run(options: DPAgentRunOptions): Promise<string> {
    const result = await this.runWithResult(options);
    return result.content;
  }

  async runWithResult(options: DPAgentRunOptions): Promise<DPAgentRunResult> {
    if (!options.context) {
      throw new Error('DPAgentRunOptions.context is required');
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
    const releaseContextRunLease = this.acquireContextRunLease(contextKey, runId);
    try {
    const interruptedContext = prepareInterruptedContextForTurnStart(this.contextManager, context, {
      runId,
      runFamilyId: options.runFamilyId,
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
    const promptEnvelope = resolveTurnPromptEnvelope(options);
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
    const replayAssembly = await this.contextReplayAssembler.build(context, historicalMessages, loaded.meta, {
      onContextPrecompress: relayContextPrecompressEvent,
    });
    const buildContextReplayMessagesMs = Date.now() - replayMessagesStartedAt;
    const preLlmTotalMs = Date.now() - preLlmStartedAt;
    agentLogger.info(
      `[DPAgent] Pre-LLM prepare: context=${context.scope}/${context.namespace} ` +
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
        `[DPAgent] Replay compression exceeded guardrail: context=${context.scope}/${context.namespace} durationMs=${replayAssembly.compressionDurationMs}`
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
        const turnMessages = collectCommittedTurnMessagesFromSnapshot(event.messages, replayBaselineMessageCount);
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
      onBeforeToolExecution: async (name, args, toolCallId) => {
        this.contextManager.flushReplayCheckpoints(turn.turnId);
        await Promise.resolve(baseCallback?.onBeforeToolExecution?.(name, args, toolCallId));
      },
      onError: () => undefined,
      onComplete: () => undefined,
    };

    const turnToolsetName = this.resolveRuntimeToolsetName(context, options.agentRuntimeOverrides?.toolsetName);
    const turnAgentSkillContext = this.resolveAgentSkillRuntimeContext({
      runtimeProfile: options.agentRuntimeOverrides?.agentProfile,
      config: options.agentRuntimeOverrides,
    });
    const activeAgentRoleSegment = this.resolveActiveAgentRoleSystemSegment(
      options.agentRuntimeOverrides?.agentProfile
    );
    const workspaceInstructionsSegment = this.resolveWorkspaceInstructionsSystemSegment(runWorkspaceDir);
    const baseSystemPrompt = activeAgentRoleSegment
      ? this.config.getNeutralRuntimeSystemPrompt()
      : this.fullSystemPrompt;
    const turnSystemPrompt = buildTurnSystemPrompt({
      config: this.config.get(),
      fullSystemPrompt: baseSystemPrompt,
      workspaceDir: runWorkspaceDir,
      agentSkillDir: turnAgentSkillContext.agentSkillDir,
      includeGlobalSkills: turnAgentSkillContext.includeGlobalSkills,
      context,
      additionalSystemPrompt: promptEnvelope.additionalSystemPrompt,
      activeAgentRoleSegment,
      workspaceInstructionsSegment,
      compressedHistorySegment: replayAssembly.compressedHistorySegment,
      systemSegment: loaded.systemSegment,
      interruptedSideEffectSegment: buildInterruptedSideEffectSegment(persistedInterruptedSideEffects),
      resolveToolsetName: (targetContext) => this.resolveToolsetName(targetContext),
      toolsetName: turnToolsetName,
      toolsetRegistry: this.toolsetRegistry,
      skillLoader: this.skillLoader,
      memoryStore: this.memoryStore,
      todoStore: this.todoStore,
    });
    const turn = this.contextManager.beginTurn(context, promptEnvelope.rawUserPrompt, runWorkspaceDir, {
      rawUserPrompt: promptEnvelope.rawUserPrompt,
      historyUserPrompt: promptEnvelope.historyUserPrompt,
      effectivePrompt: promptEnvelope.effectivePrompt,
      promptRef: promptEnvelope.promptReference,
      promptInjected: promptEnvelope.hasSystemPromptInjection,
      draftId: interruptedContext.draftId,
      runId,
      runFamilyId: interruptedContext.runFamilyId,
      maxSteps: options.agentRuntimeOverrides?.maxSteps ?? this.config.get().agent.maxSteps,
    });
    const workspaceTurnHandle: WorkspaceTurnHandle | null = this.workspaceTransactionCoordinator.beginTurn({
      context,
      turnId: turn.turnId,
      workspaceDir: runWorkspaceDir,
    });
    const turnToolRegistry = this.createTurnToolRegistry(
      context,
      turn.turnId,
      runWorkspaceDir,
      runCallback,
      options.planningState,
      {
        ...options.agentRuntimeOverrides,
        toolsetName: turnToolsetName,
      },
      turnAgentSkillContext
    );
    const turnLlmRuntime = this.resolveTurnLlmRuntime(options.agentRuntimeOverrides);
    const turnLlmClient = turnLlmRuntime
      ? new LLMClient({
          apiKey: turnLlmRuntime.apiKey,
          apiBase: turnLlmRuntime.apiBase,
          model: turnLlmRuntime.model,
          maxTokens: turnLlmRuntime.maxOutputTokens ?? resolveConfiguredMaxOutputTokens(turnLlmRuntime),
          provider: turnLlmRuntime.provider,
          llmRuntime: turnLlmRuntime,
          onPreparedMessages: (snapshot) => {
            void this.persistPreparedMessagesSnapshot(snapshot);
          },
        })
      : this.llmClient;
    const runtimeConfig = turnLlmClient.getRuntimeConfig?.() ?? resolveLlmRuntimeConfig({ llmProfiles: this.config.get().llmProfiles });
    const resolvedBudget = resolveContextBudget({
      config: this.config.get(),
      profileId: runtimeConfig.profileId,
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      modelRuntimeOptions: resolveModelRuntimeBudgetOptions(runtimeConfig),
    });
    const turnAgent = new Agent({
      llmClient: turnLlmClient,
      toolRegistry: turnToolRegistry,
      systemPrompt: turnSystemPrompt,
      maxSteps: options.agentRuntimeOverrides?.maxSteps ?? this.config.get().agent.maxSteps,
      tokenLimit: this.config.get().agent.tokenLimit,
      contextBudget: resolvedBudget,
      contextOverflowMaxErrorsBeforeTrim: this.config.get().agent.contextOverflowMaxErrorsBeforeTrim,
      contextUsageCalibrationStore: this.contextUsageCalibrationStore,
      workspaceDir: runWorkspaceDir,
      callback: runCallback,
      mcpToolDescriptions: this.mcpToolDescriptions,
      materializeToolResultArtifact: (artifactInput) =>
        this.contextManager.materializeToolResultArtifact(context, artifactInput),
      maxTokensRecoveryMaxAttempts: 2,
      progressOnlyRecoveryEnabled: context.scope !== 'session',
    });
    if (replayAssembly.replayMessages.length > 0) {
      turnAgent.setMessages(replayAssembly.replayMessages);
    }
    if (this.hookRunner && this.hookRegistry) {
      turnAgent.setHooks(this.hookRunner, this.hookRegistry);
    }
    const baselineMessageCount = turnAgent.getMessages().length;
    replayBaselineMessageCount = baselineMessageCount > 0 ? baselineMessageCount - 1 : 0;
    this.activeTurnAgents.set(turnAgent, contextKey);
    this.activeTurnContextRefs.set(turnAgent, context);

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
        this.workspaceTransactionCoordinator.abortTurn(workspaceTurnHandle, 'Run was cancelled before turn commit.');
        const interrupted = finalizeInterruptedRun(this.contextManager, {
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
        this.applyCompressedHistoryContextUpdate(
          context,
          replayAssembly.compressedHistoryContextUpdate,
          turnMessages
        );
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
          maxOutputTokens: resolveConfiguredMaxOutputTokens(runtimeConfig),
          terminalState,
        };
      }

      const commitResult = this.workspaceTransactionCoordinator.commitPreparedTurn(turn.turnId, workspaceTurnHandle, {
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
      this.applyCompressedHistoryContextUpdate(context, replayAssembly.compressedHistoryContextUpdate, turnMessages);
      const updatedMeta = this.getContextNamespaceMeta(context);
      this.refreshSessionSearchIndex(context, updatedMeta);
      if (context.scope === 'session') {
        void this.memoryPromotionCoordinator.noteCommittedTurn({
          sessionId: context.namespace,
          workspaceDir: runWorkspaceDir,
          contextVersion: commitResult.contextVersion,
        });
        const skillWrite = this.skillWriteStore.observeSuccessfulTurn({
          sessionId: context.namespace,
          workspaceDir: runWorkspaceDir,
          prompt: promptEnvelope.rawUserPrompt,
          finalOutput: content,
          globalSkillsDir: this.config.get().agent.skillsDir,
          toolsetName: this.resolveToolsetName(context),
          platform: getRuntimePlatformCapabilities().platform,
        });
        if (skillWrite) {
          this.reloadSkills();
          this.maybeAutoPublishGeneratedWorkspaceSkills(skillWrite.workspaceDir, skillWrite.sourceSessionId);
          this.recordSkillWrittenAudit(skillWrite);
          const skillDetail =
            skillWrite.action === 'update'
              ? `v${skillWrite.baseVersion ?? 'unknown'} -> v${skillWrite.nextVersion ?? 'unknown'}`
              : `v${skillWrite.nextVersion ?? '1'}`;
          this.governanceAuditStore.append({
            kind: 'skill_triggered',
            title: `Skill ${skillWrite.action} trigger: ${skillWrite.name}`,
            detail: skillDetail,
            sessionId: context.namespace,
            workspaceDir: runWorkspaceDir,
            entityType: 'skill',
            entityId: skillWrite.targetPath,
            status: 'success',
            metadata: {
              action: skillWrite.action,
              baseVersion: skillWrite.baseVersion,
              nextVersion: skillWrite.nextVersion,
              applied: true,
              passSignal: skillWrite.action === 'update' ? 'skill_update_triggered' : 'skill_create_triggered',
            },
          });
          baseCallback?.onSkillTrigger?.({
            name: skillWrite.name,
            action: skillWrite.action,
            target: skillWrite.target,
            targetPath: skillWrite.targetPath,
            version: skillWrite.nextVersion ?? '1',
            detail: skillDetail,
          });
        }
      }
      terminalState = buildRunTerminalState({
        runId,
        runFamilyId: interruptedContext.runFamilyId,
        draftId: interruptedContext.draftId,
        terminalCode: 'completed',
        replayCutoffKind: 'endturn',
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
        maxOutputTokens: resolveConfiguredMaxOutputTokens(runtimeConfig),
        terminalState,
      };
    } catch (error) {
      this.workspaceTransactionCoordinator.abortTurn(workspaceTurnHandle, error instanceof Error ? error.message : String(error));
      const err = error instanceof Error ? error : new Error(String(error));
      const turnMessages = this.collectTurnMessages(turnAgent, baselineMessageCount);
      const interrupted = finalizeInterruptedRun(this.contextManager, {
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
      this.applyCompressedHistoryContextUpdate(context, replayAssembly.compressedHistoryContextUpdate, turnMessages);
      const updatedMeta = this.getContextNamespaceMeta(context);
      this.refreshSessionSearchIndex(context, updatedMeta);
      (err as Error & { terminalState?: RunTerminalState }).terminalState = terminalState;
      throw err;
    } finally {
      this.subAgentManager.cancelContext(context);
      this.activeTurnAgents.delete(turnAgent);
      this.activeTurnContextRefs.delete(turnAgent);
      const snapshotContext = this.activeContextForLlmSnapshot;
      if (
        !snapshotContext ||
        (snapshotContext.scope === context.scope && snapshotContext.namespace === context.namespace)
      ) {
        this.activeContextForLlmSnapshot = null;
        this.activePrecompressSnapshot = latestPrecompressEvent;
      }
    }
    } finally {
      releaseContextRunLease();
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
    const transcriptMessages = this.contextReplayAssembler.extractSessionSearchMessages(
      this.contextManager.getConversationMessages(ref, {
        preserveAgentProfileRefs: false,
      })
    );
    this.sessionSearchIndex.upsertSession(ref, meta, transcriptMessages);
  }

  private applyCompressedHistoryContextUpdate(
    ref: ContextRef,
    update: ContextReplayAssembly['compressedHistoryContextUpdate'],
    turnMessages?: Message[]
  ): void {
    if (turnMessages?.some((message) => this.isContextCompactionMessage(message))) {
      this.contextManager.updateNamespaceMeta(ref, {
        compressedHistoryContext: undefined,
      });
      return;
    }
    if (update === undefined) {
      return;
    }
    this.contextManager.updateNamespaceMeta(ref, {
      compressedHistoryContext: update ?? undefined,
    });
  }

  private isContextCompactionMessage(message: Message): boolean {
    return message.role === 'assistant' && Boolean(message.metadata?.contextCompaction);
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

  getContextMessages(
    ref: ContextRef,
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): Message[] {
    return this.contextManager.getConversationMessages(ref, options);
  }

  getContextWebMessages(
    ref: ContextRef,
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): Array<Message & { createdAt?: string }> {
    return this.contextManager.getConversationMessagesWithTimestamps(ref, options);
  }

  cancel(): void {
    const canceledContextKeys = new Set<string>();
    for (const turnAgent of this.activeTurnAgents.keys()) {
      turnAgent.cancel();
      const context = this.activeTurnContextRefs.get(turnAgent);
      if (!context) {
        continue;
      }
      const contextKey = this.makeContextKey(context);
      if (canceledContextKeys.has(contextKey)) {
        continue;
      }
      this.subAgentManager.cancelContext(context);
      canceledContextKeys.add(contextKey);
    }
  }

  cancelContext(context: ContextRef): number {
    return this.cancelContextWithSummary(context).mainRunCount;
  }

  cancelContextWithSummary(context: ContextRef): CancelContextSummary {
    const targetKey = this.makeContextKey(this.normalizeContextRef(context));
    let mainRunCount = 0;
    for (const [turnAgent, contextKey] of this.activeTurnAgents.entries()) {
      if (contextKey !== targetKey) {
        continue;
      }
      turnAgent.cancel();
      mainRunCount += 1;
    }
    const subagentCount = this.subAgentManager.cancelContext(context);
    return {
      mainRunCount,
      subagentCount,
      totalCount: mainRunCount + subagentCount,
    };
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
    const snapshot = this.mcpConnector?.getStatusSnapshot() ?? SharedMcpRuntimePool.getSnapshot(runtime);
    return buildMcpStatusResponse({ runtime, snapshot });
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    if (updates.api) {
      this.config['config'].api = {
        ...this.config['config'].api,
        ...updates.api,
      };
    }
    if (updates.llmProfiles) {
      this.config['config'].llmProfiles = updates.llmProfiles;
    }
    if (updates.mcp) {
      this.config['config'].mcp = {
        ...this.config['config'].mcp,
        ...updates.mcp,
        servers: updates.mcp.servers ?? this.config['config'].mcp.servers,
      };
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'toolsets')) {
      this.config['config'].toolsets = {
        custom: updates.toolsets?.custom ?? [],
      };
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'contextBudget')) {
      this.config['config'].contextBudget = updates.contextBudget;
    }
    if (updates.agent) {
      if (typeof updates.agent.maxSteps === 'number') {
        this.config['config'].agent.maxSteps = updates.agent.maxSteps;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'skillsDir')) {
        this.config['config'].agent.skillsDir = updates.agent.skillsDir;
      }
      if (updates.agent.workspaceDir) this.config['config'].agent.workspaceDir = updates.agent.workspaceDir;
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'completionMarkerEnforcementEnabled')) {
        this.config['config'].agent.completionMarkerEnforcementEnabled =
          updates.agent.completionMarkerEnforcementEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'defaultToolset')) {
        this.config['config'].agent.defaultToolset = updates.agent.defaultToolset;
      }
      if (typeof updates.agent.subAgentMaxParallelPerParent === 'number') {
        this.config['config'].agent.subAgentMaxParallelPerParent = updates.agent.subAgentMaxParallelPerParent;
      }
      if (typeof updates.agent.subAgentGlobalMaxParallel === 'number') {
        this.config['config'].agent.subAgentGlobalMaxParallel = updates.agent.subAgentGlobalMaxParallel;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'contextReplayMinRounds')) {
        this.config['config'].agent.contextReplayMinRounds = updates.agent.contextReplayMinRounds;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'contextReplayMaxRounds')) {
        this.config['config'].agent.contextReplayMaxRounds = updates.agent.contextReplayMaxRounds;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'contextReplayBudgetRatio')) {
        this.config['config'].agent.contextReplayBudgetRatio = updates.agent.contextReplayBudgetRatio;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'contextOverflowMaxErrorsBeforeTrim')) {
        this.config['config'].agent.contextOverflowMaxErrorsBeforeTrim = updates.agent.contextOverflowMaxErrorsBeforeTrim;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'contextDir')) {
        this.config['config'].agent.contextDir = updates.agent.contextDir;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'runtimeDataDir')) {
        this.config['config'].agent.runtimeDataDir = updates.agent.runtimeDataDir;
      }
      if (Object.prototype.hasOwnProperty.call(updates.agent, 'systemPromptPath')) {
        this.config['config'].agent.systemPromptPath = updates.agent.systemPromptPath;
      }
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
    if (Object.prototype.hasOwnProperty.call(updates, 'remoteAccessAuth')) {
      this.config['config'].remoteAccessAuth = updates.remoteAccessAuth;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'web')) {
      this.config['config'].web = {
        ...(this.config['config'].web ?? {}),
        ...(updates.web ?? {}),
      };
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'workspaceTimeline')) {
      this.config['config'].workspaceTimeline = normalizeWorkspaceTimelineConfig(updates.workspaceTimeline);
      this.workspaceTimelineStore = new WorkspaceTimelineStore({
        runtimeDataDir: this.runtimeDataDir,
        config: this.config['config'].workspaceTimeline,
      });
      this.workspaceTransactionCoordinator = new TurnWorkspaceTransactionCoordinator({
        contextManager: this.contextManager,
        timelineStore: this.workspaceTimelineStore,
      });
      this.workspaceTransactionCoordinator.recoverPreparedCommits();
    }
    const nextConfig = this.config.get();
    this.toolsetRegistry = createToolsetRegistry(nextConfig.agent.defaultToolset, nextConfig.toolsets?.custom ?? []);
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

  setDownloadLinkIssuer(issuer: SendFileToUserLinkIssuer | null): void {
    this.downloadLinkIssuer = issuer;
  }

  getLLMClient(): LLMRuntime | null {
    return this.llmClient;
  }

  private resolveTurnLlmRuntime(
    overrides?: DPAgentRunOptions['agentRuntimeOverrides']
  ): ReturnType<typeof resolveLlmRuntimeConfig> | null {
    const overrideProfileId = String(overrides?.llmProfileId ?? '').trim();
    const overrideModel = String(overrides?.llmModel ?? '').trim();
    const overrideReasoning = overrides?.reasoningPreset;
    if (!overrideProfileId && !overrideModel && !overrideReasoning) {
      return null;
    }
    const currentRuntime =
      this.llmClient?.getRuntimeConfig?.() ??
      resolveLlmRuntimeConfig({ llmProfiles: this.config.get().llmProfiles });
    return resolveLlmRuntimeConfig(
      { llmProfiles: this.config.get().llmProfiles },
      {
        profileId: overrideProfileId || currentRuntime.profileId,
        model: overrideModel || currentRuntime.model,
        reasoningPreset: overrideReasoning ?? currentRuntime.reasoningPreset,
        providerOptions: currentRuntime.providerOptions,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  getToolsetRegistry(): ToolsetRegistry {
    return this.toolsetRegistry;
  }

  resolveToolsetName(context: ContextRef): string {
    const meta = this.getContextNamespaceMeta(context);
    const preferred = String(meta?.toolsetName ?? '').trim();
    if (preferred.length > 0) {
      return this.toolsetRegistry.requireToolset(preferred, 'context toolsetName').name;
    }
    const workspaceDir = this.resolveWorkspaceDirForContext(context);
    const workspacePreset = this.toolsetPresetStore.getWorkspacePreset(workspaceDir);
    if (workspacePreset?.toolsetName) {
      return this.toolsetRegistry.requireToolset(workspacePreset.toolsetName, 'workspace toolset preset').name;
    }
    if (workspaceDir) {
      const seeded = this.toolsetPresetStore.setWorkspacePreset(workspaceDir, 'full-access');
      return this.toolsetRegistry.requireToolset(seeded.toolsetName, 'workspace toolset preset').name;
    }
    const configuredDefaultToolset = String(this.config.get().agent.defaultToolset ?? '').trim();
    return configuredDefaultToolset
      ? this.toolsetRegistry.requireToolset(configuredDefaultToolset, 'default toolset').name
      : this.toolsetRegistry.getDefaultName();
  }

  private resolveRuntimeToolsetName(context: ContextRef, toolsetName?: string): string {
    const requestedToolsetName = String(toolsetName ?? '').trim();
    return requestedToolsetName
      ? this.toolsetRegistry.requireToolset(requestedToolsetName, 'runtime toolset override').name
      : this.resolveToolsetName(context);
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

  getSkillWriteStore(): SkillWriteStore {
    return this.skillWriteStore;
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
    const resolvedName = this.toolsetRegistry.requireToolset(input.toolsetName, 'toolset preset').name;
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

  updateMemoryEntry(input: {
    id: string;
    title?: string;
    content: string;
    workspaceDir?: string;
    sessionId?: string;
  }) {
    const workspaceDir = this.resolveGovernanceWorkspaceDir(input);
    const target = this.memoryStore.readEntry(input.id, {
      workspaceDir,
      includeUser: false,
      includeExpired: true,
      includeSuperseded: true,
    });
    if (!target || target.scope !== 'workspace' || path.resolve(target.workspaceDir ?? '') !== workspaceDir) {
      return null;
    }
    const entry = this.memoryStore.replaceEntry(input.id, {
      title: input.title,
      content: input.content,
      workspaceDir,
      includeUser: false,
      sourceSessionId: input.sessionId,
      reason: 'manual_settings_edit',
    });
    if (entry) {
      this.governanceAuditStore.append({
        kind: 'memory_replaced',
        title: `Memory edited: ${entry.title}`,
        sessionId: input.sessionId,
        workspaceDir,
        entityType: 'memory',
        entityId: entry.id,
        status: 'success',
        metadata: {
          version: entry.version,
          scope: entry.scope,
        },
      });
    }
    return entry;
  }

  writeSkill(input: Parameters<SkillWriteStore['writeSkill']>[0]) {
    const record = this.skillWriteStore.writeSkill(input);
    this.reloadSkills();
    this.maybeAutoPublishGeneratedWorkspaceSkills(record.workspaceDir, record.sourceSessionId);
    this.recordSkillWrittenAudit(record);
    return record;
  }

  private recordSkillWrittenAudit(record: ReturnType<SkillWriteStore['writeSkill']>): void {
    this.governanceAuditStore.append({
      kind: 'skill_written',
      title: `Skill ${record.action} applied: ${record.name}`,
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
          includeWorkspaceSkills: true,
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
      agentLogger.warn(`[DPAgent] Failed to auto-publish generated workspace skill: ${String(error)}`);
    }
  }

  listSkillHistory(input: { name: string; workspaceDir?: string }) {
    const skill = this.skillLoader.getSkillByName(input.name, {
      workspaceDir: input.workspaceDir,
      includeWorkspaceSkills: true,
      includePackSkills: true,
      includeDeprecated: true,
    });
    if (!skill) {
      return [];
    }
    return this.skillWriteStore.listHistory({
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
      includeWorkspaceSkills: true,
      includePackSkills: true,
      includeDeprecated: true,
    });
    if (!skill) {
      return null;
    }
    const result = this.skillWriteStore.rollbackSkill({
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

  updateWorkspaceSkillContent(input: {
    name: string;
    workspaceDir?: string;
    content: string;
    sessionId?: string;
  }) {
    const workspaceDir = path.resolve(
      String(input.workspaceDir ?? '').trim() || this.config.get().agent.workspaceDir
    );
    const skill = this.skillLoader.getSkillByName(input.name, {
      workspaceDir,
      includeGlobalSkills: false,
      includeWorkspaceSkills: true,
      includePackSkills: false,
      includeDeprecated: true,
    });
    if (!skill || skill.source !== 'workspace') {
      return null;
    }
    const targetPath = path.resolve(skill.path);
    const workspaceSkillsDir = path.join(workspaceDir, 'skills');
    const relative = path.relative(workspaceSkillsDir, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Skill is outside the current workspace skills directory.');
    }
    if (!fsSync.existsSync(targetPath)) {
      return null;
    }
    const content = String(input.content ?? '');
    if (!content.trim()) {
      throw new Error('Skill content is required.');
    }
    const currentContent = fsSync.readFileSync(targetPath, 'utf-8');
    const changed = currentContent !== content;
    if (changed) {
      this.skillWriteStore.recordSkillRevision({
        skillName: skill.name,
        targetPath,
        workspaceDir,
        version: readSkillVersion(currentContent),
        content: currentContent,
        sourceAction: 'edit',
      });
      fsSync.writeFileSync(targetPath, content, 'utf-8');
      this.reloadSkills();
      this.maybeAutoPublishGeneratedWorkspaceSkills(workspaceDir, input.sessionId);
      this.governanceAuditStore.append({
        kind: 'skill_edited',
        title: `Workspace skill edited: ${skill.name}`,
        sessionId: input.sessionId,
        workspaceDir,
        entityType: 'skill',
        entityId: targetPath,
        status: 'success',
        metadata: {
          previousVersion: readSkillVersion(currentContent),
          nextVersion: readSkillVersion(content),
        },
      });
    }
    return {
      name: skill.name,
      targetPath,
      workspaceDir,
      version: readSkillVersion(content),
      changed,
    };
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
        includeWorkspaceSkills: true,
        includePackSkills: true,
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
    if (cfg.agent.skillsDir) {
      const globalSkills = this.skillLoader.loadCodexSkills(cfg.agent.skillsDir);
      agentLogger.info(`[DPAgent] Reloaded ${globalSkills.length} global skills from ${cfg.agent.skillsDir}`);
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
    this.contextManager.flushReplayCheckpoints();
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

  private collectTurnMessages(turnAgent: Agent, baselineMessageCount: number): Message[] {
    return collectCommittedTurnMessagesFromSnapshot(turnAgent.getMessages(), baselineMessageCount);
  }

  private createTurnToolRegistry(
    context: ContextRef,
    turnId: string,
    workspaceDir: string,
    callback?: AgentCallback,
    planningState?: DPAgentRunOptions['planningState'],
    agentRuntimeOverrides?: DPAgentRunOptions['agentRuntimeOverrides'],
    agentSkillContext: AgentSkillRuntimeContext = { includeGlobalSkills: true }
  ): ToolRegistry {
    return this.executionToolRegistryFactory.build({
      context,
      turnId,
      workspaceDir,
      callback,
      planningState,
      includeContextManage: true,
      includeSubAgentManage: true,
      toolsetName: agentRuntimeOverrides?.toolsetName,
      allowedTools: agentRuntimeOverrides?.allowedTools,
      agentSkillDir: agentSkillContext.agentSkillDir,
      includeGlobalSkills: agentSkillContext.includeGlobalSkills,
    });
  }

  private createSubAgentExecutionToolRegistry(
    context: ContextRef,
    turnId: string,
    workspaceDir: string,
    allowedTools?: string[],
    toolsetName?: string,
    agentSkillContext: AgentSkillRuntimeContext = { includeGlobalSkills: true }
  ): ToolRegistry {
    return this.executionToolRegistryFactory.createSubAgentRegistry({
      context,
      turnId,
      workspaceDir,
      toolsetName,
      allowedTools,
      agentSkillDir: agentSkillContext.agentSkillDir,
      includeGlobalSkills: agentSkillContext.includeGlobalSkills,
    });
  }

  private resolveSubAgentAllowedTools(
    context: ContextRef,
    workspaceDir: string,
    allowedTools?: string[]
  ): string[] | undefined {
    return this.executionToolRegistryFactory.resolveSubAgentAllowedTools(
      context,
      workspaceDir,
      allowedTools
    );
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
      maxOutputTokens: resolveConfiguredMaxOutputTokens(resolveLlmRuntimeConfig({ llmProfiles: cfg.llmProfiles })),
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
        contextWindowTokens: event.contextWindowTokens,
        precompressTriggerRatio: event.precompressTriggerRatio,
        precompressTriggerThresholdChars: event.precompressTriggerThresholdChars,
        precompressTriggerThresholdTokens: event.precompressTriggerThresholdTokens,
        forcedTrimChars: event.forcedTrimChars,
        maxErrorsBeforeTrim: event.maxErrorsBeforeTrim,
      },
      before: {
        messageCount: event.beforeMessageCount,
        chars: event.beforeChars,
        tokens: event.beforeTokens ?? null,
      },
      after:
        event.afterMessageCount !== undefined || event.afterChars !== undefined || event.afterTokens !== undefined
          ? {
              messageCount: event.afterMessageCount ?? null,
              chars: event.afterChars ?? null,
              tokens: event.afterTokens ?? null,
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
        `[DPAgent] Failed to persist context_overflow snapshot for context=${context.scope}/${context.namespace}: ${String(
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
            triggerThresholdTokens: this.activePrecompressSnapshot.triggerThresholdTokens,
            totalCharsBefore: this.activePrecompressSnapshot.totalCharsBefore,
            totalCharsAfter: this.activePrecompressSnapshot.totalCharsAfter,
            keepLlmRoundsApplied: this.activePrecompressSnapshot.keepLlmRoundsApplied,
            chunkCount: this.activePrecompressSnapshot.chunkCount,
            retryCount: this.activePrecompressSnapshot.retryCount,
            sourceDroppedMessageCount: this.activePrecompressSnapshot.sourceDroppedMessageCount,
            willRetriggerImmediately: this.activePrecompressSnapshot.willRetriggerImmediately,
            willRetriggerNextTurn: this.activePrecompressSnapshot.willRetriggerNextTurn,
            providerPayloadCharsAfter: this.activePrecompressSnapshot.providerPayloadCharsAfter,
            providerPayloadTokensAfter: this.activePrecompressSnapshot.providerPayloadTokensAfter,
            projectedCharsAfter: this.activePrecompressSnapshot.projectedCharsAfter,
            projectedTokensAfter: this.activePrecompressSnapshot.projectedTokensAfter,
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
        `[DPAgent] Failed to persist latest_llm_input_messages for context=${context.scope}/${context.namespace}: ${String(
          error
        )}`
      );
    }
  }

}

let defaultAgent: DPAgent | null = null;

export async function dpagentRun(options: DPAgentRunOptions): Promise<DPAgentRunResult> {
  if (!defaultAgent) {
    defaultAgent = new DPAgent();
  }
  return defaultAgent.runWithResult(options);
}

export function createAgent(options?: DPAgentOptions): DPAgent {
  return new DPAgent(options);
}

export function getSessionContext(sessionId: string): Session | undefined {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call dpagentRun first or use createAgent.');
  }
  return defaultAgent.getSessionContext(sessionId);
}

export function deleteSessionContext(sessionId: string): boolean {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call dpagentRun first or use createAgent.');
  }
  return defaultAgent.deleteSessionContext(sessionId);
}

export function listSessionContexts(): string[] {
  if (!defaultAgent) {
    throw new Error('No default agent initialized. Call dpagentRun first or use createAgent.');
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
