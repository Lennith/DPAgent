import * as crypto from 'crypto';
import type { Message, SideEffectLedgerEntry } from './types.js';
import { resolveToolCapabilityFamily } from './tools/tool-registration.js';

export const INTERRUPTED_TURN_RESUME_MARKER = '[INTERRUPTED_TURN_RESUME]';

function messageTextContent(content: Message['content']): string {
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

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

function inferToolResultSuccess(content: string): boolean {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) {
    return true;
  }

  if (/^(error|failed|exception)\b/i.test(trimmed)) {
    return false;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && 'success' in parsed) {
        return Boolean((parsed as { success?: unknown }).success);
      }
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        return false;
      }
    } catch {
      // Ignore parse failures and fall back to string heuristics.
    }
  }

  return true;
}

export function hasCheckpointProgress(messages: Message[]): boolean {
  return messages.some((message) => message.role !== 'user');
}

export function slicePreviewMessages(turnMessages: Message[], checkpointMessages: Message[]): Message[] {
  if (checkpointMessages.length === 0) {
    return turnMessages.map(cloneMessage);
  }
  const matchedPrefixLength = resolveReplayCheckpointPrefixLength(turnMessages, checkpointMessages);
  return turnMessages.slice(matchedPrefixLength).map(cloneMessage);
}

export function buildSideEffectLedgerFromPreview(previewMessages: Message[]): SideEffectLedgerEntry[] {
  const entries: SideEffectLedgerEntry[] = [];
  let activeToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of previewMessages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      activeToolCalls = new Map(
        message.toolCalls.map((toolCall) => [
          toolCall.id,
          {
            name: toolCall.function.name,
            args: { ...toolCall.function.arguments },
          },
        ])
      );
      continue;
    }
    if (message.role !== 'tool') {
      continue;
    }
    const toolCallId = message.toolCallId?.trim() || undefined;
    const matched = toolCallId ? activeToolCalls.get(toolCallId) : undefined;
    const toolName = matched?.name ?? message.name ?? '(unknown)';
    const content = truncate(messageTextContent(message.content), 240);
    const resultSuccess = inferToolResultSuccess(content);
    if (!shouldPersistInterruptedSideEffect(toolName, resultSuccess, matched?.args)) {
      continue;
    }
    entries.push({
      id: crypto.randomUUID(),
      observedAt: new Date().toISOString(),
      toolName,
      toolCallId,
      args: matched?.args ? { ...matched.args } : undefined,
      resultSuccess,
      resultSummary: content,
    });
  }
  return entries;
}

export function buildInterruptedSideEffectSegment(entries: SideEffectLedgerEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const lines = ['## Interrupted Turn Side Effects'];
  lines.push(
    'The previous turn terminated after the last replay-safe checkpoint. The following mutating tool operations happened after that checkpoint and must be reconciled against current workspace/runtime state before continuing.'
  );
  lines.push(
    'Successful file/memory/todo/skill mutations should be assumed already applied. Failed shell executions may be partially applied and should be verified before repeating them.'
  );
  for (const entry of entries.slice(-20)) {
    const args = entry.args ? truncate(JSON.stringify(entry.args), 220) : '{}';
    const disposition = entry.resultSuccess === false ? 'possible_partial' : 'confirmed';
    lines.push(
      `- mutation=${disposition} tool=${entry.toolName} tool_call_id=${entry.toolCallId ?? '(missing)'} success=${entry.resultSuccess !== false} args=${args} result=${truncate(entry.resultSummary, 260)}`
    );
  }
  if (entries.length > 20) {
    lines.push(`- ...(${entries.length - 20} more post-checkpoint side effects)`);
  }
  return lines.join('\n');
}

export function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}

function resolveReplayCheckpointPrefixLength(turnMessages: Message[], checkpointMessages: Message[]): number {
  const maxLength = Math.min(turnMessages.length, checkpointMessages.length);
  let matched = 0;
  for (let i = 0; i < maxLength; i += 1) {
    if (!areReplayComparableMessagesEqual(turnMessages[i], checkpointMessages[i])) {
      break;
    }
    matched += 1;
  }
  return matched;
}

function areReplayComparableMessagesEqual(left: Message | undefined, right: Message | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return JSON.stringify(toReplayComparableMessage(left)) === JSON.stringify(toReplayComparableMessage(right));
}

function toReplayComparableMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: cloneComparableValue(message.content),
    name: message.name,
    toolCallId: message.toolCallId,
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function.name,
            arguments: cloneComparableValue(toolCall.function.arguments),
          },
        }))
      : undefined,
  };
}

function cloneComparableValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

const OBSERVATION_TOOL_FAMILIES = new Set([
  'file_read',
  'file_glob',
  'file_grep',
  'web_fetch',
  'web_search',
  'session_search',
  'skills_catalog',
  'plan_request_user_input',
]);

const CONTROL_TOOL_FAMILIES = new Set(['context_manage', 'plan_finalize', 'auto_loop_exit']);

const MUTATING_TOOL_FAMILIES = new Set([
  'file_write',
  'file_edit',
  'memory_manage',
  'todo_manage',
  'skill_manage',
]);

const MUTATING_SUBAGENT_ACTIONS = new Set(['create', 'resume', 'cancel']);

function shouldPersistInterruptedSideEffect(
  toolName: string,
  resultSuccess: boolean,
  args?: Record<string, unknown>
): boolean {
  const family = resolveToolCapabilityFamily(String(toolName ?? ''));
  if (OBSERVATION_TOOL_FAMILIES.has(family) || CONTROL_TOOL_FAMILIES.has(family)) {
    return false;
  }
  if (family === 'subagent_manage') {
    const action = String(args?.action ?? '').trim().toLowerCase();
    return MUTATING_SUBAGENT_ACTIONS.has(action);
  }
  if (family === 'shell_exec') {
    return isMutatingShellCommand(String(args?.command ?? ''));
  }
  if (MUTATING_TOOL_FAMILIES.has(family)) {
    return resultSuccess || family === 'shell_exec';
  }
  const normalized = String(toolName ?? '').trim().toLowerCase();
  if (
    /(?:^|_)(read|list|grep|glob|search|fetch|view|inspect|get|status|stat|ls)(?:_|$)/.test(normalized)
  ) {
    return false;
  }
  if (
    /(?:^|_)(write|edit|patch|apply|update|create|delete|remove|rename|move|install|exec|run)(?:_|$)/.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

const MUTATING_SHELL_PATTERNS = [
  />{1,2}/,
  /\b(?:rm|del|mv|move|cp|copy|touch|mkdir|rmdir|chmod|chown)\b/i,
  /\b(?:Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Rename-Item|Start-Process)\b/i,
  /\bgit\s+(?:apply|checkout|restore|clean|reset|commit|merge|rebase|stash(?:\s+(?:apply|pop))?)\b/i,
  /\b(?:npm|pnpm|yarn|pip|uv)\s+(?:install|add|remove|uninstall|update)\b/i,
  /\b(?:migrate|migration|seed|bootstrap|deploy|publish)\b/i,
];

function isMutatingShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  if (MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return false;
}
