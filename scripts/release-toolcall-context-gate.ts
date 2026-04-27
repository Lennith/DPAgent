#!/usr/bin/env tsx
/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = process.cwd();
const KIMI_RELEASE_DEFAULT_MODEL = 'Kimi-k2.6';
const MAX_COMPRESSION_DURATION_MS = 180_000;

export const RELEASE_TOOLCALL_AGGREGATE_FILE = 'release-toolcall-context-gate.json';
export const RELEASE_TOOLCALL_MARKDOWN_FILE = 'release-toolcall-context-gate.md';
export const RELEASE_TOOLCALL_MANUAL_REVIEW_FILE = 'release-toolcall-context-manual-review.json';

export interface GateArgs {
  runs: number;
  rounds: number;
  minPassRate: number;
  model: string;
  profiles: string[];
  configPath: string;
  devProfilesPath: string;
  localProfilesPath: string;
  runTimeoutMs: number;
  outputRoot: string;
}

export interface GateRuntimeProfile {
  label: string;
  id: string;
  name: string;
  provider: 'anthropic' | 'openai';
  apiKey: string;
  apiBase: string;
  model: string;
  maxOutputTokens?: number;
}

interface RoundEvaluation {
  round: number;
  flags: string[];
  ok: boolean;
  maxCompressionDurationMs?: number;
}

export interface SessionReport {
  sessionId: string;
  provider: string;
  model: string;
  passCount: number;
  failCount: number;
  accuracy: number;
  failureFlagCounts: Record<string, number>;
  maxCompressionDurationMs?: number;
  rounds: RoundEvaluation[];
}

export interface ReleaseToolcallGateAggregate {
  generatedAt: string;
  sourceCommitSha: string;
  runs: Array<{
    index: number;
    profile: string;
    profileId: string;
    profileName: string;
    sessionId: string;
    provider: string;
    model: string;
    passCount: number;
    failCount: number;
    accuracy: number;
    failureFlagCounts: Record<string, number>;
    thresholdPassed: boolean;
  }>;
  requiredRuns: number;
  roundsPerRun: number;
  minPassRate: number;
  model: string;
  requiredProfiles: string[];
  gatePassed: boolean;
  manualReviewRequired: true;
  manualReview: {
    required: true;
    aggregateFile: string;
    templateFile: string;
    generatedAt: string;
    reviewedRunSessionIds: string[];
  };
}

export interface ReleaseToolcallManualReview {
  version: 1;
  generatedAt: string;
  aggregateGeneratedAt: string;
  reviewedCommitSha: string;
  reviewer: string;
  reviewedAt: string;
  reviewedRunSessionIds: string[];
  reviewedRequiredRuns: number;
  reviewedRoundsPerRun: number;
  reviewedModel: string;
  reviewedProfiles: string[];
  checklist: {
    runMetricsChecked: boolean;
    failureFlagsChecked: boolean;
    fieldMismatchesChecked: boolean;
    toolCallContinuityChecked: boolean;
    cascadeFailuresChecked: boolean;
    completionMarkerRepairsChecked: boolean;
    materiallyCorrect: boolean;
    seriousHallucinationFound: boolean;
    scriptFalsePositivePassFound: boolean;
  };
  conclusion: 'pending' | 'approved' | 'rejected';
  issuesFound: string[];
  notes: string;
}

