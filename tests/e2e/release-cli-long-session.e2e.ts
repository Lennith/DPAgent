import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { chromium, type Page } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WebSocket, { WebSocketServer } from 'ws';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { Sidebar } from '../../src/web/client/components/sidebar/Sidebar.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import { createWebServer } from '../../src/web/server/WebServer.js';

const SESSION_ID = 'release-cli-long-session';
const OUTPUT_DIR = path.join('logs', 'release-cli-long-session-e2e');

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

interface ReceivedCliRequest {
  headers: http.IncomingHttpHeaders;
  message: Record<string, unknown>;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate test port.')));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function startMockAnthropicProvider(delayFirstResponseMs = 700): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !String(req.url ?? '').includes('/messages')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requestCount += 1;
        const body = JSON.parse(raw || '{}') as { messages?: Array<{ content?: unknown }> };
        const lastMessage = body.messages?.[body.messages.length - 1];
        const content = Array.isArray(lastMessage?.content)
          ? lastMessage?.content.map((item) => String((item as { text?: unknown }).text ?? '')).join('\n')
          : String(lastMessage?.content ?? '');
        const round = /CLI_LONG_ROUND_(\d{2})/.exec(content)?.[1] ?? '01';
        const text = `CLI_LONG_ACK_${round}`;
        const send = (event: string, data: Record<string, unknown>) => {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        const writeResponse = () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          send('message_start', {
            type: 'message_start',
            message: {
              id: `msg-release-cli-${requestCount}`,
              type: 'message',
              role: 'assistant',
              model: 'release-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          });
          send('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          send('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          });
          send('content_block_stop', { type: 'content_block_stop', index: 0 });
          send('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          });
          send('message_stop', { type: 'message_stop' });
          res.end();
        };
        if (requestCount === 1) {
          setTimeout(writeResponse, delayFirstResponseMs);
        } else {
          writeResponse();
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.equal(typeof address, 'object');
      assert.notEqual(address, null);
      resolve({
        url: `http://127.0.0.1:${address?.port}`,
        close: async () => {
          await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
        },
      });
    });
  });
}

function startMockBackend(): Promise<{
  url: string;
  received: ReceivedCliRequest[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const received: ReceivedCliRequest[] = [];
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, request) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push({ headers: request.headers, message });
        const data = normalizeRecord(message.data);
        const prompt = String(data.prompt ?? '');
        const roundMatch = /CLI_LONG_ROUND_(\d{2})/.exec(prompt);
        const round = roundMatch?.[1] ?? String(received.length).padStart(2, '0');
        const runId = `run-cli-${round}`;
        const context = normalizeRecord(data.context);
        ws.send(
          JSON.stringify({
            type: 'chat_started',
            data: {
              runId,
              sessionId: data.sessionId,
              context,
              startedAt: new Date().toISOString(),
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'message',
            data: {
              runId,
              sessionId: data.sessionId,
              context,
              role: 'assistant',
              content: `CLI_LONG_ACK_${round}`,
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'complete',
            data: { runId, sessionId: data.sessionId, context },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'run_terminal',
            data: {
              runId,
              sessionId: data.sessionId,
              context,
              terminalCode: 'completed',
            },
          })
        );
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.equal(typeof address, 'object');
      assert.notEqual(address, null);
      resolve({
        url: `http://127.0.0.1:${address?.port}`,
        received,
        close: async () => {
          for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.close();
            }
          }
          await new Promise<void>((closeResolve) => wss.close(() => closeResolve()));
          await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
        },
      });
    });
  });
}

function resolveCliInvocation(): { command: string; args: string[] } {
  const repoRoot = process.cwd();
  const distEntry = path.resolve(repoRoot, 'dist', 'cli', 'dpagent.js');
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }
  const sourceEntry = path.resolve(repoRoot, 'src', 'cli', 'dpagent.ts');
  const tsxLoader = pathToFileURL(path.resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsxLoader, sourceEntry] };
}

