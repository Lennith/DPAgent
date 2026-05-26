import fs from 'node:fs';
import path from 'node:path';
import { Request, Response } from 'express';
import {
  normalizeAgentProfileConfig,
  writeAgentProfileConfig,
} from '../../agents/AgentProfiles.js';
import {
  DEFAULT_TOOLSETS,
  createToolsetRegistry,
  type ToolsetDefinition,
} from '../../tools/index.js';
import {
  findResolvedLlmProfile,
  normalizeLlmProfilesConfig,
} from '../../llm/provider-profiles.js';
import type {
  AgentConfig,
  AgentProfileConfig,
  LlmProviderProfileConfig,
  MCPServerConfig,
} from '../../types.js';
import {
  ConfigMutationService,
  cloneAgentConfig,
  serializeLlmProfiles,
} from './config-mutation-service.js';
import {
  type WebServerRouteRegistrationDependencies,
} from './web-server-route-contracts.js';
import { rejectShareOnlyIfNeeded } from './web-server-route-guards.js';

interface AgentAuthoringApplyRequest {
  dryRun?: boolean;
  confirm?: string;
  agent?: {
    name?: unknown;
    content?: unknown;
    config?: unknown;
  };
  llmProfiles?: {
    upsert?: unknown;
    defaultProfileId?: unknown;
  };
  mcp?: {
    enabled?: unknown;
    upsert?: unknown;
    servers?: unknown;
    removeNames?: unknown;
  };
  toolsets?: {
    upsert?: unknown;
    custom?: unknown;
    removeNames?: unknown;
  };
}

type BuildPlanResult =
  | {
      ok: true;
      updates: Partial<AgentConfig>;
      agentWrite?: {
        name: string;
        dir: string;
        contentPath: string;
        configPath: string;
        content: string;
        config: AgentProfileConfig;
      };
      changes: {
        agent: boolean;
        llmProfiles: number;
        mcpServers: number;
        customToolsets: number;
      };
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details?: unknown;
    };

type AgentAuthoringWrite = NonNullable<Extract<BuildPlanResult, { ok: true }>['agentWrite']>;

interface AgentFileBackup {
  dirExisted: boolean;
  content: ExistingFileBackup;
  config: ExistingFileBackup;
}

type ExistingFileBackup =
  | { existed: true; content: Buffer }
  | { existed: false };

function buildAgentYamlSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      version: { type: 'integer', enum: [1] },
      description: { type: 'string' },
      llmProfileId: { type: 'string' },
      llmModel: { type: 'string' },
      reasoningPreset: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
      toolsetName: { type: 'string' },
      allowedTools: { type: 'array', items: { type: 'string' } },
      maxSteps: { type: 'integer', minimum: 1 },
      timeoutMs: { type: 'integer', minimum: 1 },
      loadGlobalSkills: { type: 'boolean' },
      exposeAsSubagent: { type: 'boolean' },
      promptAppend: { type: 'string' },
    },
  };
}

function redactRecordValues(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return Object.fromEntries(Object.keys(value).map((key) => [key, '[redacted]']));
}

function redactMcpServer(server: MCPServerConfig): MCPServerConfig {
  return {
    ...server,
    env: redactRecordValues(server.env),
    headers: redactRecordValues(server.headers),
  };
}

function ok(res: Response, payload: unknown): void {
  res.json(payload);
}

function fail(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeNameList(value: unknown): string[] {
  return asArray(value)
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

function safeAgentName(value: unknown): { ok: true; name: string } | { ok: false; message: string } {
  const name = String(value ?? '').trim();
  if (!name) {
    return { ok: false, message: 'agent.name is required' };
  }
  if (name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1F]/.test(name)) {
    return { ok: false, message: 'agent.name contains invalid path characters' };
  }
  return { ok: true, name };
}

function resolveAgentTargetDir(globalAgentsDir: string, name: string): string {
  const root = path.resolve(globalAgentsDir);
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('agent.name resolves outside globalAgentsDir');
  }
  return target;
}

function normalizeToolsetDefinition(raw: unknown): ToolsetDefinition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  const name = String(data.name ?? '').trim();
  const capabilities = asArray(data.capabilities)
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (!name || capabilities.length === 0) {
    return null;
  }
  return {
    name,
    description: String(data.description ?? '').trim() || `Custom toolset: ${name}`,
    capabilities: Array.from(new Set(capabilities)),
    ...(typeof data.allowUnknownTools === 'boolean' ? { allowUnknownTools: data.allowUnknownTools } : {}),
  };
}

