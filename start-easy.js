#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');
const yaml = require('js-yaml');

const PORT = 53721;
const URL = `http://localhost:${PORT}`;
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.yaml');

function ensureBootConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config.yaml: ${CONFIG_PATH}`);
  }
  const parsed = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  if (!parsed.api || typeof parsed.api !== 'object') {
    throw new Error('Invalid config.yaml: missing api section.');
  }
  if (!parsed.agent || typeof parsed.agent !== 'object') {
    throw new Error('Invalid config.yaml: missing agent section.');
  }
  if (!Number.isFinite(parsed.api.maxOutputTokens) || parsed.api.maxOutputTokens <= 0) {
    throw new Error('Invalid config.yaml: api.maxOutputTokens must be a positive number.');
  }
}

function ensureBuildArtifacts() {
  const serverEntry = path.join(ROOT, 'dist', 'web', 'server', 'index.js');
  const clientIndex = path.join(ROOT, 'dist', 'web', 'client', 'index.html');
  if (!fs.existsSync(serverEntry) || !fs.existsSync(clientIndex)) {
    throw new Error('Missing dist artifacts. This package is incomplete. Please re-download the release package.');
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function describePortUsage(port) {
  let lines = '';
  try {
    lines = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
  if (!lines) {
    return '';
  }
  const pids = [...new Set(
    lines
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid) => /^[0-9]+$/.test(String(pid)))
  )];
  const details = [];
  for (const pid of pids) {
    try {
      const task = execSync(`tasklist /FI "PID eq ${pid}" /FO LIST`, { encoding: 'utf8' }).trim();
      details.push(`PID ${pid}\n${task}`);
    } catch {
      details.push(`PID ${pid}`);
    }
  }
  return details.join('\n\n');
}

function openBrowser(url) {
  const child = spawn('cmd', ['/c', 'start', '', url], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function main() {
  ensureBootConfig();
  ensureBuildArtifacts();
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

  const available = await isPortAvailable(PORT);
  if (!available) {
    const usage = describePortUsage(PORT);
    console.error(`[easy-run] Port ${PORT} is already in use.`);
    if (usage) {
      console.error('[easy-run] Occupying process info:');
      console.error(usage);
    }
    console.error('[easy-run] Please stop the occupying process and retry.');
    process.exit(1);
  }

  console.log(`[easy-run] Starting web server on ${URL}`);
  const child = spawn(process.execPath, [path.join('dist', 'web', 'server', 'index.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT: '1',
    },
  });

  setTimeout(() => openBrowser(URL), 900);

  child.on('error', (error) => {
    console.error('[easy-run] Failed to start server:', error);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
