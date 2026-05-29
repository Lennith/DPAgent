#!/usr/bin/env node
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, execSync } from 'child_process';
import yaml from 'js-yaml';
import { resolveWebServerPort } from '../web/server/port-config.js';
import { runDpagentExec } from './dpagent-exec.js';

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');
const SERVER_ENTRY = path.resolve(__dirname, '..', 'web', 'server', 'index.js');

type ParsedArgs = {
  command: 'start' | 'init' | 'exec';
  noOpen: boolean;
  rest: string[];
};

type PortHttpProbe =
  | { ok: true; status: number; bodyPreview: string }
  | { ok: false; error: string };

function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0]?.trim().toLowerCase();
  const command = first === 'init' ? 'init' : first === 'exec' ? 'exec' : 'start';
  const noOpen = argv.includes('--no-open');
  return { command, noOpen, rest: command === 'exec' ? argv.slice(1) : argv.slice(1) };
}

function ensureConfigTemplate(): void {
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
      globalAgentsDir: './agents',
    },
    contextBudget: {
  defaultContextWindowTokens: 230000,
      compressionTriggerRatio: 0.9,
      postCompressionTargetRatio: 0.55,
      minTokensAddedAfterCompression: 0,
      precompressKeepLlmRounds: 5,
      precompressChunkChars: 20000,
      precompressRetry: 1,
      compressionMaxChars: 6000,
      reservedOutputTokens: 32768,
      reservedReasoningTokens: 0,
      reservedProtocolTokens: 4096,
      modelOverrides: {},
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
  console.log(`[dpagent] Created ${CONFIG_PATH}`);
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

async function probePortHttpHealth(port: number): Promise<PortHttpProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      ok: true,
      status: response.status,
      bodyPreview: body.slice(0, 800),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
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
  const port = resolveWebServerPort(process.env.DPAGENT_PORT);
  ensureConfigTemplate();
  fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });

  const available = await isPortAvailable(port);
  if (!available) {
    console.error(`[dpagent] Port ${port} is already in use.`);
    const details = describePortUsage(port);
    if (details) {
      console.error('[dpagent] Occupying process:');
      console.error(details);
    }
    const probe = await probePortHttpHealth(port);
    if (probe.ok) {
      console.error(`[dpagent] Existing HTTP health probe: status=${probe.status}`);
      if (probe.bodyPreview) {
        console.error(probe.bodyPreview);
      }
    } else {
      console.error(`[dpagent] Existing HTTP health probe failed: ${probe.error}`);
      console.error('[dpagent] The port is occupied, but the existing process did not return /api/health.');
    }
    process.exit(1);
  }

  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Missing server entry: ${SERVER_ENTRY}`);
  }
  const url = `http://localhost:${port}`;
  console.log(`[dpagent] Starting web server at ${url}`);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT: '1',
      DPAGENT_PORT: String(port),
    },
  });

  if (!noOpen) {
    setTimeout(() => openBrowser(url), 900);
  }

  child.on('error', (error) => {
    console.error('[dpagent] Failed to start server:', error);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === 'exec') {
    await runDpagentExec(parsed.rest);
    return;
  }
  if (parsed.command === 'init') {
    ensureConfigTemplate();
    return;
  }
  await start(parsed.noOpen);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
