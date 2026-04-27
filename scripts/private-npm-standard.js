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

function fail(message) {
  console.error(`[private-publish] ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[private-publish] ${message}`);
}

function warn(message) {
  console.warn(`[private-publish] WARN: ${message}`);
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

function parseArgs() {
  const modeArgIndex = process.argv.findIndex((item) => item === '--mode');
  const mode = modeArgIndex >= 0 ? process.argv[modeArgIndex + 1] : 'preflight';
  if (mode !== 'preflight' && mode !== 'publish') {
    fail('Invalid --mode. Use preflight or publish.');
  }
  return { mode };
}

function createPublishPlan(mode) {
  return {
    verifyReleaseEvidence: true,
    buildBeforePublish: true,
    dryRunPack: false,
    packagedSmoke: false,
    registrySmoke: mode === 'publish',
    publish: mode === 'publish',
  };
}

function loadPackageJson() {
  const packagePath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(packagePath)) {
    fail(`package.json not found: ${packagePath}`);
  }
  const raw = fs.readFileSync(packagePath, 'utf8');
  return JSON.parse(raw);
}

function normalizePathForMatch(input) {
  return String(input || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function compilePathRules(values, fieldName) {
  if (!Array.isArray(values)) {
    fail(`internalPublish.${fieldName} must be an array.`);
  }
  return values.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      fail(`internalPublish.${fieldName} contains invalid entry.`);
    }
    const normalized = normalizePathForMatch(entry.trim());
    return normalized.endsWith('/') ? normalized : `${normalized}`;
  });
}

function startsWithAnyPrefix(targetPath, prefixes) {
  return prefixes.some((prefix) => {
    if (prefix.endsWith('/')) {
      return targetPath.startsWith(prefix);
    }
    return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
  });
}

