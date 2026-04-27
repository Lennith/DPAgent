import * as path from 'path';
import { LLMClient, type PreparedMessagesSnapshot } from '../llm/index.js';
import {
  type Tool,
  type ToolSource,
  ToolRegistry,
  createFileTools,
  createWebTools,
  createShellTool,
  PermissionManager,
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamilyForTool,
} from '../tools/index.js';
import { MCPConnector, SharedMcpRuntimePool, type SharedMcpRuntimeLease } from '../mcp/index.js';
import type { MCPRuntimeConfig } from '../config/ConfigManager.js';
import type { AgentConfig, ResolvedLlmRuntimeConfig } from '../types.js';
import { agentLogger } from '../utils/logger.js';

export interface BootstrapMiniMaxRuntimeInput {
  config: AgentConfig;
  llmRuntime?: ResolvedLlmRuntimeConfig;
  mcpRuntime: MCPRuntimeConfig;
  runtimeDataDir: string;
  extraReadableDirs: string[];
  maxOutputTokens: number;
  onPreparedMessages: (snapshot: PreparedMessagesSnapshot) => void;
}

export interface BootstrapMiniMaxRuntimeResult {
  llmClient: LLMClient;
  permissionManager: PermissionManager;
  toolRegistry: ToolRegistry;
  mcpConnector: MCPConnector | null;
  mcpRuntimeLease: SharedMcpRuntimeLease | null;
  mcpToolDescriptions: string;
}

export async function bootstrapMiniMaxRuntime(
  input: BootstrapMiniMaxRuntimeInput
): Promise<BootstrapMiniMaxRuntimeResult> {
  const resolvedLlmRuntime = input.llmRuntime;
  const llmClient = new LLMClient({
    apiKey: resolvedLlmRuntime?.apiKey ?? input.config.api.apiKey,
    apiBase: resolvedLlmRuntime?.apiBase ?? input.config.api.apiBase,
    model: resolvedLlmRuntime?.model ?? input.config.api.model,
    maxTokens: resolvedLlmRuntime?.maxOutputTokens ?? input.maxOutputTokens,
    provider: resolvedLlmRuntime?.provider ?? input.config.api.provider,
    llmRuntime: resolvedLlmRuntime,
    onPreparedMessages: input.onPreparedMessages,
  });

  const permissionManager = new PermissionManager({
    workspaceDir: input.config.agent.workspaceDir,
    additionalWritableDirs: [],
  });
  for (const dir of input.extraReadableDirs) {
    permissionManager.addReadableDir(dir);
    agentLogger.info(`Added readable directory whitelist: ${dir}`);
  }

  const toolRegistry = new ToolRegistry();
  const registrationState = createToolRegistrationState();
  const activeMcpTools: Tool[] = [];
  const registerWithDedupe = (tool: Tool, source: ToolSource): void => {
    const capability = resolveToolCapabilityFamilyForTool(tool);
    const result = registerToolWithDedupe(toolRegistry, registrationState, tool, source);
    if (result.skipped) {
      agentLogger.info(
        `[MiniMaxAgent] Tool skipped: name=${tool.name} source=${source} capability=${capability} reason=${result.reason} kept=${result.keptToolName ?? ''}`
      );
      return;
    }
    if (result.replaced) {
      agentLogger.info(
        `[MiniMaxAgent] Tool replaced: capability=${capability} next=${tool.name}(${source}) prev=${result.replaced.toolName}(${result.replaced.source})`
      );
    } else {
      agentLogger.info(
        `[MiniMaxAgent] Tool registered: name=${tool.name} source=${source} capability=${capability}`
      );
    }
    if (source === 'team') {
      activeMcpTools.push(tool);
    }
  };

  if (input.config.tools.enableFileTools) {
    const fileTools = createFileTools({
      workspaceDir: input.config.agent.workspaceDir,
      checkPermission: permissionManager.createPermissionChecker(),
      exemptDirs: input.extraReadableDirs,
    });
    for (const tool of fileTools) {
      registerWithDedupe(tool, 'core');
    }
  }

  if (input.config.tools.enableWeb) {
    const webTools = createWebTools();
    for (const tool of webTools) {
      registerWithDedupe(tool, 'core');
    }
  }

  if (input.config.tools.enableShell) {
    const shellTool = createShellTool({
      workspaceDir: input.config.agent.workspaceDir,
      shell: input.config.tools.shellType,
      timeout: input.config.tools.shellTimeout,
      outputIdleTimeout: 120000,
      maxRunTime: 3600000,
      maxOutputSize: 52428800,
      logDir: path.join(input.runtimeDataDir, 'shell-logs'),
      checkPermission: permissionManager.createPermissionChecker(),
    });
    registerWithDedupe(shellTool, 'core');
  }

  let mcpRuntimeLease: SharedMcpRuntimeLease | null = null;
  let mcpConnector: MCPConnector | null = null;
  if (input.mcpRuntime.enabled && input.mcpRuntime.servers.length > 0) {
    agentLogger.info(`Initializing MCP with ${input.mcpRuntime.servers.length} servers...`);
    try {
      mcpRuntimeLease = await SharedMcpRuntimePool.acquire(input.mcpRuntime);
      mcpConnector = mcpRuntimeLease?.connector ?? null;
      const mcpTools = mcpRuntimeLease?.tools ?? [];
      agentLogger.info(`Shared MCP runtime acquired: reused=${mcpRuntimeLease?.reused === true}`);
      agentLogger.info(`Loaded ${mcpTools.length} MCP tools: ${mcpTools.map((tool) => tool.name).join(', ')}`);
      for (const tool of mcpTools) {
        registerWithDedupe(tool, 'team');
      }
    } catch (error) {
      agentLogger.error(`Failed to load MCP tools: ${error}`);
      mcpRuntimeLease = null;
      mcpConnector = null;
    }
  } else {
    agentLogger.info('MCP disabled or no servers configured');
  }

  const mcpToolDescriptions =
    activeMcpTools.length > 0
      ? activeMcpTools.map((tool) => `- **${tool.name}**: ${tool.description}`).join('\n')
      : '';

  return {
    llmClient,
    permissionManager,
    toolRegistry,
    mcpConnector,
    mcpRuntimeLease,
    mcpToolDescriptions,
  };
}
