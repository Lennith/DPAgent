import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { parseDpagentExecArgs } from '../../src/cli/dpagent-exec-args.js';

function runCli(
  args: string[],
  stdin: string,
  options: { cwd?: string } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/dpagent.ts', ...args], {
      cwd: options.cwd ?? process.cwd(),
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
    child.stdin.end(stdin);
  });
}

function startMockDpAgentServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  received: Promise<Record<string, unknown>>;
  headers: Promise<http.IncomingHttpHeaders>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let resolveReceived: (value: Record<string, unknown>) => void = () => {};
    let resolveHeaders: (value: http.IncomingHttpHeaders) => void = () => {};
    const received = new Promise<Record<string, unknown>>((innerResolve) => {
      resolveReceived = innerResolve;
    });
    const headers = new Promise<http.IncomingHttpHeaders>((innerResolve) => {
      resolveHeaders = innerResolve;
    });

    wss.on('connection', (ws, request) => {
      resolveHeaders(request.headers);
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        resolveReceived(message);
        ws.send(JSON.stringify({ type: 'chat_started', data: { startedAt: new Date().toISOString() } }));
        ws.send(
          JSON.stringify({
            type: 'message',
            data: { role: 'assistant', content: 'DPAGENT_EAT_OK' },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'complete',
            data: {},
          })
        );
        ws.send(
          JSON.stringify({
            type: 'run_terminal',
            data: { terminalCode: 'completed' },
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
        headers,
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

function runCliFromRepoEntry(
  args: string[],
  stdin: string,
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliEntry = path.resolve(process.cwd(), 'src', 'cli', 'dpagent.ts');
  const tsxLoader = pathToFileURL(path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
      cwd,
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
    child.stdin.end(stdin);
  });
}

function startCompleteOnlyMockDpAgentServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'chat_started', data: { startedAt: new Date().toISOString() } }));
        ws.send(
          JSON.stringify({
            type: 'complete',
            data: { content: 'LEGACY_COMPLETE_DONE' },
          })
        );
        ws.close(1000, 'complete-only');
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

function startBroadcastingMockDpAgentServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            type: 'chat_started',
            data: {
              runId: 'own-run',
              startedAt: new Date().toISOString(),
              context: { scope: 'session', namespace: 'mock-session' },
              sessionId: 'mock-session',
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'run_terminal',
            data: {
              runId: 'foreign-run',
              terminalCode: 'completed',
              context: { scope: 'session', namespace: 'other-session' },
              sessionId: 'other-session',
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'message',
            data: {
              runId: 'own-run',
              role: 'assistant',
              content: 'OWN_RUN_DONE',
              context: { scope: 'session', namespace: 'mock-session' },
              sessionId: 'mock-session',
            },
          })
        );
        ws.send(
          JSON.stringify({
            type: 'run_terminal',
            data: {
              runId: 'own-run',
              terminalCode: 'completed',
              context: { scope: 'session', namespace: 'mock-session' },
              sessionId: 'mock-session',
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

async function runParseCase(): Promise<void> {
  const parsed = parseDpagentExecArgs([
    'resume',
    'thread-1',
    '--json',
    '--sandbox',
    'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '--server-url',
    'http://127.0.0.1:53721',
    '-c',
    "mcp_servers.teamtool.command='node'",
    '-c',
    "mcp_servers.teamtool.args=['teamtool.js','--context-base64','abc']",
    '-c',
    "mcp_servers.teamtool.env.AUTO_DEV_MANAGER_URL='http://127.0.0.1:43123'",
    '--workspace',
    'work',
    '--session-id',
    'ignored-new-session',
    '--llm-profile',
    'kimi',
    '--model',
    'kimi-k2',
    '--reasoning',
    'high',
    '--plan-mode',
  ]);

  assert.equal(parsed.json, true);
  assert.equal(parsed.resumeSessionId, 'thread-1');
  assert.equal(parsed.serverUrl, 'http://127.0.0.1:53721');
  assert.equal(parsed.workspaceDir, 'work');
  assert.equal(parsed.sessionId, 'ignored-new-session');
  assert.deepEqual(parsed.llmSelection, {
    profileId: 'kimi',
    model: 'kimi-k2',
    reasoningPreset: 'high',
  });
  assert.equal(parsed.planMode, true);
  assert.deepEqual(parsed.externalMcpServers, [
    {
      name: 'teamtool',
      type: 'stdio',
      command: 'node',
      args: ['teamtool.js', '--context-base64', 'abc'],
      env: {
        AUTO_DEV_MANAGER_URL: 'http://127.0.0.1:43123',
      },
    },
  ]);
}

async function runJsonlErrorCase(): Promise<void> {
  const result = await runCli(
    ['exec', '--json', '--server-url', 'http://127.0.0.1:9', '--sandbox', 'danger-full-access'],
    'Say hello from EAT.'
  );

  assert.equal(result.code, 1);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 2);
  const started = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  const error = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
  assert.equal(started.type, 'thread.started');
  assert.equal(typeof started.thread_id, 'string');
  assert.equal(error.type, 'error');
  assert.match(String(error.message), /ECONNREFUSED|connection/i);
}

async function runJsonlSuccessCase(): Promise<void> {
  const server = await startMockDpAgentServer();
  try {
    const result = await runCli(
      [
        'exec',
        '--json',
        '--server-url',
        server.url,
        '--workspace',
        'mock-workspace',
        '--session-id',
        'mock-session',
        '--llm-profile',
        'kimi',
        '--model',
        'kimi-k2',
        '--reasoning',
        'medium',
        '--plan-mode',
        '-c',
        "mcp_servers.teamtool.command='node'",
        '-c',
        "mcp_servers.teamtool.args=['teamtool.js']",
      ],
      'Say hello from EAT.'
    );
    const received = await server.received;
    const headers = await server.headers;

    assert.equal(result.code, 0);
    assert.equal(headers['x-dpagent-client-kind'], 'cli');
    assert.equal(received.type, 'chat');
    assert.equal((received.data as Record<string, unknown>).clientKind, 'cli');
    assert.deepEqual((received.data as Record<string, unknown>).llmSelection, {
      profileId: 'kimi',
      model: 'kimi-k2',
      reasoningPreset: 'medium',
    });
    assert.equal((received.data as Record<string, unknown>).planningAction, 'enter_drafting');
    assert.deepEqual((received.data as Record<string, unknown>).context, {
      scope: 'session',
      namespace: 'mock-session',
    });
    assert.match(String((received.data as Record<string, unknown>).workspaceDir), /mock-workspace/);
    assert.deepEqual((received.data as Record<string, unknown>).externalMcpServers, [
      {
        name: 'teamtool',
        type: 'stdio',
        command: 'node',
        args: ['teamtool.js'],
      },
    ]);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.type), [
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
      'task_complete',
    ]);
    assert.equal(lines.filter((line) => line.type === 'turn.completed').length, 1);
    assert.equal((lines[2]?.item as Record<string, unknown>).type, 'agent_message');
    assert.equal((lines[2]?.item as Record<string, unknown>).content, 'DPAGENT_EAT_OK');
  } finally {
    await server.close();
  }
}

async function runCompleteOnlyCloseCompatibilityCase(): Promise<void> {
  const server = await startCompleteOnlyMockDpAgentServer();
  try {
    const result = await runCli(
      ['exec', '--json', '--server-url', server.url, '--session-id', 'mock-session'],
      'Say hello from EAT.'
    );

    assert.equal(result.code, 0);
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.type), [
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
      'task_complete',
    ]);
    assert.equal((lines[2]?.item as Record<string, unknown>).content, 'LEGACY_COMPLETE_DONE');
  } finally {
    await server.close();
  }
}

