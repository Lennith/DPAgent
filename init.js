#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const yaml = require('js-yaml');

const CONFIG_FILE = 'config.yaml';

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function createTemplate({
  apiKey,
  model,
  apiBase,
  skillsDir,
}) {
  return {
    llmProfiles: {
      defaultProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default Profile',
          provider: 'anthropic',
          apiKey,
          apiBase,
          defaultModel: model,
          maxOutputTokens: 32768,
          enabled: true,
          capabilities: {
            modelDiscovery: true,
            reasoningEffort: false,
            thinkingBudget: true,
          },
        },
      ],
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 210000,
      workspaceDir: './workspace',
      contextDir: './contexts',
      runtimeDataDir: './runtime',
      defaultToolset: 'windows-safe',
      globalAgentsDir: './agents',
      skillsDir,
    },
    tools: {
      enableFileTools: true,
      enableWeb: false,
      enableShell: false,
      shellType: 'powershell',
      shellTimeout: 30000,
    },
    mcp: {
      enabled: false,
      servers: [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
    retry: {
      enabled: true,
      maxRetries: 3,
      initialDelay: 1,
      maxDelay: 60,
      exponentialBase: 2,
    },
    agentProviders: [
      {
        id: 'local-default',
        type: 'local',
        enabled: true,
        timeoutMs: 300000,
      },
    ],
    subAgentPresets: {
      coding: {
        description: 'Code implementation and debugging specialist',
        providerId: 'local-default',
        systemPrompt: 'You are a coding sub-agent. Focus on implementation, debugging, and concise progress updates.',
      },
      research: {
        description: 'Repository and technical investigation specialist',
        providerId: 'local-default',
        systemPrompt: 'You are a research sub-agent. Focus on evidence-driven exploration and clear findings.',
      },
      review: {
        description: 'Code review and risk assessment specialist',
        providerId: 'local-default',
        systemPrompt: 'You are a review sub-agent. Focus on correctness risks, regressions, and missing tests.',
      },
    },
  };
}

async function main() {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (fs.existsSync(configPath)) {
      const overwrite = await ask(rl, `${CONFIG_FILE} already exists. Overwrite? (y/N): `);
      if (overwrite.trim().toLowerCase() !== 'y') {
        console.log('Canceled.');
        return;
      }
    }

    const apiKey = (await ask(rl, 'API Key: ')).trim();
    if (apiKey.length < 20) {
      throw new Error('Invalid API key. Expected length >= 20.');
    }

    const apiBase = (await ask(rl, 'API Base: ')).trim();
    if (!apiBase) {
      throw new Error('API Base is required.');
    }

    const model = (await ask(rl, 'Model: ')).trim();
    if (!model) {
      throw new Error('Model is required.');
    }

    const defaultSkillsDir = path.join(os.homedir(), '.codex', 'skills');
    const skillsInput = (await ask(rl, `Skills Dir [${defaultSkillsDir}]: `)).trim();
    const skillsDir = skillsInput || defaultSkillsDir;

    const config = createTemplate({ apiKey, model, apiBase, skillsDir });
    fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: -1 }), 'utf8');

    console.log(`\nWrote ${configPath}`);
    console.log('Next steps:');
    console.log('1. npm install');
    console.log('2. npm run dev:web');
    console.log('3. Switch to windows-dev only when shell/write access is needed.');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