function getInternalPublishConfig(pkg) {
  const cfg = pkg.internalPublish;
  if (!cfg || typeof cfg !== 'object') {
    fail('Missing internalPublish config in package.json.');
  }
  if (typeof cfg.registry !== 'string' || cfg.registry.trim().length === 0) {
    fail('internalPublish.registry must be set.');
  }
  const userSmoke =
    cfg.userSmoke && typeof cfg.userSmoke === 'object'
      ? {
          command: typeof cfg.userSmoke.command === 'string' ? cfg.userSmoke.command.trim() : '',
          timeoutMs: Number(cfg.userSmoke.timeoutMs),
          successPattern: cfg.userSmoke.successPattern ? String(cfg.userSmoke.successPattern) : '',
        }
      : null;
  if (userSmoke) {
    if (!userSmoke.command) {
      fail('internalPublish.userSmoke.command must be set when userSmoke is provided.');
    }
    if (!Number.isFinite(userSmoke.timeoutMs) || userSmoke.timeoutMs <= 0) {
      fail('internalPublish.userSmoke.timeoutMs must be > 0 when userSmoke is provided.');
    }
    if (
      cfg.userSmoke.successPattern !== undefined &&
      (typeof cfg.userSmoke.successPattern !== 'string' || cfg.userSmoke.successPattern.trim().length === 0)
    ) {
      fail('internalPublish.userSmoke.successPattern must be a non-empty string when provided.');
    }
  }
  if (!cfg.releaseToolcallGate || typeof cfg.releaseToolcallGate !== 'object') {
    fail('internalPublish.releaseToolcallGate must be set.');
  }
  if (
    typeof cfg.releaseToolcallGate.outputRoot !== 'string' ||
    cfg.releaseToolcallGate.outputRoot.trim().length === 0
  ) {
    fail('internalPublish.releaseToolcallGate.outputRoot must be set.');
  }
  if (
    typeof cfg.releaseToolcallGate.aggregateFile !== 'string' ||
    cfg.releaseToolcallGate.aggregateFile.trim().length === 0
  ) {
    fail('internalPublish.releaseToolcallGate.aggregateFile must be set.');
  }
  if (
    typeof cfg.releaseToolcallGate.markdownFile !== 'string' ||
    cfg.releaseToolcallGate.markdownFile.trim().length === 0
  ) {
    fail('internalPublish.releaseToolcallGate.markdownFile must be set.');
  }
  if (
    typeof cfg.releaseToolcallGate.manualReviewFile !== 'string' ||
    cfg.releaseToolcallGate.manualReviewFile.trim().length === 0
  ) {
    fail('internalPublish.releaseToolcallGate.manualReviewFile must be set.');
  }
  if (
    typeof cfg.releaseToolcallGate.requiredRuns !== 'number' ||
    !Number.isFinite(cfg.releaseToolcallGate.requiredRuns) ||
    cfg.releaseToolcallGate.requiredRuns <= 0
  ) {
    fail('internalPublish.releaseToolcallGate.requiredRuns must be > 0.');
  }
  if (
    typeof cfg.releaseToolcallGate.requiredRoundsPerRun !== 'number' ||
    !Number.isFinite(cfg.releaseToolcallGate.requiredRoundsPerRun) ||
    cfg.releaseToolcallGate.requiredRoundsPerRun <= 0
  ) {
    fail('internalPublish.releaseToolcallGate.requiredRoundsPerRun must be > 0.');
  }
  if (
    typeof cfg.releaseToolcallGate.requiredModel !== 'string' ||
    cfg.releaseToolcallGate.requiredModel.trim().length === 0
  ) {
    fail('internalPublish.releaseToolcallGate.requiredModel must be set.');
  }
  if (
    cfg.releaseToolcallGate.requiredProfiles !== undefined &&
    (!Array.isArray(cfg.releaseToolcallGate.requiredProfiles) ||
      cfg.releaseToolcallGate.requiredProfiles.some((item) => typeof item !== 'string' || item.trim().length === 0))
  ) {
    fail('internalPublish.releaseToolcallGate.requiredProfiles must be a string array when provided.');
  }
  if (
    cfg.releaseToolcallGate.requiredProfileModels !== undefined &&
    (!cfg.releaseToolcallGate.requiredProfileModels ||
      typeof cfg.releaseToolcallGate.requiredProfileModels !== 'object' ||
      Array.isArray(cfg.releaseToolcallGate.requiredProfileModels) ||
      Object.entries(cfg.releaseToolcallGate.requiredProfileModels).some(
        ([profile, model]) =>
          typeof profile !== 'string' ||
          profile.trim().length === 0 ||
          typeof model !== 'string' ||
          model.trim().length === 0
      ))
  ) {
    fail('internalPublish.releaseToolcallGate.requiredProfileModels must be an object of non-empty profile model strings when provided.');
  }
  if (
    typeof cfg.releaseToolcallGate.minimumPassRate !== 'number' ||
    !Number.isFinite(cfg.releaseToolcallGate.minimumPassRate) ||
    cfg.releaseToolcallGate.minimumPassRate <= 0 ||
    cfg.releaseToolcallGate.minimumPassRate > 1
  ) {
    fail('internalPublish.releaseToolcallGate.minimumPassRate must be within (0, 1].');
  }

  return {
    registry: cfg.registry.trim(),
    userSmoke: userSmoke
      ? {
          command: userSmoke.command,
          timeoutMs: Math.floor(userSmoke.timeoutMs),
          successPattern: userSmoke.successPattern,
        }
      : null,
    requiredReadmeInitCommand:
      typeof cfg.requiredReadmeInitCommand === 'string' ? cfg.requiredReadmeInitCommand.trim() : '',
    forbiddenPackPaths: compilePathRules(cfg.forbiddenPackPaths || [], 'forbiddenPackPaths'),
    requiredPackPaths: compilePathRules(cfg.requiredPackPaths || [], 'requiredPackPaths'),
    requireUsabilityEntrypoint: cfg.requireUsabilityEntrypoint !== false,
    releaseToolcallGate: {
      outputRoot: cfg.releaseToolcallGate.outputRoot.trim(),
      aggregateFile: cfg.releaseToolcallGate.aggregateFile.trim(),
      markdownFile: cfg.releaseToolcallGate.markdownFile.trim(),
      manualReviewFile: cfg.releaseToolcallGate.manualReviewFile.trim(),
      requiredRuns: Math.floor(cfg.releaseToolcallGate.requiredRuns),
      requiredRoundsPerRun: Math.floor(cfg.releaseToolcallGate.requiredRoundsPerRun),
      requiredModel: cfg.releaseToolcallGate.requiredModel.trim(),
      requiredProfiles: normalizeStringArray(cfg.releaseToolcallGate.requiredProfiles || []),
      requiredProfileModels: normalizeProfileModelMap(cfg.releaseToolcallGate.requiredProfileModels || {}),
      minimumPassRate: Number(cfg.releaseToolcallGate.minimumPassRate),
    },
  };
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

function normalizeProfileModelMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [profile, model] of Object.entries(value)) {
    const label = normalizeProfileLabels([profile])[0];
    const modelValue = String(model || '').trim();
    if (label && modelValue) {
      normalized[label] = modelValue;
    }
  }
  return normalized;
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
      'toolCallContinuityChecked',
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

