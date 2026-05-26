import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface TimedCommandResult {
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage?: string;
  raw: SpawnSyncReturns<Buffer>;
}

export function resolvePositiveTimeoutMs(value: unknown, defaultTimeoutMs: number): number {
  const timeoutMs = Number(value ?? defaultTimeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : defaultTimeoutMs;
}

export function resolveGitCommitSha(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `failed to resolve git HEAD in ${cwd}`);
  }
  const sha = String(result.stdout || '').trim();
  if (!sha) {
    throw new Error(`git rev-parse returned empty HEAD in ${cwd}`);
  }
  return sha;
}

export function runTimedShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  stdio?: 'inherit' | 'pipe';
}): TimedCommandResult {
  const startedAt = Date.now();
  const result = spawnSync(input.command, {
    cwd: input.cwd,
    stdio: input.stdio ?? 'inherit',
    shell: true,
    env: process.env,
    timeout: input.timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    durationMs,
    timeoutMs: input.timeoutMs,
    timedOut: error?.code === 'ETIMEDOUT',
    exitCode: result.status,
    signal: result.signal,
    ...(error?.message ? { errorMessage: error.message } : {}),
    raw: result,
  };
}
