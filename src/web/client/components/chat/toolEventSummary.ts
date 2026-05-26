import { redactToolCallArgumentsForCheckpoint } from '../../../../runtime/tool-result-payload-policy.js';

const MAX_TOOL_EVENT_DETAIL_STRING_CHARS = 2000;
const MAX_TOOL_EVENT_DETAIL_JSON_CHARS = 6000;
const MAX_TOOL_EVENT_DETAIL_ARRAY_ITEMS = 20;
const MAX_TOOL_EVENT_DETAIL_OBJECT_KEYS = 40;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars = 180): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 16))}...(truncated)`;
}

function toDisplayText(value: unknown): string {
  if (typeof value === 'string') {
    return truncate(normalizeWhitespace(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '0 items';
    }
    return `${value.length} items`;
  }
  if (value && typeof value === 'object') {
    try {
      return truncate(normalizeWhitespace(JSON.stringify(value)));
    } catch {
      return '[object]';
    }
  }
  return '';
}

function toDetailValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_TOOL_EVENT_DETAIL_STRING_CHARS) {
    return `${value.slice(0, MAX_TOOL_EVENT_DETAIL_STRING_CHARS)}...(truncated ${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_TOOL_EVENT_DETAIL_ARRAY_ITEMS).map((item) => toDetailValue(item));
    if (value.length > MAX_TOOL_EVENT_DETAIL_ARRAY_ITEMS) {
      items.push(`...(truncated ${value.length - MAX_TOOL_EVENT_DETAIL_ARRAY_ITEMS} items)`);
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, MAX_TOOL_EVENT_DETAIL_OBJECT_KEYS)) {
      out[key] = toDetailValue(item);
    }
    if (entries.length > MAX_TOOL_EVENT_DETAIL_OBJECT_KEYS) {
      out.__truncated_keys = entries.length - MAX_TOOL_EVENT_DETAIL_OBJECT_KEYS;
    }
    return out;
  }
  return value;
}

