#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isPrereleaseVersion,
  npmPackJson,
  removePathWithRetry,
  runFreshWebBuild,
  runNpm,
  runSmoke,
  validateCleanGitWorktree,
  validatePackFileList,
  validatePublishTagForVersion,
  validateReleaseE2EGateEvidence,
  validateReleaseToolcallGateEvidence,
} = require('./lib/npm-publish-audit.js');

const ROOT = process.cwd();
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_USER_SMOKE = {
  command: 'npx dpagent --no-open',
  timeoutMs: 120000,
  successPattern: 'Starting web server at http://localhost:{PORT}',
};
const DEFAULT_REQUIRED_PACK_PATHS = [
  'dist/',
  'agents/',
  'doc/guide/user-guide.md',
  'README.md',
  'LICENSE',
  'CONFIG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'config.example.yaml',
];
const DEFAULT_FORBIDDEN_PACK_PATHS = [
  'runtime/',
  'sessions/',
  'contexts/',
  'logs/',
  'workspace/',
  'config.yaml',
  'release-toolcall-profiles.dev.json',
  'release-toolcall-profiles.local.json',
  '.env',
];
const DEFAULT_RELEASE_E2E_GATE = {
  outputRoot: 'logs/release-gate-e2e',
  aggregateFile: 'release-e2e-gate.json',
  markdownFile: 'release-e2e-gate.md',
  requiredCases: [
    'e2e:release-agent-web-regression',
    'e2e:release-plan-mode-lifecycle',
    'e2e:release-plan-mode-ux',
    'e2e:release-cli-long-session',
  ],
};
const DEFAULT_RELEASE_TOOLCALL_GATE = {
  outputRoot: 'logs/release-gate-toolcall-context-session',
  aggregateFile: 'release-toolcall-context-gate.json',
  markdownFile: 'release-toolcall-context-gate.md',
  manualReviewFile: 'release-toolcall-context-manual-review.json',
  requiredRuns: 2,
  requiredRoundsPerRun: 10,
  requiredModel: 'multi-profile',
  requiredProfiles: ['deepseek', 'minimax'],
  requiredProfileModels: {
    deepseek: 'deepseek-v4-flash',
    minimax: 'MiniMax-M2.7-highspeed',
  },
  minimumPassRate: 0.9,
};

