import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  estimateMessageCharacters as estimatePreparedMessageCharacters,
  type LLMRuntime,
  extractMissingToolCallId,
  isMiniMaxContextWindowExceededError,
  isMiniMaxToolResultIdNotFoundError,
  messageTextContent,
  sanitizeMessagesForToolProtocol,
  trimMessagesForContextWindow,
} from '../llm/index.js';
import { ToolRegistry, Tool } from '../tools/index.js';
import { agentLogger } from '../utils/logger.js';
import { buildCompressionPrompt, ContextCompressor } from '../compression/index.js';
import { ContextPayloadProjector } from '../context/ContextPayloadProjector.js';
import {
  buildPromptWithAgentProfileReference,
  parseAgentProfilePrompt,
  type AgentProfileReference,
} from '../agents/index.js';
import type {
  Message,
  AgentCallback,
  ToolResult,
  ToolCall,
  Session,
  TokenUsage,
  LLMResponse,
  MaxTokensRecoveryEvent,
  PersistedMessage,
  SummaryApplyRequest,
  SummaryCheckpoint,
  AgentCompletionMeta,
  ContextPrecompressEvent,
  ContextOverflowEvent,
  ToolResultArtifactRef,
} from '../types.js';

function isRetriableTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('socket hang up') ||
    normalized.includes('fetch failed') ||
    normalized.includes('stream ended without receiving a complete event') ||
    normalized.includes('network') ||
    normalized.includes('connection reset')
  );
}

export interface AgentRunResult {
  content: string;
  finishReason?: string;
  step: number;
  usage?: TokenUsage;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
}

interface CompressionChunk {
  messages: Message[];
  preparedMessages: PersistedMessage[];
  chars: number;
}

export interface AgentOptions {
  llmClient: LLMRuntime;
  toolRegistry: ToolRegistry;
  systemPrompt: string;
  maxSteps?: number;
  tokenLimit?: number;
  contextWindowChars?: number;
  contextPrecompressTriggerRatio?: number;
  contextOverflowForcedTrimChars?: number;
  contextOverflowMaxErrorsBeforeTrim?: number;
  contextPrecompressKeepLlmRounds?: number;
  contextPrecompressChunkChars?: number;
  contextPrecompressRetry?: number;
  workspaceDir?: string;
  callback?: AgentCallback;
  mcpToolDescriptions?: string;
  materializeToolResultArtifact?: (input: {
    toolName: string;
    toolCallId: string;
    content: string;
    thresholdChars?: number;
    previewChars?: number;
  }) => Promise<{ content: string; artifact?: ToolResultArtifactRef }> | { content: string; artifact?: ToolResultArtifactRef };
  maxTokensRecoveryMaxAttempts?: number;
  progressOnlyRecoveryEnabled?: boolean;
}

export class Agent {
  private static readonly DEFAULT_TOOL_RESULT_CHAR_LIMIT = 4000;
  private static readonly DEFAULT_SUMMARY_CHECKPOINT_LIMIT = 50;
  private static readonly DEFAULT_CONTEXT_WINDOW_CHARS = 230000;
  private static readonly DEFAULT_PRECOMPRESS_TRIGGER_RATIO = 0.85;
  private static readonly DEFAULT_OVERFLOW_FORCED_TRIM_CHARS = 160000;
  private static readonly DEFAULT_OVERFLOW_MAX_ERRORS_BEFORE_TRIM = 2;
  private static readonly DEFAULT_OVERFLOW_AGGRESSIVE_KEEP_LLM_ROUNDS = 3;
  private static readonly DEFAULT_PRECOMPRESS_KEEP_LLM_ROUNDS = 5;
  private static readonly DEFAULT_PRECOMPRESS_CHUNK_CHARS = 60000;
  private static readonly DEFAULT_PRECOMPRESS_RETRY = 1;
  private static readonly DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS = 3;
  private static readonly DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS = 2;
  private llm: LLMRuntime;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private maxSteps: number;
  private tokenLimit: number;
  private contextWindowChars: number;
  private contextPrecompressTriggerRatio: number;
  private contextOverflowForcedTrimChars: number;
  private contextOverflowMaxErrorsBeforeTrim: number;
  private contextPrecompressTriggerThresholdChars: number;
  private contextPrecompressKeepLlmRounds: number;
  private contextPrecompressChunkChars: number;
  private contextPrecompressRetry: number;
  private workspaceDir: string;
  private callback?: AgentCallback;
  private mcpToolDescriptions?: string;
  private materializeToolResultArtifact?: AgentOptions['materializeToolResultArtifact'];
  private contextCompressor: ContextCompressor;
  private contextPayloadProjector = new ContextPayloadProjector();
  private maxTokensRecoveryMaxAttempts: number;
  private progressOnlyRecoveryEnabled: boolean;
  private lastCompletedPrecompressEvent: ContextPrecompressEvent | null = null;

  private messages: Message[] = [];
  private sessionId: string | null = null;
  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private lastUsage: TokenUsage | undefined;
  private checkpointCounter = 0;
  private totalOverflowSnapshots = 0;
  private pendingSummaryApplyRequest: SummaryApplyRequest | null = null;

  private isTurnCompleteFinishReason(finishReason: string | undefined): boolean {
    return finishReason === 'end_turn';
  }

  private shouldRecoverProgressOnlyTurnStop(response: LLMResponse): boolean {
    if (!this.isTurnCompleteFinishReason(response.finishReason)) {
      return false;
    }
    if (response.toolCalls && response.toolCalls.length > 0) {
      return false;
    }

    const text = response.content.trim();
    if (text.length === 0) {
      return false;
    }

    const blockerPattern =
      /(请提供|需要你|需要您|缺少|缺失|无法继续|无法执行|blocked|missing|please provide|need .* from you|cannot proceed|can't proceed)/i;
    if (blockerPattern.test(text)) {
      return false;
    }

    const promiseActionPattern =
      /(?:^|[。！？!?，,\n]\s*)(?:(?:让我|我来|我先|我去|我直接|先让我|我现在|接下来我|下面我)\s*(?:先)?(?:看|查看|检查|读|读取|查|确认|排查|分析|重新审视|梳理|trace|追踪|定位|验证|测试|更新|执行|清理|记录)|(?:现在|接下来|下面)\s*(?:继续|先)?(?:检查|查看|读取|分析|排查|更新|执行|清理|记录|验证|测试)|(?:let me|i(?:'ll| will)|first[,，]?\s*i(?:'ll| will)|now[,，]?\s*(?:let me|i(?:'ll| will))|next[,，]?\s*i(?:'ll| will))\s*(?:first\s*)?(?:check|inspect|look|read|trace|investigate|analy[sz]e|verify|update|run|test|clean|record)\b)/i;

    return promiseActionPattern.test(text);
  }

  private buildProgressOnlyContinuationPrompt(attempt: number, maxAttempts: number): string {
    return [
      `[EXECUTION_CONTINUE_REQUIRED attempt=${attempt}/${maxAttempts}]`,
      'Your previous reply ended the turn with progress-only text or a promise to act later, but no concrete action followed.',
      'Continue in the same turn now.',
      'If tools are available, use them immediately instead of describing the next step.',
      'Only stop when the request is actually complete or you are blocked by missing essential user input.',
    ].join(' ');
  }

  private buildProgressOnlyStallMessage(attempts: number): string {
    return [
      `[PROGRESS_ONLY_STALL attempts=${attempts}]`,
      'The model repeatedly ended the turn with progress-only text without taking concrete action.',
      'Treat this as a protocol stall and retry with a stronger instruction or a narrower task.',
    ].join(' ');
  }

  private completeCancelledRun(input: {
    step: number;
    usage?: TokenUsage;
    recoveredFromMaxTokens?: boolean;
    maxTokensRecoveryAttempt?: number;
    maxTokensEvents?: MaxTokensRecoveryEvent[];
  }): AgentRunResult {
    const content = 'Task cancelled by user.';
    const meta: AgentCompletionMeta = {
      finishReason: 'cancelled',
      usage: input.usage,
      step: input.step,
      recoveredFromMaxTokens: input.recoveredFromMaxTokens,
      maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
      maxTokensEvents: input.maxTokensEvents,
    };
    this.callback?.onComplete?.(content, 'cancelled', meta);
    return {
      content,
      finishReason: 'cancelled',
      step: input.step,
      usage: input.usage,
      recoveredFromMaxTokens: input.recoveredFromMaxTokens,
      maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
      maxTokensEvents: input.maxTokensEvents,
    };
  }

  constructor(options: AgentOptions) {
    this.llm = options.llmClient;
    this.tools = options.toolRegistry;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 100;
    this.tokenLimit = options.tokenLimit ?? 80000;
    this.contextWindowChars = Math.max(
      50000,
      Math.floor(options.contextWindowChars ?? Agent.DEFAULT_CONTEXT_WINDOW_CHARS)
    );
    this.contextPrecompressTriggerRatio = Math.min(
      1,
      Math.max(
        0.1,
        Number.isFinite(options.contextPrecompressTriggerRatio)
          ? (options.contextPrecompressTriggerRatio as number)
          : Agent.DEFAULT_PRECOMPRESS_TRIGGER_RATIO
      )
    );
    this.contextOverflowForcedTrimChars = Math.max(
      40000,
      Math.floor(options.contextOverflowForcedTrimChars ?? Agent.DEFAULT_OVERFLOW_FORCED_TRIM_CHARS)
    );
    this.contextOverflowMaxErrorsBeforeTrim = Math.max(
      1,
      Math.floor(options.contextOverflowMaxErrorsBeforeTrim ?? Agent.DEFAULT_OVERFLOW_MAX_ERRORS_BEFORE_TRIM)
    );
    this.contextPrecompressTriggerThresholdChars = Math.max(
      10000,
      Math.floor(this.contextWindowChars * this.contextPrecompressTriggerRatio)
    );
    this.contextPrecompressKeepLlmRounds = Math.max(
      1,
      Math.floor(options.contextPrecompressKeepLlmRounds ?? Agent.DEFAULT_PRECOMPRESS_KEEP_LLM_ROUNDS)
    );
    this.contextPrecompressChunkChars = Math.max(
      4000,
      Math.floor(options.contextPrecompressChunkChars ?? Agent.DEFAULT_PRECOMPRESS_CHUNK_CHARS)
    );
    this.contextPrecompressRetry = Math.max(
      0,
      Math.floor(options.contextPrecompressRetry ?? Agent.DEFAULT_PRECOMPRESS_RETRY)
    );
    this.workspaceDir = path.resolve(options.workspaceDir ?? './workspace');
    this.callback = options.callback;
    this.mcpToolDescriptions = options.mcpToolDescriptions;
    this.materializeToolResultArtifact = options.materializeToolResultArtifact;
    this.contextCompressor = new ContextCompressor(this.llm, 0.35);
    this.maxTokensRecoveryMaxAttempts = Math.max(0, Math.floor(options.maxTokensRecoveryMaxAttempts ?? 2));
    this.progressOnlyRecoveryEnabled = options.progressOnlyRecoveryEnabled !== false;

    this.ensureWorkspace();
    this.initializeMessages();
  }

  private ensureWorkspace(): void {
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  private initializeMessages(): void {
    let prompt = this.systemPrompt;

    if (!prompt.includes('Current Workspace')) {
      prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
    }

    if (this.mcpToolDescriptions) {
      prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
    }

    this.messages = [{ role: 'system', content: prompt }];
  }

  private ensureSystemPrompt(): void {
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      let prompt = this.systemPrompt;

      if (!prompt.includes('Current Workspace')) {
        prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
      }

      if (this.mcpToolDescriptions) {
        prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
      }

      this.messages.unshift({ role: 'system', content: prompt });
    }
  }

  private nextCheckpointId(): string {
    this.checkpointCounter += 1;
    return `ckpt-${this.checkpointCounter}`;
  }

  private withCheckpointMetadata(
    message: Message,
    reason: 'user_prompt' | 'assistant_toolcall' | 'summary_anchor'
  ): Message {
    return {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        checkpointId: this.nextCheckpointId(),
        checkpointReason: reason,
      },
    };
  }

  private syncCheckpointCounterFromMessages(): void {
    let maxFound = 0;
    for (const message of this.messages) {
      const checkpointId = message.metadata?.checkpointId;
      if (!checkpointId) {
        continue;
      }
      const match = checkpointId.match(/^ckpt-(\d+)$/);
      if (!match) {
        continue;
      }
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > maxFound) {
        maxFound = parsed;
      }
    }
    this.checkpointCounter = Math.max(0, maxFound);
  }

