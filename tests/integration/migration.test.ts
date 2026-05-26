import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ConfigManager } from '../../src/config/ConfigManager.js';
import { createAgent } from '../../src/index.js';

function writeJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function runMigrationContractTest(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-migration-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');

  try {
    const legacyConfigPath = path.join(tempDir, 'legacy-config.json');
    writeJson(legacyConfigPath, {
      api: {
        apiKey: 'legacy-api-key-123456789012345',
        apiBase: 'https://legacy.example/v1',
        model: 'legacy-model',
        provider: 'openai',
        maxOutputTokens: 12345,
      },
      agent: {
        maxSteps: 7,
        workspaceDir,
      },
      tools: {
        enableFileTools: true,
        enableShell: false,
      },
    });

    const configManager = new ConfigManager();
    configManager.loadFromJson(legacyConfigPath);
    const migratedConfig = configManager.get();

    assert.equal(migratedConfig.llmProfiles.defaultProfileId, 'default');
    assert.equal(migratedConfig.llmProfiles.profiles[0]?.apiKey, 'legacy-api-key-123456789012345');
    assert.equal(migratedConfig.llmProfiles.profiles[0]?.apiBase, 'https://legacy.example/v1');
    assert.equal(migratedConfig.llmProfiles.profiles[0]?.defaultModel, 'legacy-model');
    assert.equal(migratedConfig.llmProfiles.profiles[0]?.provider, 'openai');
    assert.equal(migratedConfig.llmProfiles.profiles[0]?.maxOutputTokens, 12345);

    const agent = createAgent({
      configPath: legacyConfigPath,
      workspaceDir,
      runtimeDataDir,
      contextDir,
      allowMissingApiKeyAtBoot: true,
    });

    assert.equal(agent.getConfig().llmProfiles.profiles[0]?.defaultModel, 'legacy-model');
    await agent.cleanup();

    const removedAgentConfigPath = path.join(tempDir, 'removed-agent-config.json');
    writeJson(removedAgentConfigPath, {
      agent: {
        memoryWriteMode: 'confirm',
        skillListPath: './skills.json',
        skillWriteMode: 'confirm',
      },
    });

    assert.throws(
      () => new ConfigManager().loadFromJson(removedAgentConfigPath),
      /Removed agent config field\(s\).*memoryWriteMode.*skillListPath.*skillWriteMode/,
    );

    console.log('migration tests passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runMigrationContractTest().catch((error) => {
  console.error(error);
  process.exit(1);
});
