import { DPAgent } from '../../dpagent-runtime.js';
import { resolveLlmRuntimeConfig, resolveSessionLlmSelection } from '../../llm/provider-profiles.js';
import type {
  ContextRef,
  MCPServerConfig,
  ResolvedLlmRuntimeConfig,
  SessionLlmSelection,
  SessionLlmSelectionInput,
} from '../../types.js';
import type { SessionRuntime } from './web-server-runtime-contracts.js';

export interface WebServerSessionRuntimeHost {
  agent: DPAgent;
  sessionRuntimes: Map<string, SessionRuntime>;
  bootMissingApiKey: boolean;
  getContextNamespaceMetaSafe(context: ContextRef): { llmSelection?: SessionLlmSelection | SessionLlmSelectionInput | null } | undefined;
  buildSessionRuntimeKey(
    workspaceDir: string,
    llmSelection: SessionLlmSelection,
    llmRuntime: ResolvedLlmRuntimeConfig,
    externalMcpServers?: MCPServerConfig[]
  ): string;
  getSessionRuntime(sessionId: string): SessionRuntime | undefined;
  hasActiveRunForContext(context: ContextRef): boolean;
  cleanupSessionRuntime(sessionId: string, options?: { cancelActive?: boolean; cancelReason?: string }): Promise<void>;
  installDownloadLinkIssuer(agent: DPAgent): void;
  cloneRuntimeConfig(
    workspaceDir: string,
    llmRuntime?: ResolvedLlmRuntimeConfig,
    externalMcpServers?: MCPServerConfig[]
  ): ReturnType<DPAgent['getConfig']>;
  cloneExternalMcpServers(servers: MCPServerConfig[] | undefined): MCPServerConfig[];
  touchSessionRuntime(sessionId: string): void;
}

export async function ensureWebServerSessionRuntime(
  host: WebServerSessionRuntimeHost,
  sessionId: string,
  workspaceDir: string,
  llmRuntime?: ResolvedLlmRuntimeConfig,
  llmSelection?: SessionLlmSelection,
  externalMcpServers?: MCPServerConfig[]
): Promise<{ agent: DPAgent; reused: boolean }> {
  const context: ContextRef = {
    scope: 'session',
    namespace: sessionId,
  };
  const resolvedLlmSelection =
    llmSelection ?? resolveSessionLlmSelection(host.agent.getConfig(), host.getContextNamespaceMetaSafe(context)?.llmSelection);
  const resolvedLlmRuntime =
    llmRuntime ?? resolveLlmRuntimeConfig(host.agent.getConfig(), resolvedLlmSelection);
  const runtimeKey = host.buildSessionRuntimeKey(
    workspaceDir,
    resolvedLlmSelection,
    resolvedLlmRuntime,
    externalMcpServers
  );
  const existing = host.getSessionRuntime(sessionId);
  if (existing?.configDirty && !host.hasActiveRunForContext(context)) {
    await host.cleanupSessionRuntime(sessionId, {
      cancelActive: false,
      cancelReason: 'system_config_reload',
    });
  }
  const current = host.getSessionRuntime(sessionId);
  if (current && current.runtimeKey === runtimeKey) {
    host.installDownloadLinkIssuer(current.agent);
    await current.agent.initialize();
    host.touchSessionRuntime(sessionId);
    return {
      agent: current.agent,
      reused: true,
    };
  }

  if (current) {
    await host.cleanupSessionRuntime(sessionId);
  }

  const nextAgent = new DPAgent({
    config: host.cloneRuntimeConfig(workspaceDir, resolvedLlmRuntime, externalMcpServers),
    allowMissingApiKeyAtBoot: host.bootMissingApiKey,
    llmRuntime: resolvedLlmRuntime,
  });
  host.installDownloadLinkIssuer(nextAgent);
  await nextAgent.initialize();
  host.sessionRuntimes.set(sessionId, {
    agent: nextAgent,
    workspaceDir,
    runtimeKey,
    llmRuntime: resolvedLlmRuntime,
    externalMcpServers: host.cloneExternalMcpServers(externalMcpServers),
    lastUsedAt: new Date().toISOString(),
  });
  return {
    agent: nextAgent,
    reused: false,
  };
}
