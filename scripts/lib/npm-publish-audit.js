#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = process.cwd();
const DEFAULT_SMOKE_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_SMOKE_HTTP_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSmokeFetchError(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    String(error?.message || '').toLowerCase() === 'fetch failed'
  );
}

function info(message) {
  console.log(`[npm-publish-audit] ${message}`);
}

function warn(message) {
  console.warn(`[npm-publish-audit] WARN: ${message}`);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: options.shell === true,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(
      [`${command} ${args.join(' ')}`, stdout ? `stdout: ${stdout}` : '', stderr ? `stderr: ${stderr}` : '']
        .filter(Boolean)
        .join('\n')
    );
  }
  return String(result.stdout || '');
}

function runNpm(args, options = {}) {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return runSync(process.execPath, [npmExecPath, ...args], { ...options, shell: false });
  }

  const bundledNpmCli = path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundledNpmCli)) {
    return runSync(process.execPath, [bundledNpmCli, ...args], { ...options, shell: false });
  }

  return runSync('npm', args, { ...options, shell: true });
}

function resolveGitCommitSha(cwd) {
  const output = runSync('git', ['rev-parse', 'HEAD'], { cwd });
  const sha = String(output || '').trim();
  if (!sha) {
    throw new Error(`git rev-parse returned empty HEAD in ${cwd}`);
  }
  return sha;
}

function validateCleanGitWorktree(cwd, options = {}) {
  const statusOutput =
    typeof options.statusOutput === 'string'
      ? options.statusOutput
      : runSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd });
  const dirtyEntries = String(statusOutput || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim().length > 0);
  if (dirtyEntries.length > 0) {
    throw new Error(`git worktree is dirty:\n${dirtyEntries.join('\n')}`);
  }
  return dirtyEntries;
}

function runFreshWebBuild() {
  info('Running fresh web build before pack validation.');
  runNpm(['run', 'build:web'], { cwd: ROOT });
}

function removePathWithRetry(targetPath, options = {}) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }

  const rmOptions = {
    force: true,
    maxRetries: 12,
    recursive: true,
    retryDelay: 250,
    ...options,
  };

  try {
    fs.rmSync(targetPath, rmOptions);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    const message = error instanceof Error ? error.message : String(error);
    const retriable = code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EPERM';

    if (process.platform === 'win32' && retriable) {
      scheduleWindowsCleanup(targetPath, rmOptions.recursive !== false);
      warn(`Deferred cleanup scheduled for ${targetPath}: ${message}`);
      return;
    }

    throw error;
  }
}