export function parseArgs(argv: string[]): GateArgs {
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      index += 1;
    } else {
      map.set(key, 'true');
    }
  }

  const runsRaw = map.has('runs') ? Number.parseInt(String(map.get('runs')), 10) : Number.NaN;
  const profiles = String(map.get('profiles') || 'kimi,deepseek,minimax')
    .split(',')
    .map((item) => normalizeProfileLabel(item))
    .filter(Boolean);
  const uniqueProfiles = profiles.filter((item, index) => profiles.indexOf(item) === index);
  const roundsRaw = Number.parseInt(String(map.get('rounds') || '20'), 10);
  const minPassRateRaw = Number.parseFloat(String(map.get('min-pass-rate') || '0.9'));
  const runTimeoutRaw = Number.parseInt(String(map.get('run-timeout-ms') || '900000'), 10);
  return {
    runs: Number.isFinite(runsRaw)
      ? Math.max(1, Math.min(10, runsRaw))
      : Math.max(1, uniqueProfiles.length),
    rounds: Number.isFinite(roundsRaw) ? Math.max(1, Math.min(30, roundsRaw)) : 20,
    minPassRate:
      Number.isFinite(minPassRateRaw) && minPassRateRaw > 0 && minPassRateRaw <= 1
        ? minPassRateRaw
        : 0.9,
    model: String(map.get('model') || 'multi-profile').trim() || 'multi-profile',
    profiles: uniqueProfiles.length > 0 ? uniqueProfiles : ['kimi', 'deepseek', 'minimax'],
    configPath: path.resolve(String(map.get('config-path') || path.join(ROOT, 'config.yaml'))),
    devProfilesPath: path.resolve(
      String(map.get('dev-profiles') || path.join(ROOT, 'release-toolcall-profiles.dev.json'))
    ),
    localProfilesPath: path.resolve(
      String(map.get('local-profiles') || path.join(ROOT, 'release-toolcall-profiles.local.json'))
    ),
    runTimeoutMs: Number.isFinite(runTimeoutRaw) ? Math.max(60_000, runTimeoutRaw) : 900_000,
    outputRoot: path.resolve(
      String(map.get('output-root') || path.join(ROOT, 'logs', 'release-gate-toolcall-context-session'))
    ),
  };
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeProfileLabel(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJsonOrYaml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = filePath.toLowerCase().endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

function readBaseModel(config: Record<string, unknown>): string {
  return String(((config.api as Record<string, unknown> | undefined) ?? {}).model ?? '').trim();
}

function normalizeRuntimeProfile(raw: unknown, fallbackLabel: string, fallbackModel = ''): GateRuntimeProfile | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = String(record.name ?? fallbackLabel).trim();
  const id = String(record.id ?? fallbackLabel).trim();
  const label = normalizeProfileLabel(String(record.label ?? (name || id || fallbackLabel)));
  const provider = String(record.provider ?? 'anthropic').trim().toLowerCase();
  const apiKey = String(record.apiKey ?? '').trim();
  const apiBase = String(record.apiBase ?? '').trim();
  const explicitModel = String(record.model ?? record.defaultModel ?? '').trim();
  const model = explicitModel || (label === 'kimi' ? KIMI_RELEASE_DEFAULT_MODEL : fallbackModel).trim();
  const maxOutputTokens = Number(record.maxOutputTokens);
  if (!label || !id || !apiKey || !apiBase || !model) {
    return null;
  }
  return {
    label,
    id,
    name: name || id,
    provider: provider === 'openai' ? 'openai' : 'anthropic',
    apiKey,
    apiBase,
    model,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : undefined,
  };
}

function enforceProfileModelContract(profile: GateRuntimeProfile): GateRuntimeProfile {
  if (profile.label === 'deepseek' && profile.model !== 'deepseek-v4-flash') {
    throw new Error(
      `Release toolcall profile 'deepseek' must use model deepseek-v4-flash, got ${profile.model || '<empty>'}.`
    );
  }
  return profile;
}

function readProfilesFromConfig(configPath: string): GateRuntimeProfile[] {
  const config = readJsonOrYaml(configPath);
  const fallbackModel = readBaseModel(config);
  const profiles = Array.isArray((config.llmProfiles as Record<string, unknown> | undefined)?.profiles)
    ? ((config.llmProfiles as Record<string, unknown>).profiles as unknown[])
    : [];
  return profiles
    .map((profile) => normalizeRuntimeProfile(profile, 'profile', fallbackModel))
    .filter((profile): profile is GateRuntimeProfile => profile !== null);
}

function readProfilesFile(profilesPath: string, fallbackModel: string): GateRuntimeProfile[] {
  const config = readJsonOrYaml(profilesPath);
  const rawProfiles = Array.isArray(config.profiles) ? config.profiles : [];
  return rawProfiles
    .map((profile) => normalizeRuntimeProfile(profile, 'release-profile', fallbackModel))
    .filter((profile): profile is GateRuntimeProfile => profile !== null);
}

