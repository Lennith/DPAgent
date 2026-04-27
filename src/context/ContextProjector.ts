import {
  buildAgentProfileReferenceTag,
  parseAgentProfilePrompt,
} from '../agents/index.js';
import type {
  ContentBlock,
  ContextEvent,
  ContextNamespaceMeta,
  ContextPayloadProjectionMetrics,
  ContextProjection,
  ContextRef,
  ContextTurnSummary,
  Message,
  ToolResultArtifactRef,
  ToolCall,
} from '../types.js';

interface TurnState {
  turnId: string;
  startedAt: string;
  committedAt?: string;
  prompt?: string;
  promptRef?: string;
  assistant?: string;
  finalOutput?: string;
  summary?: string;
  toolCalls: number;
  toolCallDetails: ToolCall[];
  userMessages: string[];
  assistantMessages: string[];
  replayOnly?: boolean;
}

interface ConversationReplayTurnState {
  userMessages: string[];
  lastAssistantMessage?: string;
  finalOutput?: string;
  cancelled?: boolean;
  replayOnly?: boolean;
  compactionSummary?: string;
  compactionMessage?: Message;
  orderedMessages: Message[];
  pendingAssistantIndex?: number;
  hasToolProtocol: boolean;
}

function toStringSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeSourceRange(value: unknown): {
  startIndex: number;
  endIndex: number;
  messageCount: number;
  sourceHash: string;
} {
  const record = toRecord(value);
  return {
    startIndex: Math.max(0, Math.floor(toFiniteNumber(record.startIndex))),
    endIndex: Math.max(0, Math.floor(toFiniteNumber(record.endIndex))),
    messageCount: Math.max(0, Math.floor(toFiniteNumber(record.messageCount))),
    sourceHash: toStringSafe(record.sourceHash).trim(),
  };
}

function normalizeSealedBoundary(value: unknown): { keptLlmRounds: number; tailMessageCount: number } {
  const record = toRecord(value);
  return {
    keptLlmRounds: Math.max(0, Math.floor(toFiniteNumber(record.keptLlmRounds))),
    tailMessageCount: Math.max(0, Math.floor(toFiniteNumber(record.tailMessageCount))),
  };
}

function normalizeSourceCoverage(value: unknown): {
  status: 'complete' | 'truncated';
  droppedMessageCount: number;
  reason?: string;
} | undefined {
  const record = toRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const status = toStringSafe(record.status).trim() === 'truncated' ? 'truncated' : 'complete';
  const reason = toStringSafe(record.reason).trim();
  return {
    status,
    droppedMessageCount: Math.max(0, Math.floor(toFiniteNumber(record.droppedMessageCount))),
    reason: reason.length > 0 ? reason : undefined,
  };
}

