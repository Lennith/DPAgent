import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { WebServer } from '../../src/web/server/WebServer.js';

function createTempConfig(config: Record<string, unknown>): { tempDir: string; configPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-default-mcp-config-'));
  const configPath = path.join(tempDir, 'config.yaml');
  fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: -1 }), 'utf-8');
  return { tempDir, configPath };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function testWebServerDoesNotInjectDefaultMcpWhenConfigHasNoServers(): void {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-default-mcp-config-case-'));
  const { tempDir, configPath } = createTempConfig({
    api: {
      apiKey: '',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      provider: 'anthropic',
      maxOutputTokens: 32768,
    },
    agent: {
      workspaceDir: baseDir,
      contextDir: path.join(baseDir, 'contexts'),
      runtimeDataDir: path.join(baseDir, 'runtime'),
      globalAgentsDir: path.join(baseDir, 'agents'),
    },
    tools: {
      enableFileTools: true,
      enableWeb: true,
      enableShell: true,
      shellType: 'powershell',
      shellTimeout: 30000,
    },
    mcp: {
      enabled: false,
      servers: [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
  });

  try {
    const server = new WebServer({
      port: 53721,
      configPath,
      allowMissingApiKeyAtBoot: true,
    }) as unknown as { agent: { getConfig: () => { mcp: { enabled: boolean; servers: Array<{ name: string; command?: string; args?: string[] }> } } } };

    const config = server.agent.getConfig();
    assert.equal(config.mcp.enabled, false);
    assert.equal(config.mcp.servers.length, 0);
  } finally {
    cleanup(baseDir);
    cleanup(tempDir);
  }
}

function testWebServerKeepsExplicitMcpServersUntouched(): void {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-default-mcp-config-case-'));
  const { tempDir, configPath } = createTempConfig({
    api: {
      apiKey: '',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      provider: 'anthropic',
      maxOutputTokens: 32768,
    },
    agent: {
      workspaceDir: baseDir,
      contextDir: path.join(baseDir, 'contexts'),
      runtimeDataDir: path.join(baseDir, 'runtime'),
      globalAgentsDir: path.join(baseDir, 'agents'),
    },
    tools: {
      enableFileTools: true,
      enableWeb: true,
      enableShell: true,
      shellType: 'powershell',
      shellTimeout: 30000,
    },
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
      connectTimeout: 10,
      executeTimeout: 60,
    },
  });

  try {
    const server = new WebServer({
      port: 53721,
      configPath,
      allowMissingApiKeyAtBoot: true,
    }) as unknown as { agent: { getConfig: () => { mcp: { enabled: boolean; servers: Array<{ name: string; command?: string; args?: string[] }> } } } };

    const config = server.agent.getConfig();
    assert.equal(config.mcp.enabled, false);
    assert.equal(config.mcp.servers.length, 1);
    assert.equal(config.mcp.servers[0]?.name, 'custom-mcp');
    assert.deepEqual(config.mcp.servers[0]?.args, ['custom-mcp', '-y']);
  } finally {
    cleanup(baseDir);
    cleanup(tempDir);
  }
}

function runAll(): void {
  testWebServerDoesNotInjectDefaultMcpWhenConfigHasNoServers();
  testWebServerKeepsExplicitMcpServersUntouched();
  console.log('web-default-mcp-config tests passed');
}

runAll();