function runCliExec(input: {
  tempDir: string;
  serverUrl: string;
  workspaceDir: string;
  prompt: string;
  round: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const invocation = resolveCliInvocation();
  const args = [
    ...invocation.args,
    'exec',
    '--json',
    '--server-url',
    input.serverUrl,
    '--workspace',
    input.workspaceDir,
    '--session-id',
    SESSION_ID,
    '--max-steps',
    '5',
    '--llm-profile',
    'release',
    '--model',
    'release-model',
    '--reasoning',
    'off',
    '-c',
    "mcp_servers.release.command='node'",
    '-c',
    "mcp_servers.release.args=['-e','console.log(1)']",
    ...(input.round === 1 ? ['--plan-mode'] : []),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd: input.tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input.prompt);
  });
}

function parseJsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runTwentyCliRounds(input: {
  tempDir: string;
  workspaceDir: string;
  serverUrl: string;
}): Promise<Array<Array<Record<string, unknown>>>> {
  const rounds: Array<Array<Record<string, unknown>>> = [];
  for (let round = 1; round <= 20; round += 1) {
    const label = String(round).padStart(2, '0');
    const result = await runCliExec({
      ...input,
      round,
      prompt: `CLI_LONG_ROUND_${label}: keep this long release conversation deterministic.`,
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const events = parseJsonl(result.stdout);
    rounds.push(events);
    assert.equal(events[0]?.type, 'thread.started');
    assert.equal(events.some((event) => event.type === 'turn.started'), true);
    assert.equal(
      events.some((event) => {
        const item = normalizeRecord(event.item);
        return item.type === 'agent_message' && String(item.content ?? '').includes(`CLI_LONG_ACK_${label}`);
      }),
      true,
      `round ${label} should emit assistant content`
    );
    assert.equal(events.some((event) => event.type === 'turn.completed'), true);
    assert.equal(events.some((event) => event.type === 'task_complete'), true);
  }
  return rounds;
}

function assertBackendRequests(received: ReceivedCliRequest[], workspaceDir: string): void {
  assert.equal(received.length, 20);
  for (let index = 0; index < received.length; index += 1) {
    const { headers, message } = received[index]!;
    const data = normalizeRecord(message.data);
    const context = normalizeRecord(data.context);
    assert.equal(headers['x-dpagent-client-kind'], 'cli');
    assert.equal(message.type, 'chat');
    assert.equal(data.clientKind, 'cli');
    assert.equal(data.sessionId, SESSION_ID);
    assert.equal(context.scope, 'session');
    assert.equal(context.namespace, SESSION_ID);
    assert.equal(path.resolve(String(data.workspaceDir ?? '')), path.resolve(workspaceDir));
    assert.equal(normalizeRecord(data.llmSelection).model, 'release-model');
    assert.equal(normalizeRecord(data.llmSelection).reasoningPreset, 'off');
    assert.equal(Array.isArray(data.externalMcpServers), true);
    if (index === 0) {
      assert.equal(data.planningAction, 'enter_drafting');
    } else {
      assert.equal(data.planningAction, undefined);
    }
  }
}

function writeRealServerConfig(input: {
  configPath: string;
  workspaceDir: string;
  runtimeDataDir: string;
  contextDir: string;
  providerUrl: string;
}): void {
  fs.writeFileSync(
    input.configPath,
    yaml.dump({
      llmProfiles: {
        defaultProfileId: 'release',
        profiles: [
          {
            id: 'release',
            name: 'Release E2E',
            provider: 'anthropic',
            apiKey: 'sk-release-e2e-000000000000000000',
            apiBase: input.providerUrl,
            defaultModel: 'release-model',
            maxOutputTokens: 1024,
            enabled: true,
            capabilities: {
              modelDiscovery: false,
              reasoningEffort: true,
              thinkingBudget: false,
            },
          },
        ],
      },
      api: {
        provider: 'anthropic',
        apiKey: 'sk-release-e2e-000000000000000000',
        apiBase: input.providerUrl,
        model: 'release-model',
        maxOutputTokens: 1024,
      },
      agent: {
        maxSteps: 5,
        tokenLimit: 80000,
        workspaceDir: input.workspaceDir,
        runtimeDataDir: input.runtimeDataDir,
        contextDir: input.contextDir,
        defaultToolset: 'windows-safe',
      },
      tools: {
        enableFileTools: true,
        enableShell: false,
      },
      mcp: {
        enabled: false,
        servers: [],
      },
    }),
    'utf8'
  );
}

async function waitForRealSession(baseUrl: string, expectedActive: boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/sessions`);
    if (response.ok) {
      const payload = (await response.json()) as { sessions?: Array<Record<string, unknown>> };
      const session = payload.sessions?.find((item) => item.id === SESSION_ID);
      if (session) {
        const activeRun = session.activeRun ? normalizeRecord(session.activeRun) : null;
        if (expectedActive === Boolean(activeRun)) {
          return session;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for real server session active=${expectedActive}`);
}

async function assertRealWebServerCliIsolation(input: {
  tempDir: string;
  workspaceDir: string;
}): Promise<void> {
  const provider = await startMockAnthropicProvider();
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(input.tempDir, 'real-server-config.yaml');
  writeRealServerConfig({
    configPath,
    workspaceDir: input.workspaceDir,
    runtimeDataDir: path.join(input.tempDir, 'runtime-real'),
    contextDir: path.join(input.tempDir, 'contexts-real'),
    providerUrl: provider.url,
  });
  const server = createWebServer({ port, configPath });
  try {
    await server.start();
    const firstRun = runCliExec({
      tempDir: input.tempDir,
      serverUrl: baseUrl,
      workspaceDir: input.workspaceDir,
      prompt: 'CLI_LONG_ROUND_01: real server isolation probe.',
      round: 1,
    });
    const activeSession = await waitForRealSession(baseUrl, true);
    assert.equal(activeSession.origin, 'cli');
    assert.equal(normalizeRecord(activeSession.activeRun).owner, 'cli');
    assert.equal(normalizeRecord(activeSession.activeRun).origin, 'cli');
    assert.equal(normalizeRecord(activeSession.interactionState).mode, 'observe_only');

    const todoMutation = await fetch(`${baseUrl}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        sessionId: SESSION_ID,
        work: 'should be rejected while cli owns the run',
        detection_standard: 'observe-only route rejects mutation',
      }),
    });
    assert.equal(todoMutation.status, 409);
    const mutationPayload = (await todoMutation.json()) as { error?: string };
    assert.equal(mutationPayload.error, 'observe_only');

    const firstResult = await firstRun;
    assert.equal(firstResult.code, 0, firstResult.stderr || firstResult.stdout);
    const events = parseJsonl(firstResult.stdout);
    assert.equal(
      events.some((event) => {
        const item = normalizeRecord(event.item);
        return item.type === 'agent_message' && String(item.content ?? '').includes('CLI_LONG_ACK_01');
      }),
      true
    );
    const completedSession = await waitForRealSession(baseUrl, false);
    assert.equal(completedSession.origin, 'cli');
    assert.equal(completedSession.activeRun, null);
  } finally {
    await server.stop().catch(() => undefined);
    await provider.close().catch(() => undefined);
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) {
      throw error;
    }
    for (const channel of ['chrome', 'msedge']) {
      try {
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

function renderIsolationShell(): string {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const sidebar = React.createElement(Sidebar, {
    sessions: [
      {
        id: 'release-web-session',
        name: 'Web release check',
        workspaceDir: 'D:\\release-web',
        origin: 'web',
        interactionState: { mode: 'normal' },
      },
      {
        id: SESSION_ID,
        name: 'CLI release check',
        workspaceDir: 'D:\\release-cli',
        origin: 'cli',
        interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
      },
    ],
    currentSessionId: SESSION_ID,
    onSelectSession: () => undefined,
    onNewSession: () => undefined,
    onOpenAutomations: () => undefined,
    onDeleteSession: () => undefined,
    onRenameSession: () => undefined,
    workspaceDir: 'D:\\release-web',
    onChangeWorkspace: () => undefined,
    isConnected: true,
    runningSessionIds: [SESSION_ID],
  });
  const chat = React.createElement(ChatContainer, {
    messages: [],
    liveEvents: [],
    pendingPlanInput: {
      requestId: 'req-cli-readonly',
      questions: [
        {
          header: 'Execution',
          id: 'plan_execution_approval',
          question: 'Approve CLI-owned plan execution?',
          options: [{ label: 'Approve execution', description: 'Should be disabled from Web while CLI owns the run.' }],
        },
      ],
    },
    pendingPlanInputError: null,
    onSubmitPlanInput: () => undefined,
    input: '',
    setInput: () => undefined,
    onSend: () => undefined,
    onCancel: () => undefined,
    isRunning: true,
    canCancel: false,
    isInteractionLocked: true,
    interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
    error: null,
    interruptedArtifact: null,
    sessionId: SESSION_ID,
    planningState: 'plan_executing',
    llmSelection: {
      profileId: 'release',
      model: 'release-model',
      reasoningPreset: 'off',
      updatedAt: '2026-05-03T00:00:00.000Z',
    },
    currentLlmRuntime: {
      profileId: 'release',
      provider: 'anthropic',
      model: 'release-model',
      reasoningPreset: 'off',
    },
  });
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, React.createElement('div', { className: 'release-shell' }, sidebar, chat))
    )
  );
}

async function assertUiIsolation(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.setContent(
    [
      '<!doctype html><html><head><meta charset="utf-8" />',
      '<style>',
      '* { box-sizing: border-box; } body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; }',
      '.release-shell { min-height: 100vh; display: grid; grid-template-columns: 320px minmax(0, 1fr); }',
      '.chat-panel-root { min-height: 100vh; display: flex; flex-direction: column; }',
      '.chat-messages-viewport { flex: 1; overflow: auto; }',
      '.chat-transcript { max-width: 860px; margin: 0 auto; }',
      '.message-width-assistant { max-width: 780px; }',
      '.border { border: 1px solid rgba(148, 163, 184, 0.35); }',
      '.rounded-2xl { border-radius: 16px; } .rounded-xl { border-radius: 12px; } .rounded-lg { border-radius: 8px; }',
      '.p-2 { padding: 8px; } .p-3 { padding: 12px; } .p-4 { padding: 16px; } .px-4 { padding-left: 16px; padding-right: 16px; } .py-3 { padding-top: 12px; padding-bottom: 12px; }',
      '.space-y-2 > * + * { margin-top: 8px; } .space-y-3 > * + * { margin-top: 12px; } .space-y-4 > * + * { margin-top: 16px; }',
      '.flex { display: flex; } .flex-1 { flex: 1 1 auto; } .items-center { align-items: center; } .items-start { align-items: flex-start; } .justify-between { justify-content: space-between; } .justify-start { justify-content: flex-start; } .justify-end { justify-content: flex-end; }',
      '.gap-2 { gap: 8px; } .w-full { width: 100%; } .text-xs { font-size: 12px; } .text-sm { font-size: 14px; } .font-semibold, .font-medium { font-weight: 600; }',
      'button:disabled, input:disabled, textarea:disabled { cursor: not-allowed; }',
      '</style></head><body>',
      renderIsolationShell(),
      '</body></html>',
    ].join('')
  );
  await page.getByTestId('cli-observe-only-banner').waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('body').innerText(), /Web Sessions \(1\)/);
  assert.match(await page.locator('body').innerText(), /CLI Sessions \(1\)/);
  assert.match(await page.locator('body').innerText(), /CLI is running/);
  assert.equal(await page.getByTestId('plan-input-card').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.getByTestId('plan-input-card').locator('input[type="radio"]').first().isDisabled(), true);
  await assert.rejects(
    async () => {
      await page.getByTestId('chat-send').waitFor({ state: 'visible', timeout: 500 });
    },
    /Timeout/
  );
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'cli-isolation.png'), fullPage: true });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cli-long-session-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const backend = await startMockBackend();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await assertRealWebServerCliIsolation({ tempDir, workspaceDir });
    await runTwentyCliRounds({ tempDir, workspaceDir, serverUrl: backend.url });
    assertBackendRequests(backend.received, workspaceDir);
    await assertUiIsolation(page);
    console.log('release-cli-long-session e2e passed');
  } finally {
    await browser.close();
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