export function resolveRuntimeProfiles(args: GateArgs): GateRuntimeProfile[] {
  const baseConfig = readJsonOrYaml(args.configPath);
  const fallbackModel = readBaseModel(baseConfig);
  const candidates = [
    ...readProfilesFromConfig(args.configPath),
    ...readProfilesFile(args.devProfilesPath, fallbackModel),
    ...readProfilesFile(args.localProfilesPath, fallbackModel),
  ];
  const byKey = new Map<string, GateRuntimeProfile>();
  for (const profile of candidates) {
    byKey.set(normalizeProfileLabel(profile.label), profile);
    byKey.set(normalizeProfileLabel(profile.id), profile);
    byKey.set(normalizeProfileLabel(profile.name), profile);
  }

  return args.profiles.map((requested) => {
    const resolved = byKey.get(normalizeProfileLabel(requested));
    if (!resolved) {
      throw new Error(
        `Release toolcall profile '${requested}' is missing. Add it to config.yaml llmProfiles, ${args.devProfilesPath}, or ${args.localProfilesPath}.`
      );
    }
    return enforceProfileModelContract({ ...resolved, label: normalizeProfileLabel(requested) });
  });
}

function createTempConfigForProfile(args: GateArgs, profile: GateRuntimeProfile): string {
  const baseConfig = readJsonOrYaml(args.configPath);
  const baseMaxOutputTokens = Number(((baseConfig.api as Record<string, unknown> | undefined) ?? {}).maxOutputTokens);
  const profileConfig = {
    ...baseConfig,
    api: {
      ...((baseConfig.api as Record<string, unknown> | undefined) ?? {}),
      apiKey: profile.apiKey,
      apiBase: profile.apiBase,
      model: profile.model,
      provider: profile.provider,
      maxOutputTokens:
        profile.maxOutputTokens ?? (Number.isFinite(baseMaxOutputTokens) && baseMaxOutputTokens > 0 ? baseMaxOutputTokens : 32768),
    },
    llmProfiles: {
      defaultProfileId: profile.id,
      profiles: [
        {
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          apiKey: profile.apiKey,
          apiBase: profile.apiBase,
          defaultModel: profile.model,
          maxOutputTokens: profile.maxOutputTokens,
          enabled: true,
        },
      ],
    },
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `toolcall-${profile.label}-`));
  const tempConfigPath = path.join(tempDir, 'config.yaml');
  fs.writeFileSync(tempConfigPath, yaml.dump(profileConfig, { lineWidth: 120 }), 'utf8');
  return tempConfigPath;
}

function resolveGitCommitSha(cwd: string): string {
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

export function failureTop(flags: Record<string, number>): string[] {
  return Object.entries(flags)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([flag, count]) => `${flag}:${count}`);
}

function runEval(args: GateArgs, profile: GateRuntimeProfile, runIndex: number): SessionReport {
  const runOutput = path.join(
    args.outputRoot,
    `run-${String(runIndex).padStart(2, '0')}-${profile.label}`
  );
  ensureDir(runOutput);
  const tempConfigPath = createTempConfigForProfile(args, profile);

  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'scripts', 'eval-toolcall-context-session.ts'),
      '--rounds',
      String(args.rounds),
      '--config-path',
      tempConfigPath,
      '--output-root',
      runOutput,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: args.runTimeoutMs,
    }
  );

  try {
    fs.rmSync(path.dirname(tempConfigPath), { recursive: true, force: true });
  } catch {
    // best effort cleanup for a temp config that may contain API keys
  }

  const reportPath = path.join(runOutput, 'toolcall-context-session-report.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error(result.stderr || result.stdout || `run ${runIndex} did not produce report json`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as SessionReport;
  report.provider = profile.provider;
  report.model = profile.model;
  const runMaxCompressionDurationMs = Math.max(
    typeof report.maxCompressionDurationMs === 'number' && Number.isFinite(report.maxCompressionDurationMs)
      ? Math.max(0, Math.floor(report.maxCompressionDurationMs))
      : 0,
    report.rounds.reduce(
      (max, round) =>
        typeof round.maxCompressionDurationMs === 'number' && Number.isFinite(round.maxCompressionDurationMs)
          ? Math.max(max, Math.max(0, Math.floor(round.maxCompressionDurationMs)))
          : max,
      0
    )
  );
  report.maxCompressionDurationMs = runMaxCompressionDurationMs > 0 ? runMaxCompressionDurationMs : undefined;
  if (runMaxCompressionDurationMs > MAX_COMPRESSION_DURATION_MS) {
    throw new Error(
      `run ${runIndex} exceeds compression duration gate: maxCompressionDurationMs=${runMaxCompressionDurationMs} > ${MAX_COMPRESSION_DURATION_MS}`
    );
  }
  if (result.status !== 0 && report.failCount <= 0) {
    throw new Error(result.stderr || result.stdout || `run ${runIndex} exited with ${String(result.status)}`);
  }
  return report;
}

