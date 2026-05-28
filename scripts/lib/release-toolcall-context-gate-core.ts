import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { resolveGitCommitSha } from './test-command-runner.js';
import {
  ensureDir,
  parseFlagArgs,
  resolveOutputRoot,
  writeJsonArtifact,
  writeTextArtifact,
} from './script-cli-utils.js';

const ROOT = process.cwd();
const KIMI_RELEASE_DEFAULT_MODEL = 'Kimi-k2.6';
const RELEASE_REQUIRED_PROFILE_MODELS: Record<string, string> = {
  kimi: KIMI_RELEASE_DEFAULT_MODEL,
  deepseek: 'deepseek-v4-flash',
  minimax: 'MiniMax-M2.7-highspeed',
  xiaomi: 'mimo-v2.5-pro',
};

export const MAX_COMPRESSION_DURATION_MS = 180_000;
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
    historyConsistencyChecked: boolean;
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
  const map = parseFlagArgs(argv);

  const runsRaw = map.has('runs') ? Number.parseInt(String(map.get('runs')), 10) : Number.NaN;
  const profiles = String(map.get('profiles') || 'deepseek,minimax,xiaomi')
    .split(',')
    .map((item) => normalizeProfileLabel(item))
    .filter(Boolean);
  const uniqueProfiles = profiles.filter((item, index) => profiles.indexOf(item) === index);
  const roundsRaw = Number.parseInt(String(map.get('rounds') || '10'), 10);
  const minPassRateRaw = Number.parseFloat(String(map.get('min-pass-rate') || '0.9'));
  const runTimeoutRaw = Number.parseInt(String(map.get('run-timeout-ms') || '900000'), 10);
  return {
    runs: Number.isFinite(runsRaw)
      ? Math.max(1, Math.min(10, runsRaw))
      : Math.max(1, uniqueProfiles.length),
    rounds: Number.isFinite(roundsRaw) ? Math.max(1, Math.min(30, roundsRaw)) : 10,
    minPassRate:
      Number.isFinite(minPassRateRaw) && minPassRateRaw > 0 && minPassRateRaw <= 1
        ? minPassRateRaw
        : 0.9,
    model: String(map.get('model') || 'multi-profile').trim() || 'multi-profile',
    profiles: uniqueProfiles.length > 0 ? uniqueProfiles : ['deepseek', 'minimax', 'xiaomi'],
    configPath: path.resolve(String(map.get('config-path') || path.join(ROOT, 'config.yaml'))),
    devProfilesPath: path.resolve(
      String(map.get('dev-profiles') || path.join(ROOT, 'release-toolcall-profiles.dev.json'))
    ),
    localProfilesPath: path.resolve(
      String(map.get('local-profiles') || path.join(ROOT, 'release-toolcall-profiles.local.json'))
    ),
    runTimeoutMs: Number.isFinite(runTimeoutRaw) ? Math.max(60_000, runTimeoutRaw) : 900_000,
    outputRoot: resolveOutputRoot(map.get('output-root'), path.join(ROOT, 'logs', 'release-gate-toolcall-context-session')),
  };
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
  const apiKeyEnv = String(record.apiKeyEnv ?? '').trim();
  const apiKey = String(record.apiKey ?? '').trim() || (apiKeyEnv ? String(process.env[apiKeyEnv] ?? '').trim() : '');
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
  const requiredModel = RELEASE_REQUIRED_PROFILE_MODELS[profile.label];
  if (requiredModel && profile.model !== requiredModel) {
    throw new Error(
      `Release toolcall profile '${profile.label}' must use model ${requiredModel}, got ${profile.model || '<empty>'}.`
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

export function createTempConfigForProfile(args: GateArgs, profile: GateRuntimeProfile): string {
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

export function failureTop(flags: Record<string, number>): string[] {
  return Object.entries(flags)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([flag, count]) => `${flag}:${count}`);
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
      historyConsistencyChecked: false,
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
    `- Fill ${RELEASE_TOOLCALL_MANUAL_REVIEW_FILE} before \`npm run publish:npm-official:preflight\`.`
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
  writeJsonArtifact(args.outputRoot, RELEASE_TOOLCALL_AGGREGATE_FILE, aggregate);
  writeTextArtifact(args.outputRoot, RELEASE_TOOLCALL_MARKDOWN_FILE, buildMarkdown(args, aggregate, runs));
  writeJsonArtifact(args.outputRoot, RELEASE_TOOLCALL_MANUAL_REVIEW_FILE, manualReview);
  return { aggregate, manualReview };
}
