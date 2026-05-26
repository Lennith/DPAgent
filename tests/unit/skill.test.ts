import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../../src/index.js';

function createTempDirs(): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-offline-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

async function testSkillBootstrapDoesNotRequireLiveApiKey(): Promise<void> {
  const dirs = createTempDirs();
  const agent = createAgent({
    allowMissingApiKeyAtBoot: true,
    workspaceDir: dirs.workspaceDir,
    runtimeDataDir: dirs.runtimeDir,
    contextDir: dirs.contextDir,
    config: {
      api: {
        apiKey: '',
      },
      mcp: {
        enabled: false,
        servers: [],
      },
    },
  });

  try {
    await agent.initialize();
    const config = agent.getConfig();
    assert.equal(config.api.apiKey, '');
    assert.equal(config.agent.workspaceDir, dirs.workspaceDir);
    assert.equal(config.agent.runtimeDataDir, dirs.runtimeDir);
    assert.equal(config.agent.contextDir, dirs.contextDir);
    assert.equal(agent.getMcpStatus().summary.totalEnabled, 0);
  } finally {
    await agent.cleanup();
    fs.rmSync(dirs.tempDir, { recursive: true, force: true });
  }
}

testSkillBootstrapDoesNotRequireLiveApiKey()
  .then(() => {
    console.log('skill tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
