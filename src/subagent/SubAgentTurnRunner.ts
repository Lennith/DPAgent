import { Agent } from '../agent/index.js';
import { buildAgentProfileBlock } from '../agents/index.js';
import { ContextManager } from '../context/index.js';
import { ToolRegistry } from '../tools/index.js';
import type { LLMRuntime } from '../llm/index.js';
import type {
  SubAgentProviderConfig,
  Message,
} from '../types.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask } from './types.js';

const DEFAULT_TASK_TIMEOUT_MS = 300000;

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

export interface SubAgentProgressUpdate {
  type: 'step' | 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'heartbeat' | 'timeout_warning' | 'timeout_force';
  step?: number;
  maxSteps?: number;
  thinking?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  messageRole?: string;
  messageContent?: string;
  timestamp: string;
  elapsedMs: number;
  timeoutWarning?: {
    threshold: number; // 0.8 or 0.95
    elapsedMs: number;
    message: string;
  };
}

export interface SubAgentTurnRunnerOptions {
  getLLMClient: () => LLMRuntime | null;
  contextManager: ContextManager;
  getMainToolRegistry: () => ToolRegistry | null;
  getTaskToolRegistry?: (task: SubAgentQueuedTask, turnId: string) => ToolRegistry | null;
  getBaseSystemPrompt: () => string;
  getMcpToolDescriptions: () => string;
  getMaxSteps: () => number;
  getTokenLimit: () => number;
  getContextWindowChars?: () => number | undefined;
  getContextPrecompressTriggerRatio?: () => number | undefined;
  getContextOverflowForcedTrimChars?: () => number | undefined;
  getContextOverflowMaxErrorsBeforeTrim?: () => number | undefined;
  getContextPrecompressKeepLlmRounds?: () => number | undefined;
  getContextPrecompressChunkChars?: () => number | undefined;
  getContextPrecompressRetry?: () => number | undefined;
  getDefaultWorkspaceDir: () => string;
  getProviderConfigs: () => SubAgentProviderConfig[] | undefined;
  onProgress?: (update: SubAgentProgressUpdate) => void;
}

export class SubAgentTurnRunner {
  private readonly options: SubAgentTurnRunnerOptions;
  private readonly runningAgents = new Map<string, Agent>();

  constructor(options: SubAgentTurnRunnerOptions) {
    this.options = options;
  }

  cancelTask(taskId: string): boolean {
    const running = this.runningAgents.get(taskId);
    if (!running) {
      return false;
    }
    running.cancel();
    return true;
  }

  async runTask(task: SubAgentQueuedTask, onHeartbeat?: () => void): Promise<SubAgentExecutionOutput> {
    const startedAt = nowIso();
    let provider: SubAgentProviderConfig;
    try {
      provider = this.resolveProvider(task.providerId);
    } catch (error) {
      const providerError = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        summary: `Sub-agent failed to resolve provider: ${truncate(providerError, 280)}`,
        artifacts: { files: [], commands: [], notes: [] },
        error: providerError,
        startedAt,
        completedAt: nowIso(),
      };
    }
    if (provider.type !== 'local') {
      return {
        status: 'failed',
        summary: `Provider '${provider.id}' is not supported in current version.`,
        artifacts: { files: [], commands: [], notes: [] },
        error: `provider_not_supported:${provider.type}`,
        startedAt,
        completedAt: nowIso(),
      };
    }

    const llmClient = this.options.getLLMClient();
    if (!llmClient) {
      return {
        status: 'failed',
        summary: 'Sub-agent failed because the main LLM client is not initialized.',
        artifacts: { files: [], commands: [], notes: [] },
        error: 'llm_client_not_initialized',
        startedAt,
        completedAt: nowIso(),
      };
    }