function normalizePayloadMetrics(value: unknown): ContextPayloadProjectionMetrics {
  const record = toRecord(value);
  return {
    originalChars: Math.max(0, Math.floor(toFiniteNumber(record.originalChars))),
    projectedChars: Math.max(0, Math.floor(toFiniteNumber(record.projectedChars))),
    preparedChars: Math.max(0, Math.floor(toFiniteNumber(record.preparedChars))),
    originalMessageCount: Math.max(0, Math.floor(toFiniteNumber(record.originalMessageCount))),
    projectedMessageCount: Math.max(0, Math.floor(toFiniteNumber(record.projectedMessageCount))),
    preparedMessageCount: Math.max(0, Math.floor(toFiniteNumber(record.preparedMessageCount))),
    toolResultRefReplacements: Math.max(0, Math.floor(toFiniteNumber(record.toolResultRefReplacements))),
    oversizedInlineToolTruncations: Math.max(0, Math.floor(toFiniteNumber(record.oversizedInlineToolTruncations))),
    protocolCorrectionCount: Math.max(0, Math.floor(toFiniteNumber(record.protocolCorrectionCount))),
    trimRemovedCount: Math.max(0, Math.floor(toFiniteNumber(record.trimRemovedCount))),
    trimTruncatedCount: Math.max(0, Math.floor(toFiniteNumber(record.trimTruncatedCount))),
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

export class ContextProjector {
  project(ref: ContextRef, events: ContextEvent[]): ContextProjection {
    const turnMap = new Map<string, TurnState>();
    const keyValues = new Map<string, string>();
    let latestSummary = '';
    let committedCount = 0;

    const ensureTurn = (turnId: string, ts?: string): TurnState => {
      const existing = turnMap.get(turnId);
      if (existing) {
        return existing;
      }
      const created: TurnState = {
        turnId,
        startedAt: ts ?? new Date().toISOString(),
        toolCalls: 0,
        toolCallDetails: [],
        userMessages: [],
        assistantMessages: [],
      };
      turnMap.set(turnId, created);
      return created;
    };

    for (const event of events) {
      const turn = ensureTurn(event.turnId, event.timestamp);
      switch (event.type) {
        case 'turn_started':
          turn.startedAt = event.timestamp;
          turn.prompt = toStringSafe(event.data.rawUserPrompt || event.data.prompt || event.data.content || '');
          turn.promptRef = toStringSafe(event.data.promptRef);
          break;
        case 'user_message': {
          const userContent = toStringSafe(event.data.content);
          if (userContent) {
            turn.userMessages.push(userContent);
            if (!turn.prompt) {
              turn.prompt = userContent;
            }
          }
          break;
        }
        case 'assistant_message': {
          const assistantContent = toStringSafe(event.data.content);
          if (assistantContent) {
            turn.assistantMessages.push(assistantContent);
            turn.assistant = assistantContent;
          }
          break;
        }
        case 'tool_call': {
          const name = toStringSafe(event.data.name);
          const args = (event.data.args ?? {}) as Record<string, unknown>;
          const toolCallId = toStringSafe(event.data.toolCallId) || `ctx-${event.id}`;
          if (name) {
            turn.toolCalls += 1;
            turn.toolCallDetails.push({
              id: toolCallId,
              type: 'function',
              function: {
                name,
                arguments: args,
              },
            });
          }
          break;
        }
        case 'context_patch': {
          const op = toStringSafe(event.data.op);
          const key = toStringSafe(event.data.key);
          if (!key) {
            break;
          }
          if (op === 'delete') {
            keyValues.delete(key);
            break;
          }
          const value = toStringSafe(event.data.value);
          keyValues.set(key, value);
          break;
        }
        case 'turn_summary': {
          const nextLatestSummary = this.applyTurnSummaryEvent(turn, event.data);
          if (nextLatestSummary) {
            latestSummary = nextLatestSummary;
          }
          break;
        }
        case 'turn_committed':
          turn.committedAt = event.timestamp;
          committedCount += 1;
          break;
      }
    }

    const turns: ContextTurnSummary[] = Array.from(turnMap.values())
      .sort((a, b) => (a.committedAt ?? a.startedAt).localeCompare(b.committedAt ?? b.startedAt))
      .map((turn) => ({
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        committedAt: turn.committedAt,
        prompt: turn.prompt ? truncate(turn.prompt, 180) : undefined,
        promptRef: turn.promptRef ? truncate(turn.promptRef, 260) : undefined,
        assistant: turn.assistant ? truncate(turn.assistant, 220) : undefined,
        finalOutput: turn.finalOutput ? truncate(turn.finalOutput, 260) : undefined,
        summary: turn.summary ? truncate(turn.summary, 260) : undefined,
        toolCalls: turn.toolCalls,
      }));

    return {
      scope: ref.scope,
      namespace: ref.namespace,
      version: committedCount,
      eventCount: events.length,
      keyValues: Object.fromEntries(keyValues.entries()),
      latestSummary: latestSummary || undefined,
      recentTurns: turns.slice(-10).reverse(),
    };
  }

  buildSystemSegment(projection: ContextProjection, meta?: ContextNamespaceMeta): string {
    const lines: string[] = [];
    lines.push('## Context Snapshot');
    lines.push(`scope=${projection.scope}`);
    lines.push(`namespace=${projection.namespace}`);
    lines.push(`version=${projection.version}`);
    lines.push(`event_count=${projection.eventCount}`);

    const keys = Object.entries(projection.keyValues);
    if (keys.length > 0) {
      lines.push('');
      lines.push('### Structured Context');
      for (const [key, value] of keys.slice(0, 30)) {
        lines.push(`- ${key}: ${truncate(value, 220)}`);
      }
      if (keys.length > 30) {
        lines.push(`- ...(${keys.length - 30} more)`);
      }
    }

    const activeAgentSource = meta?.agentInjectionState?.lastProfileSource;
    const activeAgentName = String(meta?.agentInjectionState?.lastProfileName ?? '').trim();
    const activeAgentPath = String(meta?.agentInjectionState?.lastProfilePath ?? '').trim();
    if ((activeAgentSource === 'workspace' || activeAgentSource === 'global') && activeAgentName && activeAgentPath) {
      lines.push('');
      lines.push('### Active Agent');
      lines.push(`- source: ${activeAgentSource}`);
      lines.push(`- name: ${activeAgentName}`);
      lines.push(`- path: ${truncate(activeAgentPath, 220)}`);
      lines.push(
        `- ref: ${buildAgentProfileReferenceTag({
          source: activeAgentSource,
          name: activeAgentName,
          path: activeAgentPath,
        })}`
      );
    }

    lines.push('');
    lines.push(
      'Use this snapshot for structured state only; inspect or patch it with context_manage. Use session_search for raw transcript recall, memory_manage for durable facts, and recent replay messages plus optional compressed older-session context for conversational continuity.'
    );
    return lines.join('\n');
  }

  private applyTurnSummaryEvent(turn: TurnState, data: Record<string, unknown>): string | undefined {
    const summary = toStringSafe(data.summary);
    if (summary) {
      turn.summary = summary;
    }
    const prompt = toStringSafe(data.prompt);
    if (prompt) {
      turn.prompt = prompt;
    }
    const promptRef = toStringSafe(data.promptRef);
    if (promptRef) {
      turn.promptRef = promptRef;
    }
    const finishReason = toStringSafe(data.finishReason).trim();
    const isCancelled = finishReason === 'cancelled';
    turn.replayOnly = finishReason === 'interrupted_checkpoint';
    if (isCancelled) {
      turn.finalOutput = undefined;
      turn.assistant = undefined;
      return undefined;
    }
    const finalOutput = isCancelled ? '' : toStringSafe(data.finalOutput);
    if (finalOutput) {
      turn.finalOutput = finalOutput;
      turn.assistant = finalOutput;
      return finalOutput;
    }
    return summary || undefined;
  }

  toConversationMessages(
    events: ContextEvent[],
    options?: {
      preserveAgentProfileRefs?: boolean;
      includeInterruptedCheckpoints?: boolean;
    }
  ): Message[] {
    const turnOrder: string[] = [];
    const turnState = new Map<string, ConversationReplayTurnState>();

    const ensureTurn = (turnId: string): ConversationReplayTurnState => {
      const existing = turnState.get(turnId);
      if (existing) {
        return existing;
      }
      const created: ConversationReplayTurnState = {
        userMessages: [],
        orderedMessages: [],
        hasToolProtocol: false,
      };
      turnState.set(turnId, created);
      turnOrder.push(turnId);
      return created;
    };

    for (const event of events) {
      const turn = ensureTurn(event.turnId);
      if (event.type === 'user_message') {
        let content = toStringSafe(event.data.content);
        if (options?.preserveAgentProfileRefs !== true) {
          const parsed = parseAgentProfilePrompt(content);
          if (parsed.matched && parsed.strippedPrompt.trim().length > 0) {
            content = parsed.strippedPrompt;
          }
        }
        const normalized = content.trim();
        if (normalized.length > 0) {
          turn.userMessages.push(normalized);
          turn.orderedMessages.push({
            role: 'user',
            content: normalized,
          });
        }
        continue;
      }
      if (event.type === 'assistant_message') {
        const normalized = toStringSafe(event.data.content).trim();
        const contentBlocks = this.cloneContentBlocks(event.data.contentBlocks);
        const thinking = toStringSafe(event.data.thinking).trim();
        const thinkingSignature = toStringSafe(event.data.thinkingSignature).trim();
        const llmProviderProfileId = toStringSafe(event.data.llmProviderProfileId).trim();
        const llmProvider = toStringSafe(event.data.llmProvider).trim();
        const llmModel = toStringSafe(event.data.llmModel).trim();
        const thinkingComplete = event.data.thinkingComplete === true;
        if (normalized.length === 0 && !contentBlocks && thinking.length === 0) {
          continue;
        }
        turn.lastAssistantMessage = normalized;
        turn.pendingAssistantIndex = turn.orderedMessages.length;
        turn.orderedMessages.push({
          role: 'assistant',
          content: contentBlocks ?? normalized,
          thinking: thinking || undefined,
          thinkingSignature: thinkingSignature || undefined,
          metadata:
            llmProviderProfileId || llmProvider || llmModel || thinkingComplete
              ? {
                  llmProviderProfileId: llmProviderProfileId || undefined,
                  llmProvider: llmProvider === 'anthropic' || llmProvider === 'openai' ? llmProvider : undefined,
                  llmModel: llmModel || undefined,
                  thinkingComplete,
                }
              : undefined,
        });
        continue;
      }
      if (event.type === 'tool_call') {
        const name = toStringSafe(event.data.name).trim();
        if (!name) {
          continue;
        }
        const args = (event.data.args ?? {}) as Record<string, unknown>;
        const toolCallId = toStringSafe(event.data.toolCallId).trim() || `ctx-${event.id}`;
        turn.hasToolProtocol = true;
        let assistantMessage =
          typeof turn.pendingAssistantIndex === 'number'
            ? turn.orderedMessages[turn.pendingAssistantIndex]
            : undefined;
        if (!assistantMessage || assistantMessage.role !== 'assistant') {
          turn.pendingAssistantIndex = turn.orderedMessages.length;
          assistantMessage = {
            role: 'assistant',
            content: '',
          };
          turn.orderedMessages.push(assistantMessage);
        }
        const toolCalls = assistantMessage.toolCalls ?? [];
        toolCalls.push({
          id: toolCallId,
          type: 'function',
          function: {
            name,
            arguments: args,
          },
        });
        assistantMessage.toolCalls = toolCalls;
        continue;
      }
      if (event.type === 'tool_result') {
        const normalized = toStringSafe(event.data.content).trim();
        const name = toStringSafe(event.data.name).trim();
        const toolCallId = toStringSafe(event.data.toolCallId).trim();
        if (normalized.length === 0 && name.length === 0 && toolCallId.length === 0) {
          continue;
        }
        turn.hasToolProtocol = true;
        turn.pendingAssistantIndex = undefined;
        turn.orderedMessages.push({
          role: 'tool',
          content: normalized,
          name: name || undefined,
          toolCallId: toolCallId || undefined,
          metadata:
            event.data.artifact && typeof event.data.artifact === 'object'
              ? {
                  toolResultArtifact: event.data.artifact as ToolResultArtifactRef,
                }
              : undefined,
        });
        continue;
      }
      if (event.type === 'context_compaction') {
        const summary = toStringSafe(event.data.summary).trim();
        if (summary.length > 0) {
          const compactionMessage: Message = {
            role: 'assistant',
            content: summary,
            metadata: {
              compressed: true,
              contextCompaction: {
                sourceRange: normalizeSourceRange(event.data.sourceRange),
                sourceCoverage: normalizeSourceCoverage(event.data.sourceCoverage),
                sealedBoundary: normalizeSealedBoundary(event.data.sealedBoundary),
                payloadMetrics: normalizePayloadMetrics(event.data.payloadMetrics),
                configFingerprint: toStringSafe(event.data.configFingerprint).trim(),
              },
            },
          };
          turn.compactionSummary = summary;
          turn.compactionMessage = compactionMessage;
          turn.orderedMessages.push(compactionMessage);
        }
        continue;
      }
      if (event.type === 'turn_summary') {
        const finishReason = toStringSafe(event.data.finishReason).trim();
        const isCancelled = finishReason === 'cancelled';
        turn.replayOnly = finishReason === 'interrupted_checkpoint';
        if (isCancelled) {
          turn.cancelled = true;
          turn.finalOutput = undefined;
          turn.lastAssistantMessage = undefined;
          turn.orderedMessages = turn.orderedMessages.filter((message) => message.role === 'user');
          turn.pendingAssistantIndex = undefined;
          continue;
        }
        const finalOutput = isCancelled ? '' : toStringSafe(event.data.finalOutput).trim();
        if (finalOutput.length > 0) {
          turn.finalOutput = finalOutput;
        }
      }
    }

    const out: Message[] = [];
    for (const turnId of turnOrder) {
      const turn = turnState.get(turnId);
      if (!turn) {
        continue;
      }
      if (!turn.hasToolProtocol) {
        if (turn.replayOnly && options?.includeInterruptedCheckpoints !== true) {
          continue;
        }
        if (turn.compactionSummary) {
          out.length = 0;
          out.push(turn.compactionMessage ?? {
            role: 'assistant',
            content: turn.compactionSummary,
            metadata: {
              compressed: true,
            },
          });
        }
        for (const content of turn.userMessages) {
          out.push({
            role: 'user',
            content,
          });
        }
        if (turn.cancelled) {
          continue;
        }
        const assistantContent = turn.finalOutput?.trim() || turn.lastAssistantMessage?.trim() || '';
        if (assistantContent.length > 0) {
          out.push({
            role: 'assistant',
            content: assistantContent,
          });
        }
        continue;
      }

      if (turn.cancelled) {
        out.push(...turn.orderedMessages.filter((message) => message.role === 'user'));
        continue;
      }
      if (turn.replayOnly && options?.includeInterruptedCheckpoints !== true) {
        continue;
      }
      if (turn.compactionSummary) {
        out.length = 0;
      }

      const orderedMessages: Message[] = turn.orderedMessages.map((message): Message => ({
        ...message,
        content: Array.isArray(message.content) ? this.cloneContentBlocks(message.content) ?? [] : message.content,
        toolCalls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function.name,
            arguments: { ...toolCall.function.arguments },
          },
        })),
      }));
      const assistantContent = turn.finalOutput?.trim();
      if (assistantContent) {
        const lastMessage = orderedMessages[orderedMessages.length - 1];
        if (lastMessage?.role === 'assistant' && (!lastMessage.toolCalls || lastMessage.toolCalls.length === 0)) {
          lastMessage.content = assistantContent;
        } else {
          orderedMessages.push({
            role: 'assistant',
            content: assistantContent,
          });
        }
      }
      out.push(...orderedMessages);
    }

    return out;
  }

  private cloneContentBlocks(value: unknown): ContentBlock[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const blocks: ContentBlock[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const block = item as ContentBlock;
      if (block.type !== 'text' && block.type !== 'image') {
        continue;
      }
      blocks.push({
        ...block,
        source: block.source ? { ...block.source } : undefined,
      });
    }
    return blocks.length > 0 ? blocks : undefined;
  }
}