function applyToolsetChanges(
  current: AgentConfig,
  raw: AgentAuthoringApplyRequest['toolsets']
): { ok: true; toolsets: NonNullable<AgentConfig['toolsets']>; count: number } | { ok: false; message: string } {
  if (!raw) {
    return { ok: true, toolsets: current.toolsets ?? { custom: [] }, count: 0 };
  }
  const builtins = new Set(DEFAULT_TOOLSETS.map((definition) => definition.name.trim().toLowerCase()));
  const byName = new Map<string, ToolsetDefinition>();
  for (const definition of current.toolsets?.custom ?? []) {
    byName.set(definition.name.trim().toLowerCase(), {
      ...definition,
      capabilities: [...definition.capabilities],
    });
  }
  for (const name of normalizeNameList(raw.removeNames)) {
    byName.delete(name.toLowerCase());
  }
  for (const entry of [...asArray(raw.upsert), ...asArray(raw.custom)]) {
    const definition = normalizeToolsetDefinition(entry);
    if (!definition) {
      return { ok: false, message: 'custom toolsets require name and capabilities' };
    }
    const normalizedName = definition.name.trim().toLowerCase();
    if (builtins.has(normalizedName)) {
      return { ok: false, message: `Custom toolset cannot override built-in toolset: ${definition.name}` };
    }
    byName.set(normalizedName, definition);
  }
  const custom = Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
  try {
    createToolsetRegistry(current.agent.defaultToolset, custom);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, toolsets: { custom }, count: asArray(raw.upsert).length + asArray(raw.custom).length };
}

function applyLlmProfileChanges(
  current: AgentConfig,
  raw: AgentAuthoringApplyRequest['llmProfiles']
): { llmProfiles: AgentConfig['llmProfiles']; count: number } {
  if (!raw) {
    return { llmProfiles: current.llmProfiles, count: 0 };
  }
  const normalizedCurrent = normalizeLlmProfilesConfig(current);
  const byId = new Map<string, LlmProviderProfileConfig>(
    normalizedCurrent.profiles.map((profile) => [profile.id, cloneAgentConfig(profile)])
  );
  let count = 0;
  for (const entry of asArray(raw.upsert)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const data = entry as Partial<LlmProviderProfileConfig>;
    const id = String(data.id ?? '').trim();
    if (!id) {
      continue;
    }
    const existing = byId.get(id);
    byId.set(id, {
      ...(existing ?? {}),
      ...data,
      id,
      apiKey: typeof data.apiKey === 'string' ? data.apiKey : existing?.apiKey ?? '',
    } as LlmProviderProfileConfig);
    count += 1;
  }
  return {
    llmProfiles: normalizeLlmProfilesConfig({
      llmProfiles: {
        defaultProfileId:
          typeof raw.defaultProfileId === 'string' && raw.defaultProfileId.trim().length > 0
            ? raw.defaultProfileId.trim()
            : normalizedCurrent.defaultProfileId,
        profiles: Array.from(byId.values()),
      },
    }),
    count,
  };
}

function normalizeMcpServer(raw: unknown): MCPServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const data = raw as Partial<MCPServerConfig>;
  const name = String(data.name ?? '').trim();
  const type = data.type === 'stdio' || data.type === 'sse' || data.type === 'http' ? data.type : undefined;
  if (!name || !type) {
    return null;
  }
  return {
    name,
    type,
    ...(typeof data.command === 'string' && data.command.trim() ? { command: data.command.trim() } : {}),
    ...(Array.isArray(data.args) ? { args: data.args.map((item) => String(item)) } : {}),
    ...(data.env && typeof data.env === 'object' ? { env: data.env as Record<string, string> } : {}),
    ...(typeof data.url === 'string' && data.url.trim() ? { url: data.url.trim() } : {}),
    ...(data.headers && typeof data.headers === 'object' ? { headers: data.headers as Record<string, string> } : {}),
    ...(typeof data.disabled === 'boolean' ? { disabled: data.disabled } : {}),
    ...(typeof data.connectTimeout === 'number' ? { connectTimeout: Math.max(1, Math.floor(data.connectTimeout)) } : {}),
    ...(typeof data.executeTimeout === 'number' ? { executeTimeout: Math.max(1, Math.floor(data.executeTimeout)) } : {}),
  };
}

