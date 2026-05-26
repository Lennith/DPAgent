export type TimerHandle = ReturnType<typeof setTimeout>;

export interface ManagedTimerOptions {
  unref?: boolean;
}

export interface ExponentialBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  minDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export function computeExponentialBackoffDelayMs(attempt: number, options: ExponentialBackoffOptions): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const baseDelay = Math.min(
    Math.max(0, options.baseDelayMs) * Math.pow(2, normalizedAttempt),
    Math.max(0, options.maxDelayMs)
  );
  const jitterRatio = Math.max(0, options.jitterRatio ?? 0);
  const random = options.random ?? Math.random;
  const jitter = baseDelay * jitterRatio * (random() * 2 - 1);
  return Math.max(options.minDelayMs ?? 0, Math.round(baseDelay + jitter));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  const ms = Math.max(0, timeoutMs);
  let timeout: TimerHandle | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timeout = null;
        reject(new Error(message));
      }, ms);
    });
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export interface RetryWithBackoffOptions<T> {
  maxAttempts: number;
  delaysMs: readonly number[];
  run: (attempt: number) => Promise<T>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onFailedAttempt?: (error: unknown, attempt: number) => void | Promise<void>;
}

export async function retryWithBackoff<T>(options: RetryWithBackoffOptions<T>): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await options.run(attempt);
    } catch (error) {
      lastError = error;
      await options.onFailedAttempt?.(error, attempt);
      if (attempt >= maxAttempts || options.shouldRetry?.(error, attempt) === false) {
        break;
      }
      await sleep(options.delaysMs[Math.min(attempt - 1, options.delaysMs.length - 1)] ?? 0);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class ManagedTimeout {
  private handle: TimerHandle | null = null;

  start(callback: () => void, delayMs: number, options: ManagedTimerOptions = {}): this {
    this.clear();
    this.handle = setTimeout(() => {
      this.handle = null;
      callback();
    }, Math.max(0, delayMs));
    if (options.unref) {
      (this.handle as { unref?: () => void }).unref?.();
    }
    return this;
  }

  clear(): void {
    if (!this.handle) {
      return;
    }
    clearTimeout(this.handle);
    this.handle = null;
  }

  get active(): boolean {
    return Boolean(this.handle);
  }
}

export class ManagedInterval {
  private handle: ReturnType<typeof setInterval> | null = null;

  start(callback: () => void, intervalMs: number, options: ManagedTimerOptions = {}): this {
    this.clear();
    this.handle = setInterval(callback, Math.max(0, intervalMs));
    if (options.unref) {
      (this.handle as { unref?: () => void }).unref?.();
    }
    return this;
  }

  clear(): void {
    if (!this.handle) {
      return;
    }
    clearInterval(this.handle);
    this.handle = null;
  }

  get active(): boolean {
    return Boolean(this.handle);
  }
}

export class TimerScope {
  private readonly timers = new Set<ManagedTimeout>();

  setTimeout(callback: () => void, delayMs: number, options: ManagedTimerOptions = {}): ManagedTimeout {
    const timer = new ManagedTimeout();
    this.timers.add(timer);
    timer.start(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs, options);
    return timer;
  }

  clearAll(): void {
    for (const timer of this.timers) {
      timer.clear();
    }
    this.timers.clear();
  }
}