function scheduleWindowsCleanup(targetPath, recursive) {
  const normalizedPath = String(targetPath).replace(/'/g, "''");
  const command = [
    'Start-Sleep -Milliseconds 1500',
    `Remove-Item -LiteralPath '${normalizedPath}' ${recursive ? '-Recurse' : ''} -Force -ErrorAction SilentlyContinue`,
  ].join('; ');

  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Failed to schedule deferred cleanup for ${targetPath}: ${message}`);
  }
}

function parseEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`));
  if (!line) {
    return '';
  }
  const rawValue = line.slice(line.indexOf('=') + 1).trim();
  return rawValue.replace(/^['"]|['"]$/g, '');
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizeConfigApiKey(value) {
  const normalized = String(value || '').trim();
  return normalized && !/YOUR_API_KEY/i.test(normalized) ? normalized : '';
}

function resolveSmokeRuntimeConfigFromSources(sources = {}) {
  const env = sources.env || {};
  const configApi = sources.configApi || {};
  const apiKey = firstNonEmptyString(
    env.MINIMAX_API_KEY,
    sources.dotenvKey,
    normalizeConfigApiKey(configApi.apiKey)
  );
  const maxOutputTokens = firstNonEmptyString(
    env.MINIMAX_MAX_OUTPUT_TOKENS,
    env.MINIMAX_API_MAX_OUTPUT_TOKENS,
    configApi.maxOutputTokens
  );

  return {
    apiKey,
    apiBase: firstNonEmptyString(env.MINIMAX_API_BASE, configApi.apiBase),
    model: firstNonEmptyString(env.MINIMAX_MODEL, configApi.model),
    provider: firstNonEmptyString(env.MINIMAX_PROVIDER, configApi.provider),
    maxOutputTokens,
  };
}

function resolveSmokeRuntimeConfig() {
  let configApi = {};
  const configPath = path.join(ROOT, 'config.yaml');
  if (fs.existsSync(configPath)) {
    try {
      const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
      configApi = config && config.api && typeof config.api === 'object' ? config.api : {};
    } catch {
      // ignore and fall through
    }
  }

  return resolveSmokeRuntimeConfigFromSources({
    env: process.env,
    dotenvKey: parseEnvFileValue(path.join(ROOT, '.env'), 'MINIMAX_API_KEY'),
    configApi,
  });
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve available smoke port.')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function resolveSmokeSuccessPattern(pattern, port) {
  const raw = String(pattern || '').trim();
  if (!raw) {
    return raw;
  }
  return raw.replace(/\{PORT\}/g, String(port)).replace(/53721/g, String(port));
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}

function waitForChildClose(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(settle, timeoutMs);
    child.once('close', settle);
    child.once('exit', settle);
  });
}

