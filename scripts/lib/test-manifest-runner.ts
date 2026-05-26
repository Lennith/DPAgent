import {
  getTestManifestEntries,
  TEST_MANIFEST,
  type TestManifestEntry,
  type TestSuiteName,
} from '../../tests/test-manifest.js';
import { resolvePositiveTimeoutMs, runTimedShellCommand } from './test-command-runner.js';

export const DEFAULT_TEST_MANIFEST_ENTRY_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunnerOptions {
  list: boolean;
  suites: TestSuiteName[];
  grep?: string;
  tag?: string;
}

const VALID_SUITES = new Set<TestSuiteName>(['unit', 'integration', 'e2e', 'contracts', 'all']);

export function parseManifestRunnerArgs(argv: string[]): RunnerOptions {
  const suites: TestSuiteName[] = [];
  let list = false;
  let grep: string | undefined;
  let tag: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--grep') {
      grep = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--tag') {
      tag = argv[index + 1];
      index += 1;
      continue;
    }
    if (!VALID_SUITES.has(arg as TestSuiteName)) {
      throw new Error(`Unknown test suite or option: ${arg}`);
    }
    suites.push(arg as TestSuiteName);
  }

  return {
    list,
    suites: suites.length > 0 ? suites : ['unit'],
    grep,
    tag,
  };
}

function uniqueEntries(entries: TestManifestEntry[]): TestManifestEntry[] {
  const seen = new Set<string>();
  const unique: TestManifestEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

export function resolveManifestEntries(options: RunnerOptions): TestManifestEntry[] {
  let entries = uniqueEntries(options.suites.flatMap((suite) => getTestManifestEntries(suite)));
  if (options.grep) {
    const pattern = new RegExp(options.grep);
    entries = entries.filter((entry) => pattern.test(entry.id) || entry.files.some((file) => pattern.test(file)));
  }
  if (options.tag) {
    entries = entries.filter((entry) => entry.tags.includes(options.tag as string));
  }
  return entries;
}

export function printManifestEntries(entries: TestManifestEntry[]): void {
  for (const entry of entries) {
    console.log(`${entry.id}\t${entry.command}\t${entry.tags.join(',')}`);
  }
}

export function resolveEntryTimeoutMs(entry: Pick<TestManifestEntry, 'timeoutMs'>): number {
  return resolvePositiveTimeoutMs(entry.timeoutMs, DEFAULT_TEST_MANIFEST_ENTRY_TIMEOUT_MS);
}

export function runEntry(entry: TestManifestEntry): void {
  console.log(`\n[test-manifest] ${entry.id}: ${entry.command}`);
  const timeoutMs = resolveEntryTimeoutMs(entry);
  const result = runTimedShellCommand({
    command: entry.command,
    cwd: process.cwd(),
    stdio: 'inherit',
    timeoutMs,
  });
  if (result.errorMessage) {
    if (result.timedOut) {
      throw new Error(`[test-manifest] ${entry.id} timed out after ${timeoutMs}ms`);
    }
    throw result.raw.error ?? new Error(result.errorMessage);
  }
  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

export function runManifest(options: RunnerOptions): void {
  const entries = resolveManifestEntries(options);
  if (options.list) {
    printManifestEntries(entries);
    return;
  }
  if (entries.length === 0) {
    throw new Error(`No tests matched. Manifest entries=${TEST_MANIFEST.length}`);
  }
  for (const entry of entries) {
    runEntry(entry);
  }
}