function validateUsabilityEntrypoint(pkg, cfg) {
  if (!cfg.requireUsabilityEntrypoint) {
    return;
  }
  const hasBin = !!pkg.bin && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
  const hasStartScript = !!pkg.scripts && typeof pkg.scripts.start === 'string' && pkg.scripts.start.trim().length > 0;
  if (!hasBin && !hasStartScript) {
    fail('Usability gate failed: package must provide bin or scripts.start for end users.');
  }
}

function validateReadmeInitCommand(cfg) {
  if (!cfg.requiredReadmeInitCommand) {
    fail('internalPublish.requiredReadmeInitCommand must be configured.');
  }
  const readmePath = path.join(ROOT, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fail('README.md is required for publish usability gate.');
  }
  const content = fs.readFileSync(readmePath, 'utf8');
  if (!content.includes(cfg.requiredReadmeInitCommand)) {
    fail(
      `README usability gate failed: missing init command "${cfg.requiredReadmeInitCommand}".`
    );
  }
}

function checkRegistryConsistency(pkg, cfg) {
  const publishRegistry = pkg.publishConfig && typeof pkg.publishConfig.registry === 'string'
    ? pkg.publishConfig.registry.trim()
    : '';
  if (publishRegistry && publishRegistry !== cfg.registry) {
    fail(`publishConfig.registry (${publishRegistry}) does not match internalPublish.registry (${cfg.registry}).`);
  }
}

function npmWhoami(registry) {
  const output = runNpm(['whoami', '--registry', registry], { cwd: ROOT }).trim();
  if (!output) {
    fail('npm whoami returned empty account.');
  }
  info(`Authenticated as ${output} on ${registry}`);
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

function createPublishTarball() {
  const tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-pack-'));
  try {
    const packResult = npmPackJson(['--pack-destination', tarballDir], ROOT);
    const tarballName = packResult.filename;
    if (!tarballName || typeof tarballName !== 'string') {
      throw new Error('npm pack did not return tarball filename.');
    }
    const tarballPath = path.join(tarballDir, tarballName);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`local tarball missing: ${tarballPath}`);
    }
    return { tarballDir, tarballPath, packResult };
  } catch (error) {
    removePathWithRetry(tarballDir);
    throw error;
  }
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

function checkDryRunPack(cfg) {
  return validatePackFileList(npmPackJson(['--dry-run'], ROOT), cfg, 'dry-run');
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-smoke-'));
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
        MINIMAX_PORT: String(smokePort),
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

function publish(registry, publishTarget) {
  runNpm(['publish', publishTarget, '--registry', registry], { cwd: ROOT });
  info('publish completed.');
}

async function main() {
  const { mode } = parseArgs();
  const plan = createPublishPlan(mode);
  const pkg = loadPackageJson();
  const cfg = getInternalPublishConfig(pkg);

  info(`mode=${mode}`);
  if (plan.registrySmoke && !cfg.userSmoke) {
    fail('internalPublish.userSmoke is required because publish:standard runs post-publish registry smoke.');
  }
  validateCleanGitWorktree(ROOT);
  checkRegistryConsistency(pkg, cfg);
  validateUsabilityEntrypoint(pkg, cfg);
  validateReadmeInitCommand(cfg);
  if (plan.verifyReleaseEvidence) {
    const releaseGateEvidence = validateReleaseToolcallGateEvidence(ROOT, cfg.releaseToolcallGate);
    info(`release toolcall evidence verified: ${releaseGateEvidence.aggregatePath}`);
  }
  npmWhoami(cfg.registry);
  if (plan.buildBeforePublish) {
    runFreshWebBuild();
  }
  if (plan.dryRunPack) {
    checkDryRunPack(cfg);
  }

  const { tarballDir, tarballPath, packResult } = createPublishTarball();

  try {
    validatePackFileList(packResult, cfg, 'publish');

    if (plan.packagedSmoke) {
      await runSmoke('pre-publish local', cfg, tarballPath);
    }

    if (plan.publish) {
      publish(cfg.registry, tarballPath);
      if (plan.registrySmoke) {
        const installTarget = `${pkg.name}@${pkg.version}`;
        await runSmoke('post-publish registry', cfg, installTarget);
      }
    }
  } finally {
    removePathWithRetry(tarballDir);
  }

  info('All checks passed.');
}

module.exports = {
  createPublishPlan,
  getInternalPublishConfig,
  fetchResponseOrFail,
  resolveSmokeRuntimeConfigFromSources,
  validatePackFileList,
  validateCleanGitWorktree,
  validateReleaseToolcallGateEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
