import * as assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDpAgentAssistantSkillScript } from '../helpers/dpagent-assistant-skill-paths.js';

const rootDir = process.cwd();

function testSkillScriptsResolveFromBundledAgent(): void {
  const script = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  assert.match(script, /agents[\\/]dpagent-assistant[\\/]skill[\\/]dpagent-update[\\/]scripts[\\/]run\.js$/);
  assert.equal(fs.existsSync(script), true);
}

function runJson(script: string, args: string[]): any {
  const output = execFileSync(process.execPath, [script, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(output);
}

function testAgentCreateCliSchemaDescribeAndPlan(): void {
  const script = resolveDpAgentAssistantSkillScript('dpagent-agent-create', path.join('scripts', 'run.js'));
  const schema = runJson(script, ['schema', '--output', 'json']);
  assert.equal(schema.success, true);
  assert.equal(schema.data.name, 'dpagent-agent-create');
  assert.equal(schema.data.commands.apply.write, true);

  const describe = runJson(script, ['describe', 'apply', '--output', 'json']);
  assert.equal(describe.data.name, 'apply');
  assert.equal(describe.data.write, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpai-agent-create-cli-'));
  try {
    const payloadPath = path.join(tempDir, 'payload.json');
    fs.writeFileSync(
      payloadPath,
      JSON.stringify({
        agent: {
          name: 'Novelist',
          content: '# Novelist',
        },
        toolsets: { upsert: [{ name: 'novelist-tools', capabilities: ['file_read'] }] },
      }),
      'utf8'
    );
    const plan = runJson(script, ['plan', '--json', `@${payloadPath}`, '--output', 'json']);
    assert.equal(plan.success, true);
    assert.equal(plan.data.agentName, 'Novelist');
    assert.equal(plan.data.toolsetUpserts, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testUpdateCliSchemaDescribeAndStatus(): void {
  const script = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  const schema = runJson(script, ['schema', '--output', 'json']);
  assert.equal(schema.success, true);
  assert.equal(schema.data.name, 'dpagent-update');
  assert.equal(schema.data.commands.start.write, true);

  const describe = runJson(script, ['describe', 'start', '--output', 'json']);
  assert.equal(describe.data.name, 'start');
  assert.equal(describe.data.write, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpai-update-cli-'));
  try {
    const statusPath = path.join(tempDir, 'status.json');
    fs.writeFileSync(statusPath, JSON.stringify({ status: 'complete' }), 'utf8');
    const status = runJson(script, ['status', '--status-file', statusPath, '--output', 'json']);
    assert.equal(status.success, true);
    assert.equal(status.data.status, 'complete');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testCliErrorModelHasNoStack(): void {
  const script = resolveDpAgentAssistantSkillScript('dpagent-agent-create', path.join('scripts', 'run.js'));
  const result = spawnSync(process.execPath, [script, 'missing-command', '--output', 'json'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  const body = JSON.parse(result.stdout);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNKNOWN_COMMAND');
  assert.equal(body.error.stack, undefined);
  assert.doesNotMatch(result.stdout, /at .*run\.js/);

  const unknownDescribe = spawnSync(process.execPath, [script, 'describe', 'missing-command', '--output', 'json'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(unknownDescribe.status, 0);
  const describeBody = JSON.parse(unknownDescribe.stdout);
  assert.equal(describeBody.success, false);
  assert.equal(describeBody.error.code, 'UNKNOWN_COMMAND');

  const updateScript = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  const unknownUpdateDescribe = spawnSync(process.execPath, [updateScript, 'describe', 'missing-command', '--output', 'json'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(unknownUpdateDescribe.status, 0);
  const updateDescribeBody = JSON.parse(unknownUpdateDescribe.stdout);
  assert.equal(updateDescribeBody.success, false);
  assert.equal(updateDescribeBody.error.code, 'UNKNOWN_COMMAND');
}

function listenRuntimeServer(input: {
  onShutdown?: (req: http.IncomingMessage, body: string) => { status: number; body: unknown };
}): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    res.setHeader('connection', 'close');
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/api/system/runtime-info') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '0.0.0-test',
          pid: process.pid,
          configPath: path.join(os.tmpdir(), 'dpagent-update-test-config.yaml'),
          port: 53721,
          packageRoot: rootDir,
          installMode: 'npm-local',
          packageManager: 'npm',
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/system/shutdown') {
        const result = input.onShutdown?.(req, bodyText) ?? { status: 202, body: { success: true } };
        res.statusCode = result.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result.body));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind runtime test server'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function runProcess(args: string[], timeoutMs = 10000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`process timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function waitForStatus(statusPath: string, expected: string, timeoutMs = 6000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(statusPath)) {
      last = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (last.status === expected) {
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`status ${expected} not reached; last=${JSON.stringify(last)}`);
}

async function testUpdateStartDoesNotInstallWithoutAcceptedShutdown(): Promise<void> {
  const script = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpai-update-guard-'));
  const runtime = await listenRuntimeServer({
    onShutdown: () => ({ status: 500, body: { success: false, code: 'boom' } }),
  });
  try {
    const statusPath = path.join(tempDir, 'status.json');
    const result = await runProcess(
      [
        script,
        'start',
        '--base-url',
        runtime.baseUrl,
        '--confirm',
        'yes',
        '--approval-timeout-ms',
        '700',
        '--wait-for-stop-ms',
        '700',
        '--status-file',
        statusPath,
        '--target-version',
        '0.0.0-test',
        '--output',
        'json',
      ]
    );
    assert.notEqual(result.status, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'SHUTDOWN_REQUEST_FAILED');
    const status = await waitForStatus(statusPath, 'shutdown_not_approved');
    assert.equal(status.status, 'shutdown_not_approved');
  } finally {
    await closeServer(runtime.server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testUpdateStartDoesNotInstallUntilServerStops(): Promise<void> {
  const script = resolveDpAgentAssistantSkillScript('dpagent-update', path.join('scripts', 'run.js'));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpai-update-timeout-'));
  let sawConfirmHeader = false;
  const runtime = await listenRuntimeServer({
    onShutdown: (req) => {
      sawConfirmHeader = req.headers['x-dpagent-shutdown-confirm'] === 'yes';
      return { status: 202, body: { success: true } };
    },
  });
  try {
    const statusPath = path.join(tempDir, 'status.json');
    const result = await runProcess(
      [
        script,
        'start',
        '--base-url',
        runtime.baseUrl,
        '--confirm',
        'yes',
        '--approval-timeout-ms',
        '700',
        '--wait-for-stop-ms',
        '900',
        '--status-file',
        statusPath,
        '--target-version',
        '0.0.0-test',
        '--output',
        'json',
      ]
    );
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).meta.shutdownRequested, true);
    assert.equal(sawConfirmHeader, true);
    const status = await waitForStatus(statusPath, 'shutdown_timeout');
    assert.equal(status.status, 'shutdown_timeout');
  } finally {
    await closeServer(runtime.server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  testSkillScriptsResolveFromBundledAgent();
  testAgentCreateCliSchemaDescribeAndPlan();
  testUpdateCliSchemaDescribeAndStatus();
  testCliErrorModelHasNoStack();
  await testUpdateStartDoesNotInstallWithoutAcceptedShutdown();
  await testUpdateStartDoesNotInstallUntilServerStops();
}

runAll().then(() => {
  console.log('dpagent-assistant-skills-cli tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
