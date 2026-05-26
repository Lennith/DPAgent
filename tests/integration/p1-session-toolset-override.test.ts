import * as assert from 'node:assert/strict';
import { DPAgent } from '../../src/index.js';
import type { ContextRef } from '../../src/types.js';
import { cleanupIntegrationHarness, createIntegrationHarness } from './helpers/integration-harness.js';

async function runCase(): Promise<void> {
  const harness = createIntegrationHarness('p1-toolset-override-', {
    configYaml: [
      'api:',
      '  apiKey: test-key',
      '  apiBase: https://api.minimaxi.com',
      '  model: MiniMax-M2.7',
      '  provider: anthropic',
      'agent:',
      '  defaultToolset: windows-dev',
    ],
  });
  try {
    const agent = new DPAgent({
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
    cleanupIntegrationHarness(harness);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
