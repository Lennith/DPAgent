import { messageTextContent } from '../llm/index.js';
import type { HookContext, HookExecutionResult, HookRunner } from '../hooks/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { AgentCallback, LLMResponse, MaxTokensRecoveryEvent, Message, TokenUsage, ToolResult } from '../types.js';
import type { AgentRunResult } from './agent-contracts.js';
import { applyBeforeToolCallHookModified } from './AgentHookEffectApplier.js';
import type { ToolResultMaterializer } from './ToolResultMaterializer.js';

const PLAN_APPROVED_TURN_COMPLETION_MESSAGE = 'Plan approved. Execution will continue in a new turn.';

function shouldCompleteTurnAfterToolResult(toolName: string, rawContent: string): boolean {
  if (toolName !== 'finalize_plan') {
    return false;
  }
  try {
    const parsed = JSON.parse(rawContent) as {
      decision?: unknown;
      executionContinuation?: unknown;
    };
    return parsed.decision === 'approved' && parsed.executionContinuation === 'approved_new_turn';
  } catch {
    return false;
  }
}

export interface AgentToolCallHost {
  abortController: AbortController;
  sessionId: string | null;
  hookRunner?: HookRunner;
  callback?: AgentCallback;
  tools: Pick<ToolRegistry, 'execute'>;
  toolResultMaterializer: ToolResultMaterializer;
  messageStore: { messages: Message[] };
  executeHookPoint(event: string, context: HookContext): Promise<HookExecutionResult>;
  completeCancelledRun(input: {
    step: number;
    usage?: TokenUsage;
    recoveredFromMaxTokens: boolean;
    maxTokensRecoveryAttempt: number;
    maxTokensEvents: MaxTokensRecoveryEvent[];
  }): AgentRunResult;
  getMessages(): Message[];
  applyPendingSummaryIfNeeded(): void;
  consumeRunningInputAtCheckpoint(step: number): Promise<void>;
}

export type AgentToolCallResult =
  | { kind: 'terminal'; result: AgentRunResult }
  | { kind: 'completed'; forcedTurnCompletion: { content: string; finishReason: 'end_turn' } | null };

