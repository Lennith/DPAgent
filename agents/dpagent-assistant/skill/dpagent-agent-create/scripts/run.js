#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = process.env.DPAGENT_BASE_URL || `http://127.0.0.1:${process.env.DPAGENT_PORT || '53721'}`;

const COMMANDS = {
  schema: {
    write: false,
    summary: 'Return the CLI command and payload schema.',
  },
  describe: {
    write: false,
    summary: 'Describe one command or the whole CLI.',
  },
  discover: {
    write: false,
    summary: 'Fetch live DPAgent agent-authoring capabilities.',
  },
  plan: {
    write: false,
    summary: 'Summarize the supplied apply payload without calling the server.',
  },
  validate: {
    write: false,
    summary: 'POST a dry-run authoring apply request.',
  },
  apply: {
    write: true,
    summary: 'Apply an external agent/profile/MCP/toolset payload.',
  },
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq >= 0) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function boolFlag(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function readJson(value) {
  if (!value) return {};
  const raw = String(value);
  const text = raw.startsWith('@')
    ? fs.readFileSync(path.resolve(raw.slice(1)), 'utf8')
    : raw;
  return JSON.parse(text);
}

function schema() {
  return {
    name: 'dpagent-agent-create',
    commands: COMMANDS,
    auth: {
      baseUrl: 'DPAGENT_BASE_URL or --base-url',
      cookie: 'DPAGENT_SESSION_COOKIE or --cookie',
      password: 'DPAGENT_PASSWORD or --password, used through /api/auth/login',
    },
    globalFlags: {
      '--base-url': 'DPAgent server URL. Defaults to loopback port 53721.',
      '--json': 'Raw JSON string or @file for apply payload.',
      '--output': 'json, ndjson, or text. Defaults to json.',
      '--fields': 'Comma-separated top-level or dotted fields to return.',
      '--dry-run': 'Force dry-run behavior for validate/apply.',
      '--confirm': 'Must be yes for non-dry-run apply.',
    },
    payload: {
      agent: {
        name: 'Folder name under agent.globalAgentsDir.',
        content: 'AGENTS.md body.',
        config: {
          version: 1,
          description: 'Optional description.',
          llmProfileId: 'Optional LLM profile id.',
          llmModel: 'Optional model override.',
          reasoningPreset: 'off|low|medium|high|xhigh|max',
          toolsetName: 'Optional built-in or custom toolset.',
          allowedTools: ['Optional explicit tool names'],
          maxSteps: 'Optional positive integer.',
          timeoutMs: 'Optional positive integer.',
          exposeAsSubagent: 'Optional boolean; external agents default false server-side.',
        },
      },
      llmProfiles: { upsert: ['LlmProviderProfileConfig'], defaultProfileId: 'optional' },
      mcp: { enabled: 'optional boolean', upsert: ['MCPServerConfig'], removeNames: ['name'] },
      toolsets: { upsert: ['ToolsetDefinition'], removeNames: ['name'] },
    },
  };
}

function pickFields(value, fields) {
  if (!fields) return value;
  const output = {};
  for (const rawField of String(fields).split(',')) {
    const field = rawField.trim();
    if (!field) continue;
    const parts = field.split('.');
    let source = value;
    let target = output;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (source == null || !Object.prototype.hasOwnProperty.call(source, part)) {
        break;
      }
      if (i === parts.length - 1) {
        target[part] = source[part];
      } else {
        target[part] = target[part] || {};
        target = target[part];
        source = source[part];
      }
    }
  }
  return output;
}

function stringifyPayload(payload, output) {
  return output === 'text' ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

function emit(payload, flags) {
  const selected = pickFields(payload, flags.fields);
  const output = flags.output || 'json';
  process.stdout.write(`${stringifyPayload(selected, output)}\n`);
}

function error(code, message, details) {
  const err = new Error(message);
  err.payload = { success: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
  return err;
}

function describeCommand(target) {
  if (target && !COMMANDS[target]) {
    throw error('UNKNOWN_COMMAND', `Unknown command: ${target}`, { commands: Object.keys(COMMANDS) });
  }
  return target ? { name: target, ...COMMANDS[target] } : schema();
}

async function login(baseUrl, flags) {
  const existing = flags.cookie || process.env.DPAGENT_SESSION_COOKIE;
  if (existing) return existing;
  const password = flags.password || process.env.DPAGENT_PASSWORD;
  if (!password) return '';
  const response = await fetch(new URL('/api/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw error('AUTH_FAILED', `Login failed with HTTP ${response.status}`);
  }
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) {
    throw error('AUTH_COOKIE_MISSING', 'Login succeeded but no session cookie was returned.');
  }
  return cookie;
}

async function requestJson(baseUrl, flags, method, route, body) {
  const cookie = await login(baseUrl, flags);
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw error('HTTP_ERROR', `HTTP ${response.status} from ${route}`, payload);
  }
  return payload;
}

function summarizePayload(payload) {
  return {
    agentName: payload.agent && payload.agent.name,
    hasAgentContent: Boolean(payload.agent && payload.agent.content),
    llmProfileUpserts: Array.isArray(payload.llmProfiles && payload.llmProfiles.upsert)
      ? payload.llmProfiles.upsert.length
      : 0,
    mcpUpserts: Array.isArray(payload.mcp && payload.mcp.upsert) ? payload.mcp.upsert.length : 0,
    toolsetUpserts: Array.isArray(payload.toolsets && payload.toolsets.upsert) ? payload.toolsets.upsert.length : 0,
    dryRun: payload.dryRun === true,
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0] || 'schema';
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  if (!COMMANDS[command]) {
    throw error('UNKNOWN_COMMAND', `Unknown command: ${command}`, { commands: Object.keys(COMMANDS) });
  }
  if (command === 'schema') {
    emit({ success: true, command, data: schema() }, flags);
    return;
  }
  if (command === 'describe') {
    emit({
      success: true,
      command,
      data: describeCommand(flags._[1]),
    }, flags);
    return;
  }
  if (command === 'discover') {
    const data = await requestJson(baseUrl, flags, 'GET', '/api/agent-authoring/capabilities');
    emit({ success: true, command, data, meta: { baseUrl } }, flags);
    return;
  }
  const payload = readJson(flags.json);
  if (command === 'plan') {
    emit({ success: true, command, data: summarizePayload(payload), meta: { baseUrl } }, flags);
    return;
  }
  if (command === 'validate') {
    const body = { ...payload, dryRun: true };
    const data = await requestJson(baseUrl, flags, 'POST', '/api/agent-authoring/apply', body);
    emit({ success: true, command, data, meta: { baseUrl } }, flags);
    return;
  }
  if (command === 'apply') {
    const dryRun = boolFlag(flags['dry-run']) || payload.dryRun === true;
    const body = {
      ...payload,
      dryRun,
      ...(flags.confirm ? { confirm: flags.confirm } : {}),
    };
    const data = await requestJson(baseUrl, flags, 'POST', '/api/agent-authoring/apply', body);
    emit({ success: true, command, data, meta: { baseUrl } }, flags);
  }
}

main().catch((err) => {
  const payload = err && err.payload
    ? err.payload
    : { success: false, error: { code: 'UNEXPECTED_ERROR', message: err instanceof Error ? err.message : String(err) } };
  emit(payload, parseArgs(process.argv.slice(2)));
  process.exitCode = 1;
});
