#!/usr/bin/env node
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, execSync } from 'child_process';
import yaml from 'js-yaml';
import { resolveWebServerPort } from '../web/server/port-config.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');
const SKILL_LIST_PATH = path.join(process.cwd(), 'skill-list.yaml');
const SERVER_ENTRY = path.resolve(__dirname, '..', 'web', 'server', 'index.js');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_GLOBAL_AGENTS_DIR = path.join(PACKAGE_ROOT, 'agents');

type ParsedArgs = {
  command: 'start' | 'init';
  noOpen: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0]?.trim().toLowerCase();
  const command = first === 'init' ? 'init' : 'start';
  const noOpen = argv.includes('--no-open');
  return { command, noOpen };
}

function ensureConfigTemplate(): void {
  if (fs.existsSync(CONFIG_PATH)) {
    return;
  }
  const template = {
    api: {
      apiKey: '',
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
      globalAgentsDir: DEFAULT_GLOBAL_AGENTS_DIR,
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
  console.log(`[minimax-agent] Created ${CONFIG_PATH}`);
}

function ensureSkillListTemplate(): void {
  if (fs.existsSync(SKILL_LIST_PATH)) {
    return;
  }
  fs.writeFileSync(SKILL_LIST_PATH, 'skills: []\n', 'utf8');
  console.log(`[minimax-agent] Created ${SKILL_LIST_PATH}`);
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function describePortUsage(port: number): string {
  if (process.platform !== 'win32') {
    return '';
  }
  try {
    const lines = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' }).trim();
    if (!lines) {
      return '';
    }
    const pids = [...new Set(
      lines
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid) => !!pid && /^[0-9]+$/.test(String(pid)))
    )];
    if (pids.length === 0) {
      return '';
    }
    return pids
      .map((pid) => {
        try {
          const task = execSync(`tasklist /FI "PID eq ${pid}" /FO LIST`, { encoding: 'utf8' }).trim();
          return `PID ${pid}\n${task}`;
        } catch {
          return `PID ${pid}`;
        }
      })
      .join('\n\n');
  } catch {
    return '';
  }
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function start(noOpen: boolean): Promise<void> {
  const port = resolveWebServerPort(process.env.MINIMAX_PORT);
  ensureConfigTemplate();
  ensureSkillListTemplate();
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  const available = await isPortAvailable(port);
  if (!available) {
    console.error(`[minimax-agent] Port ${port} is already in use.`);
    const details = describePortUsage(port);
    if (details) {
      console.error('[minimax-agent] Occupying process:');
      console.error(details);
    }
    process.exit(1);
  }

  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Missing server entry: ${SERVER_ENTRY}`);
  }
  const url = `http://localhost:${port}`;
  console.log(`[minimax-agent] Starting web server at ${url}`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT: '1',
      MINIMAX_PORT: String(port),
    },
  });

  if (!noOpen) {
    setTimeout(() => openBrowser(url), 900);
  }

  child.on('error', (error) => {
    console.error('[minimax-agent] Failed to start server:', error);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'init') {
    ensureConfigTemplate();
    ensureSkillListTemplate();
    return;
  }
  await start(parsed.noOpen);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
