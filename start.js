#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config.yaml: ${CONFIG_PATH}`);
  }
  const parsed = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const apiKey = parsed.api?.apiKey || '';
  const maxOutputTokens = parsed.api?.maxOutputTokens;
  if (!apiKey || apiKey.length < 20) {
    throw new Error('Invalid config.yaml: api.apiKey must be configured.');
  }
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error('Invalid config.yaml: api.maxOutputTokens must be a positive number.');
  }
}

function ensureBuildArtifacts() {
  const serverEntry = path.join(process.cwd(), 'dist', 'web', 'server', 'index.js');
  const clientIndex = path.join(process.cwd(), 'dist', 'web', 'client', 'index.html');
  if (fs.existsSync(serverEntry) && fs.existsSync(clientIndex)) {
    return;
  }
  console.log('[start] build artifacts missing, running npm run build:web');
  execSync('npm run build:web', { stdio: 'inherit' });
}

function main() {
  ensureConfig();
  ensureBuildArtifacts();
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  console.log('[start] starting production server with logs in logs/start-web.*.log');
  const child = spawn('npm', ['run', 'start:web:logs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  child.on('error', (error) => {
    console.error('[start] failed to start:', error);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

try {
  main();
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