export async function executeAgentToolCallsForTurn(
  host: AgentToolCallHost,
  input: {
    response: LLMResponse;
    persistedAssistantMsg: Message | null;
    step: number;
    lastUsage?: TokenUsage;
    recoveredFromMaxTokens: boolean;
    maxTokensRecoveryAttempt: number;
    maxTokensEvents: MaxTokensRecoveryEvent[];
  }
): Promise<AgentToolCallResult> {
  if (!input.response.toolCalls || input.response.toolCalls.length === 0) {
    return { kind: 'completed', forcedTurnCompletion: null };
  }

  let forcedTurnCompletion: { content: string; finishReason: 'end_turn' } | null = null;
  for (const toolCall of input.response.toolCalls) {
    if (host.abortController.signal.aborted) {
      return {
        kind: 'terminal',
        result: host.completeCancelledRun({
          step: input.step,
          usage: input.lastUsage,
          recoveredFromMaxTokens: input.recoveredFromMaxTokens,
          maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
          maxTokensEvents: input.maxTokensEvents,
        }),
      };
    }

    const { name, arguments: args } = toolCall.function;
    const beforeCtx = {
      event: 'onBeforeToolCall' as const,
      sessionId: host.sessionId ?? '',
      step: input.step,
      toolCall,
      toolName: name,
      toolArgs: args,
    };
    const beforeResult = await host.executeHookPoint('onBeforeToolCall', beforeCtx as HookContext);
    if (beforeResult.blocked) {
      const errContent =
        host.hookRunner?.buildToolError(beforeResult, beforeCtx) ??
        JSON.stringify({
          type: 'tool_error',
          tool_call_id: toolCall.id,
          tool_name: name,
          error: 'Tool call blocked by hook',
        });
      const blockedMsg: Message = host.toolResultMaterializer.sanitize({
        role: 'tool',
        content: errContent,
        toolCallId: toolCall.id,
        name,
      });
      host.messageStore.messages.push(blockedMsg);
      host.callback?.onToolResult?.(name, {
        success: false,
        content: '',
        error: beforeResult.blockError ?? 'Tool call blocked by hook',
      });
      await Promise.resolve(
        host.callback?.onReplayCheckpoint?.({
          observedAt: new Date().toISOString(),
          step: input.step + 1,
          messages: host.getMessages().filter((message) => message.role !== 'system'),
        })
      );
      continue;
    }

    const modifiedToolCall = applyBeforeToolCallHookModified({
      modified: beforeResult.modified,
      toolCall,
      toolName: name,
      toolArgs: args,
    });
    const effectiveToolCall = modifiedToolCall.toolCall;
    const effectiveName = modifiedToolCall.toolName;
    const effectiveArgs = modifiedToolCall.toolArgs;
    if (input.persistedAssistantMsg?.toolCalls) {
      input.persistedAssistantMsg.toolCalls = input.persistedAssistantMsg.toolCalls.map((item) =>
        item.id === toolCall.id ? effectiveToolCall : item
      );
    }

    host.callback?.onToolCall?.(
      effectiveName,
      host.toolResultMaterializer.redactToolCallArgumentsForCheckpoint(effectiveName, effectiveArgs),
      effectiveToolCall.id
    );
    await Promise.resolve(host.callback?.onBeforeToolExecution?.(effectiveName, effectiveArgs, effectiveToolCall.id));
    if (host.abortController.signal.aborted) {
      return {
        kind: 'terminal',
        result: host.completeCancelledRun({
          step: input.step,
          usage: input.lastUsage,
          recoveredFromMaxTokens: input.recoveredFromMaxTokens,
          maxTokensRecoveryAttempt: input.maxTokensRecoveryAttempt,
          maxTokensEvents: input.maxTokensEvents,
        }),
      };
    }

    const result = await host.tools.execute(effectiveName, effectiveArgs, { signal: host.abortController.signal });
    const rawToolContent = result.success ? result.content : `Error: ${result.error}`;
    let callbackToolResult: ToolResult = result;
    const toolMsg: Message = host.toolResultMaterializer.sanitize({
      role: 'tool',
      content: rawToolContent,
      toolCallId: effectiveToolCall.id,
      name: effectiveName,
    });
    host.messageStore.messages.push(toolMsg);
    if (result.success) {
      const materialized = await host.toolResultMaterializer.materialize({
        toolName: effectiveName,
        toolCallId: effectiveToolCall.id,
        content: rawToolContent,
      });
      const finalizedToolMsg = host.toolResultMaterializer.sanitize({
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

    const afterCtx = {
      event: 'onAfterToolCall' as const,
      sessionId: host.sessionId ?? '',
      step: input.step,
      toolCall: effectiveToolCall,
      toolName: effectiveName,
      result: callbackToolResult,
    };
    await host.executeHookPoint('onAfterToolCall', afterCtx as HookContext);
    host.callback?.onToolResult?.(effectiveName, callbackToolResult);
    if (!forcedTurnCompletion && result.success && shouldCompleteTurnAfterToolResult(effectiveName, rawToolContent)) {
      forcedTurnCompletion = {
        content: PLAN_APPROVED_TURN_COMPLETION_MESSAGE,
        finishReason: 'end_turn',
      };
    }
  }

  host.applyPendingSummaryIfNeeded();
  await Promise.resolve(
    host.callback?.onReplayCheckpoint?.({
      observedAt: new Date().toISOString(),
      step: input.step + 1,
      messages: host.getMessages().filter((message) => message.role !== 'system'),
    })
  );
  if (!forcedTurnCompletion) {
    await host.consumeRunningInputAtCheckpoint(input.step + 1);
  }

  return { kind: 'completed', forcedTurnCompletion };
}