async function runBroadcastIsolationCase(): Promise<void> {
  const server = await startBroadcastingMockDpAgentServer();
  try {
    const result = await runCli(
      ['exec', '--json', '--server-url', server.url, '--session-id', 'mock-session'],
      'Say hello from EAT.'
    );

    assert.equal(result.code, 0);
    const lines = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.type), [
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
      'task_complete',
    ]);
    assert.equal((lines[2]?.item as Record<string, unknown>).content, 'OWN_RUN_DONE');
  } finally {
    await server.close();
  }
}

async function runFirstRunInitCreatesSafeProfileConfig(): Promise<void> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-first-run-'));
  const result = await runCliFromRepoEntry(['init'], '', rootDir);
  const configPath = path.join(rootDir, 'config.yaml');

  assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /Created .*config\.yaml/);
  assert.equal(fs.existsSync(configPath), true);
  const config = fs.readFileSync(configPath, 'utf8');
  assert.match(config, /llmProfiles:/);
  assert.match(config, /defaultProfileId: default/);
  assert.match(config, /apiKey: ''/);
  assert.doesNotMatch(config, /skillListPath/);
  assert.doesNotMatch(config, /sk-[A-Za-z0-9_-]{12,}/);
}

runParseCase()
  .then(runFirstRunInitCreatesSafeProfileConfig)
  .then(runJsonlErrorCase)
  .then(runJsonlSuccessCase)
  .then(runCompleteOnlyCloseCompatibilityCase)
  .then(runBroadcastIsolationCase)
  .then(() => {
    console.log('dpagent-exec-cli tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
