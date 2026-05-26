import { messageTextContent, sanitizeMessagesForToolProtocol } from '../llm/index.js';
import type {
  AgentCallback,
  Message,
  ResolvedLlmRuntimeConfig,
  Session,
  SummaryApplyRequest,
  SummaryCheckpoint,
} from '../types.js';
import { estimateAgentMessagesChars, truncateForAgentLog } from './agent-message-utils.js';

export interface MessageStoreOptions {
  systemPrompt: string;
  getWorkspaceDir: () => string;
  getMcpToolDescriptions: () => string | undefined;
  getCallback: () => AgentCallback | undefined;
  getLlmRuntime: () => ResolvedLlmRuntimeConfig | undefined;
  clearPromptUsageAnchor: () => void;
}

export class MessageStore {
  messages: Message[] = [];
  sessionId: string | null = null;
  private checkpointCounter = 0;
  private pendingSummaryApplyRequest: SummaryApplyRequest | null = null;

  constructor(private readonly options: MessageStoreOptions) {}

  resetRunState(): void {
    this.pendingSummaryApplyRequest = null;
    this.checkpointCounter = 0;
  }

  initializeMessages(): void {
    this.messages = [{ role: 'system', content: this.buildSystemPrompt() }];
    this.options.clearPromptUsageAnchor();
  }

  ensureSystemPrompt(): void {
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({ role: 'system', content: this.buildSystemPrompt() });
    }
  }

  addUserMessage(content: string): void {
    this.messages.push(this.withCheckpointMetadata({ role: 'user', content }, 'user_prompt'));
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    const hasSystemPrompt = this.messages.length > 0 && this.messages[0].role === 'system';
    const incomingHasSystem = messages.length > 0 && messages[0].role === 'system';
    this.messages = hasSystemPrompt && !incomingHasSystem ? [this.messages[0], ...messages] : [...messages];
    this.pendingSummaryApplyRequest = null;
    this.options.clearPromptUsageAnchor();
    this.syncCheckpointCounterFromMessages();
  }

  getSession(): Session {
    return {
      id: this.sessionId ?? '',
      messages: this.messages,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaceDir: this.options.getWorkspaceDir(),
      additionalDirs: [],
    };
  }

  setSession(session: Session): void {
    this.sessionId = session.id;
    this.messages = [...session.messages];
    this.pendingSummaryApplyRequest = null;
    this.options.clearPromptUsageAnchor();
    this.syncCheckpointCounterFromMessages();
  }

  nextCheckpointId(): string {
    this.checkpointCounter += 1;
    return `ckpt-${this.checkpointCounter}`;
  }

  withCheckpointMetadata(
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

  async saveInterruptedStreamCheckpoint(input: { step: number; content: string }): Promise<boolean> {
    if (input.content.trim().length === 0) {
      return false;
    }
    const llmRuntime = this.options.getLlmRuntime();
    const assistantMsg: Message = {
      role: 'assistant',
      content: input.content,
      metadata: llmRuntime
        ? {
            llmProviderProfileId: llmRuntime.profileId,
            llmProvider: llmRuntime.provider,
            llmModel: llmRuntime.model,
          }
        : undefined,
    };
    this.messages.push(assistantMsg);
    await Promise.resolve(
      this.options.getCallback()?.onReplayCheckpoint?.({
        observedAt: new Date().toISOString(),
        step: input.step,
        messages: this.getMessages().filter((message) => message.role !== 'system'),
      })
    );
    return true;
  }

  listSummaryCheckpoints(limit: number): SummaryCheckpoint[] {
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
        preview: truncateForAgentLog(messageTextContent(message.content).replace(/\s+/g, ' '), 180),
      });
      if (checkpoints.length >= normalizedLimit) {
        break;
      }
    }
    return checkpoints;
  }

  enqueueSummaryApply(request: SummaryApplyRequest): { accepted: boolean; availableCheckpoints: number } {
    const checkpoints = this.listSummaryCheckpoints(1000);
    const exists = checkpoints.some((item) => item.checkpointId === request.checkpointId);
    if (!exists) {
      return {
        accepted: false,
        availableCheckpoints: checkpoints.length,
      };
    }
    this.pendingSummaryApplyRequest = { ...request };
    this.options.getCallback()?.onSummaryMessagesAccepted?.({
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

  findToolNameById(toolCallId: string | undefined): string | undefined {
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

  buildToolCallFailedMessage(input: {
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

  applyPendingSummaryIfNeeded(): void {
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
    const beforeChars = estimateAgentMessagesChars(this.messages);
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

    this.messages = sanitizeMessagesForToolProtocol([...preservedHead, ...preservedTail, anchor]).messages;
    const afterMessages = this.messages.length;
    const afterChars = estimateAgentMessagesChars(this.messages);
    this.options.getCallback()?.onSummaryMessagesApplied?.({
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

  syncCheckpointCounterFromMessages(): void {
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

  findCheckpointMessageIndex(checkpointId: string): number {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const id = this.messages[i]?.metadata?.checkpointId;
      if (id === checkpointId) {
        return i;
      }
    }
    return -1;
  }

  private buildSystemPrompt(): string {
    let prompt = this.options.systemPrompt;
    if (!prompt.includes('Current Workspace')) {
      prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.options.getWorkspaceDir()}\`\nAll relative paths will be resolved relative to this directory.`;
    }
    const mcpToolDescriptions = this.options.getMcpToolDescriptions();
    if (mcpToolDescriptions) {
      prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${mcpToolDescriptions}`;
    }
    return prompt;
  }
}
