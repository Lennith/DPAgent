#!/usr/bin/env tsx
/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, isDirectCliInvocation } from './lib/script-cli-utils.js';
import {
  MAX_COMPRESSION_DURATION_MS,
  RELEASE_TOOLCALL_AGGREGATE_FILE,
  RELEASE_TOOLCALL_MANUAL_REVIEW_FILE,
  RELEASE_TOOLCALL_MARKDOWN_FILE,
  createTempConfigForProfile,
  failureTop,
  parseArgs,
  resolveRuntimeProfiles,
  writeGateArtifacts,
  type GateArgs,
  type GateRuntimeProfile,
  type SessionReport,
} from './lib/release-toolcall-context-gate-core.js';

const ROOT = process.cwd();

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

function main(): void {
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

if (isDirectCliInvocation(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
