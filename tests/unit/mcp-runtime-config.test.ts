import * as assert from 'node:assert/strict';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import type { MCPServerConfig } from '../../src/types.js';

const API_KEY = 'sk-cp-test-api-key-12345678901234567890';
const API_BASE = 'https://api.minimaxi.com';

function createConfigManager(overrides?: {
  mcp?: {
    enabled?: boolean;
    servers?: MCPServerConfig[];
  };
}): ConfigManager {
  return new ConfigManager({
    api: {
      apiKey: API_KEY,
      apiBase: API_BASE,
      model: 'MiniMax-M2.7-highspeed',
      provider: 'anthropic',
      maxOutputTokens: 32768,
    },
    mcp: {
      enabled: overrides?.mcp?.enabled ?? false,
      servers: overrides?.mcp?.servers ?? [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
  });
}

function testDisablesMcpWhenNoServerConfigured(): void {
  const manager = createConfigManager({
    mcp: {
      enabled: false,
      servers: [],
    },
  });
  const runtime = manager.getMcpRuntimeConfig();
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.servers.length, 0);
}

function testConfiguredServerGetsApiFallbackEnv(): void {
  const manager = createConfigManager({
    mcp: {
      enabled: true,
      servers: [
        {
          name: 'custom-mcp',
          type: 'stdio',
          command: 'uvx',
          args: ['custom-mcp', '-y'],
        },
      ],
    },
  });
  const runtime = manager.getMcpRuntimeConfig();
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.servers.length, 1);
  const server = runtime.servers[0];
  assert.equal(server.env?.MINIMAX_API_KEY, API_KEY);
  assert.equal(server.env?.MINIMAX_API_HOST, API_BASE);
}

function testExplicitMcpEnvNotOverriddenByApiFallback(): void {
  const manager = createConfigManager({
    mcp: {
      enabled: true,
      servers: [
        {
          name: 'custom-mcp',
          type: 'stdio',
          command: 'uvx',
          args: ['custom-mcp', '-y'],
          env: {
            MINIMAX_API_KEY: 'custom-key',
            MINIMAX_API_HOST: 'https://custom-host.example',
          },
        },
      ],
    },
  });
  const runtime = manager.getMcpRuntimeConfig();
  const server = runtime.servers[0];
  assert.equal(server.env?.MINIMAX_API_KEY, 'custom-key');
  assert.equal(server.env?.MINIMAX_API_HOST, 'https://custom-host.example');
}

function testConfiguredServersRespectExplicitDisable(): void {
  const manager = createConfigManager({
    mcp: {
      enabled: false,
      servers: [
        {
          name: 'custom-mcp',
          type: 'stdio',
          command: 'uvx',
          args: ['custom-mcp', '-y'],
        },
      ],
    },
  });
  const runtime = manager.getMcpRuntimeConfig();
  assert.equal(runtime.enabled, false);
}

function runAll(): void {
  testDisablesMcpWhenNoServerConfigured();
  testConfiguredServerGetsApiFallbackEnv();
  testExplicitMcpEnvNotOverriddenByApiFallback();
  testConfiguredServersRespectExplicitDisable();
  console.log('mcp-runtime-config tests passed');
}

runAll();