function normalizePathForMatch(input) {
  return String(input || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function startsWithAnyPrefix(targetPath, prefixes) {
  return prefixes.some((prefix) => {
    if (prefix.endsWith('/')) {
      return targetPath.startsWith(prefix);
    }
    return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
  });
}

function readJsonFileOrError(filePath, label, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`${label} is missing: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((item) => String(item || '').trim()).filter((item) => item.length > 0);
}

function normalizeProfileLabels(values) {
  return normalizeStringArray(values).map((item) =>
    item
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function validateSourceGateReuseApproval(review, aggregateSourceCommitSha, currentCommitSha, manualReviewPath, errors) {
  const reuse =
    review && review.sourceGateReuse && typeof review.sourceGateReuse === 'object' ? review.sourceGateReuse : null;
  if (!reuse) {
    return false;
  }

  let valid = true;
  const failReuse = (message) => {
    errors.push(`release toolcall manual review sourceGateReuse ${message}: ${manualReviewPath}`);
    valid = false;
  };
  const diffScope = normalizeStringArray(reuse.diffScope);
  const skippedCommands = normalizeStringArray(reuse.skippedCommands);

  if (reuse.approved !== true) {
    failReuse('approved must be true');
  }
  if (String(reuse.scope || '').trim() !== 'release-process-only') {
    failReuse('scope must be release-process-only');
  }
  if (String(reuse.previousReviewedCommitSha || '').trim() !== aggregateSourceCommitSha) {
    failReuse('previousReviewedCommitSha must match aggregate sourceCommitSha');
  }
  if (String(reuse.currentCommitSha || '').trim() !== currentCommitSha) {
    failReuse('currentCommitSha must match current HEAD');
  }
  if (diffScope.length === 0) {
    failReuse('diffScope must list reviewed release-only paths');
  }
  if (skippedCommands.length === 0) {
    failReuse('skippedCommands must list the reused source gate commands');
  }
  if (!isNonEmptyString(reuse.rationale)) {
    failReuse('rationale is required');
  }

  return valid;
}

function validateReleaseToolcallGateEvidence(rootDir, cfg, options = {}) {
  const outputRoot = path.resolve(rootDir, cfg.outputRoot);
  const aggregatePath = path.join(outputRoot, cfg.aggregateFile);
  const markdownPath = path.join(outputRoot, cfg.markdownFile);
  const manualReviewPath = path.join(outputRoot, cfg.manualReviewFile);
  const currentCommitSha = isNonEmptyString(options.currentCommitSha)
    ? String(options.currentCommitSha).trim()
    : resolveGitCommitSha(rootDir);
  const errors = [];
  let aggregateSourceCommitMismatch = false;

  if (!fs.existsSync(markdownPath)) {
    errors.push(`release toolcall markdown report is missing: ${markdownPath}`);
  }

  const aggregate = readJsonFileOrError(aggregatePath, 'release toolcall aggregate', errors);
  if (aggregate) {
    if (aggregate.gatePassed !== true) {
      errors.push(`release toolcall aggregate did not pass: ${aggregatePath}`);
    }
    if (!isNonEmptyString(aggregate.generatedAt)) {
      errors.push(`release toolcall aggregate is missing generatedAt: ${aggregatePath}`);
    }
    if (!isNonEmptyString(aggregate.sourceCommitSha)) {
      errors.push(`release toolcall aggregate is missing sourceCommitSha: ${aggregatePath}`);
    } else if (String(aggregate.sourceCommitSha).trim() !== currentCommitSha) {
      aggregateSourceCommitMismatch = true;
    }
    if (!Array.isArray(aggregate.runs) || aggregate.runs.length === 0) {
      errors.push(`release toolcall aggregate is missing runs: ${aggregatePath}`);
    }
    if (Number(aggregate.requiredRuns) !== Number(cfg.requiredRuns)) {
      errors.push(`release toolcall aggregate requiredRuns mismatch: ${aggregatePath}`);
    }
    if (Array.isArray(aggregate.runs) && aggregate.runs.length !== Number(cfg.requiredRuns)) {
      errors.push(`release toolcall aggregate run count mismatch: ${aggregatePath}`);
    }
    if (Number(aggregate.roundsPerRun) !== Number(cfg.requiredRoundsPerRun)) {
      errors.push(`release toolcall aggregate roundsPerRun mismatch: ${aggregatePath}`);
    }
    if (String(aggregate.model || '').trim() !== String(cfg.requiredModel || '').trim()) {
      errors.push(`release toolcall aggregate model mismatch: ${aggregatePath}`);
    }
    const expectedProfiles = normalizeProfileLabels(cfg.requiredProfiles || []);
    const aggregateProfiles = normalizeProfileLabels(aggregate.requiredProfiles || []);
    if (expectedProfiles.length > 0 && !arraysEqual(aggregateProfiles, expectedProfiles)) {
      errors.push(`release toolcall aggregate requiredProfiles mismatch: ${aggregatePath}`);
    }
    if (Number(aggregate.minPassRate) !== Number(cfg.minimumPassRate)) {
      errors.push(`release toolcall aggregate minPassRate mismatch: ${aggregatePath}`);
    }
    if (aggregate.manualReviewRequired !== true) {
      errors.push(`release toolcall aggregate must require manual review: ${aggregatePath}`);
    }
    const aggregateManualReview =
      aggregate.manualReview && typeof aggregate.manualReview === 'object' ? aggregate.manualReview : null;
    if (!aggregateManualReview) {
      errors.push(`release toolcall aggregate is missing manualReview metadata: ${aggregatePath}`);
    } else {
      if (aggregateManualReview.required !== true) {
        errors.push(`release toolcall aggregate manualReview.required must be true: ${aggregatePath}`);
      }
      if (String(aggregateManualReview.aggregateFile || '').trim() !== cfg.aggregateFile) {
        errors.push(`release toolcall aggregate manualReview.aggregateFile mismatch: ${aggregatePath}`);
      }
      if (String(aggregateManualReview.templateFile || '').trim() !== cfg.manualReviewFile) {
        errors.push(`release toolcall aggregate manualReview.templateFile mismatch: ${aggregatePath}`);
      }
    }
    if (Array.isArray(aggregate.runs)) {
      const expectedProfiles = normalizeProfileLabels(cfg.requiredProfiles || []);
      const expectedProfileModels = cfg.requiredProfileModels && typeof cfg.requiredProfileModels === 'object'
        ? cfg.requiredProfileModels
        : {};
      const runProfiles = normalizeProfileLabels(aggregate.runs.map((run) => run && run.profile));
      if (
        expectedProfiles.length > 0 &&
        !arraysEqual([...runProfiles].sort(), [...expectedProfiles].sort())
      ) {
        errors.push(`release toolcall aggregate run profiles mismatch: ${aggregatePath}`);
      }
      for (const run of aggregate.runs) {
        if (!isNonEmptyString(run && run.sessionId)) {
          errors.push(`release toolcall aggregate run is missing sessionId: ${aggregatePath}`);
          continue;
        }
        const passCount = Number(run.passCount);
        const failCount = Number(run.failCount);
        const accuracy = Number(run.accuracy);
        const expectedRounds = Number(cfg.requiredRoundsPerRun);
        const minimumPasses = Math.ceil(expectedRounds * Number(cfg.minimumPassRate));
        if (!Number.isInteger(passCount) || passCount < 0) {
          errors.push(`release toolcall aggregate run has invalid passCount: ${aggregatePath}`);
        }
        if (!Number.isInteger(failCount) || failCount < 0) {
          errors.push(`release toolcall aggregate run has invalid failCount: ${aggregatePath}`);
        }
        if (Number.isInteger(passCount) && Number.isInteger(failCount) && passCount + failCount !== expectedRounds) {
          errors.push(`release toolcall aggregate run round count mismatch: ${aggregatePath}`);
        }
        if (!Number.isFinite(accuracy) || Math.abs(accuracy - passCount / expectedRounds) > 0.000001) {
          errors.push(`release toolcall aggregate run accuracy mismatch: ${aggregatePath}`);
        }
        if (Number.isInteger(passCount) && passCount < minimumPasses) {
          errors.push(`release toolcall aggregate run passCount is below threshold: ${aggregatePath}`);
        }
        const runProfile = normalizeProfileLabels([run.profile])[0];
        const expectedProfileModel = runProfile ? expectedProfileModels[runProfile] : '';
        if (expectedProfileModel && String(run.model || '').trim() !== String(expectedProfileModel).trim()) {
          errors.push(`release toolcall aggregate run model mismatch for profile ${runProfile}: ${aggregatePath}`);
        } else if (String(cfg.requiredModel || '').trim() !== 'multi-profile' && String(run.model || '').trim() !== String(cfg.requiredModel || '').trim()) {
          errors.push(`release toolcall aggregate run model mismatch: ${aggregatePath}`);
        }
        if (expectedProfiles.length > 0 && !expectedProfiles.includes(runProfile)) {
          errors.push(`release toolcall aggregate run profile is not expected: ${aggregatePath}`);
        }
        if (run.thresholdPassed !== true) {
          errors.push(`release toolcall aggregate run thresholdPassed must be true: ${aggregatePath}`);
        }
      }
    }
  }

  const review = readJsonFileOrError(manualReviewPath, 'release toolcall manual review', errors);
  if (aggregate && review) {
    const expectedRunSessionIds = normalizeStringArray(aggregate.runs.map((run) => run.sessionId));
    const reviewedRunSessionIds = normalizeStringArray(review.reviewedRunSessionIds);
    const checklist = review.checklist && typeof review.checklist === 'object' ? review.checklist : {};
    const requiredTrueChecklistFields = [
      'runMetricsChecked',
      'failureFlagsChecked',
      'fieldMismatchesChecked',
      'historyConsistencyChecked',
      'cascadeFailuresChecked',
      'completionMarkerRepairsChecked',
      'materiallyCorrect',
    ];

    if (!isNonEmptyString(review.reviewer)) {
      errors.push(`release toolcall manual review is missing reviewer: ${manualReviewPath}`);
    }
    const sourceGateReuseApproved =
      aggregateSourceCommitMismatch &&
      validateSourceGateReuseApproval(
        review,
        String(aggregate.sourceCommitSha || '').trim(),
        currentCommitSha,
        manualReviewPath,
        errors
      );
    if (aggregateSourceCommitMismatch && !sourceGateReuseApproved) {
      errors.push(`release toolcall aggregate sourceCommitSha does not match current HEAD: ${aggregatePath}`);
    }
    const expectedReviewedCommitSha = sourceGateReuseApproved
      ? currentCommitSha
      : String(aggregate.sourceCommitSha || '').trim();

    if (!isNonEmptyString(review.reviewedCommitSha)) {
      errors.push(`release toolcall manual review is missing reviewedCommitSha: ${manualReviewPath}`);
    } else if (String(review.reviewedCommitSha).trim() !== expectedReviewedCommitSha) {
      errors.push(`release toolcall manual review reviewedCommitSha mismatch: ${manualReviewPath}`);
    }
    if (!isNonEmptyString(review.reviewedAt)) {
      errors.push(`release toolcall manual review is missing reviewedAt: ${manualReviewPath}`);
    }
    if (review.aggregateGeneratedAt !== aggregate.generatedAt) {
      errors.push(`release toolcall manual review is stale for current aggregate: ${manualReviewPath}`);
    }
    if (Number(review.reviewedRequiredRuns) !== Number(aggregate.requiredRuns)) {
      errors.push(`release toolcall manual review requiredRuns mismatch: ${manualReviewPath}`);
    }
    if (Number(review.reviewedRoundsPerRun) !== Number(aggregate.roundsPerRun)) {
      errors.push(`release toolcall manual review roundsPerRun mismatch: ${manualReviewPath}`);
    }
    if (String(review.reviewedModel || '').trim() !== String(aggregate.model || '').trim()) {
      errors.push(`release toolcall manual review model mismatch: ${manualReviewPath}`);
    }
    if (!arraysEqual(normalizeProfileLabels(review.reviewedProfiles || []), normalizeProfileLabels(aggregate.requiredProfiles || []))) {
      errors.push(`release toolcall manual review profiles mismatch: ${manualReviewPath}`);
    }
    if (!arraysEqual(reviewedRunSessionIds, expectedRunSessionIds)) {
      errors.push(`release toolcall manual review reviewedRunSessionIds mismatch: ${manualReviewPath}`);
    }
    for (const fieldName of requiredTrueChecklistFields) {
      if (checklist[fieldName] !== true) {
        errors.push(`release toolcall manual review checklist.${fieldName} must be true: ${manualReviewPath}`);
      }
    }
    if (checklist.seriousHallucinationFound !== false) {
      errors.push(`release toolcall manual review checklist.seriousHallucinationFound must be false: ${manualReviewPath}`);
    }
    if (checklist.scriptFalsePositivePassFound !== false) {
      errors.push(`release toolcall manual review checklist.scriptFalsePositivePassFound must be false: ${manualReviewPath}`);
    }
    if (review.conclusion !== 'approved') {
      errors.push(`release toolcall manual review conclusion must be approved: ${manualReviewPath}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    outputRoot,
    aggregatePath,
    markdownPath,
    manualReviewPath,
    currentCommitSha,
    aggregate,
    review,
  };
}

function validateReleaseE2EGateEvidence(rootDir, cfg, options = {}) {
  const outputRoot = path.resolve(rootDir, cfg.outputRoot);
  const aggregatePath = path.join(outputRoot, cfg.aggregateFile);
  const markdownPath = path.join(outputRoot, cfg.markdownFile);
  const currentCommitSha = isNonEmptyString(options.currentCommitSha)
    ? String(options.currentCommitSha).trim()
    : resolveGitCommitSha(rootDir);
  const errors = [];

  if (!fs.existsSync(markdownPath)) {
    errors.push(`release e2e markdown report is missing: ${markdownPath}`);
  }

  const aggregate = readJsonFileOrError(aggregatePath, 'release e2e aggregate', errors);
  if (aggregate) {
    if (aggregate.gatePassed !== true) {
      errors.push(`release e2e aggregate did not pass: ${aggregatePath}`);
    }
    if (!isNonEmptyString(aggregate.generatedAt)) {
      errors.push(`release e2e aggregate is missing generatedAt: ${aggregatePath}`);
    }
    if (!isNonEmptyString(aggregate.sourceCommitSha)) {
      errors.push(`release e2e aggregate is missing sourceCommitSha: ${aggregatePath}`);
    } else if (String(aggregate.sourceCommitSha).trim() !== currentCommitSha) {
      errors.push(`release e2e aggregate sourceCommitSha does not match current HEAD: ${aggregatePath}`);
    }
    const expectedCases = normalizeStringArray(cfg.requiredCases || []);
    const aggregateRequiredCases = normalizeStringArray(aggregate.requiredCases || []);
    if (!arraysEqual([...aggregateRequiredCases].sort(), [...expectedCases].sort())) {
      errors.push(`release e2e aggregate requiredCases mismatch: ${aggregatePath}`);
    }
    if (!Array.isArray(aggregate.cases) || aggregate.cases.length === 0) {
      errors.push(`release e2e aggregate is missing cases: ${aggregatePath}`);
    } else {
      const caseIds = normalizeStringArray(aggregate.cases.map((item) => item && item.id));
      if (!arraysEqual([...caseIds].sort(), [...expectedCases].sort())) {
        errors.push(`release e2e aggregate case ids mismatch: ${aggregatePath}`);
      }
      for (const item of aggregate.cases) {
        if (!isNonEmptyString(item && item.id)) {
          errors.push(`release e2e aggregate case is missing id: ${aggregatePath}`);
          continue;
        }
        if (item.status !== 'passed') {
          errors.push(`release e2e case ${item.id} did not pass: ${aggregatePath}`);
        }
        if (Number(item.exitCode) !== 0) {
          errors.push(`release e2e case ${item.id} exitCode must be 0: ${aggregatePath}`);
        }
        if (item.signal !== null && item.signal !== undefined) {
          errors.push(`release e2e case ${item.id} signal must be empty: ${aggregatePath}`);
        }
        if (!Number.isFinite(Number(item.durationMs)) || Number(item.durationMs) < 0) {
          errors.push(`release e2e case ${item.id} has invalid durationMs: ${aggregatePath}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    outputRoot,
    aggregatePath,
    markdownPath,
    currentCommitSha,
    aggregate,
  };
}

function npmPackJson(args, cwd) {
  const output = runNpm(['pack', ...args, '--json'], { cwd });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to parse npm pack json: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack json returned empty list.');
  }
  return parsed[parsed.length - 1];
}

function validatePackFileList(packResult, cfg, label = 'publish') {
  const files = Array.isArray(packResult.files) ? packResult.files : [];
  if (files.length === 0) {
    throw new Error(`${label} pack returned no files.`);
  }
  const paths = files
    .map((item) => normalizePathForMatch(item.path))
    .filter((item) => item.length > 0);

  const forbidden = paths.filter((item) => startsWithAnyPrefix(item, cfg.forbiddenPackPaths));
  if (forbidden.length > 0) {
    throw new Error(`${label} pack includes forbidden runtime/sensitive files: ${forbidden.join(', ')}`);
  }

  const missingRequired = cfg.requiredPackPaths.filter((required) => !startsWithAnyPrefixAny(paths, required));
  if (missingRequired.length > 0) {
    throw new Error(`${label} pack missing required publish files: ${missingRequired.join(', ')}`);
  }
  info(`${label} pack audit passed with ${paths.length} files.`);
  return packResult;
}

function startsWithAnyPrefixAny(paths, requiredPrefix) {
  return paths.some((item) => {
    if (requiredPrefix.endsWith('/')) {
      return item.startsWith(requiredPrefix);
    }
    return item === requiredPrefix || item.startsWith(`${requiredPrefix}/`);
  });
}

function runCommandForSmoke(command, cwd, timeoutMs, successPattern, envOverrides = {}, onReady) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...envOverrides },
    });
    let combined = '';
    let done = false;
    let verifying = false;
    const pattern = successPattern ? new RegExp(successPattern, 'i') : null;

    const finalize = async (result, error) => {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        killProcessTree(child.pid);
        await waitForChildClose(child);
      }

      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    const settle = (result, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void finalize(result, error);
    };

    const verifyReady = async (reason) => {
      if (done || verifying) {
        return;
      }
      verifying = true;
      try {
        if (typeof onReady === 'function') {
          await onReady();
        }
        settle({ ok: true, reason, output: combined });
      } catch (error) {
        settle(null, error instanceof Error ? error : new Error(String(error)));
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      combined += text;
      if (pattern && pattern.test(combined)) {
        void verifyReady('pattern');
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      combined += text;
      if (pattern && pattern.test(combined)) {
        void verifyReady('pattern');
      }
    });

    child.on('error', (error) => {
      settle(null, new Error(`Smoke command failed to start: ${String(error)}`));
    });

    child.on('exit', (code) => {
      if (pattern) {
        if (code === 0 && pattern.test(combined)) {
          void verifyReady('exit+pattern');
          return;
        }
        settle(
          null,
          new Error(
            `Smoke command exited before success pattern. code=${String(code)}\nOutput:\n${combined}`
          )
        );
        return;
      }
      if (code === 0) {
        void verifyReady('exit0');
      } else {
        settle(null, new Error(`Smoke command failed. code=${String(code)}\nOutput:\n${combined}`));
      }
    });

    const timer = setTimeout(() => {
      settle(null, new Error(`Smoke timeout (${timeoutMs}ms)\nOutput:\n${combined}`));
    }, timeoutMs);
  });
}

async function fetchResponseOrFail(url, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_SMOKE_HTTP_TIMEOUT_MS));
  const retryDelayMs = Math.max(1, Number(options.retryDelayMs || DEFAULT_SMOKE_HTTP_RETRY_DELAY_MS));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  for (;;) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Smoke HTTP check failed: ${url} -> HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableSmokeFetchError(lastError) || Date.now() >= deadline) {
        break;
      }
      await sleep(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
    }
  }

  throw lastError;
}

function extractClientAssets(indexHtml) {
  const assets = [];
  const regex = /\b(?:src|href)="([^"]+\.(?:js|css))(?:\?[^"]*)?"/gi;
  let match = regex.exec(indexHtml);
  while (match) {
    assets.push(match[1]);
    match = regex.exec(indexHtml);
  }
  return assets;
}

async function verifySmokeServer(baseUrl) {
  const healthResponse = await fetchResponseOrFail(`${baseUrl}/api/health`);
  const healthJson = await healthResponse.json();
  if (!healthJson || healthJson.status !== 'ok') {
    throw new Error(`Smoke health payload invalid for ${baseUrl}/api/health`);
  }

  const indexResponse = await fetchResponseOrFail(`${baseUrl}/`);
  const indexHtml = await indexResponse.text();
  if (!/<script\b/i.test(indexHtml)) {
    throw new Error(`Smoke root page missing script tags: ${baseUrl}/`);
  }

  const assets = extractClientAssets(indexHtml);
  if (assets.length === 0) {
    throw new Error(`Smoke root page missing client asset references: ${baseUrl}/`);
  }

  const firstJsAsset = assets.find((asset) => /\.js(?:\?|$)/i.test(asset));
  if (!firstJsAsset) {
    throw new Error(`Smoke root page missing JavaScript asset references: ${baseUrl}/`);
  }

  const assetUrl = new URL(firstJsAsset, `${baseUrl}/`).toString();
  const assetResponse = await fetchResponseOrFail(assetUrl);
  const contentType = String(assetResponse.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('javascript')) {
    throw new Error(`Smoke JS asset has unexpected content-type: ${assetUrl} -> ${contentType || '(empty)'}`);
  }
}

function runBrowserSmoke(baseUrl, outputDir) {
  const smokeScript = path.join(ROOT, 'scripts', 'smoke-playwright-ui.js');
  if (!fs.existsSync(smokeScript)) {
    throw new Error(`Browser smoke script missing: ${smokeScript}`);
  }

  const runtimeConfig = resolveSmokeRuntimeConfig();
  const runtimeEnv = {};
  for (const [key, value] of Object.entries({
    SMOKE_API_KEY: runtimeConfig.apiKey,
    SMOKE_API_BASE: runtimeConfig.apiBase,
    SMOKE_MODEL: runtimeConfig.model,
    SMOKE_PROVIDER: runtimeConfig.provider,
    SMOKE_MAX_OUTPUT_TOKENS: runtimeConfig.maxOutputTokens,
  })) {
    if (value) {
      runtimeEnv[key] = value;
    }
  }

  runSync(process.execPath, [smokeScript], {
    cwd: ROOT,
    env: {
      SMOKE_URL: baseUrl,
      SMOKE_OUTPUT_DIR: outputDir,
      SMOKE_ALLOW_EXISTING_SETTINGS_WRITE: '1',
      SMOKE_RESPONSE_TIMEOUT_MS: '90000',
      SMOKE_DISPATCH_TIMEOUT_MS: '10000',
      ...runtimeEnv,
    },
  });
}

function installPackage(targetDir, installTarget, registry) {
  runNpm(['init', '-y'], { cwd: targetDir });
  if (/\.tgz$/i.test(installTarget)) {
    runNpm(['install', installTarget], { cwd: targetDir });
    return;
  }
  runNpm(['install', installTarget, '--registry', registry], { cwd: targetDir });
}

async function runSmoke(stageName, cfg, installTarget) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-publish-smoke-'));
  try {
    const smokePort = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${smokePort}`;
    installPackage(tmpRoot, installTarget, cfg.registry);
    info(`${stageName} smoke install done: ${installTarget}`);
    info(`${stageName} smoke using port ${smokePort}.`);
    await runCommandForSmoke(
      cfg.userSmoke.command,
      tmpRoot,
      cfg.userSmoke.timeoutMs,
      resolveSmokeSuccessPattern(cfg.userSmoke.successPattern, smokePort),
      {
        DPAGENT_PORT: String(smokePort),
      },
      async () => {
        await verifySmokeServer(baseUrl);
        runBrowserSmoke(baseUrl, path.join(tmpRoot, 'smoke-ui'));
      }
    );
    info(`${stageName} smoke passed.`);
  } finally {
    removePathWithRetry(tmpRoot);
  }
}

function isPrereleaseVersion(version) {
  return /^\d+\.\d+\.\d+-/.test(String(version || '').trim());
}

function validatePublishTagForVersion(pkg, publishTag) {
  if (!isPrereleaseVersion(pkg.version)) {
    return;
  }
  if (!publishTag || publishTag === 'latest') {
    throw new Error(`prerelease version ${pkg.version} requires an explicit non-latest dist-tag.`);
  }
}

module.exports = {
  isPrereleaseVersion,
  validatePublishTagForVersion,
  npmPackJson,
  removePathWithRetry,
  runFreshWebBuild,
  runNpm,
  runSmoke,
  fetchResponseOrFail,
  resolveSmokeRuntimeConfigFromSources,
  validatePackFileList,
  validateCleanGitWorktree,
  validateReleaseE2EGateEvidence,
  validateReleaseToolcallGateEvidence,
};