function detailJsonForToolCall(name: string, args: Record<string, unknown>): string {
  const detail = JSON.stringify(toDetailValue(redactToolCallArgumentsForCheckpoint(name, args)), null, 2);
  if (detail.length <= MAX_TOOL_EVENT_DETAIL_JSON_CHARS) {
    return detail;
  }
  return `${detail.slice(0, MAX_TOOL_EVENT_DETAIL_JSON_CHARS)}\n...(truncated ${detail.length} chars)`;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildSecondary(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = toDisplayText(args[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

export interface ToolCallSummary {
  title: string;
  subtitle: string;
  detailJson: string;
}

export interface ToolResultSummary {
  title: string;
  subtitle: string;
  detailText: string;
}

export function summarizeToolCall(name: string, args: Record<string, unknown>): ToolCallSummary {
  const normalizedName = name.trim();
  const action = getStringArg(args, 'action');

  if (normalizedName === 'memory_manage') {
    return {
      title: action ? `Memory ${action}` : 'Memory operation',
      subtitle: buildSecondary(args, ['id', 'title', 'scope', 'query']) || 'Durable memory mutation or lookup.',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'session_search') {
    return {
      title: action ? `Session search ${action}` : 'Session search',
      subtitle: buildSecondary(args, ['query', 'keywords', 'question']) || 'Search prior session context.',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'context_manage') {
    return {
      title: action ? `Context ${action}` : 'Context inspection',
      subtitle:
        buildSecondary(args, ['key', 'namespace', 'scope']) ||
        'Inspect or patch current structured or runtime context state.',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'todo') {
    if (action === 'plan_set') {
      const items = Array.isArray(args.items) ? args.items : [];
      const firstItem =
        items.length > 0 && items[0] && typeof items[0] === 'object' && !Array.isArray(items[0])
          ? (items[0] as Record<string, unknown>)
          : null;
      const firstWork = firstItem ? toDisplayText(firstItem.work) : '';
      return {
        title: 'Todo plan_set',
        subtitle:
          items.length > 0
            ? `${items.length} planned item${items.length === 1 ? '' : 's'}${firstWork ? ` - ${firstWork}` : ''}`
            : 'Replace the current todo plan.',
        detailJson: detailJsonForToolCall(normalizedName, args),
      };
    }
    return {
      title: action ? `Todo ${action}` : 'Todo operation',
      subtitle: buildSecondary(args, ['work', 'detection_standard', 'id', 'status', 'scope']) || 'Manage agent task state.',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'read_file' || normalizedName === 'write_file' || normalizedName === 'edit_file') {
    return {
      title: humanizeToolName(normalizedName),
      subtitle: buildSecondary(args, ['path', 'filePath']) || 'File operation',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'send_file_to_user') {
    return {
      title: 'Send file to user',
      subtitle: buildSecondary(args, ['path', 'filename']) || 'Create a user download link',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'shell_execute') {
    return {
      title: 'Shell execute',
      subtitle: buildSecondary(args, ['command']) || 'Shell command execution',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  if (normalizedName === 'web_search') {
    return {
      title: 'Web search',
      subtitle: buildSecondary(args, ['query', 'q']) || 'Search the web',
      detailJson: detailJsonForToolCall(normalizedName, args),
    };
  }

  return {
    title: humanizeToolName(normalizedName),
    subtitle: buildSecondary(args, ['path', 'command', 'query', 'title', 'id']) || 'Tool call details available.',
    detailJson: detailJsonForToolCall(normalizedName, args),
  };
}

export function summarizeToolResult(
  name: string,
  result: { success: boolean; content: string; error?: string }
): ToolResultSummary {
  const detailText = result.success ? result.content : result.error || result.content || 'No tool result content.';
  const parsed = parseJsonRecord(detailText);
  const normalizedName = name.trim();

  if (parsed) {
    const action = typeof parsed.action === 'string' ? parsed.action : '';
    if (normalizedName === 'memory_manage') {
      const itemCount = Array.isArray(parsed.items) ? parsed.items.length : Array.isArray(parsed.history) ? parsed.history.length : undefined;
      return {
        title: action ? `Memory ${action} ${result.success ? 'succeeded' : 'failed'}` : `Memory ${result.success ? 'succeeded' : 'failed'}`,
        subtitle:
          itemCount !== undefined
            ? `${itemCount} item${itemCount === 1 ? '' : 's'} returned.`
            : toDisplayText(parsed.content ?? parsed.message ?? parsed.id) || 'Memory tool completed.',
        detailText,
      };
    }
    if (normalizedName === 'session_search') {
      const matchCount = Array.isArray(parsed.hits)
        ? parsed.hits.length
        : Array.isArray(parsed.matches)
          ? parsed.matches.length
          : Array.isArray(parsed.results)
            ? parsed.results.length
            : undefined;
      return {
        title: `Session search ${result.success ? 'succeeded' : 'failed'}`,
        subtitle:
          matchCount !== undefined
            ? `${matchCount} match${matchCount === 1 ? '' : 'es'} returned.`
            : toDisplayText(parsed.summary ?? parsed.message) || 'Session search completed.',
        detailText,
      };
    }
    if (normalizedName === 'context_manage') {
      const namespaceCount = Array.isArray(parsed.namespaces) ? parsed.namespaces.length : undefined;
      return {
        title: action
          ? `Context ${action} ${result.success ? 'succeeded' : 'failed'}`
          : `Context ${result.success ? 'succeeded' : 'failed'}`,
        subtitle:
          namespaceCount !== undefined
            ? `${namespaceCount} namespace${namespaceCount === 1 ? '' : 's'} returned.`
            : toDisplayText(
                parsed.sourceStatus ??
                  parsed.summary ??
                  parsed.mode ??
                  parsed.key ??
                  parsed.message ??
                  parsed.version
              ) || 'Context state inspection completed.',
        detailText,
      };
    }
    if (normalizedName === 'todo') {
      const itemCount = Array.isArray(parsed.items) ? parsed.items.length : undefined;
      return {
        title: action ? `Todo ${action} ${result.success ? 'succeeded' : 'failed'}` : `Todo ${result.success ? 'succeeded' : 'failed'}`,
        subtitle:
          action === 'plan_set' && itemCount !== undefined
            ? `Plan replaced with ${itemCount} todo item${itemCount === 1 ? '' : 's'}.`
            : itemCount !== undefined
            ? `${itemCount} todo item${itemCount === 1 ? '' : 's'} returned.`
            : toDisplayText(parsed.removed ?? parsed.item ?? parsed.success) || 'Todo tool completed.',
        detailText,
      };
    }
    if (normalizedName === 'send_file_to_user') {
      return {
        title: `Send file ${result.success ? 'succeeded' : 'failed'}`,
        subtitle: toDisplayText(parsed.displayPath ?? parsed.filename ?? parsed.href) || 'Download link created.',
        detailText,
      };
    }
  }

  return {
    title: `${humanizeToolName(normalizedName)} ${result.success ? 'succeeded' : 'failed'}`,
    subtitle: truncate(normalizeWhitespace(detailText || 'No tool result content.')),
    detailText,
  };
}
