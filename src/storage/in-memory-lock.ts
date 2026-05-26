export interface InMemoryLockOptions {
  maxSpinAttempts?: number;
}

const DEFAULT_MAX_SPIN_ATTEMPTS = 100000;

export class InMemoryLockTimeoutError extends Error {
  constructor(filePath: string, attempts: number) {
    super(`Timed out waiting for in-memory file lock after ${attempts} attempts: ${filePath}`);
    this.name = 'InMemoryLockTimeoutError';
  }
}

const fileLocks = new Map<string, boolean>();

function acquireLock(filePath: string): boolean {
  if (fileLocks.get(filePath)) {
    return false;
  }
  fileLocks.set(filePath, true);
  return true;
}

export function releaseInMemoryLock(filePath: string): void {
  fileLocks.delete(filePath);
}

export function acquireInMemoryLockOrThrow(filePath: string, options: InMemoryLockOptions = {}): void {
  const maxSpinAttempts = Math.max(1, Math.floor(options.maxSpinAttempts ?? DEFAULT_MAX_SPIN_ATTEMPTS));
  for (let attempt = 1; attempt <= maxSpinAttempts; attempt += 1) {
    if (acquireLock(filePath)) {
      return;
    }
  }
  throw new InMemoryLockTimeoutError(filePath, maxSpinAttempts);
}
