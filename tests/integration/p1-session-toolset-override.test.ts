import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MiniMaxAgent } from '../../src/index.js';
import type { ContextRef } from '../../src/types.js';

function createHarness(): { tempDir: string; workspaceDir: string; runtimeDir: string; contextDir: string; configPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-toolset-override-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const configPath = path.join(tempDir, 'config.yaml');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      'api:',
      '  apiKey: test-key',
      '  apiBase: https://api.minimaxi.com',
      '  model: MiniMax-M2.7',
      '  provider: anthropic',
      'agent:',
      '  defaultToolset: windows-dev',
      '',
    ].join('\n')
  );
  return { tempDir, workspaceDir, runtimeDir, contextDir, configPath };
}

function cleanupHarness(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function runCase(): Promise<void> {
  const harness = createHarness();
  try {
    const agent = new MiniMaxAgent({
      allowMissingApiKeyAtBoot: true,
      configPath: harness.configPath,
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
    });
    const context: ContextRef = { scope: 'session', namespace: 'p1-toolset-override' };
    agent.updateContextNamespaceMeta(context, {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
    });

    assert.equal(agent.getConfig().agent.defaultToolset, 'windows-dev');
    assert.equal(agent.resolveToolsetName(context), 'windows-dev');

    agent.updateContextNamespaceMeta(context, { toolsetName: 'windows-safe' });
    assert.equal(agent.resolveToolsetName(context), 'windows-safe');
    assert.equal(agent.getConfig().agent.defaultToolset, 'windows-dev');

    console.log('p1-session-toolset-override integration test passed');
  } finally {
    cleanupHarness(harness.tempDir);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