export function createAggregateReport(
  args: GateArgs,
  runs: SessionReport[],
  profiles: GateRuntimeProfile[] = [],
  generatedAt = new Date().toISOString(),
  sourceCommitSha = resolveGitCommitSha(ROOT)
): ReleaseToolcallGateAggregate {
  const reviewedRunSessionIds = runs.map((run) => run.sessionId);
  return {
    generatedAt,
    sourceCommitSha,
    runs: runs.map((run, index) => ({
      index: index + 1,
      profile: profiles[index]?.label ?? normalizeProfileLabel(run.provider || `run-${index + 1}`),
      profileId: profiles[index]?.id ?? '',
      profileName: profiles[index]?.name ?? '',
      sessionId: run.sessionId,
      provider: run.provider,
      model: run.model,
      passCount: run.passCount,
      failCount: run.failCount,
      accuracy: run.accuracy,
      failureFlagCounts: run.failureFlagCounts,
      thresholdPassed: run.accuracy >= args.minPassRate,
    })),
    requiredRuns: args.runs,
    roundsPerRun: args.rounds,
    minPassRate: args.minPassRate,
    model: args.model,
    requiredProfiles: profiles.map((profile) => profile.label),
    gatePassed: runs.every((run) => run.accuracy >= args.minPassRate),
    manualReviewRequired: true,
    manualReview: {
      required: true,
      aggregateFile: RELEASE_TOOLCALL_AGGREGATE_FILE,
      templateFile: RELEASE_TOOLCALL_MANUAL_REVIEW_FILE,
      generatedAt,
      reviewedRunSessionIds,
    },
  };
}

export function createManualReviewTemplate(
  aggregate: ReleaseToolcallGateAggregate,
  generatedAt = new Date().toISOString(),
  reviewedCommitSha = aggregate.sourceCommitSha
): ReleaseToolcallManualReview {
  return {
    version: 1,
    generatedAt,
    aggregateGeneratedAt: aggregate.generatedAt,
    reviewedCommitSha,
    reviewer: '',
    reviewedAt: '',
    reviewedRunSessionIds: aggregate.runs.map((run) => run.sessionId),
    reviewedRequiredRuns: aggregate.requiredRuns,
    reviewedRoundsPerRun: aggregate.roundsPerRun,
    reviewedModel: aggregate.model,
    reviewedProfiles: aggregate.requiredProfiles,
    checklist: {
      runMetricsChecked: false,
      failureFlagsChecked: false,
      fieldMismatchesChecked: false,
      toolCallContinuityChecked: false,
      cascadeFailuresChecked: false,
      completionMarkerRepairsChecked: false,
      materiallyCorrect: false,
      seriousHallucinationFound: false,
      scriptFalsePositivePassFound: false,
    },
    conclusion: 'pending',
    issuesFound: [],
    notes: '',
  };
}

