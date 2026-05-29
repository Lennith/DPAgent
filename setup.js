#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');

function ensureNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js >= 18 is required. Current: ${process.version}`);
  }
}

function ensureConfigTemplate() {
  if (fs.existsSync(CONFIG_PATH)) {
    return;
  }
  const template = {
    llmProfiles: {
      defaultProfileId: '',
      profiles: [],
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 210000,
      workspaceDir: './workspace',
      contextDir: './contexts',
      runtimeDataDir: './runtime',
      defaultToolset: 'windows-safe',
      globalAgentsDir: './agents',
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
  };
  fs.writeFileSync(CONFIG_PATH, yaml.dump(template, { indent: 2, lineWidth: -1 }), 'utf8');
}

function main() {
  console.log('=== DPAgent setup ===');
  ensureNodeVersion();
  ensureConfigTemplate();
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  console.log('[1/3] npm install');
  execSync('npm install', { stdio: 'inherit' });

  console.log('[2/3] npm run build:web');
  execSync('npm run build:web', { stdio: 'inherit' });

  const loaded = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const defaultProfileId = String(loaded.llmProfiles?.defaultProfileId || '').trim();
  const profiles = Array.isArray(loaded.llmProfiles?.profiles) ? loaded.llmProfiles.profiles : [];
  const defaultProfile = profiles.find((profile) => profile?.id === defaultProfileId) || profiles[0] || {};
  const apiKey = defaultProfile.apiKey || loaded.api?.apiKey || '';
  console.log('[3/3] setup summary');
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`maxOutputTokens: ${defaultProfile.maxOutputTokens ?? loaded.api?.maxOutputTokens}`);
  if (!apiKey) {
    console.log('apiKey: not configured yet. Open Web Settings and create a provider profile before starting a run.');
  } else {
    console.log('apiKey: configured');
  }

  console.log('\nRun: npm start');
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
