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
    api: {
      apiKey: 'YOUR_API_KEY',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7-highspeed',
      provider: 'anthropic',
      maxOutputTokens: 32768,
    },
    agent: {
      maxSteps: 100,
      tokenLimit: 210000,
      workspaceDir: './workspace',
      contextDir: './contexts',
      runtimeDataDir: './runtime',
      skillListPath: './skill-list.yaml',
    },
    tools: {
      enableFileTools: true,
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
  console.log('=== MiniMax Agent setup ===');
  ensureNodeVersion();
  ensureConfigTemplate();
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  console.log('[1/3] npm install');
  execSync('npm install', { stdio: 'inherit' });

  console.log('[2/3] npm run build:web');
  execSync('npm run build:web', { stdio: 'inherit' });

  const loaded = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const apiKey = loaded.api?.apiKey || '';
  console.log('[3/3] setup summary');
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`maxOutputTokens: ${loaded.api?.maxOutputTokens}`);
  if (!apiKey || apiKey === 'YOUR_API_KEY') {
    console.log('apiKey: not configured yet. Edit config.yaml before starting.');
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
