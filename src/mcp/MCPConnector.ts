import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpLogger } from '../utils/logger.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Tool, successResult, errorResult } from '../tools/Tool.js';
import type { ToolResult, MCPServerConfig } from '../types.js';
import { ManagedInterval, retryWithBackoff, withTimeout } from '../runtime/async-primitives.js';

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000] as const;

export type MCPServerRuntimeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disabled';

export interface MCPServerStatusSnapshot {
  name: string;
  status: MCPServerRuntimeStatus;
  toolCount: number;
  retryCount: number;
  lastError?: string;
  updatedAt: string;
  disabled: boolean;
}

export interface MCPStatusSummary {
  state: 'connected' | 'degraded' | 'idle' | 'disabled';
  connectedCount: number;
  totalEnabled: number;
}

export interface MCPStatusSnapshot {
  summary: MCPStatusSummary;
  servers: MCPServerStatusSnapshot[];
}

export interface MCPToolOptions {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  connector: MCPConnector;
  serverName: string;
  timeout?: number;
}

interface MCPServerRuntimeState {
  status: MCPServerRuntimeStatus;
  toolCount: number;
  retryCount: number;
  lastError?: string;
  updatedAt: string;
}

export class MCPTool extends Tool {
  private _name: string;
  private _description: string;
  private _parameters: Record<string, unknown>;
  private connector: MCPConnector;
  private serverName: string;
  private timeout: number;

  constructor(options: MCPToolOptions) {
    super();
    this._name = options.name;
    this._description = options.description;
    this._parameters = options.parameters;
    this.connector = options.connector;
    this.serverName = options.serverName;
    this.timeout = options.timeout ?? 60000;
  }

  get name(): string {
    return this._name;
  }

  get description(): string {
    return this._description;
  }

