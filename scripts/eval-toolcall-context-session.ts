#!/usr/bin/env tsx
/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DPAgent } from '../src/index.js';
import {
  ensureDir,
  isDirectCliInvocation,
  parseFlagArgs,
  resolveOutputRoot,
  writeJsonArtifact,
  writeTextArtifact,
} from './lib/script-cli-utils.js';
import {
  detectCompletionMarker,
  extractToolCalls,
  extractToolResults,
  parseStructuredLines,
  previousRuntimeFromEvaluation,
  validateRequiredOperations,
} from './lib/eval-toolcall-context-core.js';
import type {
  AgentConfig,
  ContextEvent,
  ContextPrecompressEvent,
  ContextRef,
  DPAgentRunResult,
} from '../src/types.js';

const ROOT = process.cwd();
const DONE_MARKER = '\u3010\u5b8c\u6210\uff01\u3011';
const REPORT_END_MARKER = '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011';

type RoundMode = 'work' | 'review';

interface SeedSpec {
  index: number;
  code: string;
  value: string;
}

interface RoundSpec {
  round: number;
  mode: RoundMode;
  seed: SeedSpec;
  outputPath: string;
  prompt: string;
  expectedFields: Record<string, string>;
  expectedArtifact: string;
  requiredTools: string[];
  requiredOperations: RequiredOperation[];
  minToolCalls: number;
  reviewOfRound?: number;
}

interface RequiredOperation {
  label: string;
  name: string;
  args: Record<string, string>;
}

interface ToolCallTrace {
  name: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}

interface ToolResultTrace {
  name: string;
  toolCallId?: string;
  content: string;
  contentPreview: string;
}

interface RoundEvaluation {
  round: number;
  mode: RoundMode;
  turnId?: string;
  prompt: string;
  outputPath: string;
  finishReason?: string;
  response: string;
  responseFields: Record<string, string>;
  fileFields: Record<string, string>;
  expectedFields: Record<string, string>;
  expectedArtifact: string;
  toolCalls: ToolCallTrace[];
  toolResults: ToolResultTrace[];
  uniqueToolNames: string[];
  requiredToolsMissing: string[];
  markerMatched: boolean;
  matchedMarker?: string;
  responseMatchesExpected: boolean;
  fileMatchesExpected: boolean;
  toolCallCount: number;
  minToolCalls: number;
  validatedOperations: string[];
  toolValidationFlags: string[];
  maxCompressionDurationMs?: number;
  flags: string[];
  ok: boolean;
}

interface PreviousRoundRuntime {
  round: number;
  token: string;
  uniqueToolNames: string[];
  seedCode: string;
  seedValue: string;
  status: string;
}

interface EvalArgs {
  rounds: number;
  dryRun: boolean;
  keepTemp: boolean;
  outputRoot: string;
  configPath: string;
  provider?: AgentConfig['api']['provider'];
  apiBase?: string;
  model?: string;
}

interface SessionReport {
  startedAt: string;
  finishedAt: string;
  sessionId: string;
  workspaceDir: string;
  runtimeDataDir: string;
  contextDir: string;
  outputRoot: string;
  provider: string;
  apiBase: string;
  model: string;
  passCount: number;
  failCount: number;
  accuracy: number;
  failureFlagCounts: Record<string, number>;
  maxCompressionDurationMs?: number;
  rounds: RoundEvaluation[];
}

function padRound(round: number): string {
  return String(round).padStart(2, '0');
}

