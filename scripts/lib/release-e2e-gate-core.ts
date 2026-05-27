import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TEST_MANIFEST,
  type TestManifestEntry,
} from '../../tests/test-manifest.js';
import { resolveGitCommitSha, resolvePositiveTimeoutMs, runTimedShellCommand } from './test-command-runner.js';
import {
  parseFlagArgs,
  resolveOutputRoot,
  sameStringSet,
  writeJsonArtifact,
  writeTextArtifact,
} from './script-cli-utils.js';

const ROOT = process.cwd();

export const DEFAULT_RELEASE_E2E_CASE_TIMEOUT_MS = 30 * 60 * 1000;
export const RELEASE_E2E_AGGREGATE_FILE = 'release-e2e-gate.json';
export const RELEASE_E2E_MARKDOWN_FILE = 'release-e2e-gate.md';
export const DEFAULT_RELEASE_E2E_REQUIRED_CASES = [
  'e2e:release-agent-web-regression',
  'e2e:release-plan-mode-lifecycle',
  'e2e:release-plan-mode-ux',
  'e2e:release-cli-long-session',
] as const;

export interface ReleaseE2EArgs {
  tag: string;
  outputRoot: string;
}

export interface ReleaseE2ECaseResult {
  id: string;
  command: string;
  files: string[];
  tags: string[];
  status: 'passed' | 'failed';
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorMessage?: string;
}

export interface ReleaseE2EGateAggregate {
  generatedAt: string;
  sourceCommitSha: string;
  requiredCases: string[];
  cases: ReleaseE2ECaseResult[];
  gatePassed: boolean;
}

export function parseReleaseE2EArgs(argv: string[]): ReleaseE2EArgs {
  const map = parseFlagArgs(argv);
  return {
    tag: String(map.get('tag') || 'release-gate').trim() || 'release-gate',
    outputRoot: resolveOutputRoot(map.get('output-root'), path.join(ROOT, 'logs', 'release-gate-e2e')),
  };
}

function resolveReleaseCases(tag: string): TestManifestEntry[] {
  return TEST_MANIFEST.filter((entry) => entry.suite === 'e2e' && entry.tags.includes(tag));
}

function resolveRequiredCasesFromPackageJson(): string[] {
  const packagePath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
    releaseGate?: {
      releaseE2E?: {
        requiredCases?: unknown;
      };
    };
    internalPublish?: {
      releaseE2EGate?: {
        requiredCases?: unknown;
      };
    };
  };
  const requiredCases =
    pkg.releaseGate?.releaseE2E?.requiredCases ??
    pkg.internalPublish?.releaseE2EGate?.requiredCases ??
    [...DEFAULT_RELEASE_E2E_REQUIRED_CASES];
  if (!Array.isArray(requiredCases)) {
    throw new Error('package.json releaseGate.releaseE2E.requiredCases must be an array.');
  }
  const normalized = requiredCases
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
  if (normalized.length === 0 || normalized.length !== requiredCases.length) {
    throw new Error('package.json releaseGate.releaseE2E.requiredCases must contain non-empty strings.');
  }
  return normalized;
}

export function resolveReleaseCaseTimeoutMs(entry: Pick<TestManifestEntry, 'timeoutMs'>): number {
  return resolvePositiveTimeoutMs(entry.timeoutMs, DEFAULT_RELEASE_E2E_CASE_TIMEOUT_MS);
}

export function runCase(entry: TestManifestEntry): ReleaseE2ECaseResult {
  console.log(`\n[release-e2e] ${entry.id}: ${entry.command}`);
  const timeoutMs = resolveReleaseCaseTimeoutMs(entry);
  const result = runTimedShellCommand({
    command: entry.command,
    cwd: ROOT,
    stdio: 'inherit',
    timeoutMs,
  });
  if (result.errorMessage) {
    console.error(`[release-e2e] ${entry.id} failed to start: ${result.errorMessage}`);
  }
  return {
    id: entry.id,
    command: entry.command,
    files: [...entry.files],
    tags: [...entry.tags],
    status: result.exitCode === 0 && !result.errorMessage ? 'passed' : 'failed',
    durationMs: result.durationMs,
    timeoutMs,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}

export function buildAggregate(input: {
  generatedAt: string;
  sourceCommitSha: string;
  requiredCases: string[];
  cases: ReleaseE2ECaseResult[];
}): ReleaseE2EGateAggregate {
  return {
    generatedAt: input.generatedAt,
    sourceCommitSha: input.sourceCommitSha,
    requiredCases: input.requiredCases,
    cases: input.cases,
    gatePassed:
      sameStringSet(
        input.cases.map((item) => item.id),
        input.requiredCases
      ) &&
      input.cases.every((item) => item.status === 'passed'),
  };
}

function buildMarkdown(aggregate: ReleaseE2EGateAggregate): string {
  const lines = [
    '# Release E2E Gate',
    '',
    `- Generated at: ${aggregate.generatedAt}`,
    `- Source commit: ${aggregate.sourceCommitSha}`,
    `- Required cases: ${aggregate.requiredCases.join(', ')}`,
    `- Gate passed: ${aggregate.gatePassed ? 'yes' : 'no'}`,
    '',
    '## Cases',
    '',
    '| Case | Status | Timeout | Duration ms | Command |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const item of aggregate.cases) {
    lines.push(`| ${item.id} | ${item.status} | ${item.timedOut ? 'yes' : 'no'} | ${item.durationMs} | \`${item.command}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeArtifacts(outputRoot: string, aggregate: ReleaseE2EGateAggregate): void {
  writeJsonArtifact(outputRoot, RELEASE_E2E_AGGREGATE_FILE, aggregate);
  writeTextArtifact(outputRoot, RELEASE_E2E_MARKDOWN_FILE, buildMarkdown(aggregate));
}

export function runReleaseE2EGate(args: ReleaseE2EArgs): ReleaseE2EGateAggregate {
  const cases = resolveReleaseCases(args.tag);
  if (cases.length === 0) {
    throw new Error(`No release E2E cases found for tag '${args.tag}'.`);
  }
  const requiredCases = resolveRequiredCasesFromPackageJson();
  const results = cases.map((entry) => runCase(entry));
  const aggregate = buildAggregate({
    generatedAt: new Date().toISOString(),
    sourceCommitSha: resolveGitCommitSha(ROOT),
    requiredCases,
    cases: results,
  });
  writeArtifacts(args.outputRoot, aggregate);
  return aggregate;
}
