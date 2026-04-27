import * as assert from 'node:assert/strict';
import { MCPConnector } from '../../src/mcp/MCPConnector.js';

type MutableConnection = {
  name: string;
  config: {
    name: string;
    type: 'stdio';
    command: string;
    args: string[];
  };
  client: {
    callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
    listTools: () => Promise<{ tools: Array<unknown> }>;
    close: () => Promise<void>;
  } | null;
  transport: null;
  tools: unknown[];
  state: {
    status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disabled';
    toolCount: number;
    retryCount: number;
    updatedAt: string;
    lastError?: string;
  };
};

function createConnection(client: MutableConnection['client']): MutableConnection {
  return {
    name: 'test-mcp',
    config: {
      name: 'test-mcp',
      type: 'stdio',
      command: 'uvx',
      args: ['test-mcp', '-y'],
    },
    client,
    transport: null,
    tools: [],
    state: {
      status: 'connected',
      toolCount: 1,
      retryCount: 0,
      updatedAt: new Date().toISOString(),
    },
  };
}

async function testCallToolRetriesAfterReconnectOnFailure(): Promise<void> {
  const connector = new MCPConnector(1000);

  const failingClient = {
    callTool: async () => {
      throw new Error('simulated_call_failure');
    },
    listTools: async () => ({ tools: [] }),
    close: async () => {},
  };
  const healthyClient = {
    callTool: async (input: { name: string; arguments: Record<string, unknown> }) => ({
      isError: false,
      content: [{ type: 'text', text: `${input.name}:${String(input.arguments.value ?? '')}` }],
    }),
    listTools: async () => ({ tools: [] }),
    close: async () => {},
  };

  const connection = createConnection(failingClient);
  (connector as any).connections.set(connection.name, connection);

  let reconnectCalls = 0;
  (connector as any).reconnectServer = async (serverName: string, reason: string) => {
    reconnectCalls += 1;
    assert.equal(serverName, 'test-mcp');
    assert.equal(reason, 'tool_call_failed');
    connection.client = healthyClient;
    (connector as any).updateStatus(connection, 'connected', { retryCount: 1, toolCount: 1, lastError: undefined });
    return true;
  };

  const result = await connector.callTool('test-mcp', 'echo', { value: 42 }, 1000);
  assert.equal(reconnectCalls, 1);
  assert.equal(connection.state.status, 'connected');
  assert.deepEqual(result, {
    isError: false,
    content: [{ type: 'text', text: 'echo:42' }],
  });
}

async function testHealthCheckFailureTriggersReconnect(): Promise<void> {
  const connector = new MCPConnector(1000);
  const flakyClient = {
    callTool: async () => ({ isError: false, content: [] }),
    listTools: async () => {
      throw new Error('health_check_failed');
    },
    close: async () => {},
  };
  const connection = createConnection(flakyClient);
  (connector as any).connections.set(connection.name, connection);

  let reconnectCalls = 0;
  (connector as any).reconnectServer = async (serverName: string, reason: string) => {
    reconnectCalls += 1;
    assert.equal(serverName, 'test-mcp');
    assert.equal(reason, 'health_check_failed');
    (connector as any).updateStatus(connection, 'connected', { retryCount: 1, toolCount: 1, lastError: undefined });
    return true;
  };

  await (connector as any).runHealthCheck();
  assert.equal(reconnectCalls, 1);
  assert.equal(connection.state.status, 'connected');
}

async function runAll(): Promise<void> {
  await testCallToolRetriesAfterReconnectOnFailure();
  await testHealthCheckFailureTriggersReconnect();
  console.log('mcp-connector-reconnect tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