    const loaded = this.options.contextManager.loadForTurn(task.subagentContext);
    const turn = this.options.contextManager.beginTurn(task.subagentContext, task.prompt, task.workspaceDir);
    let toolRegistry: ToolRegistry;
    try {
      toolRegistry = this.createSubAgentToolRegistry(task, turn.turnId);
    } catch (error) {
      const toolError = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        summary: `Sub-agent failed to initialize tools: ${truncate(toolError, 280)}`,
        artifacts: { files: [], commands: [], notes: [] },
        error: toolError,
        startedAt,
        completedAt: nowIso(),
      };
    }
    const agentPrompt = this.resolveSubAgentAgentPrompt(task);
    const mergedSystemPrompt = [
      this.options.getBaseSystemPrompt(),
      '## Sub-Agent Runtime',
      agentPrompt,
      '### Sub-Agent Rules',
      '- You are a sub-agent executing a delegated task.',
      '- Remember you are part of a team: do not revert others\' changes, coordinate through concise updates, and focus on integrating safely.',
      '- Do not create or manage the parent session todo protocol. Return results, verification evidence, and blockers so the parent can update todos.',
      '- Report concise progress and final summary only.',
      '- You cannot create nested sub-agents.',
      loaded.systemSegment,
    ].join('\n\n');

    const startTime = Date.now();
    const emitProgress = (update: Omit<SubAgentProgressUpdate, 'timestamp' | 'elapsedMs'>): void => {
      const elapsedMs = Date.now() - startTime;
      try {
        this.options.onProgress?.({
          ...update,
          timestamp: nowIso(),
          elapsedMs,
        });
        onHeartbeat?.();
      } catch {
        // ignore progress callback failures
      }
    };

    const agent = new Agent({
      llmClient,
      toolRegistry,
      systemPrompt: mergedSystemPrompt,
      maxSteps: this.options.getMaxSteps(),
      tokenLimit: this.options.getTokenLimit(),
      contextWindowChars: this.options.getContextWindowChars?.(),
      contextPrecompressTriggerRatio: this.options.getContextPrecompressTriggerRatio?.(),
      contextOverflowForcedTrimChars: this.options.getContextOverflowForcedTrimChars?.(),
      contextOverflowMaxErrorsBeforeTrim: this.options.getContextOverflowMaxErrorsBeforeTrim?.(),
      contextPrecompressKeepLlmRounds: this.options.getContextPrecompressKeepLlmRounds?.(),
      contextPrecompressChunkChars: this.options.getContextPrecompressChunkChars?.(),
      contextPrecompressRetry: this.options.getContextPrecompressRetry?.(),
      workspaceDir: task.workspaceDir ?? this.options.getDefaultWorkspaceDir(),
      callback: {
        onThinking: (thinking) => emitProgress({ type: 'thinking', thinking }),
        onToolCall: (name, args) => emitProgress({ type: 'tool_call', toolName: name, toolArgs: args }),
        onToolResult: (name, result) => emitProgress({ type: 'tool_result', toolName: name, toolResult: result }),
        onStep: (step, maxSteps) => emitProgress({ type: 'step', step, maxSteps }),
        onMessage: (role, content) => emitProgress({ type: 'message', messageRole: role, messageContent: content }),
      },
      mcpToolDescriptions: this.options.getMcpToolDescriptions(),
      maxTokensRecoveryMaxAttempts: 2,
    });

    this.runningAgents.set(task.taskId, agent);
    emitProgress({ type: 'heartbeat' });

    // REQ-0002: Timeout watchdog with escalation - early warnings at 30s/60s + percentage-based
    const TIMEOUT_WARNING_THRESHOLD = 0.8;
    const TIMEOUT_FORCE_THRESHOLD = 0.95;
    const ABSOLUTE_WARNING_30S = 30000;
    const ABSOLUTE_WARNING_60S = 60000;
    const taskTimeoutMs = provider.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const warningThresholdMs = Math.floor(taskTimeoutMs * TIMEOUT_WARNING_THRESHOLD);
    const forceThresholdMs = Math.floor(taskTimeoutMs * TIMEOUT_FORCE_THRESHOLD);

    let watchdogTimer: NodeJS.Timeout | null = null;
    let forceResolveTimer: NodeJS.Timeout | null = null;
    let earlyWarning30sTimer: NodeJS.Timeout | null = null;
    let earlyWarning60sTimer: NodeJS.Timeout | null = null;
    let isForceResolved = false;
    let forceResolveReason: string | undefined;
    let hasEmitted30sWarning = false;
    let hasEmitted60sWarning = false;

    const clearWatchdogs = (): void => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (forceResolveTimer) {
        clearTimeout(forceResolveTimer);
        forceResolveTimer = null;
      }
      if (earlyWarning30sTimer) {
        clearTimeout(earlyWarning30sTimer);
        earlyWarning30sTimer = null;
      }
      if (earlyWarning60sTimer) {
        clearTimeout(earlyWarning60sTimer);
        earlyWarning60sTimer = null;
      }
    };

    const setupWatchdogs = (): void => {
      // REQ-0002: Early warning at 30s (only if task timeout > 30s)
      if (taskTimeoutMs > ABSOLUTE_WARNING_30S) {
        earlyWarning30sTimer = setTimeout(() => {
          if (!hasEmitted30sWarning) {
            hasEmitted30sWarning = true;
            emitProgress({
              type: 'timeout_warning',
              timeoutWarning: {
                threshold: 30,
                elapsedMs: ABSOLUTE_WARNING_30S,
                message: `Sub-agent running for 30s (timeout: ${taskTimeoutMs}ms). Progress may be slow.`,
              },
            });
          }
        }, ABSOLUTE_WARNING_30S);
      }

      // REQ-0002: Early warning at 60s (only if task timeout > 60s)
      if (taskTimeoutMs > ABSOLUTE_WARNING_60S) {
        earlyWarning60sTimer = setTimeout(() => {
          if (!hasEmitted60sWarning) {
            hasEmitted60sWarning = true;
            emitProgress({
              type: 'timeout_warning',
              timeoutWarning: {
                threshold: 60,
                elapsedMs: ABSOLUTE_WARNING_60S,
                message: `Sub-agent running for 60s (timeout: ${taskTimeoutMs}ms). Consider if operation is stuck.`,
              },
            });
          }
        }, ABSOLUTE_WARNING_60S);
      }

      // Warning at percentage-based threshold (80%)
      watchdogTimer = setTimeout(() => {
        const elapsedMs = Date.now() - startTime;
        emitProgress({
          type: 'timeout_warning',
          timeoutWarning: {
            threshold: TIMEOUT_WARNING_THRESHOLD,
            elapsedMs,
            message: `Sub-agent approaching timeout (${elapsedMs}ms / ${taskTimeoutMs}ms). Consider completing soon.`,
          },
        });
        // Schedule force-resolve at 95%
        forceResolveTimer = setTimeout(() => {
          const elapsedMs2 = Date.now() - startTime;
          if (!isForceResolved) {
            isForceResolved = true;
            forceResolveReason = `timeout_force: exceeded ${TIMEOUT_FORCE_THRESHOLD * 100}% of ${taskTimeoutMs}ms limit`;
            emitProgress({
              type: 'timeout_force',
              timeoutWarning: {
                threshold: TIMEOUT_FORCE_THRESHOLD,
                elapsedMs: elapsedMs2,
                message: forceResolveReason,
              },
            });
            agent.cancel();
          }
        }, forceThresholdMs - warningThresholdMs);
      }, warningThresholdMs);
    };

    setupWatchdogs();

    let finishReason: string | undefined;
    let usage: SubAgentExecutionOutput['usage'];
    let content = '';
    let runError: string | undefined;

    try {
      const result = await agent.runWithResult(task.prompt, turn.turnId);
      finishReason = result.finishReason;
      usage = result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined;
      content = result.content;
    } catch (error) {
      runError = error instanceof Error ? error.message : String(error);
    } finally {
      clearWatchdogs();
      this.runningAgents.delete(task.taskId);
    }

    const turnMessages = agent.getMessages().filter((message) => message.role !== 'system');
    try {
      this.options.contextManager.commitTurn(turn.turnId, {
        messages: turnMessages,
        finishReason: finishReason ?? 'failed',
        usage: usage,
      });
    } catch {
      // ignore commit errors for runner return path
    }

    const artifacts = this.extractArtifacts(turnMessages);
    const completedAt = nowIso();
    if (runError) {
      return {
        status: 'failed',
        summary: `Sub-agent failed: ${truncate(runError, 280)}`,
        artifacts,
        error: runError,
        finishReason,
        usage,
        startedAt,
        completedAt,
      };
    }
    // REQ-0002: Handle timeout force-resolve
    if (isForceResolved) {
      return {
        status: 'timeout',
        summary: `Sub-agent force-resolved: ${forceResolveReason ?? 'timeout'}. Partial result: ${truncate(content || '(no content)', 280)}`,
        artifacts,
        error: forceResolveReason,
        finishReason: 'timeout',
        usage,
        startedAt,
        completedAt,
      };
    }
    if (finishReason === 'cancelled') {
      return {
        status: 'canceled',
        summary: 'Sub-agent canceled by request.',
        artifacts,
        finishReason,
        usage,
        startedAt,
        completedAt,
      };
    }
    return {
      status: 'succeeded',
      summary: truncate(content || '(empty result)', 600),
      artifacts,
      finishReason,
      usage,
      startedAt,
      completedAt,
    };
  }

  private resolveProvider(providerId: string): SubAgentProviderConfig {
    const providers = this.options.getProviderConfigs() ?? [];
    const fallback: SubAgentProviderConfig = {
      id: 'local-default',
      type: 'local',
      enabled: true,
      timeoutMs: 300000,
    };
    if (!providerId) {
      return fallback;
    }
    const matched = providers.find((item) => item.id === providerId);
    if (!matched || matched.enabled === false) {
      throw new Error(`provider_unavailable:${providerId}`);
    }
    return matched;
  }

  private resolveSubAgentAgentPrompt(task: SubAgentQueuedTask): string {
    if (task.agentProfile) {
      return [
        '### Selected Agent Profile',
        'Use this AGENT profile as role guidance for this delegated task:',
        buildAgentProfileBlock(task.agentProfile),
      ].join('\n\n');
    }
    return '### Default Sub-Agent Role\nYou are a general-purpose sub-agent. Complete delegated tasks accurately and report concise results.';
  }

  private createSubAgentToolRegistry(task: SubAgentQueuedTask, turnId: string): ToolRegistry {
    const taskRegistry = this.options.getTaskToolRegistry?.(task, turnId);
    if (taskRegistry) {
      return this.filterAllowedTools(taskRegistry, task.allowedTools);
    }

    const mainRegistry = this.options.getMainToolRegistry();
    if (!mainRegistry) {
      throw new Error('tool_registry_not_initialized');
    }
    return this.filterAllowedTools(mainRegistry, task.allowedTools);
  }

  private filterAllowedTools(sourceRegistry: ToolRegistry, allowedTools?: string[]): ToolRegistry {
    const normalizedAllowSet = allowedTools
      ? new Set(allowedTools.map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0))
      : null;
    const registry = new ToolRegistry();
    for (const tool of sourceRegistry.getAll()) {
      const normalizedName = tool.name.trim().toLowerCase();
      if (
        normalizedName === 'context_manage' ||
        normalizedName === 'subagent_manage' ||
        normalizedName === 'todo'
      ) {
        continue;
      }
      if (normalizedAllowSet && !normalizedAllowSet.has(normalizedName)) {
        continue;
      }
      registry.register(tool);
    }
    return registry;
  }

  private extractArtifacts(messages: Message[]): SubAgentExecutionOutput['artifacts'] {
    const files = new Set<string>();
    const commands = new Set<string>();
    const notes: string[] = [];

    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        for (const toolCall of message.toolCalls) {
          const name = toolCall.function.name.trim().toLowerCase();
          const args = toolCall.function.arguments;
          if (name === 'write_file' || name === 'edit_file' || name === 'read_file') {
            const filePath = String(args.path ?? args.filePath ?? '').trim();
            if (filePath) {
              files.add(filePath);
            }
          }
          if (name === 'shell_execute') {
            const command = String(args.command ?? '').trim();
            if (command) {
              commands.add(command);
            }
          }
          if (name === 'glob') {
            const pattern = String(args.pattern ?? '').trim();
            if (pattern) {
              notes.push(`glob:${truncate(pattern, 80)}`);
            }
          }
        }
      }
    }

    const assistantOutputs = messages.filter((item) => item.role === 'assistant');
    if (assistantOutputs.length > 0) {
      const finalOutput = assistantOutputs[assistantOutputs.length - 1];
      const content = typeof finalOutput.content === 'string' ? finalOutput.content : JSON.stringify(finalOutput.content);
      if (content.trim().length > 0) {
        notes.push(`final:${truncate(content.trim(), 220)}`);
      }
    }

    return {
      files: Array.from(files),
      commands: Array.from(commands),
      notes: notes.slice(0, 8),
    };
  }
}