function fail(message) {
  console.error(`[npm-official-publish] ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[npm-official-publish] ${message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const map = new Map();
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

  const mode = String(map.get('mode') || 'preflight').trim();
  if (mode !== 'preflight' && mode !== 'publish') {
    fail('Invalid --mode. Use preflight or publish.');
  }
  const tag = map.has('tag') ? String(map.get('tag') || '').trim() : undefined;
  if (tag !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) {
    fail('Invalid --tag. Use a non-empty npm dist-tag such as beta.');
  }
  return { mode, tag, skipReleaseGate: map.get('skip-release-gate') === 'true' };
}

function loadPackageJson(rootDir = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
}

function normalizeOfficialPackageName(value) {
  const name = String(value || '').trim();
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error('npmOfficialPublish.packageName must be a scoped npm package name.');
  }
  return name;
}

function getScopeRegistryArg(packageName, registry) {
  const scope = packageName.match(/^(@[^/]+)\//)?.[1];
  return scope ? `${scope}:registry=${registry}` : '';
}

function getDefaultOfficialPublishAuditConfig() {
  return {
    userSmoke: { ...DEFAULT_USER_SMOKE },
    requiredPackPaths: [...DEFAULT_REQUIRED_PACK_PATHS],
    forbiddenPackPaths: [...DEFAULT_FORBIDDEN_PACK_PATHS],
    releaseE2EGate: {
      ...DEFAULT_RELEASE_E2E_GATE,
      requiredCases: [...DEFAULT_RELEASE_E2E_GATE.requiredCases],
    },
    releaseToolcallGate: {
      ...DEFAULT_RELEASE_TOOLCALL_GATE,
      requiredProfiles: [...DEFAULT_RELEASE_TOOLCALL_GATE.requiredProfiles],
      requiredProfileModels: { ...DEFAULT_RELEASE_TOOLCALL_GATE.requiredProfileModels },
    },
  };
}

function getNpmOfficialPublishConfig(pkg, auditCfg = getDefaultOfficialPublishAuditConfig()) {
  const cfg = pkg.npmOfficialPublish;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('Missing npmOfficialPublish config in package.json.');
  }
  const packageName = normalizeOfficialPackageName(cfg.packageName);
  const registry = String(cfg.registry || DEFAULT_REGISTRY).trim();
  if (registry !== DEFAULT_REGISTRY) {
    throw new Error(`npmOfficialPublish.registry must be ${DEFAULT_REGISTRY}.`);
  }
  const access = String(cfg.access || 'public').trim();
  if (access !== 'public') {
    throw new Error('npmOfficialPublish.access must be public.');
  }
  return {
    packageName,
    registry,
    access,
    userSmoke: auditCfg.userSmoke,
    requiredPackPaths: auditCfg.requiredPackPaths,
    forbiddenPackPaths: auditCfg.forbiddenPackPaths,
    releaseE2EGate: auditCfg.releaseE2EGate,
    releaseToolcallGate: auditCfg.releaseToolcallGate,
  };
}

function pickObjectFields(source, keys) {
  const output = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

function sanitizePackageJsonForOfficial(pkg, cfg) {
  const clean = pickObjectFields(pkg, [
    'version',
    'description',
    'main',
    'types',
    'bin',
    'files',
    'keywords',
    'author',
    'license',
    'repository',
    'bugs',
    'homepage',
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
    'engines',
  ]);
  return {
    name: cfg.packageName,
    ...clean,
    publishConfig: {
      registry: cfg.registry,
      access: cfg.access,
    },
  };
}

function copyFileIntoStaging(rootDir, stagingDir, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === 'package.json') {
    return;
  }
  const source = path.join(rootDir, normalized);
  const target = path.join(stagingDir, normalized);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`Packed file is missing from source tree: ${normalized}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDryRunPackFiles(rootDir, stagingDir, packResult) {
  const files = Array.isArray(packResult.files) ? packResult.files : [];
  for (const file of files) {
    copyFileIntoStaging(rootDir, stagingDir, file.path);
  }
}

function createOfficialPublishTarball(rootDir, pkg, cfg) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-official-pack-'));
  try {
    const stagingDir = path.join(tempRoot, 'package-src');
    const tarballDir = path.join(tempRoot, 'tarball');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(tarballDir, { recursive: true });

    const sourcePack = npmPackJson(['--dry-run'], rootDir);
    copyDryRunPackFiles(rootDir, stagingDir, sourcePack);
    fs.writeFileSync(
      path.join(stagingDir, 'package.json'),
      `${JSON.stringify(sanitizePackageJsonForOfficial(pkg, cfg), null, 2)}\n`,
      'utf8'
    );

    const packResult = npmPackJson(['--pack-destination', tarballDir], stagingDir);
    const tarballName = packResult.filename;
    if (!tarballName || typeof tarballName !== 'string') {
      throw new Error('npm pack did not return tarball filename.');
    }
    const tarballPath = path.join(tarballDir, tarballName);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`official npm tarball missing: ${tarballPath}`);
    }
    return { tempRoot, tarballPath, packResult };
  } catch (error) {
    removePathWithRetry(tempRoot);
    throw error;
  }
}

function buildOfficialPublishArgs(publishTarget, cfg, publishTag) {
  const args = ['publish', publishTarget, '--registry', cfg.registry, '--access', cfg.access];
  if (publishTag) {
    args.push('--tag', publishTag);
  }
  return args;
}