function applyMcpChanges(
  current: AgentConfig,
  raw: AgentAuthoringApplyRequest['mcp']
): { ok: true; mcp: AgentConfig['mcp']; count: number } | { ok: false; message: string } {
  if (!raw) {
    return { ok: true, mcp: current.mcp, count: 0 };
  }
  const byName = new Map<string, MCPServerConfig>(
    current.mcp.servers.map((server) => [server.name.trim().toLowerCase(), cloneAgentConfig(server)])
  );
  for (const name of normalizeNameList(raw.removeNames)) {
    byName.delete(name.toLowerCase());
  }
  let count = 0;
  for (const entry of [...asArray(raw.upsert), ...asArray(raw.servers)]) {
    const server = normalizeMcpServer(entry);
    if (!server) {
      return { ok: false, message: 'MCP servers require name and type' };
    }
    byName.set(server.name.trim().toLowerCase(), server);
    count += 1;
  }
  return {
    ok: true,
    mcp: {
      ...current.mcp,
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      servers: Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name)),
    },
    count,
  };
}

function buildPlan(
  deps: WebServerRouteRegistrationDependencies,
  request: AgentAuthoringApplyRequest
): BuildPlanResult {
  const current = deps.agent.getConfig();
  const next = cloneAgentConfig(current);

  const toolsetResult = applyToolsetChanges(next, request.toolsets);
  if (!toolsetResult.ok) {
    return { ok: false, status: 400, code: 'INVALID_TOOLSET', message: toolsetResult.message };
  }
  next.toolsets = toolsetResult.toolsets;

  const llmResult = applyLlmProfileChanges(next, request.llmProfiles);
  next.llmProfiles = llmResult.llmProfiles;

  const mcpResult = applyMcpChanges(next, request.mcp);
  if (!mcpResult.ok) {
    return { ok: false, status: 400, code: 'INVALID_MCP', message: mcpResult.message };
  }
  next.mcp = mcpResult.mcp;

  let agentWrite: AgentAuthoringWrite | undefined;
  if (request.agent) {
    const nameResult = safeAgentName(request.agent.name);
    if (!nameResult.ok) {
      return { ok: false, status: 400, code: 'INVALID_AGENT_NAME', message: nameResult.message };
    }
    const globalAgentsDir = String(next.agent.globalAgentsDir ?? '').trim();
    if (!globalAgentsDir) {
      return { ok: false, status: 400, code: 'GLOBAL_AGENTS_DIR_MISSING', message: 'agent.globalAgentsDir is not configured' };
    }
    const content = String(request.agent.content ?? '').trim();
    if (!content) {
      return { ok: false, status: 400, code: 'INVALID_AGENT_CONTENT', message: 'agent.content is required' };
    }
    const normalized = normalizeAgentProfileConfig(request.agent.config ?? { version: 1 });
    if (normalized.warnings.length > 0) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_AGENT_CONFIG',
        message: normalized.warnings.join('; '),
        details: { warnings: normalized.warnings },
      };
    }
    const profileId = String(normalized.config.llmProfileId ?? '').trim();
    if (profileId && !findResolvedLlmProfile(next, profileId)) {
      return { ok: false, status: 400, code: 'UNKNOWN_LLM_PROFILE', message: `Unknown LLM profile: ${profileId}` };
    }
    const registry = createToolsetRegistry(next.agent.defaultToolset, next.toolsets?.custom ?? []);
    const toolsetName = String(normalized.config.toolsetName ?? '').trim();
    if (toolsetName && !registry.has(toolsetName)) {
      return { ok: false, status: 400, code: 'UNKNOWN_TOOLSET', message: `Unknown toolset: ${toolsetName}` };
    }
    let targetDir: string;
    try {
      targetDir = resolveAgentTargetDir(globalAgentsDir, nameResult.name);
    } catch (error) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_AGENT_NAME',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    agentWrite = {
      name: nameResult.name,
      dir: targetDir,
      contentPath: path.join(targetDir, 'AGENTS.md'),
      configPath: path.join(targetDir, 'agent.yaml'),
      content,
      config: {
        version: 1,
        ...normalized.config,
      },
    };
  }

  return {
    ok: true,
    updates: {
      llmProfiles: next.llmProfiles,
      mcp: next.mcp,
      toolsets: next.toolsets,
    },
    agentWrite,
    changes: {
      agent: Boolean(agentWrite),
      llmProfiles: llmResult.count,
      mcpServers: mcpResult.count,
      customToolsets: toolsetResult.count,
    },
  };
}

