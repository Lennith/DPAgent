import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import { MCPConnector, SharedMcpRuntimePool } from '../../src/mcp/index.js';
import type { AgentConfig } from '../../src/types.js';

function createHarness(prefix: string): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createConfig(harness: ReturnType<typeof createHarness>): Partial<AgentConfig> {
  return {
    api: {
      apiKey: 'sk-cp-test-api-key-12345678901234567890',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      provider: 'anthropic',
      maxOutputTokens: 32768,
    },
    agent: {
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
      defaultToolset: 'full-access',
      skillWriteMode: 'auto',
      globalAgentsDir: path.join(harness.tempDir, 'agents'),
      maxSteps: 10,
      tokenLimit: 40000,
      subAgentMaxParallelPerParent: 2,
      subAgentGlobalMaxParallel: 4,
    },
    tools: {
      enableFileTools: false,
      enableWeb: false,
      enableShell: false,
      shellType: 'powershell',
      shellTimeout: 30000,
    },
    mcp: {
      enabled: true,
      servers: [
        {
          name: 'shared-mcp',
          type: 'stdio',
          command: 'uvx',
          args: ['shared-mcp', '-y'],
        },
      ],
      connectTimeout: 10,
      executeTimeout: 60,
    },
  };
}

async function testAgentsReuseSingleSharedMcpConnection(): Promise<void> {
  const harness = createHarness('mcp-shared-runtime');
  const originalConnectAll = MCPConnector.prototype.connectAll;
  const originalDisconnectAll = MCPConnector.prototype.disconnectAll;
  let connectCalls = 0;
  let disconnectCalls = 0;

  MCPConnector.prototype.connectAll = async function (servers) {
    connectCalls += 1;
    return originalConnectAll.call(this, servers.slice(0, 0));
  };
  MCPConnector.prototype.disconnectAll = async function () {
    disconnectCalls += 1;
    return originalDisconnectAll.call(this);
  };

  try {
    const config = createConfig(harness);
    const first = new MiniMaxAgent({ config });
    const second = new MiniMaxAgent({ config });

    await first.initialize();
    await second.initialize();

    assert.equal(connectCalls, 1);
    assert.equal((first as any).mcpConnector, (second as any).mcpConnector);

    await first.cleanup();
    assert.equal(disconnectCalls, 0);

    await second.cleanup();
    assert.equal(disconnectCalls, 1);
  } finally {
    MCPConnector.prototype.connectAll = originalConnectAll;
    MCPConnector.prototype.disconnectAll = originalDisconnectAll;
    await SharedMcpRuntimePool.resetForTests();
    cleanupHarness(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testAgentsReuseSingleSharedMcpConnection();
  console.log('mcp-shared-runtime tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
