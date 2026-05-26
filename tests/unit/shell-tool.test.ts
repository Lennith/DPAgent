import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { ShellTool } from '../../src/tools/ShellTool.js';
import type { ShellType } from '../../src/types.js';
import { getRuntimePlatformCapabilities } from '../../src/runtime-platform.js';

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions | undefined;
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid?: number;
  killed = false;
  exitCode: number | null = null;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = this.exitCode ?? -1;
    this.emit('close', this.exitCode);
    return true;
  }
}

class TestableShellTool extends ShellTool {
  public readonly spawnCalls: SpawnCall[] = [];
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions | undefined) => FakeChildProcess;

  constructor(
    options: ConstructorParameters<typeof ShellTool>[0],
    spawnImpl: (command: string, args: string[], options: SpawnOptions | undefined) => FakeChildProcess
  ) {
    super(options);
    this.spawnImpl = spawnImpl;
  }

  protected override spawnProcess(
    command: string,
    args: string[],
    options: Parameters<typeof ShellTool.prototype['spawnProcess']>[2]
  ): ReturnType<typeof ShellTool.prototype['spawnProcess']> {
    this.spawnCalls.push({ command, args: [...args], options });
    return this.spawnImpl(command, args, options) as ReturnType<typeof ShellTool.prototype['spawnProcess']>;
  }
}

function createWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shell-tool-test-${prefix}-`));
}

function cleanupWorkspace(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createSuccessfulTool(workspaceDir: string): TestableShellTool {
  return new TestableShellTool(
    {
      workspaceDir,
      timeout: 500,
      outputIdleTimeout: 10_000,
      maxRunTime: 10_000,
    },
    () => {
      const proc = new FakeChildProcess(1101);
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('safe-output\n', 'utf-8'));
        proc.exitCode = 0;
        proc.emit('close', 0);
      });
      return proc;
    }
  );
}

async function testUnsupportedShellRejectsBeforeSpawn(): Promise<void> {
  const workspaceDir = createWorkspace('unsupported');
  try {
    const tool = createSuccessfulTool(workspaceDir);
    assert.match(tool.description, /idle-output, max-runtime, and output-size guardrails/i);
    assert.match(String((tool.parameters as any).properties.timeout.description ?? ''), /max-output guardrails/i);
    const supported = getRuntimePlatformCapabilities().supportedShells;
    const unsupported = (['powershell', 'cmd', 'bash', 'sh'] as ShellType[]).find((item) => !supported.includes(item));
    assert.ok(unsupported, 'expected at least one unsupported shell for current platform');

    const result = await tool.execute({
      command: 'echo safe',
      shell: unsupported,
    });

    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /not available/);
    assert.equal(tool.spawnCalls.length, 0);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testPermissionDeniedSkipsSpawn(): Promise<void> {
  const workspaceDir = createWorkspace('permission');
  try {
    const tool = new TestableShellTool(
      {
        workspaceDir,
        checkPermission: () => ({
          allowed: false,
          reason: 'denied-by-test',
        }),
      },
      () => {
        throw new Error('spawn should not be called when permission is denied');
      }
    );

    const result = await tool.execute({
      command: 'echo safe',
      cwd: '.',
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'denied-by-test');
    assert.equal(tool.spawnCalls.length, 0);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testExecuteSuccessPathWithMockSpawn(): Promise<void> {
  const workspaceDir = createWorkspace('success');
  try {
    const tool = createSuccessfulTool(workspaceDir);
    const result = await tool.execute({
      command: 'echo safe',
      cwd: '.',
    });

    assert.equal(result.success, true);
    assert.equal(result.content, 'safe-output');
    assert.equal(tool.spawnCalls.length, 1);
    assert.equal(tool.spawnCalls[0]?.command.endsWith('.exe'), process.platform === 'win32');
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testExecuteNonZeroExitIncludesStdoutAndStderr(): Promise<void> {
  const workspaceDir = createWorkspace('nonzero');
  try {
    const tool = new TestableShellTool(
      {
        workspaceDir,
        timeout: 500,
        outputIdleTimeout: 10_000,
        maxRunTime: 10_000,
      },
      () => {
        const proc = new FakeChildProcess(1102);
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from('std-out', 'utf-8'));
          proc.stderr.emit('data', Buffer.from('std-err', 'utf-8'));
          proc.exitCode = 2;
          proc.emit('close', 2);
        });
        return proc;
      }
    );

    const result = await tool.execute({
      command: 'echo fail',
    });

    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /exited with code 2/);
    assert.match(String(result.error ?? ''), /Stdout: std-out/);
    assert.match(String(result.error ?? ''), /Stderr: std-err/);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testExecuteTimeoutTriggersKillPathWithoutRealKill(): Promise<void> {
  const workspaceDir = createWorkspace('timeout');
  try {
    const killedPids: number[] = [];
    const tool = new TestableShellTool(
      {
        workspaceDir,
        timeout: 30,
        outputIdleTimeout: 10_000,
        maxRunTime: 10_000,
      },
      () => new FakeChildProcess(1103)
    );
    (tool as any).killProcessTree = async (pid: number) => {
      killedPids.push(pid);
    };

    const result = await tool.execute({
      command: 'long-running-safe-command',
    });

    assert.equal(result.success, false);
    assert.match(String(result.error ?? ''), /timed out/);
    assert.deepEqual(killedPids, [1103]);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

function testShellCommandAndArgsMapping(): void {
  const workspaceDir = createWorkspace('mapping');
  try {
    const tool = createSuccessfulTool(workspaceDir) as any;
    assert.equal(tool.getShellCommand('powershell'), 'powershell.exe');
    assert.equal(tool.getShellCommand('cmd'), 'cmd.exe');
    assert.equal(tool.getShellCommand('bash'), 'bash');
    assert.equal(tool.getShellCommand('sh'), 'sh');

    assert.deepEqual(tool.getShellArgs('cmd', 'echo safe'), ['/c', 'echo safe']);
    assert.deepEqual(tool.getShellArgs('bash', 'echo safe'), ['-lc', 'echo safe']);
    assert.deepEqual(tool.getShellArgs('sh', 'echo safe'), ['-c', 'echo safe']);
    const powershellArgs = tool.getShellArgs('powershell', 'echo safe');
    assert.equal(powershellArgs[0], '-NoProfile');
    assert.equal(powershellArgs[2], '-Command');
    assert.match(String(powershellArgs[3]), /chcp 65001/);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testCleanupAllUsesKillTreeAndClearsRegistry(): Promise<void> {
  const workspaceDir = createWorkspace('cleanup');
  try {
    const tool = createSuccessfulTool(workspaceDir);
    const active = (tool as any).activeProcesses as Map<number, { killed: boolean }>;
    active.set(2001, { killed: false });
    active.set(2002, { killed: true });
    const killedPids: number[] = [];
    (tool as any).killProcessTree = async (pid: number) => {
      killedPids.push(pid);
    };

    await tool.cleanupAll();

    assert.deepEqual(killedPids, [2001]);
    assert.equal(active.size, 0);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testShellExecutionLogRedactsCommandSecrets(): Promise<void> {
  const workspaceDir = createWorkspace('redact');
  try {
    const logDir = path.join(workspaceDir, 'logs');
    const tool = new TestableShellTool(
      {
        workspaceDir,
        logDir,
        timeout: 500,
        outputIdleTimeout: 10_000,
        maxRunTime: 10_000,
      },
      () => {
        const proc = new FakeChildProcess(1104);
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from('ok', 'utf-8'));
          proc.exitCode = 0;
          proc.emit('close', 0);
        });
        return proc;
      }
    );

    const result = await tool.execute({
      command:
        'echo sk-test-secret-value-1234567890 API_KEY=secret-token MINIMAX_API_KEY=minimax-secret ' +
        '--token cli-secret-value --api-key="quoted secret value" -H "Authorization: Bearer bearer-secret-value-1234567890"',
    });
    assert.equal(result.success, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const logFiles = fs.readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(logFiles.length, 1);
    const rawLog = fs.readFileSync(path.join(logDir, logFiles[0]), 'utf-8');
    assert.doesNotMatch(rawLog, /sk-test-secret-value-1234567890/);
    assert.doesNotMatch(rawLog, /secret-token/);
    assert.doesNotMatch(rawLog, /minimax-secret/);
    assert.doesNotMatch(rawLog, /cli-secret-value/);
    assert.doesNotMatch(rawLog, /quoted secret value/);
    assert.doesNotMatch(rawLog, /bearer-secret-value-1234567890/);
    assert.match(rawLog, /\[redacted/);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function testAbortSignalCancelsRunningCommand(): Promise<void> {
  const workspaceDir = createWorkspace('abort');
  try {
    const proc = new FakeChildProcess(1105);
    const tool = new TestableShellTool(
      {
        workspaceDir,
        timeout: 10_000,
        outputIdleTimeout: 10_000,
        maxRunTime: 10_000,
      },
      () => proc
    );
    const killedPids: number[] = [];
    (tool as unknown as { killProcessTree: (pid: number) => Promise<void> }).killProcessTree = async (pid: number) => {
      killedPids.push(pid);
      proc.kill();
    };
    const controller = new AbortController();
    const resultPromise = tool.execute({ command: 'long-running' }, { signal: controller.signal });
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /cancelled/i);
    assert.deepEqual(killedPids, [1105]);
  } finally {
    cleanupWorkspace(workspaceDir);
  }
}

async function runAll(): Promise<void> {
  await testUnsupportedShellRejectsBeforeSpawn();
  await testPermissionDeniedSkipsSpawn();
  await testExecuteSuccessPathWithMockSpawn();
  await testExecuteNonZeroExitIncludesStdoutAndStderr();
  await testExecuteTimeoutTriggersKillPathWithoutRealKill();
  testShellCommandAndArgsMapping();
  await testCleanupAllUsesKillTreeAndClearsRegistry();
  await testShellExecutionLogRedactsCommandSecrets();
  await testAbortSignalCancelsRunningCommand();
  console.log('shell-tool tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
