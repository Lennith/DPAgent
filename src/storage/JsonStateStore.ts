import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type JsonStateParseErrorPolicy = 'fallback' | 'reset' | 'throw';

export interface JsonStateStoreOptions<T> {
  defaultValue: () => T;
  validate?: (value: unknown) => value is T;
  parseErrorPolicy?: JsonStateParseErrorPolicy;
  onInvalid?: (filePath: string) => void;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createStateId(prefix: string, randomBytes = 4): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(randomBytes).toString('hex')}`;
}

export class JsonStateStore<T> {
  private readonly filePath: string;
  private readonly defaultValue: () => T;
  private readonly validate?: (value: unknown) => value is T;
  private readonly parseErrorPolicy: JsonStateParseErrorPolicy;
  private readonly onInvalid?: (filePath: string) => void;

  constructor(filePath: string, options: JsonStateStoreOptions<T>) {
    this.filePath = path.resolve(filePath);
    this.defaultValue = options.defaultValue;
    this.validate = options.validate;
    this.parseErrorPolicy = options.parseErrorPolicy ?? 'fallback';
    this.onInvalid = options.onInvalid;
  }

  read(): T {
    if (!fs.existsSync(this.filePath)) {
      return this.defaultValue();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
      if (this.validate && !this.validate(parsed)) {
        return this.handleInvalidState();
      }
      return parsed as T;
    } catch (error) {
      if (this.parseErrorPolicy === 'throw') {
        throw error;
      }
      return this.handleInvalidState();
    }
  }

  write(payload: T): void {
    writeJsonStateFile(this.filePath, payload);
  }

  update(mutator: (current: T) => T): T {
    const next = mutator(this.read());
    this.write(next);
    return next;
  }

  reset(): T {
    const fallback = this.defaultValue();
    this.write(fallback);
    return fallback;
  }

  private handleInvalidState(): T {
    this.onInvalid?.(this.filePath);
    if (this.parseErrorPolicy === 'reset') {
      return this.reset();
    }
    return this.defaultValue();
  }
}

export function readJsonStateFile<T>(
  filePath: string,
  fallback: T,
  validate?: (value: unknown) => value is T
): T {
  const store = new JsonStateStore<T>(filePath, {
    defaultValue: () => fallback,
    validate,
    parseErrorPolicy: 'fallback',
  });
  return store.read();
}

export function writeJsonStateFile(filePath: string, payload: unknown): void {
  const resolvedPath = path.resolve(filePath);
  const parent = path.dirname(resolvedPath);
  fs.mkdirSync(parent, { recursive: true });
  const tmpPath = path.join(
    parent,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, resolvedPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure; original write error is more useful
    }
    throw error;
  }
}