function writeAgentFiles(input: AgentAuthoringWrite): void {
  fs.mkdirSync(input.dir, { recursive: true });
  fs.writeFileSync(input.contentPath, `${input.content.replace(/\s+$/u, '')}\n`, 'utf8');
  writeAgentProfileConfig(input.configPath, input.config);
}

function backupExistingFile(filePath: string): ExistingFileBackup {
  if (!fs.existsSync(filePath)) {
    return { existed: false };
  }
  return { existed: true, content: fs.readFileSync(filePath) };
}

function backupAgentFiles(input: AgentAuthoringWrite): AgentFileBackup {
  return {
    dirExisted: fs.existsSync(input.dir),
    content: backupExistingFile(input.contentPath),
    config: backupExistingFile(input.configPath),
  };
}

function restoreExistingFile(filePath: string, backup: ExistingFileBackup): void {
  if (backup.existed) {
    fs.writeFileSync(filePath, backup.content);
  } else {
    fs.rmSync(filePath, { force: true });
  }
}

function restoreAgentFiles(input: AgentAuthoringWrite, backup: AgentFileBackup): void {
  if (!backup.dirExisted) {
    fs.rmSync(input.dir, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(input.dir, { recursive: true });
  restoreExistingFile(input.contentPath, backup.content);
  restoreExistingFile(input.configPath, backup.config);
}

function projectAgentWrite(agentWrite: AgentAuthoringWrite | undefined): { name: string; path: string; configPath: string } | undefined {
  if (!agentWrite) {
    return undefined;
  }
  return {
    name: agentWrite.name,
    path: agentWrite.contentPath,
    configPath: agentWrite.configPath,
  };
}

export function registerAgentAuthoringRoutes(deps: WebServerRouteRegistrationDependencies): void {
  deps.app.get('/api/agent-authoring/capabilities', (req: Request, res: Response) => {
    if (rejectShareOnlyIfNeeded(deps, req, res)) {
      return;
    }
    const config = deps.agent.getConfig();
    ok(res, {
      globalAgentsDir: config.agent.globalAgentsDir ?? '',
      agentYamlSchema: buildAgentYamlSchema(),
      llmProfiles: serializeLlmProfiles(config),
      mcp: {
        ...config.mcp,
        servers: config.mcp.servers.map((server) => redactMcpServer(server)),
      },
      toolsets: deps.agent.listToolsets(),
      tools: deps.agent.getToolRegistry()?.getSchemas() ?? [],
    });
  });

  deps.app.post('/api/agent-authoring/apply', async (req: Request, res: Response) => {
    if (rejectShareOnlyIfNeeded(deps, req, res)) {
      return;
    }
    const request = (req.body ?? {}) as AgentAuthoringApplyRequest;
    const dryRun = request.dryRun === true;
    if (!dryRun && request.confirm !== 'yes') {
      fail(res, 400, 'CONFIRM_REQUIRED', 'confirm must be "yes" for non-dry-run authoring apply');
      return;
    }
    const plan = buildPlan(deps, request);
    if (!plan.ok) {
      fail(res, plan.status, plan.code, plan.message, plan.details);
      return;
    }
    if (dryRun) {
      ok(res, {
        success: true,
        dryRun: true,
        changes: plan.changes,
        agent: projectAgentWrite(plan.agentWrite),
      });
      return;
    }

    const previousConfig = cloneAgentConfig(deps.agent.getConfig());
    const mutationService = new ConfigMutationService(deps.agent, deps.configServices);
    const fileBackup = plan.agentWrite ? backupAgentFiles(plan.agentWrite) : undefined;
    try {
      if (plan.agentWrite) {
        writeAgentFiles(plan.agentWrite);
      }
      await mutationService.apply({ updates: plan.updates });
      if (plan.agentWrite) {
        deps.agentCatalogServices.refreshGlobalAgentCatalog();
      }
      ok(res, {
        success: true,
        dryRun: false,
        changes: plan.changes,
        agent: projectAgentWrite(plan.agentWrite),
      });
    } catch (error) {
      if (plan.agentWrite && fileBackup) {
        try {
          restoreAgentFiles(plan.agentWrite, fileBackup);
        } catch {
          // Keep the response focused on the authoring failure.
        }
      }
      deps.agent.updateConfig({
        llmProfiles: previousConfig.llmProfiles,
        mcp: previousConfig.mcp,
        toolsets: previousConfig.toolsets,
      });
      try {
        deps.configServices.persistConfigFile(previousConfig);
      } catch {
        // Keep the response focused on the authoring failure.
      }
      fail(
        res,
        500,
        'AUTHORING_APPLY_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}