  setCallback(callback: AgentCallback): void {
    this.callback = callback;
  }

  addTool(tool: Tool): void {
    this.tools.register(tool);
  }

  removeTool(name: string): void {
    this.tools.unregister(name);
  }

  addUserMessage(content: string): void {
    this.messages.push(this.withCheckpointMetadata({ role: 'user', content }, 'user_prompt'));
  }

  listSummaryCheckpoints(limit: number = Agent.DEFAULT_SUMMARY_CHECKPOINT_LIMIT): SummaryCheckpoint[] {
    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const checkpoints: SummaryCheckpoint[] = [];
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      const checkpointId = message.metadata?.checkpointId;
      const checkpointReason = message.metadata?.checkpointReason;
      if (!checkpointId || !checkpointReason) {
        continue;
      }
      checkpoints.push({
        checkpointId,
        messageIndex: i,
        role: message.role,
        reason: checkpointReason,
        preview: this.truncate(this.messageTextContent(message.content).replace(/\s+/g, ' '), 180),
      });
      if (checkpoints.length >= normalizedLimit) {
        break;
      }
    }
    return checkpoints;
  }

  enqueueSummaryApply(request: SummaryApplyRequest): {
    accepted: boolean;
    availableCheckpoints: number;
  } {
    const checkpoints = this.listSummaryCheckpoints(1000);
    const exists = checkpoints.some((item) => item.checkpointId === request.checkpointId);
    if (!exists) {
      return {
        accepted: false,
        availableCheckpoints: checkpoints.length,
      };
    }
    this.pendingSummaryApplyRequest = { ...request };
    this.callback?.onSummaryMessagesAccepted?.({
      checkpointId: request.checkpointId,
      keepRecentMessages: request.keepRecentMessages,
      summaryChars: request.summary.length,
      availableCheckpoints: checkpoints.length,
    });
    return {
      accepted: true,
      availableCheckpoints: checkpoints.length,
    };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    const hasSystemPrompt = this.messages.length > 0 && this.messages[0].role === 'system';
    const incomingHasSystem = messages.length > 0 && messages[0].role === 'system';

    if (hasSystemPrompt && !incomingHasSystem) {
      this.messages = [this.messages[0], ...messages];
    } else {
      this.messages = [...messages];
    }
    this.pendingSummaryApplyRequest = null;
    this.syncCheckpointCounterFromMessages();
  }

  getLastUsage(): TokenUsage | undefined {
    return this.lastUsage;
  }

  getSession(): Session {
    return {
      id: this.sessionId ?? '',
      messages: this.messages,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaceDir: this.workspaceDir,
      additionalDirs: [],
    };
  }

  setSession(session: Session): void {
    this.sessionId = session.id;
    this.messages = [...session.messages];
    this.pendingSummaryApplyRequest = null;
    this.syncCheckpointCounterFromMessages();
  }

  private findToolNameById(toolCallId: string | undefined): string | undefined {
    if (!toolCallId || toolCallId.trim().length === 0) {
      return undefined;
    }
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      if (message.role !== 'assistant' || !message.toolCalls) {
        continue;
      }
      const matched = message.toolCalls.find((item) => item.id === toolCallId);
      if (matched) {
        return matched.function.name;
      }
    }
    return undefined;
  }

  private buildToolCallFailedMessage(input: {
    errorRaw: string;
    missingToolCallId?: string;
    matchedToolName?: string;
    consecutiveFailureCount: number;
  }): string {
    const missingToolCallId = input.missingToolCallId ?? '(unknown)';
    const matchedToolName = input.matchedToolName ?? '(unknown)';
    return [
      '[TOOLCALL_FAILED]',
      `error_raw=${input.errorRaw}`,
      `missing_tool_call_id=${missingToolCallId}`,
      `matched_tool_name=${matchedToolName}`,
      `consecutive_failure_count=${input.consecutiveFailureCount}`,
      'next_action=Do not reuse stale tool_result. Issue a fresh tool call and continue from current task state.',
    ].join('\n');
  }

  private messageTextContent(content: Message['content']): string {
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

  private estimateMessageChars(message: Message): number {
    return estimatePreparedMessageCharacters(message);
  }

  private estimateTotalChars(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + this.estimateMessageChars(message), 0);
  }

  private findCheckpointMessageIndex(checkpointId: string): number {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const id = this.messages[i]?.metadata?.checkpointId;
      if (id === checkpointId) {
        return i;
      }
    }
    return -1;
  }

  private applyPendingSummaryIfNeeded(): void {
    const pending = this.pendingSummaryApplyRequest;
    if (!pending) {
      return;
    }
    this.pendingSummaryApplyRequest = null;

    const checkpointIndex = this.findCheckpointMessageIndex(pending.checkpointId);
    if (checkpointIndex < 0) {
      return;
    }

    const beforeMessages = this.messages.length;
    const beforeChars = this.estimateTotalChars(this.messages);
    const keepRecent = Math.max(0, Math.min(20, pending.keepRecentMessages));

    const preservedHead = this.messages.slice(0, checkpointIndex + 1);
    const preservedTail =
      keepRecent > 0 ? this.messages.slice(Math.max(checkpointIndex + 1, this.messages.length - keepRecent)) : [];
    const anchor = this.withCheckpointMetadata(
      {
        role: 'assistant',
        content: `[SUMMARY_MESSAGES_APPLIED checkpoint_id=${pending.checkpointId}]\n${pending.summary}`,
        metadata: {
          summaryAnchor: true,
          summaryFromCheckpointId: pending.checkpointId,
        },
      },
      'summary_anchor'
    );
    anchor.metadata = {
      ...(anchor.metadata ?? {}),
      summaryCompactedMessageCount: Math.max(0, beforeMessages - (preservedHead.length + preservedTail.length + 1)),
    };

    const nextMessages = [...preservedHead, ...preservedTail, anchor];
    this.messages = sanitizeMessagesForToolProtocol(nextMessages).messages;
    const afterMessages = this.messages.length;
    const afterChars = this.estimateTotalChars(this.messages);
    this.callback?.onSummaryMessagesApplied?.({
      checkpointId: pending.checkpointId,
      keepRecentMessages: keepRecent,
      summaryChars: pending.summary.length,
      beforeMessages,
      afterMessages,
      compactedMessages: Math.max(0, beforeMessages - afterMessages),
      beforeChars,
      afterChars,
    });
  }

  private normalizeAgentProfileMessagesInPlace(): {
    activeProfileRef?: AgentProfileReference;
    normalizedCount: number;
  } {
    let normalizedCount = 0;
    let activeProfileRef: AgentProfileReference | undefined;
    const next = [...this.messages];
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
      this.messages = next;
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

  private splitMessagesForPrecompress(
    contentMessages: Message[],
    keepLlmRounds: number
  ): {
    olderMessages: Message[];
    tailMessages: Message[];
  } {
    if (contentMessages.length <= 2) {
      return {
        olderMessages: [],
        tailMessages: [...contentMessages],
      };
    }

    const rounds: Array<{ start: number; end: number }> = [];
    let cursor = 0;
    while (cursor < contentMessages.length) {
      let assistantIdx = -1;
      for (let i = cursor; i < contentMessages.length; i += 1) {
        if (contentMessages[i]?.role === 'assistant') {
          assistantIdx = i;
          break;
        }
      }
      if (assistantIdx < 0) {
        break;
      }
      let end = assistantIdx;
      while (end + 1 < contentMessages.length && contentMessages[end + 1]?.role === 'tool') {
        end += 1;
      }
      rounds.push({ start: cursor, end });
      cursor = end + 1;
    }

    const normalizedKeepRounds = Math.max(1, Math.floor(keepLlmRounds));
    if (rounds.length <= normalizedKeepRounds) {
      return {
        olderMessages: [],
        tailMessages: [...contentMessages],
      };
    }

    const tailStart = rounds[rounds.length - normalizedKeepRounds].start;
    return {
      olderMessages: contentMessages.slice(0, tailStart),
      tailMessages: contentMessages.slice(tailStart),
    };
  }

  private chunkMessagesForCompression(messages: Message[], maxChars: number): CompressionChunk[] {
    if (messages.length === 0) {
      return [];
    }
    const normalizedMaxChars = Math.max(1000, Math.floor(maxChars));
    const chunks: CompressionChunk[] = [];
    let current: Message[] = [];
    let currentEstimatedChars = 0;

    for (const message of messages) {
      const messageChars = Math.max(1, estimatePreparedMessageCharacters(message));
      if (current.length > 0 && currentEstimatedChars + messageChars > normalizedMaxChars) {
        chunks.push(this.buildCompressionChunk(current));
        current = [message];
        currentEstimatedChars = messageChars;
        continue;
      }
      current.push(message);
      currentEstimatedChars += messageChars;
    }
    if (current.length > 0) {
      chunks.push(this.buildCompressionChunk(current));
    }
    return this.mergeSmallCompressionChunks(chunks, normalizedMaxChars);
  }

  private resolveAdaptiveCompressionChunks(messages: Message[]): {
    chunkCharsApplied: number;
    chunks: CompressionChunk[];
  } {
    const baseChunkChars = Math.max(4000, Math.floor(this.contextPrecompressChunkChars));
    const baseChunks = this.chunkMessagesForCompression(messages, baseChunkChars);
    if (baseChunks.length <= 2) {
      return {
        chunkCharsApplied: baseChunkChars,
        chunks: baseChunks,
      };
    }
    const totalChunkChars = baseChunks.reduce((sum, chunk) => sum + chunk.chars, 0);
    const adaptiveChunkChars = Math.max(
      baseChunkChars,
      Math.min(Math.ceil(totalChunkChars / 2), Math.floor(baseChunkChars * 3))
    );
    if (adaptiveChunkChars === baseChunkChars) {
      return {
        chunkCharsApplied: baseChunkChars,
        chunks: baseChunks,
      };
    }
    const adaptiveChunks = this.chunkMessagesForCompression(messages, adaptiveChunkChars);
    return {
      chunkCharsApplied: adaptiveChunkChars,
      chunks: adaptiveChunks.length > 0 ? adaptiveChunks : baseChunks,
    };
  }

  private buildCompressionChunk(messages: Message[]): CompressionChunk {
    const normalized = this.contextPayloadProjector.normalizeMessages(messages, {
      maxToolResultChars: 6000,
      maxNonToolChars: 12000,
      truncateNonToolMessages: true,
    });
    const preparedMessages = this.toPersistedMessages(normalized.messages);
    const compressorPromptChars = buildCompressionPrompt(
      preparedMessages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
        }))
    ).length;
    return {
      messages: normalized.messages,
      preparedMessages,
      chars: compressorPromptChars,
    };
  }

  private mergeSmallCompressionChunks(chunks: CompressionChunk[], maxChars: number): CompressionChunk[] {
    if (chunks.length <= 1) {
      return chunks;
    }
    const minUsefulChunkChars = Math.max(1200, Math.floor(maxChars * 0.1));
    const merged: CompressionChunk[] = [];
    for (const chunk of chunks) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        chunk.chars < minUsefulChunkChars &&
        previous.chars + chunk.chars <= Math.floor(maxChars * 1.25)
      ) {
        merged[merged.length - 1] = this.buildCompressionChunk([...previous.messages, ...chunk.messages]);
        continue;
      }
      merged.push(chunk);
    }
    if (merged.length > 1 && merged[0].chars < minUsefulChunkChars) {
      const first = merged.shift();
      if (first) {
        merged[0] = this.buildCompressionChunk([...first.messages, ...merged[0].messages]);
      }
    }
    return merged;
  }

  private async compressChunksWithRetry(
    chunks: CompressionChunk[],
    onChunkProgress?: (input: { chunkIndex: number; chunkTotal: number; progressPercent: number }) => Promise<void> | void
  ): Promise<{
    ok: boolean;
    summaries: string[];
    retryCount: number;
    droppedSourceMessageCount: number;
    compressionCallCount: number;
    failureReason?: string;
  }> {
    const summaries: string[] = [];
    let retryCount = 0;
    let droppedSourceMessageCount = 0;
    let compressionCallCount = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      await Promise.resolve(
        onChunkProgress?.({
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
          progressPercent: Math.round((i / Math.max(1, chunks.length)) * 100),
        })
      );
      let success = false;
      let lastError = '';
      let candidate = chunks[i];
      let droppedForChunk = 0;
      let maxAttempts = Math.max(this.contextPrecompressRetry + 1, 3);
      const hardMaxAttempts = maxAttempts + 3;
      let attempt = 0;
      while (attempt < maxAttempts) {
        if (attempt > 0) {
          retryCount += 1;
        }
        compressionCallCount += 1;
        const result = await this.contextCompressor.compress(candidate.preparedMessages);
        if (result.success && result.compressedContent && result.compressedContent.trim().length > 0) {
          summaries.push(result.compressedContent.trim());
          droppedSourceMessageCount += droppedForChunk;
          success = true;
          break;
        }
        lastError = result.error ?? 'compress_empty_result';
        if (!this.isPromptTooLongCompressionError(lastError) || candidate.messages.length <= 2) {
          if (attempt >= this.contextPrecompressRetry) {
            break;
          }
          attempt += 1;
          continue;
        }
        const truncated = this.dropOldestCompressionRound(candidate.messages);
        if (truncated.messages.length >= candidate.messages.length) {
          break;
        }
        const droppedLeadingMarker =
          typeof candidate.messages[0]?.content === 'string' &&
          candidate.messages[0].content.startsWith('[COMPRESSION_RETRY_TRUNCATED')
            ? 1
            : 0;
        droppedForChunk += Math.max(0, truncated.droppedCount - droppedLeadingMarker);
        candidate = this.buildCompressionChunk([
          {
            role: 'user',
            content:
              `[COMPRESSION_RETRY_TRUNCATED dropped_messages=${truncated.droppedCount} reason=prompt_too_long]\n` +
              'The oldest source messages were omitted from this compression request to fit the compressor context window.',
          },
          ...truncated.messages,
        ]);
        if (attempt + 1 >= maxAttempts && maxAttempts < hardMaxAttempts) {
          maxAttempts += 1;
        }
        attempt += 1;
      }
      if (!success) {
        return {
          ok: false,
          summaries,
          retryCount,
          droppedSourceMessageCount,
          compressionCallCount,
          failureReason: `chunk_${i + 1}_failed:${lastError}`,
        };
      }
      await Promise.resolve(
        onChunkProgress?.({
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
          progressPercent: Math.round(((i + 1) / Math.max(1, chunks.length)) * 100),
        })
      );
      await this.yieldCompressionLoop();
    }
    return {
      ok: true,
      summaries,
      retryCount,
      droppedSourceMessageCount,
      compressionCallCount,
    };
  }

  private isPromptTooLongCompressionError(error: string): boolean {
    const normalized = error.toLowerCase();
    return (
      normalized.includes('prompt too long') ||
      normalized.includes('context window') ||
      normalized.includes('maximum context') ||
      normalized.includes('request too large') ||
      normalized.includes('413')
    );
  }

  private dropOldestCompressionRound(messages: Message[]): { messages: Message[]; droppedCount: number } {
    if (messages.length <= 1) {
      return { messages, droppedCount: 0 };
    }
    let dropEnd = 1;
    for (let i = 1; i < messages.length; i += 1) {
      dropEnd = i + 1;
      if (messages[i].role === 'assistant') {
        while (dropEnd < messages.length && messages[dropEnd].role === 'tool') {
          dropEnd += 1;
        }
        break;
      }
    }
    const safeDropEnd = Math.min(dropEnd, messages.length - 1);
    return {
      messages: messages.slice(safeDropEnd),
      droppedCount: safeDropEnd,
    };
  }

  private async mergeChunkSummaries(summaryChunks: string[]): Promise<string> {
    if (summaryChunks.length <= 1) {
      return summaryChunks[0] ?? '';
    }
    const merged = summaryChunks
      .map((summary, index) => `[COMPRESSION_CHUNK ${index + 1}/${summaryChunks.length}]\n${summary.trim()}`)
      .join('\n\n');
    return this.truncateMergedSummary(merged, 'deterministic_merge');
  }

  private async yieldCompressionLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  private truncateMergedSummary(content: string, reason: string): string {
    const maxChars = Math.max(
      12000,
      Math.min(48000, Math.floor(this.contextPrecompressTriggerThresholdChars * 0.25))
    );
    if (content.length <= maxChars) {
      return content;
    }
    const header = `[COMPRESSION_SUMMARY_TRUNCATED reason=${reason} original_chars=${content.length} kept_chars=${maxChars}]`;
    const bodyBudget = Math.max(0, maxChars - header.length - 1);
    return bodyBudget > 0 ? `${header}\n${content.slice(0, bodyBudget)}` : header.slice(0, maxChars);
  }

  private async emitContextPrecompress(
    event: ContextPrecompressEvent,
    phase: NonNullable<ContextPrecompressEvent['phase']>,
    options?: { swallowErrors?: boolean }
  ): Promise<void> {
    const snapshot: ContextPrecompressEvent = {
      ...event,
      phase,
      observedAt: new Date().toISOString(),
    };
    try {
      await Promise.resolve(this.callback?.onContextPrecompress?.(snapshot));
    } catch (error) {
      if (!options?.swallowErrors) {
        throw error;
      }
      console.warn('[Agent] Context precompress callback failed:', error);
    }
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
    const mode = options?.mode ?? 'light';
    const forceApply = options?.forced === true;
    const keepLlmRoundsApplied = Math.max(
      1,
      Math.floor(
        options?.keepLlmRoundsOverride ??
          (mode === 'aggressive'
            ? Math.min(this.contextPrecompressKeepLlmRounds, Agent.DEFAULT_OVERFLOW_AGGRESSIVE_KEEP_LLM_ROUNDS)
            : this.contextPrecompressKeepLlmRounds)
      )
    );
    const hasSystem = this.messages[0]?.role === 'system';
    const contentMessages = hasSystem ? this.messages.slice(1) : [...this.messages];
    const projectedBefore = this.contextPayloadProjector.projectForProvider(contentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildNormalTrimOptions(),
    });
    const totalCharsBefore = projectedBefore.metrics.preparedChars;
    const messageCharsBefore = Math.max(0, totalCharsBefore - effectiveSystemPrompt.length);
    const triggerThresholdChars = this.contextPrecompressTriggerThresholdChars;
    const shouldTrigger = totalCharsBefore >= triggerThresholdChars;

    const event: ContextPrecompressEvent = {
      source: 'in_turn_precompress',
      observedAt: new Date().toISOString(),
      triggerChars: triggerThresholdChars,
      triggerRatio: this.contextPrecompressTriggerRatio,
      triggerThresholdChars,
      keepLlmRounds: this.contextPrecompressKeepLlmRounds,
      keepLlmRoundsApplied,
      chunkChars: this.contextPrecompressChunkChars,
      retryLimit: this.contextPrecompressRetry,
      totalCharsBefore,
      totalCharsAfter: totalCharsBefore,
      systemPromptChars: effectiveSystemPrompt.length,
      messageCharsBefore,
      messageCharsAfter: messageCharsBefore,
      triggered: shouldTrigger,
      applied: false,
      chunkCount: 0,
      retryCount: 0,
      profileNormalizedCount,
      profileRuntimeSource: profileRuntime?.sourceName,
      profileRuntimePath: profileRuntime?.sourcePath,
      failureReason: profileRuntime?.failureReason,
      mode: mode === 'disabled' ? 'light' : mode,
      forced: forceApply,
      progressPercent: 0,
      chunkIndex: 0,
      chunkTotal: 0,
    };

    if (mode === 'disabled') {
      event.failureReason = event.failureReason ?? 'precompress_disabled';
      return event;
    }

    if (!event.triggered && !forceApply) {
      return event;
    }

    const split = this.splitMessagesForPrecompress(contentMessages, keepLlmRoundsApplied);
    if (split.olderMessages.length <= 2) {
      event.failureReason = event.failureReason ?? 'precompress_skipped_not_enough_older_messages';
      return event;
    }

    const adaptiveChunkPlan = this.resolveAdaptiveCompressionChunks(split.olderMessages);
    event.chunkChars = adaptiveChunkPlan.chunkCharsApplied;
    const chunks = adaptiveChunkPlan.chunks;
    event.chunkCount = chunks.length;
    event.chunkTotal = chunks.length;
    if (chunks.length === 0) {
      event.failureReason = event.failureReason ?? 'precompress_no_chunks';
      return event;
    }

    const compressStartedAt = Date.now();
    await this.emitContextPrecompress(event, 'started');
    let mergedSummary = '';
    try {
      const chunkResult = await this.compressChunksWithRetry(chunks, async ({ chunkIndex, chunkTotal, progressPercent }) => {
        event.chunkIndex = chunkIndex;
        event.chunkTotal = chunkTotal;
        event.progressPercent = progressPercent;
        if (chunkTotal > 1 || progressPercent < 100) {
          await this.emitContextPrecompress(event, 'running', { swallowErrors: true });
        }
      });
      event.retryCount = chunkResult.retryCount;
      event.sourceDroppedMessageCount = chunkResult.droppedSourceMessageCount;
      if (!chunkResult.ok || chunkResult.summaries.length === 0) {
        event.phase = 'failed';
        event.observedAt = new Date().toISOString();
        event.durationMs = Date.now() - compressStartedAt;
        event.failureReason = chunkResult.failureReason ?? event.failureReason ?? 'precompress_chunk_failed';
        agentLogger.info(
          `[MiniMaxAgent] Context precompress failed: durationMs=${event.durationMs} before=${event.totalCharsBefore} chunks=${event.chunkCount} compressionCalls=${chunkResult.compressionCallCount} reason=${event.failureReason}`
        );
        if ((event.durationMs ?? 0) > 180_000) {
          agentLogger.warn(
            `[MiniMaxAgent] Context precompress exceeded guardrail on failure: durationMs=${event.durationMs}`
          );
        }
        return event;
      }

      event.progressPercent = 100;
      mergedSummary = await this.mergeChunkSummaries(chunkResult.summaries);
      if (chunkResult.droppedSourceMessageCount > 0) {
        mergedSummary =
          `[COMPRESSION_SOURCE_TRUNCATED dropped_messages=${chunkResult.droppedSourceMessageCount} reason=prompt_too_long]\n` +
          'The oldest source messages were intentionally omitted from the compression request after compressor prompt-size failures.\n' +
          mergedSummary;
      }
    } catch (error) {
      event.phase = 'failed';
      event.observedAt = new Date().toISOString();
      event.durationMs = Date.now() - compressStartedAt;
      event.failureReason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : event.failureReason ?? 'precompress_failed';
      await this.emitContextPrecompress(event, 'failed', { swallowErrors: true });
      throw error;
    }

    const summaryMessage = this.withCheckpointMetadata(
      {
        role: 'assistant',
        content:
          `[CONTEXT_PRECOMPRESSED mode=${mode}] kept_llm_rounds=${keepLlmRoundsApplied} chunks=${chunks.length} source_messages=${split.olderMessages.length} source_dropped=${event.sourceDroppedMessageCount ?? 0}\n` +
          mergedSummary,
        metadata: {
          compressed: true,
          originalSize: totalCharsBefore,
          contextCompaction: {
            sourceRange: {
              startIndex: 0,
              endIndex: Math.max(0, split.olderMessages.length - 1),
              messageCount: split.olderMessages.length,
              sourceHash: this.hashMessages(split.olderMessages),
            },
            sourceCoverage: {
              status: (event.sourceDroppedMessageCount ?? 0) > 0 ? 'truncated' : 'complete',
              droppedMessageCount: event.sourceDroppedMessageCount ?? 0,
              reason: (event.sourceDroppedMessageCount ?? 0) > 0 ? 'prompt_too_long' : undefined,
            },
            sealedBoundary: {
              keptLlmRounds: keepLlmRoundsApplied,
              tailMessageCount: split.tailMessages.length,
            },
            payloadMetrics: this.contextPayloadProjector.projectForProvider(split.olderMessages, {
              systemPrompt: effectiveSystemPrompt,
              trimOptions: this.buildNormalTrimOptions(),
            }).metrics,
            configFingerprint: this.contextCompactionConfigFingerprint(),
          },
        },
      },
      'summary_anchor'
    );

    const nextMessages: Message[] = [];
    if (hasSystem) {
      nextMessages.push(this.messages[0]);
    }
    nextMessages.push(summaryMessage, ...split.tailMessages);
    this.messages = sanitizeMessagesForToolProtocol(nextMessages).messages;

    const nextContentMessages = this.messages[0]?.role === 'system' ? this.messages.slice(1) : [...this.messages];
    event.applied = true;
    event.phase = 'completed';
    event.observedAt = new Date().toISOString();
    event.durationMs = Date.now() - compressStartedAt;
    const postProjection = this.contextPayloadProjector.projectForProvider(nextContentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildNormalTrimOptions(),
    });
    event.messageCharsAfter = Math.max(0, postProjection.metrics.preparedChars - effectiveSystemPrompt.length);
    event.totalCharsAfter = postProjection.metrics.preparedChars;
    event.projectedCharsAfter = postProjection.metrics.projectedChars;
    event.providerPayloadCharsAfter = postProjection.metrics.preparedChars;
    event.postCompactValidation = 'provider_payload';
    summaryMessage.metadata = {
      ...(summaryMessage.metadata ?? {}),
      compressedSize: event.totalCharsAfter,
    };
    event.postCompressRatio = event.totalCharsAfter / Math.max(1, this.contextWindowChars);
    event.willRetriggerImmediately = event.totalCharsAfter >= triggerThresholdChars;
    event.willRetriggerNextTurn = postProjection.metrics.preparedChars >= triggerThresholdChars;
    event.progressPercent = 100;
    this.lastCompletedPrecompressEvent = { ...event };
    agentLogger.info(
      `[MiniMaxAgent] Context precompress completed: durationMs=${event.durationMs} before=${event.totalCharsBefore} after=${event.totalCharsAfter} ratio=${event.postCompressRatio.toFixed(3)} chunks=${event.chunkCount} willRetriggerImmediately=${event.willRetriggerImmediately}`
    );
    if ((event.durationMs ?? 0) > 180_000) {
      agentLogger.warn(`[MiniMaxAgent] Context precompress exceeded guardrail: durationMs=${event.durationMs}`);
    }
    return event;
  }

  private async refreshLastPrecompressValidation(effectiveSystemPrompt: string): Promise<void> {
    const lastEvent = this.lastCompletedPrecompressEvent;
    if (!lastEvent?.applied) {
      return;
    }
    const contentMessages = this.messages[0]?.role === 'system' ? this.messages.slice(1) : [...this.messages];
    const postProjection = this.contextPayloadProjector.projectForProvider(contentMessages, {
      systemPrompt: effectiveSystemPrompt,
      trimOptions: this.buildNormalTrimOptions(),
    });
    const nextEvent: ContextPrecompressEvent = {
      ...lastEvent,
      observedAt: new Date().toISOString(),
      phase: 'completed',
      messageCharsAfter: Math.max(0, postProjection.metrics.preparedChars - effectiveSystemPrompt.length),
      totalCharsAfter: postProjection.metrics.preparedChars,
      projectedCharsAfter: postProjection.metrics.projectedChars,
      providerPayloadCharsAfter: postProjection.metrics.preparedChars,
      postCompactValidation: 'provider_payload_after_turn',
      postCompressRatio: postProjection.metrics.preparedChars / Math.max(1, this.contextWindowChars),
      willRetriggerImmediately: postProjection.metrics.preparedChars >= this.contextPrecompressTriggerThresholdChars,
      willRetriggerNextTurn: postProjection.metrics.preparedChars >= this.contextPrecompressTriggerThresholdChars,
    };
    this.lastCompletedPrecompressEvent = nextEvent;
    agentLogger.info(
      `[MiniMaxAgent] Context precompress post-turn validation: providerPayloadChars=${nextEvent.providerPayloadCharsAfter} ratio=${(nextEvent.postCompressRatio ?? 0).toFixed(3)} willRetriggerNextTurn=${nextEvent.willRetriggerNextTurn}`
    );
    await this.emitContextPrecompress(nextEvent, 'completed', { swallowErrors: true });
  }

  private hashMessages(messages: Message[]): string {
    const normalized = messages
      .map((message) =>
        JSON.stringify({
          role: message.role,
          content: this.messageTextContent(message.content),
          toolCallId: message.toolCallId ?? '',
          name: message.name ?? '',
        })
      )
      .join('\n');
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  private contextCompactionConfigFingerprint(): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          contextWindowChars: this.contextWindowChars,
          triggerRatio: this.contextPrecompressTriggerRatio,
          keepLlmRounds: this.contextPrecompressKeepLlmRounds,
          chunkChars: this.contextPrecompressChunkChars,
          retry: this.contextPrecompressRetry,
        })
      )
      .digest('hex');
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
    const hasSystem = this.messages.length > 0 && this.messages[0]?.role === 'system';
    const baseSystemPrompt =
      hasSystem && typeof this.messages[0]?.content === 'string' ? this.messages[0].content : undefined;
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
    await Promise.resolve(this.callback?.onContextPrecompress?.(precompressEvent));

    const contentMessages = hasSystem ? this.messages.slice(1) : [...this.messages];
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
        `[MiniMaxAgent] Provider payload projected: originalChars=${payloadProjection.metrics.originalChars} projectedChars=${payloadProjection.metrics.projectedChars} preparedChars=${payloadProjection.metrics.preparedChars} toolRefs=${payloadProjection.metrics.toolResultRefReplacements} inlineToolTruncations=${payloadProjection.metrics.oversizedInlineToolTruncations} trimRemoved=${payloadProjection.metrics.trimRemovedCount} trimTruncated=${payloadProjection.metrics.trimTruncatedCount} protocolCorrections=${payloadProjection.metrics.protocolCorrectionCount}`
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
    return {
      maxTotalChars: Math.max(40000, this.contextWindowChars - 10000),
      keepLatestCount: 24,
      maxToolChars: 4000,
      maxNonToolChars: 12000,
    };
  }

  private buildProviderProjectionTrimOptions(maxTotalChars?: number): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    const normal = this.buildNormalTrimOptions();
    const requestedMax =
      typeof maxTotalChars === 'number' && Number.isFinite(maxTotalChars)
        ? Math.max(1, Math.floor(maxTotalChars))
        : normal.maxTotalChars;
    return {
      ...normal,
      maxTotalChars: Math.min(normal.maxTotalChars, requestedMax),
    };
  }

  private buildForcedTrimOptions(): {
    maxTotalChars: number;
    keepLatestCount: number;
    maxToolChars: number;
    maxNonToolChars: number;
  } {
    return {
      maxTotalChars: this.contextOverflowForcedTrimChars,
      keepLatestCount: 14,
      maxToolChars: 2000,
      maxNonToolChars: 6000,
    };
  }

  private applyForcedTrimToMessages(): {
    beforeMessageCount: number;
    beforeChars: number;
    afterMessageCount: number;
    afterChars: number;
  } {
    const beforeMessageCount = this.messages.length;
    const beforeChars = this.estimateTotalChars(this.messages);
    const forcedTrim = trimMessagesForContextWindow(this.messages, this.buildForcedTrimOptions());
    this.messages = sanitizeMessagesForToolProtocol(forcedTrim.messages).messages;
    return {
      beforeMessageCount,
      beforeChars,
      afterMessageCount: this.messages.length,
      afterChars: this.estimateTotalChars(this.messages),
    };
  }

  private async emitContextOverflowEvent(event: ContextOverflowEvent): Promise<void> {
    this.totalOverflowSnapshots += 1;
    agentLogger.contextOverflowSnapshot(
      event.stage,
      event.overflowCountInTurn,
      this.totalOverflowSnapshots,
      event.decision,
      event.beforeChars ?? 0
    );
    await Promise.resolve(this.callback?.onContextOverflow?.(event));
  }

  private truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
  }

  private resolveToolResultCharLimit(toolName?: string): number {
    const normalized = (toolName ?? '').trim().toLowerCase();
    if (normalized === 'read_file') {
      return 6000;
    }
    if (normalized === 'read_tool_result') {
      return 12000;
    }
    return Agent.DEFAULT_TOOL_RESULT_CHAR_LIMIT;
  }

  private async materializeToolResultIfNeeded(input: {
    toolName: string;
    toolCallId: string;
    content: string;
  }): Promise<{ content: string; artifact?: ToolResultArtifactRef }> {
    if (!this.materializeToolResultArtifact) {
      return { content: input.content };
    }
    const normalizedToolName = input.toolName.trim().toLowerCase();
    if (normalizedToolName === 'read_file' || normalizedToolName === 'read_tool_result') {
      return { content: input.content };
    }
    return this.materializeToolResultArtifact({
      ...input,
      thresholdChars: this.resolveToolResultCharLimit(input.toolName),
      previewChars: Math.min(3000, this.resolveToolResultCharLimit(input.toolName)),
    });
  }

  private sanitizeToolMessageBeforeAppend(message: Message): Message {
    if (message.role !== 'tool') {
      return message;
    }
    const maxChars = this.resolveToolResultCharLimit(message.name);
    const original = this.messageTextContent(message.content);
    if (original.length <= maxChars) {
      return message;
    }
    const normalizedToolName = (message.name ?? '(unknown)').trim() || '(unknown)';
    const header = `[TOOL_RESULT_TRUNCATED tool=${normalizedToolName} original_chars=${original.length} kept_chars=${maxChars}]`;
    const bodyBudget = maxChars - header.length - 1;
    const body = bodyBudget > 0 ? original.slice(0, bodyBudget) : '';
    const finalContent = body.length > 0 ? `${header}\n${body}` : header.slice(0, maxChars);
    return {
      ...message,
      content: finalContent,
    };
  }

  private compactCompletedToolHistory(messages: Message[]): {
    messages: Message[];
    compactedToolCallChains: number;
    compactedToolMessages: number;
  } {
    if (messages.length <= 3) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const hasSystem = messages[0]?.role === 'system';
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const tailWindow = Math.min(20, body.length);
    const splitIndex = Math.max(0, body.length - tailWindow);
    const head = body.slice(0, splitIndex);
    const tail = body.slice(splitIndex);

    const compactedHead: Message[] = [];
    const summaries: string[] = [];
    let compactedToolCallChains = 0;
    let compactedToolMessages = 0;

    for (let i = 0; i < head.length; i += 1) {
      const message = head[i];
      if (message.role !== 'assistant' || !message.toolCalls || message.toolCalls.length === 0) {
        compactedHead.push(message);
        continue;
      }

      const expectedToolCalls = message.toolCalls;
      const expectedIds = new Set(
        expectedToolCalls.map((toolCall) => toolCall.id?.trim()).filter((id): id is string => Boolean(id))
      );
      if (expectedIds.size !== expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const alignedResults: Message[] = [];
      let cursor = i + 1;
      while (cursor < head.length && head[cursor].role === 'tool') {
        alignedResults.push(head[cursor]);
        cursor += 1;
      }
      if (alignedResults.length < expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const matchIds = new Set<string>();
      let aligned = true;
      for (const toolMessage of alignedResults.slice(0, expectedToolCalls.length)) {
        const toolCallId = toolMessage.toolCallId?.trim();
        if (!toolCallId || !expectedIds.has(toolCallId) || matchIds.has(toolCallId)) {
          aligned = false;
          break;
        }
        matchIds.add(toolCallId);
      }
      if (!aligned || matchIds.size !== expectedIds.size) {
        compactedHead.push(message);
        continue;
      }

      const chainResults = alignedResults.slice(0, expectedToolCalls.length);
      const resultSummary = chainResults
        .map((toolMessage) => this.truncate(this.messageTextContent(toolMessage.content).replace(/\s+/g, ' '), 100))
        .join(' | ');
      const toolNames = expectedToolCalls.map((toolCall) => toolCall.function.name).join(', ');
      summaries.push(
        `tools=[${toolNames}] results=${this.truncate(resultSummary.length > 0 ? resultSummary : '(empty)', 220)}`
      );

      compactedToolCallChains += 1;
      compactedToolMessages += chainResults.length + 1;
      i = cursor - 1;
    }

    if (compactedToolCallChains === 0) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const summaryPreview = summaries.slice(0, 12).join('\n- ');
    const overflowCount = Math.max(0, summaries.length - 12);
    const summaryMessage: Message = {
      role: 'assistant',
      content:
        `[TOOL_HISTORY_COMPACTED] compacted_chains=${compactedToolCallChains}, compacted_messages=${compactedToolMessages}\n` +
        `- ${summaryPreview}\n` +
        (overflowCount > 0 ? `- ...and ${overflowCount} more compacted chain(s).` : '') +
        '\nKeep only latest tool protocol details in subsequent reasoning.',
    };

    const nextMessages: Message[] = [];
    if (systemMessage) {
      nextMessages.push(systemMessage);
    }
    nextMessages.push(...compactedHead, summaryMessage, ...tail);
    return { messages: nextMessages, compactedToolCallChains, compactedToolMessages };
  }

  private toPersistedMessages(messages: Message[]): PersistedMessage[] {
    const now = new Date().toISOString();
    return messages.map((message, index) => ({
      id: `msg-${index + 1}`,
      role: message.role,
      content: this.messageTextContent(message.content),
      timestamp: now,
      thinking: message.thinking,
      thinkingSignature: message.thinkingSignature,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
      metadata: message.metadata,
    }));
  }

  private async compressForMaxTokensRecovery(messages: Message[]): Promise<{
    messages: Message[];
    compressionMode: 'llm_compressor' | 'deterministic_trim' | 'none';
    compressionError?: string;
  }> {
    if (messages.length <= 2) {
      return { messages: [...messages], compressionMode: 'none' };
    }

    const hasSystem = messages[0]?.role === 'system';
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const keepTail = Math.min(16, body.length);
    const splitIndex = Math.max(0, body.length - keepTail);
    const olderMessages = body.slice(0, splitIndex);
    const tailMessages = body.slice(splitIndex);

    if (olderMessages.length > 2) {
      try {
        const compressed = await this.contextCompressor.compress(this.toPersistedMessages(olderMessages));
        if (compressed.success && compressed.compressedContent) {
          const summaryMessage: Message = {
            role: 'assistant',
            content:
              '[CONTEXT_COMPRESSED] Earlier history summary:\n' +
              this.truncate(compressed.compressedContent, 10000) +
              '\nUse this summary as canonical history for older steps.',
          };
          const nextMessages: Message[] = [];
          if (systemMessage) {
            nextMessages.push(systemMessage);
          }
          nextMessages.push(summaryMessage, ...tailMessages);
          return { messages: nextMessages, compressionMode: 'llm_compressor' };
        }
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: 'deterministic_trim',
          compressionError: compressed.error ?? 'llm_compressor_returned_empty',
        };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: 'deterministic_trim',
          compressionError: err,
        };
      }
    }

    return {
      messages: this.applyDeterministicTrim(messages),
      compressionMode: 'deterministic_trim',
    };
  }

  private applyDeterministicTrim(messages: Message[]): Message[] {
    const trimBudget = Math.max(24000, Math.min(120000, Math.floor(this.tokenLimit * 2)));
    return trimMessagesForContextWindow(messages, {
      maxTotalChars: trimBudget,
      keepLatestCount: 16,
      maxToolChars: 2000,
      maxNonToolChars: 6000,
    }).messages;
  }

  private buildMaxTokensContinuationPrompt(attempt: number, maxAttempts: number): string {
    return [
      '[MAX_TOKENS_RECOVERY]',
      `continuation_attempt=${attempt}/${maxAttempts}`,
      'Continue from the latest valid state with concise progress only.',
      'Do not repeat prior analysis; prioritize next actionable step.',
    ].join('\n');
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
    this.pendingSummaryApplyRequest = null;
    this.checkpointCounter = 0;
    this.totalOverflowSnapshots = 0;
    this.lastCompletedPrecompressEvent = null;

    if (sessionId) {
      this.sessionId = sessionId;
    }

    // Check API Key before processing
    if (!this.llm) {
      this.isRunning = false;
      return {
        content: '⚠️ API Key not configured.\n\nPlease configure your MiniMax API Key in the settings (⚙️ icon) and try again.\n\nYou can get your API Key from: https://platform.minimaxi.com',
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

        let response: LLMResponse | undefined;
        let recoveredToolProtocol = false;
        let overflowCountInTurn = 0;
        let pendingPreparedInput:
          | Awaited<ReturnType<Agent['prepareLlmInput']>>
          | null = null;
        let pendingPrecompressMode: 'light' | 'aggressive' | 'disabled' = 'light';
        let pendingForcePrecompress = false;
        let pendingKeepLlmRoundsOverride: number | undefined = undefined;
        let snapshotStage: 'initial' | 'overflow_retry_after_compress' | 'overflow_retry_after_forced_trim' =
          'initial';
        let trimOptions = this.buildNormalTrimOptions();
        let llmAttempt = 0;
        let transportRetryCount = 0;
        let activeSystemPrompt = '';

        while (!response) {
          const preparedInput =
            pendingPreparedInput ??
            (await this.prepareLlmInput({
              precompressMode: pendingPrecompressMode,
              forcePrecompress: pendingForcePrecompress,
              keepLlmRoundsOverride: pendingKeepLlmRoundsOverride,
            }));
          pendingPreparedInput = null;
          pendingPrecompressMode = 'disabled';
          pendingForcePrecompress = false;
          pendingKeepLlmRoundsOverride = undefined;

          const systemPrompt = preparedInput.systemPrompt;
          activeSystemPrompt = systemPrompt ?? '';
          const contentMessages = preparedInput.contentMessages;
          const beforeChars = this.estimateTotalChars(contentMessages) + (systemPrompt?.length ?? 0);
          const beforeMessageCount = contentMessages.length;
          llmAttempt += 1;
          let streamedVisibleOutput = false;

          try {
            const turnRuntime = this.llm.getRuntimeConfig?.();
            agentLogger.info(
              `[MiniMaxAgent] LLM turn start: step=${step + 1} attempt=${llmAttempt} profile=${turnRuntime?.profileId ?? 'unknown'} provider=${turnRuntime?.provider ?? 'unknown'} model=${turnRuntime?.model ?? 'unknown'} reasoning=${turnRuntime?.reasoningPreset ?? 'unknown'}`
            );
            if (systemPrompt) {
              agentLogger.debug(`Prepared system prompt, length: ${systemPrompt.length}`);
            }
            response = await this.llm.generateWithCallbacks(
              contentMessages,
              {
                onThinking: (thinking) => {
                  streamedVisibleOutput = true;
                  agentLogger.llmStreamEvent('thinking', thinking);
                  this.callback?.onThinking?.(thinking);
                },
                onText: (text) => {
                  streamedVisibleOutput = true;
                  agentLogger.llmStreamEvent('text', text);
                  this.callback?.onMessage?.('assistant', text);
                },
                onToolUse: (_id, name, input) => {
                  streamedVisibleOutput = true;
                  agentLogger.llmStreamEvent('tool_use', `Tool: ${name}`);
                  this.callback?.onToolCall?.(name, input, _id);
                },
                onComplete: () => {
                  agentLogger.debug('LLM onComplete');
                },
              },
              this.tools.getSchemas(),
              systemPrompt,
              {
                trimOptions,
                snapshotStage,
              }
            );
            agentLogger.debug('generateWithCallbacks returned');
            consecutiveToolCallProtocolFailures = 0;
          } catch (error) {
            const errorRaw = error instanceof Error ? error.message : String(error);
            if (isMiniMaxToolResultIdNotFoundError(error)) {
              const missingToolCallId = extractMissingToolCallId(errorRaw);
              const matchedToolName = this.findToolNameById(missingToolCallId);
              const nextCount = consecutiveToolCallProtocolFailures + 1;
              const recoveryMessage = this.buildToolCallFailedMessage({
                errorRaw,
                missingToolCallId,
                matchedToolName,
                consecutiveFailureCount: nextCount,
              });
              this.messages.push({
                role: 'user',
                content: recoveryMessage,
              });
              this.callback?.onMessage?.('system', recoveryMessage);
              this.callback?.onProtocolRecovery?.({
                kind: nextCount >= 2 ? 'toolcall_failed_escalated' : 'toolcall_failed_injected',
                errorRaw,
                missingToolCallId,
                matchedToolName,
                consecutiveFailureCount: nextCount,
                nextAction: 'Issue a fresh tool call, then continue reporting progress.',
              });
              consecutiveToolCallProtocolFailures = nextCount;
              if (nextCount >= 2) {
                throw new Error(`[TOOLCALL_FAILED_ESCALATED] ${errorRaw}`);
              }
              recoveredToolProtocol = true;
              break;
            }

            if (!isMiniMaxContextWindowExceededError(error)) {
              if (
                !streamedVisibleOutput &&
                isRetriableTransportError(error) &&
                transportRetryCount < Agent.DEFAULT_TRANSPORT_RETRY_MAX_ATTEMPTS
              ) {
                transportRetryCount += 1;
                agentLogger.warn(
                  `[MiniMaxAgent] Retrying LLM transport before first visible output: step=${step + 1} attempt=${llmAttempt} retry=${transportRetryCount} error=${errorRaw}`
                );
                continue;
              }
              throw error;
            }

            overflowCountInTurn += 1;
            const shouldForceTrim = overflowCountInTurn >= this.contextOverflowMaxErrorsBeforeTrim;
            const decision = shouldForceTrim
              ? 'retry_with_forced_trim'
              : 'retry_with_forced_compress';
            await this.emitContextOverflowEvent({
              observedAt: new Date().toISOString(),
              step: step + 1,
              attempt: llmAttempt,
              overflowCountInTurn,
              stage: 'overflow_detected',
              decision,
              errorRaw,
              contextWindowChars: this.contextWindowChars,
              precompressTriggerRatio: this.contextPrecompressTriggerRatio,
              precompressTriggerThresholdChars: this.contextPrecompressTriggerThresholdChars,
              forcedTrimChars: this.contextOverflowForcedTrimChars,
              maxErrorsBeforeTrim: this.contextOverflowMaxErrorsBeforeTrim,
              beforeMessageCount,
              beforeChars,
              profileRuntimeSource: preparedInput.profileRuntime.sourceName,
              profileRuntimePath: preparedInput.profileRuntime.sourcePath,
              profileRuntimeFailureReason: preparedInput.profileRuntime.failureReason,
              notes: `snapshot_stage=${snapshotStage}`,
            });

            if (!shouldForceTrim) {
              const aggressiveKeepRounds = Math.max(
                1,
                Math.min(this.contextPrecompressKeepLlmRounds, Agent.DEFAULT_OVERFLOW_AGGRESSIVE_KEEP_LLM_ROUNDS)
              );
              const forcedCompressed = await this.prepareLlmInput({
                precompressMode: 'aggressive',
                forcePrecompress: true,
                keepLlmRoundsOverride: aggressiveKeepRounds,
              });
              pendingPreparedInput = forcedCompressed;
              pendingPrecompressMode = 'disabled';
              snapshotStage = 'overflow_retry_after_compress';
              trimOptions = this.buildNormalTrimOptions();
              const forcedEvent = forcedCompressed.precompressEvent;
              await this.emitContextOverflowEvent({
                observedAt: new Date().toISOString(),
                step: step + 1,
                attempt: llmAttempt,
                overflowCountInTurn,
                stage: 'forced_compress',
                decision: 'retry_with_forced_compress',
                errorRaw,
                contextWindowChars: this.contextWindowChars,
                precompressTriggerRatio: this.contextPrecompressTriggerRatio,
                precompressTriggerThresholdChars: this.contextPrecompressTriggerThresholdChars,
                forcedTrimChars: this.contextOverflowForcedTrimChars,
                maxErrorsBeforeTrim: this.contextOverflowMaxErrorsBeforeTrim,
                beforeMessageCount,
                beforeChars,
                afterMessageCount: forcedCompressed.contentMessages.length,
                afterChars: forcedEvent.totalCharsAfter,
                tailRoundsKept: forcedEvent.keepLlmRoundsApplied,
                chunkCount: forcedEvent.chunkCount,
                retryCount: forcedEvent.retryCount,
                profileRuntimeSource: forcedCompressed.profileRuntime.sourceName,
                profileRuntimePath: forcedCompressed.profileRuntime.sourcePath,
                profileRuntimeFailureReason: forcedCompressed.profileRuntime.failureReason,
                notes: forcedEvent.failureReason,
              });
              continue;
            }

            if (overflowCountInTurn === this.contextOverflowMaxErrorsBeforeTrim) {
              const trimStats = this.applyForcedTrimToMessages();
              const preparedAfterTrim = await this.prepareLlmInput({
                precompressMode: 'disabled',
              });
              pendingPreparedInput = preparedAfterTrim;
              pendingPrecompressMode = 'disabled';
              snapshotStage = 'overflow_retry_after_forced_trim';
              trimOptions = this.buildForcedTrimOptions();
              await this.emitContextOverflowEvent({
                observedAt: new Date().toISOString(),
                step: step + 1,
                attempt: llmAttempt,
                overflowCountInTurn,
                stage: 'forced_trim',
                decision: 'retry_with_forced_trim',
                errorRaw,
                contextWindowChars: this.contextWindowChars,
                precompressTriggerRatio: this.contextPrecompressTriggerRatio,
                precompressTriggerThresholdChars: this.contextPrecompressTriggerThresholdChars,
                forcedTrimChars: this.contextOverflowForcedTrimChars,
                maxErrorsBeforeTrim: this.contextOverflowMaxErrorsBeforeTrim,
                beforeMessageCount: trimStats.beforeMessageCount,
                beforeChars: trimStats.beforeChars,
                afterMessageCount: trimStats.afterMessageCount,
                afterChars: trimStats.afterChars,
                profileRuntimeSource: preparedAfterTrim.profileRuntime.sourceName,
                profileRuntimePath: preparedAfterTrim.profileRuntime.sourcePath,
                profileRuntimeFailureReason: preparedAfterTrim.profileRuntime.failureReason,
                notes: `forced_trim_max_total_chars=${this.contextOverflowForcedTrimChars}`,
              });
              continue;
            }

            await this.emitContextOverflowEvent({
              observedAt: new Date().toISOString(),
              step: step + 1,
              attempt: llmAttempt,
              overflowCountInTurn,
              stage: 'forced_trim_failed',
              decision: 'abort',
              errorRaw,
              contextWindowChars: this.contextWindowChars,
              precompressTriggerRatio: this.contextPrecompressTriggerRatio,
              precompressTriggerThresholdChars: this.contextPrecompressTriggerThresholdChars,
              forcedTrimChars: this.contextOverflowForcedTrimChars,
              maxErrorsBeforeTrim: this.contextOverflowMaxErrorsBeforeTrim,
              beforeMessageCount,
              beforeChars,
              profileRuntimeSource: preparedInput.profileRuntime.sourceName,
              profileRuntimePath: preparedInput.profileRuntime.sourcePath,
              profileRuntimeFailureReason: preparedInput.profileRuntime.failureReason,
              notes: `abort_after_overflow_count=${overflowCountInTurn}`,
            });
            throw error;
          }
        }

        if (recoveredToolProtocol) {
          step++;
          continue;
        }

        if (!response) {
          throw new Error('LLM response is unavailable after overflow recovery attempts.');
        }

        if (response.usage) {
          lastUsage = response.usage;
          this.lastUsage = response.usage;
        }

        agentLogger.info(
          `[MiniMaxAgent] LLM response received: finishReason=${response.finishReason ?? 'unknown'} toolCalls=${response.toolCalls?.length ?? 0} contentChars=${response.content.length} thinkingChars=${response.thinking?.length ?? 0} step=${step + 1}`
        );

        const llmRuntime = this.llm.getRuntimeConfig?.();
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
                thinkingComplete: Boolean(response.thinking && response.thinkingSignature),
              }
            : undefined,
        };
        if (response.toolCalls && response.toolCalls.length > 0) {
          this.messages.push(this.withCheckpointMetadata(assistantMsg, 'assistant_toolcall'));
        } else {
          this.messages.push(assistantMsg);
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

        if (response.toolCalls && response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            if (this.abortController.signal.aborted) {
              return this.completeCancelledRun({
                step,
                usage: lastUsage,
                recoveredFromMaxTokens,
                maxTokensRecoveryAttempt,
                maxTokensEvents,
              });
            }
            const { name, arguments: args } = toolCall.function;
            // Note: onToolCall is already called via streaming callback in onToolUse
            const result = await this.tools.execute(name, args);
            const rawToolContent = result.success ? result.content : `Error: ${result.error}`;
            let callbackToolResult = result;
            const toolMsg: Message = this.sanitizeToolMessageBeforeAppend({
              role: 'tool',
              content: rawToolContent,
              toolCallId: toolCall.id,
              name,
            });
            this.messages.push(toolMsg);
            if (result.success) {
              const materialized = await this.materializeToolResultIfNeeded({
                toolName: name,
                toolCallId: toolCall.id,
                content: rawToolContent,
              });
              const finalizedToolMsg = this.sanitizeToolMessageBeforeAppend({
                ...toolMsg,
                content: materialized.content,
                metadata: materialized.artifact
                  ? {
                      toolResultArtifact: materialized.artifact,
                    }
                  : undefined,
              });
              toolMsg.content = finalizedToolMsg.content;
              toolMsg.metadata = finalizedToolMsg.metadata;
              callbackToolResult = {
                ...result,
                content: messageTextContent(finalizedToolMsg.content),
              };
            }
            this.callback?.onToolResult?.(name, callbackToolResult);
          }
          this.applyPendingSummaryIfNeeded();
          await Promise.resolve(
            this.callback?.onReplayCheckpoint?.({
              observedAt: new Date().toISOString(),
              step: step + 1,
              messages: this.getMessages().filter((message) => message.role !== 'system'),
            })
          );
        }
        await this.refreshLastPrecompressValidation(activeSystemPrompt);
        const currentStep = step + 1;

        if (response.finishReason === 'max_tokens') {
          consecutiveProgressOnlyTurnStops = 0;
          const preCompressMessageCount = this.messages.length;
          const preCompressChars = this.estimateTotalChars(this.messages);
          const compacted = this.compactCompletedToolHistory(this.messages);
          this.messages = compacted.messages;
          const compressed = await this.compressForMaxTokensRecovery(this.messages);
          this.messages = compressed.messages;

          const attempt = maxTokensRecoveryAttempt + 1;
          const recovered = attempt <= this.maxTokensRecoveryMaxAttempts;
          if (recovered) {
            recoveredFromMaxTokens = true;
            this.messages.push({
              role: 'user',
              content: this.buildMaxTokensContinuationPrompt(attempt, this.maxTokensRecoveryMaxAttempts),
            });
          }

          const event: MaxTokensRecoveryEvent = {
            observedAt: new Date().toISOString(),
            step: currentStep,
            attempt,
            maxAttempts: this.maxTokensRecoveryMaxAttempts,
            recovered,
            finishReason: 'max_tokens',
            usage: lastUsage,
            preCompressMessageCount,
            preCompressChars,
            postCompressMessageCount: this.messages.length,
            postCompressChars: this.estimateTotalChars(this.messages),
            compactedToolCallChains: compacted.compactedToolCallChains,
            compactedToolMessages: compacted.compactedToolMessages,
            compressionMode: compressed.compressionMode,
            compressionError: compressed.compressionError,
            continuationInjected: recovered,
          };
          maxTokensEvents.push(event);
          await Promise.resolve(this.callback?.onMaxTokensRecovery?.(event));
          maxTokensRecoveryAttempt = attempt;
          if (recovered) {
            step = currentStep;
            continue;
          }

          const meta: AgentCompletionMeta = {
            finishReason: response.finishReason,
            usage: lastUsage,
            step: currentStep,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          };
          this.callback?.onComplete?.(lastResult, response.finishReason, meta);
          return {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          };
        }

        if (this.progressOnlyRecoveryEnabled && this.shouldRecoverProgressOnlyTurnStop(response)) {
          const nextCount = consecutiveProgressOnlyTurnStops + 1;
          const maxAttempts = Agent.DEFAULT_PROGRESS_ONLY_RECOVERY_MAX_ATTEMPTS;
          if (nextCount > maxAttempts) {
            lastResult = this.buildProgressOnlyStallMessage(nextCount);
            this.callback?.onProtocolRecovery?.({
              kind: 'progress_only_stall',
              errorRaw: response.content,
              consecutiveFailureCount: nextCount,
              nextAction: 'Abort this turn with an explicit protocol stall result.',
            });
            const meta: AgentCompletionMeta = {
              finishReason: 'protocol_stall',
              usage: lastUsage,
              step: currentStep,
              recoveredFromMaxTokens,
              maxTokensRecoveryAttempt,
              maxTokensEvents,
            };
            this.callback?.onComplete?.(lastResult, 'protocol_stall', meta);
            return {
              content: lastResult,
              finishReason: 'protocol_stall',
              step: currentStep,
              usage: lastUsage,
              recoveredFromMaxTokens,
              maxTokensRecoveryAttempt,
              maxTokensEvents,
            };
          }

          const recoveryMessage = this.buildProgressOnlyContinuationPrompt(nextCount, maxAttempts);
          this.messages.push({
            role: 'user',
            content: recoveryMessage,
          });
          this.callback?.onMessage?.('system', recoveryMessage);
          this.callback?.onProtocolRecovery?.({
            kind: 'progress_only_continuation_injected',
            errorRaw: response.content,
            consecutiveFailureCount: nextCount,
            nextAction: 'Continue in the same turn and take concrete action now.',
          });
          consecutiveProgressOnlyTurnStops = nextCount;
          step = currentStep;
          continue;
        }

        consecutiveProgressOnlyTurnStops = 0;

        if (this.isTurnCompleteFinishReason(response.finishReason)) {
          agentLogger.info(
            `[MiniMaxAgent] Completing turn: finishReason=${response.finishReason} step=${currentStep} contentChars=${lastResult.length}`
          );
          const meta: AgentCompletionMeta = {
            finishReason: response.finishReason,
            usage: lastUsage,
            step: currentStep,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          };
          this.callback?.onComplete?.(lastResult, response.finishReason, meta);
          return {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
          };
        }

        if (response.finishReason !== 'tool_use') {
          agentLogger.info(
            `[MiniMaxAgent] Continue turn because finishReason=${response.finishReason ?? 'unknown'} is not end_turn`
          );
        }

        step = currentStep;
      }

      if (step >= this.maxSteps) {
        lastResult = `Task couldn't be completed after ${this.maxSteps} steps.`;
      }

      const meta: AgentCompletionMeta = {
        finishReason: 'max_steps',
        usage: lastUsage,
        step,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents,
      };
      this.callback?.onComplete?.(lastResult, 'max_steps', meta);
      return {
        content: lastResult,
        finishReason: 'max_steps',
        step,
        usage: lastUsage,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents,
      };
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
    this.messages = [];
    this.sessionId = null;
    this.pendingSummaryApplyRequest = null;
    this.checkpointCounter = 0;
    this.totalOverflowSnapshots = 0;
    this.initializeMessages();
  }

  setWorkspaceDir(dir: string): void {
    this.workspaceDir = path.resolve(dir);
    this.ensureWorkspace();
    this.initializeMessages();
  }
}