function npmWhoamiOfficial(cfg) {
  const output = runNpm(['whoami', '--registry', cfg.registry], { cwd: ROOT }).trim();
  if (!output) {
    throw new Error('npm whoami returned empty account.');
  }
  info(`Authenticated as ${output} on ${cfg.registry}`);
  return output;
}

function assertPackageVersionIsUnpublished(pkg, cfg, publishTag) {
  const scopeRegistry = getScopeRegistryArg(cfg.packageName, cfg.registry);
  const args = [
    ...(scopeRegistry ? [`--${scopeRegistry}`] : []),
    'view',
    `${cfg.packageName}@${pkg.version}`,
    'version',
    '--registry',
    cfg.registry,
  ];
  try {
    const observed = runNpm(args, { cwd: ROOT }).trim();
    if (observed === pkg.version) {
      throw new Error(`${cfg.packageName}@${pkg.version} already exists on ${cfg.registry}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/E404|not found/i.test(message)) {
      return;
    }
    if (message.includes('already exists')) {
      throw error;
    }
    throw new Error(`Failed to check official npm version availability: ${message}`);
  }
  if (isPrereleaseVersion(pkg.version) && !publishTag) {
    throw new Error('Prerelease official npm publish requires an explicit dist-tag.');
  }
}

function publishOfficial(tarballPath, cfg, publishTag) {
  runNpm(buildOfficialPublishArgs(tarballPath, cfg, publishTag), { cwd: ROOT });
  info('official npm publish completed.');
}

function createPlan(mode, publishTag, options = {}) {
  return {
    verifyReleaseEvidence: options.skipReleaseGate !== true,
    buildBeforePublish: true,
    packagedSmoke: mode === 'publish',
    registrySmoke: mode === 'publish',
    publish: mode === 'publish',
    publishTag,
  };
}

async function main() {
  const { mode, tag, skipReleaseGate } = parseArgs();
  const plan = createPlan(mode, tag, { skipReleaseGate });
  const pkg = loadPackageJson(ROOT);
  const cfg = getNpmOfficialPublishConfig(pkg);

  info(`mode=${mode}${tag ? ` tag=${tag}` : ''} package=${cfg.packageName}`);
  validatePublishTagForVersion(pkg, tag);
  if (plan.registrySmoke && !cfg.userSmoke) {
    throw new Error('npmOfficialPublish requires userSmoke for registry smoke.');
  }

  validateCleanGitWorktree(ROOT);
  if (plan.verifyReleaseEvidence) {
    validateReleaseE2EGateEvidence(ROOT, cfg.releaseE2EGate);
    validateReleaseToolcallGateEvidence(ROOT, cfg.releaseToolcallGate);
  } else {
    info('release evidence check skipped for official npm publish.');
  }
  npmWhoamiOfficial(cfg);
  assertPackageVersionIsUnpublished(pkg, cfg, tag);

  if (plan.buildBeforePublish) {
    runFreshWebBuild();
  }

  const { tempRoot, tarballPath, packResult } = createOfficialPublishTarball(ROOT, pkg, cfg);
  try {
    validatePackFileList(packResult, cfg, 'npm official publish');

    if (plan.packagedSmoke) {
      await runSmoke('npm official pre-publish local', cfg, tarballPath);
    }

    if (plan.publish) {
      publishOfficial(tarballPath, cfg, tag);
      if (plan.registrySmoke) {
        const installTarget = tag ? `${cfg.packageName}@${tag}` : `${cfg.packageName}@${pkg.version}`;
        await runSmoke('npm official post-publish registry', cfg, installTarget);
      }
    }
  } finally {
    removePathWithRetry(tempRoot);
  }

  info('All checks passed.');
}

module.exports = {
  buildOfficialPublishArgs,
  createPlan,
  getDefaultOfficialPublishAuditConfig,
  getNpmOfficialPublishConfig,
  normalizeOfficialPackageName,
  sanitizePackageJsonForOfficial,
};

if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
