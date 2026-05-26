import type { MCPServerConfig, ReasoningPreset, SessionLlmSelectionInput } from '../types.js';

export type ExecParsedArgs = {
  json: boolean;
  resumeSessionId?: string;
  serverUrl?: string;
  workspaceDir?: string;
  sessionId?: string;
  maxSteps?: number;
  llmSelection?: SessionLlmSelectionInput;
  planMode?: boolean;
  externalMcpServers?: MCPServerConfig[];
};

function readFlagValue(argv: string[], index: number): string | undefined {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    return undefined;
  }
  return value;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseReasoningPreset(raw: string | undefined): ReasoningPreset | undefined {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : undefined;
}

function assignLlmSelectionPatch(parsed: ExecParsedArgs, patch: SessionLlmSelectionInput): void {
  parsed.llmSelection = {
    ...(parsed.llmSelection ?? {}),
    ...patch,
  };
}

function unquoteTomlString(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

function parseTomlStringArray(raw: string): string[] {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) {
    return [];
  }
  const content = value.slice(1, -1).trim();
  if (!content) {
    return [];
  }
  const items: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? '';
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      items.push(unquoteTomlString(current));
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    items.push(unquoteTomlString(current));
  }
  return items;
}

function applyMcpConfigArg(servers: Map<string, MCPServerConfig>, rawConfig: string): void {
  const separator = rawConfig.indexOf('=');
  if (separator <= 0) {
    return;
  }
  const key = rawConfig.slice(0, separator).trim();
  const value = rawConfig.slice(separator + 1).trim();
  const match = /^mcp_servers\.([^.]+)\.(command|args|env\.[A-Za-z_][A-Za-z0-9_]*)$/u.exec(key);
  if (!match) {
    return;
  }
  const name = match[1] ?? '';
  const field = match[2] ?? '';
  const existing = servers.get(name) ?? { name, type: 'stdio' };
  if (field === 'command') {
    existing.command = unquoteTomlString(value);
  } else if (field === 'args') {
    existing.args = parseTomlStringArray(value);
  } else if (field.startsWith('env.')) {
    const envKey = field.slice('env.'.length);
    existing.env = {
      ...(existing.env ?? {}),
      [envKey]: unquoteTomlString(value),
    };
  }
  servers.set(name, existing);
}

function finalizeExternalMcpServers(servers: Map<string, MCPServerConfig>): MCPServerConfig[] | undefined {
  const items = [...servers.values()]
    .filter((server) => server.name.trim() && server.command?.trim())
    .map((server) => ({
      ...server,
      name: server.name.trim(),
      type: server.type ?? 'stdio',
      command: server.command?.trim(),
      args: server.args ? [...server.args] : undefined,
      env: server.env ? { ...server.env } : undefined,
    }));
  return items.length > 0 ? items : undefined;
}

export function parseDpagentExecArgs(argv: string[]): ExecParsedArgs {
  const parsed: ExecParsedArgs = {
    json: argv.includes('--json'),
  };
  const externalMcpServers = new Map<string, MCPServerConfig>();

  let index = 0;
  if (argv[index] === 'resume') {
    parsed.resumeSessionId = argv[index + 1];
    index += 2;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--server-url':
      case '--base-url':
        parsed.serverUrl = readFlagValue(argv, index);
        index += parsed.serverUrl ? 1 : 0;
        break;
      case '--workspace':
      case '--workspace-dir':
      case '--cwd':
        parsed.workspaceDir = readFlagValue(argv, index);
        index += parsed.workspaceDir ? 1 : 0;
        break;
      case '--session-id':
      case '--thread-id':
        parsed.sessionId = readFlagValue(argv, index);
        index += parsed.sessionId ? 1 : 0;
        break;
      case '--max-steps':
        parsed.maxSteps = parsePositiveInt(readFlagValue(argv, index));
        index += parsed.maxSteps ? 1 : 0;
        break;
      case '--llm-profile': {
        const value = readFlagValue(argv, index);
        if (value) {
          assignLlmSelectionPatch(parsed, { profileId: value });
          index += 1;
        }
        break;
      }
      case '--model': {
        const value = readFlagValue(argv, index);
        if (value) {
          assignLlmSelectionPatch(parsed, { model: value });
          index += 1;
        }
        break;
      }
      case '--reasoning': {
        const value = readFlagValue(argv, index);
        const reasoningPreset = parseReasoningPreset(value);
        if (reasoningPreset) {
          assignLlmSelectionPatch(parsed, { reasoningPreset });
          index += 1;
        }
        break;
      }
      case '--plan-mode':
        parsed.planMode = true;
        break;
      case '-c':
      case '--config': {
        const value = readFlagValue(argv, index);
        if (value) {
          applyMcpConfigArg(externalMcpServers, value);
          index += 1;
        }
        break;
      }
      default:
        // Accept additional Codex-compatible runner flags that DPAgent does not own.
        if (arg.startsWith('--') && readFlagValue(argv, index)) {
          index += 1;
        }
        break;
    }
  }

  parsed.externalMcpServers = finalizeExternalMcpServers(externalMcpServers);
  return parsed;
}