function timestampSlug(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function parseBooleanArg(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseArgs(argv: string[]): EvalArgs {
  const map = parseFlagArgs(argv);

  const roundsRaw = Number.parseInt(String(map.get('rounds') || '30'), 10);
  const providerRaw = String(map.get('provider') || '').trim().toLowerCase();
  return {
    rounds: Number.isFinite(roundsRaw) ? Math.max(1, Math.min(30, roundsRaw)) : 30,
    dryRun: parseBooleanArg(map.get('dry-run'), false),
    keepTemp: parseBooleanArg(map.get('keep-temp'), false),
    outputRoot: resolveOutputRoot(map.get('output-root'), path.join(ROOT, 'logs', `toolcall-context-session-${timestampSlug()}`)),
    configPath: path.resolve(String(map.get('config-path') || path.join(ROOT, 'config.yaml'))),
    provider:
      providerRaw === 'anthropic' || providerRaw === 'openai'
        ? (providerRaw as AgentConfig['api']['provider'])
        : undefined,
    apiBase: String(map.get('api-base') || '').trim() || undefined,
    model: String(map.get('model') || '').trim() || undefined,
  };
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function compareFields(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function createSeeds(): SeedSpec[] {
  const values = [
    ['AUR01', 'amber-orbit-lantern'],
    ['BRV02', 'bravo-cinder-reef'],
    ['CRN03', 'crane-harbor-violet'],
    ['DLT04', 'delta-cedar-matrix'],
    ['EKO05', 'echo-saffron-cascade'],
    ['FLX06', 'flux-silver-terrace'],
    ['GLD07', 'glide-maple-anvil'],
    ['HRZ08', 'horizon-cobalt-mirror'],
    ['ION09', 'ion-raven-citadel'],
    ['JDE10', 'jade-monsoon-signal'],
    ['KPR11', 'kepler-ruby-vector'],
    ['LMN12', 'lumen-graphite-arc'],
  ];
  return values.map((item, index) => ({
    index: index + 1,
    code: item[0],
    value: item[1],
  }));
}

function seedForRound(round: number, seeds: SeedSpec[]): SeedSpec {
  return seeds[(round - 1) % seeds.length];
}

function seedPath(workspaceDir: string, seed: SeedSpec): string {
  return path.join(workspaceDir, 'seeds', `seed-${padRound(seed.index)}.txt`);
}

function outputPathForRound(workspaceDir: string, round: number): string {
  return path.join(workspaceDir, 'session-files', `round-${padRound(round)}.txt`);
}

function nominalWorkToken(round: number, seed: SeedSpec): string {
  void seed;
  return `work-${padRound(round)}`;
}

function nominalReviewToken(round: number, seed: SeedSpec): string {
  void seed;
  return `review-${padRound(round)}`;
}

function artifactLines(fieldOrder: string[], fields: Record<string, string>): string[] {
  return fieldOrder.map((key) => `${key}=${fields[key] ?? ''}`);
}

function normalizeArtifactText(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\n+$/u, '');
}

function renderArtifact(fieldOrder: string[], fields: Record<string, string>): string {
  return artifactLines(fieldOrder, fields).join('\n');
}

function finalAnswerContractLines(): string[] {
  return [
    'Final answer format is strict:',
    `Return only the exact artifact lines followed immediately by the tail marker \`${DONE_MARKER}\`.`,
    'Do not use Markdown fences, bullets, headings, summaries, extracted-value sections, explanations, or parenthetical annotations.',
    'Do not add any text after the tail marker.',
  ];
}

function buildWorkRoundSpec(
  workspaceDir: string,
  totalRounds: number,
  round: number,
  seed: SeedSpec,
  previous: PreviousRoundRuntime | null
): RoundSpec {
  const prevToken = previous?.token ?? 'ROOT00';
  const token = nominalWorkToken(round, seed);
  const outputPath = outputPathForRound(workspaceDir, round);
  const previousPath = previous ? outputPathForRound(workspaceDir, previous.round) : '';
  const requireGrep = round % 5 === 0 || round % 7 === 0;
  const requiredTools = uniquePreserveOrder([
    'read_file',
    requireGrep ? 'grep' : '',
    'write_file',
  ]);
  const fieldOrder = ['ROUND', 'MODE', 'TOKEN', 'SEED_CODE', 'SEED_VALUE', 'PREV_TOKEN', 'STATUS'];
  const expectedFields: Record<string, string> = {
    ROUND: padRound(round),
    MODE: 'WORK',
    TOKEN: token,
    SEED_CODE: seed.code,
    SEED_VALUE: seed.value,
    PREV_TOKEN: prevToken,
    STATUS: 'OK',
  };
  const relativeOutput = path.relative(workspaceDir, outputPath).replace(/\\/g, '/');
  const relativeSeed = path.relative(workspaceDir, seedPath(workspaceDir, seed)).replace(/\\/g, '/');
  const relativePrevious = previousPath ? path.relative(workspaceDir, previousPath).replace(/\\/g, '/') : '';
  const expectedArtifact = renderArtifact(fieldOrder, expectedFields);
  const requiredOperations: RequiredOperation[] = uniquePreserveOrder([
    'read_seed',
    previousPath ? 'read_previous' : '',
    requireGrep ? 'grep_existing_tokens' : '',
    'write_output',
    'verify_output',
  ]).map((label) => {
    switch (label) {
      case 'read_seed':
        return { label, name: 'read_file', args: { path: relativeSeed } };
      case 'read_previous':
        return { label, name: 'read_file', args: { path: relativePrevious } };
      case 'grep_existing_tokens':
        return { label, name: 'grep', args: { path: 'session-files', pattern: '^TOKEN=' } };
      case 'write_output':
        return { label, name: 'write_file', args: { path: relativeOutput, content: expectedArtifact } };
      case 'verify_output':
        return { label, name: 'read_file', args: { path: relativeOutput } };
      default:
        throw new Error(`unsupported required operation: ${label}`);
    }
  });
  const prompt = [
    `Round ${round} of ${totalRounds}. This is a context continuity work round.`,
    'You must actually use tools and verify against the real workspace. Do not answer from memory alone.',
    'Required workflow:',
    'Use the exact tool names and paths below. Do not pass `pattern` to `read_file`, and do not replace `read_file` with directory listing on file paths.',
    `1. Read \`${relativeSeed}\`.`,
    previousPath
      ? `2. Read \`${relativePrevious}\`.`
      : '2. There is no previous round file, so use PREV_TOKEN=ROOT00.',
    requireGrep
      ? '3. Use `grep` with path exactly `session-files` and pattern exactly `^TOKEN=` before writing the new file.'
      : '3. You may skip grep this round.',
    `4. Write \`${relativeOutput}\`.`,
    `5. Read back \`${relativeOutput}\` to verify it.`,
    '',
    'Use exact values from the files. Do not abbreviate, trim, or transform token strings.',
    'From the seed file extract `SEED_CODE` and `SEED_VALUE`.',
    previousPath
      ? 'From the previous round file extract `TOKEN` and copy that exact value into `PREV_TOKEN`.'
      : 'For this round PREV_TOKEN is ROOT00.',
    'PREV_TOKEN must be the bare token value only; do not append source notes or parenthetical text.',
    `Set \`TOKEN\` exactly to \`${token}\`.`,
    'Create the file with exactly these lines and no extra lines:',
    `ROUND=${expectedFields.ROUND}`,
    'MODE=WORK',
    `TOKEN=${token}`,
    'SEED_CODE=<from seed file>',
    'SEED_VALUE=<from seed file>',
    previousPath ? 'PREV_TOKEN=<copy exact previous round TOKEN>' : 'PREV_TOKEN=ROOT00',
    'STATUS=OK',
    '',
    ...finalAnswerContractLines(),
  ].join('\n');

  return {
    round,
    mode: 'work',
    seed,
    outputPath,
    prompt,
    expectedFields,
    expectedArtifact,
    requiredTools,
    requiredOperations,
    minToolCalls: requiredOperations.length,
  };
}

function buildReviewRoundSpec(
  workspaceDir: string,
  totalRounds: number,
  round: number,
  seed: SeedSpec,
  previous: PreviousRoundRuntime
): RoundSpec {
  const prevToken = previous.token;
  const token = nominalReviewToken(round, seed);
  const outputPath = outputPathForRound(workspaceDir, round);
  const previousPath = outputPathForRound(workspaceDir, previous.round);
  const fieldOrder = [
    'ROUND',
    'MODE',
    'TOKEN',
    'REVIEW_OF',
    'PREV_SEED_CODE',
    'PREV_SEED_VALUE',
    'SEED_VALUE',
    'PREV_TOKEN',
    'STATUS',
  ];
  const expectedFields: Record<string, string> = {
    ROUND: padRound(round),
    MODE: 'REVIEW',
    TOKEN: token,
    REVIEW_OF: padRound(previous.round),
    PREV_SEED_CODE: previous.seedCode,
    PREV_SEED_VALUE: previous.seedValue,
    SEED_VALUE: seed.value,
    PREV_TOKEN: prevToken,
    STATUS: previous.status || 'OK',
  };
  const relativeOutput = path.relative(workspaceDir, outputPath).replace(/\\/g, '/');
  const relativeSeed = path.relative(workspaceDir, seedPath(workspaceDir, seed)).replace(/\\/g, '/');
  const relativePrevious = path.relative(workspaceDir, previousPath).replace(/\\/g, '/');
  const expectedArtifact = renderArtifact(fieldOrder, expectedFields);
  const requiredOperations: RequiredOperation[] = [
    { label: 'read_previous', name: 'read_file', args: { path: relativePrevious } },
    { label: 'read_seed', name: 'read_file', args: { path: relativeSeed } },
    { label: 'write_output', name: 'write_file', args: { path: relativeOutput, content: expectedArtifact } },
    { label: 'verify_output', name: 'read_file', args: { path: relativeOutput } },
  ];
  const prompt = [
    `Round ${round} of ${totalRounds}. This is a context continuity review round.`,
    'You must actually use tools for file verification and derive prior-round facts from the real workspace, not from loose transcript memory.',
    'Required workflow:',
    'Use the exact tool names and paths below. Do not pass `pattern` to `read_file`, and do not replace `read_file` with directory listing on file paths.',
    `1. Read \`${relativePrevious}\`.`,
    `2. Read \`${relativeSeed}\`.`,
    `3. Write \`${relativeOutput}\`.`,
    `4. Read back \`${relativeOutput}\` to verify it.`,
    '',
    'From the previous round file extract `TOKEN` and copy that exact value into `PREV_TOKEN`.',
    'From the previous round file extract `SEED_CODE` and copy it into `PREV_SEED_CODE`.',
    'From the previous round file extract `SEED_VALUE` and copy it into `PREV_SEED_VALUE`.',
    'From the previous round file extract `STATUS` and copy it into `STATUS`.',
    'PREV_TOKEN must be the bare token value only; do not append source notes or parenthetical text.',
    'Do not summarize or reinterpret the previous round. Copy the exact field values from the file.',
    'From the current seed file extract `SEED_VALUE`.',
    `Set \`TOKEN\` exactly to \`${token}\`.`,
    'Create the file with exactly these lines and no extra lines:',
    `ROUND=${expectedFields.ROUND}`,
    'MODE=REVIEW',
    `TOKEN=${token}`,
    `REVIEW_OF=${expectedFields.REVIEW_OF}`,
    'PREV_SEED_CODE=<copy exact previous round SEED_CODE>',
    'PREV_SEED_VALUE=<copy exact previous round SEED_VALUE>',
    'SEED_VALUE=<from seed file>',
    'PREV_TOKEN=<copy exact previous round TOKEN>',
    'STATUS=<copy exact previous round STATUS>',
    '',
    ...finalAnswerContractLines(),
  ].join('\n');

  return {
    round,
    mode: 'review',
    seed,
    outputPath,
    prompt,
    expectedFields,
    expectedArtifact,
    requiredTools: ['read_file', 'write_file'],
    requiredOperations,
    minToolCalls: requiredOperations.length,
    reviewOfRound: previous.round,
  };
}

function buildRoundSpec(
  workspaceDir: string,
  totalRounds: number,
  round: number,
  seeds: SeedSpec[],
  previous: PreviousRoundRuntime | null
): RoundSpec {
  const seed = seedForRound(round, seeds);
  if (round % 3 === 0 && previous) {
    return buildReviewRoundSpec(workspaceDir, totalRounds, round, seed, previous);
  }
  return buildWorkRoundSpec(workspaceDir, totalRounds, round, seed, previous);
}

function extractTurnEvents(agent: DPAgent, context: ContextRef, turnId: string): ContextEvent[] {
  return agent
    .getContextManager()
    .getEventStore()
    .readEvents(context.scope, context.namespace)
    .filter((event) => event.turnId === turnId);
}

function readTextIfExists(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function summarizeToolCall(toolCall: ToolCallTrace): string {
  const pathArg = typeof toolCall.args.path === 'string' ? toolCall.args.path.trim() : '';
  const patternArg = typeof toolCall.args.pattern === 'string' ? toolCall.args.pattern.trim() : '';
  const contentArg =
    typeof toolCall.args.content === 'string' ? normalizeArtifactText(toolCall.args.content).length : undefined;
  const parts = [
    pathArg ? `path=${pathArg}` : '',
    patternArg ? `pattern=${patternArg}` : '',
    typeof contentArg === 'number' ? `content_chars=${contentArg}` : '',
  ].filter(Boolean);
  return `${toolCall.name}${parts.length > 0 ? `(${parts.join(',')})` : ''}`;
}

function evaluateRound(
  spec: RoundSpec,
  result: DPAgentRunResult,
  events: ContextEvent[],
  previous: PreviousRoundRuntime | null
): RoundEvaluation {
  const toolCalls = extractToolCalls(events);
  const toolResults = extractToolResults(events);
  const uniqueToolNames = uniquePreserveOrder(toolCalls.map((item) => item.name));
  const responseFields = parseStructuredLines(result.content);
  const fileContent = readTextIfExists(spec.outputPath);
  const fileFields = parseStructuredLines(fileContent);
  const markerState = detectCompletionMarker(result.content);
  const markerMatched = markerState.matched;
  const responseMatchesExpected = compareFields(responseFields, spec.expectedFields);
  const fileMatchesExpected = compareFields(fileFields, spec.expectedFields);
  const requiredToolsMissing = spec.requiredTools.filter((tool) => !uniqueToolNames.includes(tool));
  const toolValidation = validateRequiredOperations(toolCalls, toolResults, spec.requiredOperations);
  const flags: string[] = [];

  if (result.finishReason !== 'end_turn') {
    flags.push(`finish_reason_${result.finishReason ?? 'unknown'}`);
  }
  if (!markerMatched) {
    flags.push(markerState.duplicateTail ? 'duplicate_completion_marker_tail' : 'missing_completion_marker');
  }
  if (toolCalls.length < spec.minToolCalls) {
    flags.push(`toolcall_count_below_min_${toolCalls.length}_of_${spec.minToolCalls}`);
  }
  if (requiredToolsMissing.length > 0) {
    flags.push(`required_tools_missing:${requiredToolsMissing.join(',')}`);
  }
  if (!responseMatchesExpected) {
    flags.push('response_field_mismatch');
  }
  if (!fileMatchesExpected) {
    flags.push('artifact_field_mismatch');
  }
  if (toolCalls.length === 0 && responseFields.STATUS === 'OK') {
    flags.push('claimed_success_without_toolcall');
  }
  flags.push(...toolValidation.flags);

  return {
    round: spec.round,
    mode: spec.mode,
    turnId: result.turnId,
    prompt: spec.prompt,
    outputPath: spec.outputPath,
    finishReason: result.finishReason,
    response: result.content,
    responseFields,
    fileFields,
    expectedFields: spec.expectedFields,
    expectedArtifact: spec.expectedArtifact,
    toolCalls,
    toolResults,
    uniqueToolNames,
    requiredToolsMissing,
    markerMatched,
    matchedMarker: markerState.marker,
    responseMatchesExpected,
    fileMatchesExpected,
    toolCallCount: toolCalls.length,
    minToolCalls: spec.minToolCalls,
    validatedOperations: toolValidation.validatedOperations,
    toolValidationFlags: toolValidation.flags,
    flags,
    ok: flags.length === 0,
  };
}

function buildFailureFlagCounts(rounds: RoundEvaluation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const round of rounds) {
    for (const flag of round.flags) {
      out[flag] = (out[flag] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildMarkdown(summary: SessionReport): string {
  const lines = [
    '# Toolcall Context Session Eval',
    '',
    `- Session: ${summary.sessionId}`,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Provider: ${summary.provider}`,
    `- Model: ${summary.model}`,
    `- Workspace: ${summary.workspaceDir}`,
    `- Output Root: ${summary.outputRoot}`,
    '',
    '## Aggregate',
    `- Passed rounds: ${summary.passCount}/${summary.rounds.length}`,
    `- Failed rounds: ${summary.failCount}`,
    `- Accuracy: ${(summary.accuracy * 100).toFixed(1)}%`,
    `- Review rounds: ${summary.rounds.filter((item) => item.mode === 'review').length}`,
    '',
    '## Failure Flags',
  ];

  if (Object.keys(summary.failureFlagCounts).length === 0) {
    lines.push('- none');
  } else {
    for (const [flag, count] of Object.entries(summary.failureFlagCounts)) {
      lines.push(`- ${flag}: ${count}`);
    }
  }

  lines.push('', '## Per Round');
  for (const round of summary.rounds) {
    const status = round.ok ? 'PASS' : 'FAIL';
    lines.push(
      `- R${padRound(round.round)} ${round.mode.toUpperCase()} ${status}: finish=${round.finishReason ?? 'unknown'} tool_calls=${round.toolCallCount}/${round.minToolCalls} tools=[${round.uniqueToolNames.join(', ')}]`
    );
    if (round.flags.length > 0) {
      lines.push(`  flags: ${round.flags.join('; ')}`);
    }
    lines.push(`  validated_operations: ${round.validatedOperations.join(', ') || 'none'}`);
    lines.push(`  output: ${round.outputPath}`);
    if (!round.ok) {
      lines.push(`  tool_validation_flags: ${round.toolValidationFlags.join(', ') || 'none'}`);
      lines.push(`  tool_call_trace: ${round.toolCalls.map((item) => summarizeToolCall(item)).join(' | ') || 'none'}`);
    }
  }

  return lines.join('\n');
}

function writeSeedFixtures(workspaceDir: string, seeds: SeedSpec[]): void {
  const seedDir = path.join(workspaceDir, 'seeds');
  const outputDir = path.join(workspaceDir, 'session-files');
  ensureDir(seedDir);
  ensureDir(outputDir);
  for (const seed of seeds) {
    fs.writeFileSync(
      seedPath(workspaceDir, seed),
      [
        `SEED_INDEX=${padRound(seed.index)}`,
        `SEED_CODE=${seed.code}`,
        `VALUE=${seed.value}`,
      ].join('\n') + '\n',
      'utf8'
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.outputRoot);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcall-context-session-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const runtimeDataDir = path.join(tempRoot, 'runtime');
  const contextDir = path.join(tempRoot, 'contexts');
  ensureDir(workspaceDir);
  ensureDir(runtimeDataDir);
  ensureDir(contextDir);

  const seeds = createSeeds();
  writeSeedFixtures(workspaceDir, seeds);

  const context: ContextRef = {
    scope: 'session',
    namespace: `toolcall-context-${timestampSlug()}`,
  };

  const startedAt = new Date().toISOString();
  const summaryPath = path.join(args.outputRoot, 'toolcall-context-session-report.json');
  const markdownPath = path.join(args.outputRoot, 'toolcall-context-session-report.md');

  if (args.dryRun) {
    let previous: PreviousRoundRuntime | null = null;
    const rounds = Array.from({ length: args.rounds }, (_, index) => {
      const round = index + 1;
      const spec = buildRoundSpec(workspaceDir, args.rounds, round, seeds, previous);
      previous = {
        round,
        token: spec.expectedFields.TOKEN,
        uniqueToolNames:
          spec.mode === 'review'
            ? ['list_directory', 'read_file', 'write_file']
            : spec.requiredTools,
        seedCode: spec.expectedFields.SEED_CODE ?? previous?.seedCode ?? '',
        seedValue: spec.expectedFields.SEED_VALUE ?? previous?.seedValue ?? '',
        status: spec.expectedFields.STATUS ?? previous?.status ?? '',
      };
      return {
        round,
        mode: spec.mode,
        prompt: spec.prompt,
        outputPath: spec.outputPath,
        expectedFields: spec.expectedFields,
        expectedArtifact: spec.expectedArtifact,
        requiredTools: spec.requiredTools,
        requiredOperations: spec.requiredOperations,
        minToolCalls: spec.minToolCalls,
      };
    });
    writeJsonArtifact(args.outputRoot, path.basename(summaryPath), { dryRun: true, workspaceDir, context, rounds });
    console.log(`Dry-run plan saved: ${summaryPath}`);
    if (!args.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  const agent = new DPAgent({
    configPath: args.configPath,
    workspaceDir,
    runtimeDataDir,
    contextDir,
  });
  if (args.provider || args.apiBase || args.model) {
    agent.updateConfig({
      api: {
        apiKey: agent.getConfig().api.apiKey,
        provider: args.provider ?? agent.getConfig().api.provider,
        apiBase: args.apiBase ?? agent.getConfig().api.apiBase,
        model: args.model ?? agent.getConfig().api.model,
        maxOutputTokens: agent.getConfig().api.maxOutputTokens,
      },
    });
  }

  const evaluations: RoundEvaluation[] = [];
  let previous: PreviousRoundRuntime | null = null;

  try {
    for (let index = 0; index < args.rounds; index += 1) {
      const round = index + 1;
      const spec = buildRoundSpec(workspaceDir, args.rounds, round, seeds, previous);
      console.log(`[toolcall-context] round ${padRound(round)} start mode=${spec.mode}`);
      let roundMaxCompressionDurationMs = 0;
      const result = await agent.runWithResult({
        prompt: spec.prompt,
        context,
        workspaceDir,
        callback: {
          onContextPrecompress: (event: ContextPrecompressEvent) => {
            if (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs)) {
              return;
            }
            const duration = Math.max(0, Math.floor(event.durationMs));
            if (duration > roundMaxCompressionDurationMs) {
              roundMaxCompressionDurationMs = duration;
            }
          },
        },
      });
      const turnEvents = extractTurnEvents(agent, context, result.turnId);
      const evaluation = evaluateRound(spec, result, turnEvents, previous);
      if (roundMaxCompressionDurationMs > 0) {
        evaluation.maxCompressionDurationMs = roundMaxCompressionDurationMs;
      }
      evaluations.push(evaluation);
      previous = previousRuntimeFromEvaluation(previous, spec, evaluation);
      console.log(
        `[toolcall-context] round ${padRound(round)} finish ok=${evaluation.ok} tool_calls=${evaluation.toolCallCount} flags=${evaluation.flags.join(',') || 'none'}`
      );
    }
  } finally {
    if (evaluations.length === args.rounds) {
      try {
        await agent.organizeSessionMemory({ sessionId: context.namespace, workspaceDir });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn(`[toolcall-context] final memory organize skipped: ${err.message}`);
      }
    }
    agent.reset();
    await agent.cleanup();
  }

  const finishedAt = new Date().toISOString();
  const passCount = evaluations.filter((item) => item.ok).length;
  const failCount = evaluations.length - passCount;
  const failureFlagCounts = buildFailureFlagCounts(evaluations);
  const maxCompressionDurationMs = evaluations.reduce(
    (max, item) =>
      typeof item.maxCompressionDurationMs === 'number' && Number.isFinite(item.maxCompressionDurationMs)
        ? Math.max(max, Math.max(0, Math.floor(item.maxCompressionDurationMs)))
        : max,
    0
  );
  const reportPayload: SessionReport = {
    startedAt,
    finishedAt,
    sessionId: context.namespace,
    workspaceDir,
    runtimeDataDir,
    contextDir,
    outputRoot: args.outputRoot,
    provider: agent.getConfig().api.provider,
    apiBase: agent.getConfig().api.apiBase,
    model: agent.getConfig().api.model,
    passCount,
    failCount,
    accuracy: evaluations.length > 0 ? passCount / evaluations.length : 0,
    failureFlagCounts,
    maxCompressionDurationMs: maxCompressionDurationMs > 0 ? maxCompressionDurationMs : undefined,
    rounds: evaluations,
  };

  writeJsonArtifact(args.outputRoot, path.basename(summaryPath), reportPayload);
  writeTextArtifact(args.outputRoot, path.basename(markdownPath), buildMarkdown(reportPayload));

  console.log(`Report saved: ${summaryPath}`);
  console.log(`Markdown saved: ${markdownPath}`);
  console.log(`Passed rounds: ${passCount}/${evaluations.length}`);
  if (failCount > 0) {
    console.log(`Failed rounds: ${evaluations.filter((item) => !item.ok).map((item) => item.round).join(', ')}`);
  }

  if (!args.keepTemp) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

const isMainModule = isDirectCliInvocation(import.meta.url);

if (isMainModule) {
  main()
    .then(() => {
      process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