  get parameters(): Record<string, unknown> {
    return this._parameters;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.connector.callTool(this.serverName, this._name, args, this.timeout);
      const content = this.extractContent(result);
      const isError = result.isError ?? false;
      if (isError) {
        return errorResult(content);
      }
      return successResult(content);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return errorResult(`MCP tool execution failed: ${errorMessage}`);
    }
  }

  private extractContent(result: any): string {
    if (!result?.content) {
      return '';
    }
    const parts: string[] = [];
    for (const item of result.content as Array<{ type: string; text?: string }>) {
      if (item.type === 'text') {
        parts.push(item.text ?? '');
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n');
  }
}

export interface MCPServerConnection {
  name: string;
  config: MCPServerConfig;
  client: Client | null;
  transport: Transport | null;
  tools: MCPTool[];
  state: MCPServerRuntimeState;
}

interface MCPConnectorOptions {
  connectTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export class MCPConnector {
  private connections: Map<string, MCPServerConnection> = new Map();
  private reconnectLocks: Map<string, Promise<boolean>> = new Map();
  private defaultExecuteTimeoutMs: number;
  private connectTimeoutMs: number;
  private healthCheckIntervalMs: number;
  private readonly healthCheckTimer = new ManagedInterval();
  private healthCheckInProgress = false;

  constructor(defaultExecuteTimeoutMs: number = 60000, options: MCPConnectorOptions = {}) {
    this.defaultExecuteTimeoutMs = defaultExecuteTimeoutMs;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  }

  async connect(config: MCPServerConfig): Promise<MCPTool[]> {
    if (this.connections.has(config.name)) {
      await this.disconnect(config.name);
    }

    const connection = this.createConnection(config);
    this.connections.set(config.name, connection);

    if (config.disabled) {
      this.updateStatus(connection, 'disabled');
      mcpLogger.info(`MCP server "${config.name}" is disabled, skipping`);
      return [];
    }

    this.updateStatus(connection, 'connecting');
    mcpLogger.mcpConnect(config.name, 'connecting', 'initializing');
    const success = await this.establishConnection(connection, {
      maxAttempts: 1,
      reason: 'initial_connect',
      createToolsIfMissing: true,
    });
    if (!success) {
      return [];
    }
    return connection.tools;
  }

  async connectAll(servers: MCPServerConfig[]): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];
    for (const server of servers) {
      const tools = await this.connect(server);
      allTools.push(...tools);
    }

    if (this.hasAnyEnabledServer()) {
      this.startHealthCheck();
    } else {
      this.stopHealthCheck();
    }
    return allTools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<any> {
    const effectiveTimeout = timeoutMs ?? this.defaultExecuteTimeoutMs;
    try {
      return await this.callToolOnce(serverName, toolName, args, effectiveTimeout);
    } catch (err) {
      const errorMessage = this.errorToMessage(err);
      const connection = this.connections.get(serverName);
      if (connection) {
        this.updateStatus(connection, 'failed', { lastError: errorMessage });
      }
      mcpLogger.mcpConnect(serverName, 'failed', `tool call failed: ${errorMessage}`);

      const reconnected = await this.reconnectServer(serverName, 'tool_call_failed');
      if (!reconnected) {
        throw new Error(`MCP server "${serverName}" reconnect failed after tool error: ${errorMessage}`);
      }
      return await this.callToolOnce(serverName, toolName, args, effectiveTimeout);
    }
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }
    await this.closeConnectionTransport(connection);
    this.connections.delete(name);
    if (!this.hasAnyEnabledServer()) {
      this.stopHealthCheck();
    }
  }

  async disconnectAll(): Promise<void> {
    this.stopHealthCheck();
    const names = Array.from(this.connections.keys());
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  getConnection(name: string): MCPServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const connection of this.connections.values()) {
      tools.push(...connection.tools);
    }
    return tools;
  }

  getStatusSnapshot(): MCPStatusSnapshot {
    const servers = Array.from(this.connections.values()).map((connection) => ({
      name: connection.name,
      status: connection.state.status,
      toolCount: connection.state.toolCount,
      retryCount: connection.state.retryCount,
      lastError: connection.state.lastError,
      updatedAt: connection.state.updatedAt,
      disabled: connection.config.disabled === true,
    }));
    return {
      summary: this.computeStatusSummary(servers),
      servers,
    };
  }

  private createConnection(config: MCPServerConfig): MCPServerConnection {
    return {
      name: config.name,
      config,
      client: null,
      transport: null,
      tools: [],
      state: {
        status: config.disabled ? 'disabled' : 'idle',
        toolCount: 0,
        retryCount: 0,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private async callToolOnce(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<any> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (connection.config.disabled) {
      throw new Error(`MCP server "${serverName}" is disabled`);
    }
    if (!connection.client) {
      const reconnected = await this.reconnectServer(serverName, 'missing_client');
      if (!reconnected) {
        throw new Error(`MCP server "${serverName}" is disconnected`);
      }
    }

    const liveConnection = this.connections.get(serverName);
    if (!liveConnection?.client) {
      throw new Error(`MCP server "${serverName}" has no active client`);
    }

    mcpLogger.mcpToolCall(toolName, serverName);
    const result = await withTimeout(
      liveConnection.client.callTool({ name: toolName, arguments: args }),
      timeoutMs,
      `Timeout after ${timeoutMs}ms`
    );
    return result;
  }

  private async reconnectServer(serverName: string, reason: string): Promise<boolean> {
    const existing = this.reconnectLocks.get(serverName);
    if (existing) {
      return await existing;
    }

    const reconnectPromise = this.performReconnect(serverName, reason);
    this.reconnectLocks.set(serverName, reconnectPromise);
    try {
      return await reconnectPromise;
    } finally {
      this.reconnectLocks.delete(serverName);
    }
  }

  private async performReconnect(serverName: string, reason: string): Promise<boolean> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return false;
    }
    if (connection.config.disabled) {
      this.updateStatus(connection, 'disabled');
      return false;
    }

    this.updateStatus(connection, 'reconnecting');
    mcpLogger.mcpConnect(serverName, 'connecting', `reconnecting (${reason})`);
    await this.closeConnectionTransport(connection);

    const success = await this.establishConnection(connection, {
      maxAttempts: RECONNECT_BACKOFF_MS.length,
      reason,
      createToolsIfMissing: false,
    });
    if (!success) {
      this.updateStatus(connection, 'failed', {
        retryCount: RECONNECT_BACKOFF_MS.length,
      });
    }
    return success;
  }

  private async establishConnection(
    connection: MCPServerConnection,
    options: {
      maxAttempts: number;
      reason: string;
      createToolsIfMissing: boolean;
    }
  ): Promise<boolean> {
    let lastError: string | undefined;

    try {
      await retryWithBackoff({
        maxAttempts: options.maxAttempts,
        delaysMs: RECONNECT_BACKOFF_MS,
        run: async (attempt) => {
      this.updateStatus(connection, 'reconnecting', { retryCount: attempt });
        const transport = await this.createTransport(connection.config);
        const client = new Client(
          { name: 'dpagent', version: '1.0.0' },
          { capabilities: {} }
        );

        await withTimeout(
          client.connect(transport),
          this.connectTimeoutMs,
          `MCP connect timeout after ${this.connectTimeoutMs}ms`
        );
        const toolsResult = await withTimeout(
          client.listTools(),
          this.defaultExecuteTimeoutMs,
          'MCP listTools timeout'
        );

        connection.transport = transport;
        connection.client = client;
        connection.state.toolCount = toolsResult.tools.length;

        if (options.createToolsIfMissing && connection.tools.length === 0) {
          connection.tools = toolsResult.tools.map(
            (tool) =>
              new MCPTool({
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.inputSchema as Record<string, unknown>,
                connector: this,
                serverName: connection.name,
                timeout: connection.config.executeTimeout
                  ? connection.config.executeTimeout * 1000
                  : this.defaultExecuteTimeoutMs,
              })
          );
        }

        this.updateStatus(connection, 'connected', {
          retryCount: attempt,
          toolCount: connection.state.toolCount,
          lastError: undefined,
        });
        mcpLogger.mcpConnect(
          connection.name,
          'connected',
          `loaded ${connection.state.toolCount} tools (reason=${options.reason}, attempt=${attempt})`
        );
        return true;
        },
        onFailedAttempt: (err, attempt) => {
          lastError = this.errorToMessage(err);
          this.updateStatus(connection, 'reconnecting', {
            retryCount: attempt,
            lastError,
          });
        }
      });
      return true;
    } catch {
      // lastError is captured by onFailedAttempt for status reporting.
    }

    this.updateStatus(connection, 'failed', {
      retryCount: Math.max(1, options.maxAttempts),
      lastError,
    });
    mcpLogger.mcpConnect(
      connection.name,
      'failed',
      `connection failed (reason=${options.reason})${lastError ? `: ${lastError}` : ''}`
    );
    return false;
  }

  private async runHealthCheck(): Promise<void> {
    if (this.healthCheckInProgress) {
      return;
    }
    this.healthCheckInProgress = true;

    try {
      for (const connection of this.connections.values()) {
        if (connection.config.disabled) {
          this.updateStatus(connection, 'disabled');
          continue;
        }
        if (connection.state.status === 'connecting' || connection.state.status === 'reconnecting') {
          continue;
        }

        if (!connection.client) {
          await this.reconnectServer(connection.name, 'health_missing_client');
          continue;
        }

        try {
          const toolsResult = await withTimeout(
            connection.client.listTools(),
            this.defaultExecuteTimeoutMs,
            'MCP health-check listTools timeout'
          );
          this.updateStatus(connection, 'connected', {
            toolCount: toolsResult.tools.length,
          });
        } catch (err) {
          const errorMessage = this.errorToMessage(err);
          this.updateStatus(connection, 'failed', {
            lastError: errorMessage,
          });
          mcpLogger.mcpConnect(connection.name, 'failed', `health check failed: ${errorMessage}`);
          await this.reconnectServer(connection.name, 'health_check_failed');
        }
      }
    } finally {
      this.healthCheckInProgress = false;
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer.active) {
      return;
    }
    this.healthCheckTimer.start(() => {
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  private stopHealthCheck(): void {
    this.healthCheckTimer.clear();
  }

  private hasAnyEnabledServer(): boolean {
    for (const connection of this.connections.values()) {
      if (!connection.config.disabled) {
        return true;
      }
    }
    return false;
  }

  private computeStatusSummary(servers: MCPServerStatusSnapshot[]): MCPStatusSummary {
    const enabledServers = servers.filter((server) => !server.disabled);
    const connectedCount = enabledServers.filter((server) => server.status === 'connected').length;
    const totalEnabled = enabledServers.length;

    if (totalEnabled === 0) {
      return {
        state: 'disabled',
        connectedCount,
        totalEnabled,
      };
    }
    if (connectedCount > 0) {
      return {
        state: 'connected',
        connectedCount,
        totalEnabled,
      };
    }
    const hasNonIdle = enabledServers.some((server) =>
      server.status === 'failed' || server.status === 'connecting' || server.status === 'reconnecting'
    );
    return {
      state: hasNonIdle ? 'degraded' : 'idle',
      connectedCount,
      totalEnabled,
    };
  }

  private updateStatus(
    connection: MCPServerConnection,
    status: MCPServerRuntimeStatus,
    updates: {
      toolCount?: number;
      retryCount?: number;
      lastError?: string;
    } = {}
  ): void {
    connection.state.status = status;
    if (updates.toolCount !== undefined) {
      connection.state.toolCount = updates.toolCount;
    }
    if (updates.retryCount !== undefined) {
      connection.state.retryCount = updates.retryCount;
    }
    if (updates.lastError !== undefined) {
      connection.state.lastError = updates.lastError;
    }
    if (status === 'connected' && updates.lastError === undefined) {
      connection.state.lastError = undefined;
    }
    connection.state.updatedAt = new Date().toISOString();
  }

  private async closeConnectionTransport(connection: MCPServerConnection): Promise<void> {
    if (connection.client) {
      try {
        await connection.client.close();
      } catch {
        // best effort close
      }
    }
    connection.client = null;
    connection.transport = null;
  }

  private async createTransport(config: MCPServerConfig): Promise<Transport> {
    if (config.type === 'stdio') {
      if (!config.command) {
        throw new Error('Command is required for stdio MCP server');
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: this.resolveTransportEnv(config.env),
      });
    }

    if (config.type === 'sse' && config.url) {
      return new SSEClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } }
      );
    }

    throw new Error(`Unsupported MCP server type: ${config.type}`);
  }

  private resolveTransportEnv(configuredEnv?: Record<string, string>): Record<string, string> {
    if (configuredEnv) {
      return { ...configuredEnv };
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    return env;
  }

  private errorToMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

export function createMCPConnector(defaultTimeout?: number): MCPConnector {
  return new MCPConnector(defaultTimeout);
}