export function buildMarkdown(
  args: GateArgs,
  aggregate: ReleaseToolcallGateAggregate,
  runs: SessionReport[]
): string {
  const lines = [
    '# Release Toolcall Context Gate',
    '',
    `- Generated at: ${aggregate.generatedAt}`,
    `- Source commit: ${aggregate.sourceCommitSha}`,
    `- Required runs: ${args.runs}`,
    `- Rounds per run: ${args.rounds}`,
    `- Min pass rate per run: ${(args.minPassRate * 100).toFixed(1)}%`,
    `- Model: ${args.model}`,
    `- Profiles: ${aggregate.requiredProfiles.join(', ')}`,
    `- Manual review template: ${path.join(args.outputRoot, RELEASE_TOOLCALL_MANUAL_REVIEW_FILE)}`,
    '',
    '## Runs',
  ];

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const aggregateRun = aggregate.runs[index];
    const passed = run.accuracy >= args.minPassRate;
    lines.push(
      `- Run ${index + 1} (${aggregateRun?.profile ?? 'profile'} / ${run.model}): ${passed ? 'PASS' : 'FAIL'} accuracy=${(run.accuracy * 100).toFixed(1)}% passed=${run.passCount}/${run.rounds.length} failed=${run.failCount}`
    );
    lines.push(`  session_id: ${run.sessionId}`);
    lines.push(`  top_failure_flags: ${failureTop(run.failureFlagCounts).join(', ') || 'none'}`);
  }

  lines.push('');
  lines.push('## Manual Review');
  lines.push(
    `- Fill ${RELEASE_TOOLCALL_MANUAL_REVIEW_FILE} before \`npm run publish:standard\`.`
  );
  lines.push('- Review must approve the exact runs listed above.');
  return lines.join('\n');
}

export function writeGateArtifacts(
  args: GateArgs,
  runs: SessionReport[],
  profiles: GateRuntimeProfile[] = [],
  generatedAt = new Date().toISOString(),
  sourceCommitSha = resolveGitCommitSha(ROOT)
): { aggregate: ReleaseToolcallGateAggregate; manualReview: ReleaseToolcallManualReview } {
  ensureDir(args.outputRoot);
  const aggregate = createAggregateReport(args, runs, profiles, generatedAt, sourceCommitSha);
  const manualReview = createManualReviewTemplate(aggregate, generatedAt, sourceCommitSha);
  fs.writeFileSync(
    path.join(args.outputRoot, RELEASE_TOOLCALL_AGGREGATE_FILE),
    JSON.stringify(aggregate, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(args.outputRoot, RELEASE_TOOLCALL_MARKDOWN_FILE),
    buildMarkdown(args, aggregate, runs),
    'utf8'
  );
  fs.writeFileSync(
    path.join(args.outputRoot, RELEASE_TOOLCALL_MANUAL_REVIEW_FILE),
    JSON.stringify(manualReview, null, 2),
    'utf8'
  );
  return { aggregate, manualReview };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const profiles = resolveRuntimeProfiles(args);
  args.runs = profiles.length;
  ensureDir(args.outputRoot);
  for (const stale of [
    RELEASE_TOOLCALL_AGGREGATE_FILE,
    RELEASE_TOOLCALL_MARKDOWN_FILE,
    RELEASE_TOOLCALL_MANUAL_REVIEW_FILE,
  ]) {
    const stalePath = path.join(args.outputRoot, stale);
    if (fs.existsSync(stalePath)) {
      fs.rmSync(stalePath, { force: true });
    }
  }

  const runs: SessionReport[] = [];
  for (let index = 1; index <= profiles.length; index += 1) {
    const profile = profiles[index - 1];
    console.log(
      `[release-toolcall-gate] run ${index}/${profiles.length} start profile=${profile.label} model=${profile.model}`
    );
    const report = runEval(args, profile, index);
    console.log(
      `[release-toolcall-gate] run ${index}/${profiles.length} finish profile=${profile.label} accuracy=${(report.accuracy * 100).toFixed(1)}% passed=${report.passCount}/${report.rounds.length} failed=${report.failCount}`
    );
    console.log(
      `[release-toolcall-gate] run ${index}/${profiles.length} top_failure_flags=${failureTop(report.failureFlagCounts).join(',') || 'none'}`
    );
    runs.push(report);
  }

  const { aggregate } = writeGateArtifacts(args, runs, profiles);
  if (!aggregate.gatePassed) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === currentPath) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
