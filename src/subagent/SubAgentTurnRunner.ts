import { Agent } from '../agent/index.js';
import { buildAgentProfileBlock } from '../agents/AgentProfiles.js';
import { ContextManager } from '../context/index.js';
import { LLMClient } from '../llm/index.js';
import { ToolRegistry } from '../tools/index.js';
import { filterSubAgentToolRegistry } from '../tools/CapabilityCatalog.js';
import type { LLMRuntime } from '../llm/index.js';
import { resolveLlmRuntimeConfig, resolveModelRuntimeBudgetOptions } from '../llm/provider-profiles.js';
import type {
  SubAgentProviderConfig,
  Message,
} from '../types.js';
import { resolveContextBudget } from '../runtime/context-window-budget.js';
import { ContextUsageCalibrationStore } from '../runtime/context-usage-calibration-store.js';
import { TimerScope } from '../runtime/async-primitives.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask } from './types.js';
import { DEFAULT_TASK_TIMEOUT_MS } from './subagent-manager-contracts.js';

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
  type: 'step' | 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'heartbeat' | 'timeout_warning';
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
    threshold: number;
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
  getContextOverflowMaxErrorsBeforeTrim?: () => number | undefined;
  getContextUsageCalibrationStore?: () => ContextUsageCalibrationStore | undefined;
  getConfig: () => import('../types.js').AgentConfig;
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

  async runTask(
    task: SubAgentQueuedTask,
    onProgress?: (update: SubAgentProgressUpdate) => void
  ): Promise<SubAgentExecutionOutput> {
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

    const llmClient = this.resolveTaskLlmClient(task);
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
        const progressUpdate = {
          ...update,
          timestamp: nowIso(),
          elapsedMs,
        };
        this.options.onProgress?.(progressUpdate);
        onProgress?.(progressUpdate);
      } catch {
        // ignore progress callback failures
      }
    };

    const runtimeConfig = llmClient.getRuntimeConfig?.();
    const subBudget = resolveContextBudget({
      config: this.options.getConfig(),
      profileId: runtimeConfig?.profileId,
      provider: runtimeConfig?.provider ?? 'anthropic',
      model: runtimeConfig?.model ?? 'unknown',
      modelRuntimeOptions: resolveModelRuntimeBudgetOptions(runtimeConfig),
    });

      const agent = new Agent({
        llmClient,
        toolRegistry,
        systemPrompt: mergedSystemPrompt,
        maxSteps: this.options.getMaxSteps(),
      tokenLimit: this.options.getTokenLimit(),
      contextBudget: subBudget,
      contextOverflowMaxErrorsBeforeTrim: this.options.getContextOverflowMaxErrorsBeforeTrim?.(),
      contextUsageCalibrationStore: this.options.getContextUsageCalibrationStore?.(),
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

    // Timeout watchdog: warn before and at the advisory task deadline. Explicit cancel is the only interrupt path.
    const TIMEOUT_WARNING_THRESHOLD = 0.8;
    const ABSOLUTE_WARNING_30S = 30000;
    const ABSOLUTE_WARNING_60S = 60000;
    const taskTimeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const warningThresholdMs = Math.floor(taskTimeoutMs * TIMEOUT_WARNING_THRESHOLD);

    const watchdogs = new TimerScope();
    let hasEmitted30sWarning = false;
    let hasEmitted60sWarning = false;
    let hasEmittedDeadlineWarning = false;

    const setupWatchdogs = (): void => {
      // REQ-0002: Early warning at 30s (only if task timeout > 30s)
      if (taskTimeoutMs > ABSOLUTE_WARNING_30S) {
        watchdogs.setTimeout(() => {
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
        watchdogs.setTimeout(() => {
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
      watchdogs.setTimeout(() => {
        const elapsedMs = Date.now() - startTime;
        emitProgress({
          type: 'timeout_warning',
          timeoutWarning: {
            threshold: TIMEOUT_WARNING_THRESHOLD,
            elapsedMs,
            message: `Sub-agent approaching timeout (${elapsedMs}ms / ${taskTimeoutMs}ms). Consider completing soon.`,
          },
        });
      }, warningThresholdMs);
    };

    setupWatchdogs();

    let finishReason: string | undefined;
    let usage: SubAgentExecutionOutput['usage'];
    let content = '';
    let runError: string | undefined;

    try {
      const runPromise = agent.runWithResult(task.prompt, turn.turnId);
      watchdogs.setTimeout(() => {
        if (hasEmittedDeadlineWarning) {
          return;
        }
        hasEmittedDeadlineWarning = true;
        const elapsedMs = Date.now() - startTime;
        emitProgress({
          type: 'timeout_warning',
          timeoutWarning: {
            threshold: 1,
            elapsedMs,
            message:
              `Sub-agent exceeded expected timeout (${elapsedMs}ms / ${taskTimeoutMs}ms). ` +
              'It remains running until it finishes or is explicitly canceled.',
          },
        });
      }, taskTimeoutMs);
      const result = await runPromise;
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
      watchdogs.clearAll();
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
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
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

  private resolveTaskLlmClient(task: SubAgentQueuedTask): LLMRuntime | null {
    const agentConfig = task.agentConfig;
    if (!agentConfig?.llmProfileId && !agentConfig?.llmModel && !agentConfig?.reasoningPreset) {
      return this.options.getLLMClient();
    }
    const runtime = resolveLlmRuntimeConfig(this.options.getConfig(), {
      profileId: agentConfig.llmProfileId,
      model: agentConfig.llmModel,
      reasoningPreset: agentConfig.reasoningPreset,
    });
    return new LLMClient({
      provider: runtime.provider,
      apiKey: runtime.apiKey,
      apiBase: runtime.apiBase,
      model: runtime.model,
      maxTokens: runtime.maxOutputTokens,
      llmRuntime: runtime,
    });
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
    return filterSubAgentToolRegistry(sourceRegistry, allowedTools);
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
