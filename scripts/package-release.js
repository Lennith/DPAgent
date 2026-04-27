#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = process.cwd();
const RELEASES_DIR = path.join(ROOT, 'releases');
const NPM_RUN_PREFIX = process.platform === 'win32' ? 'npm.cmd run' : 'npm run';

const STANDARD_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'CONFIG.md',
  'config.yaml',
  'skill-list.yaml',
  'start.js',
  'setup.js',
  'init.js',
  'start.bat',
  'start-dev.bat',
  'setup.bat',
  'scripts/run-with-logs.js',
  'scripts/diagnose.js',
  'scripts/collect-evidence.js',
  'docs/LOGGING.md',
];

const STANDARD_DIRS = ['dist'];

const EASY_RUN_FILES = [
  'config.yaml',
  'skill-list.yaml',
  'start-easy.js',
  'Run-MiniMax.bat',
  'docs/WINDOWS_EASY_RUN.md',
];

const EASY_RUN_DIRS = ['dist', 'agents', 'node_modules'];

function getShortCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'no-git';
  }
}

function runRepositoryScript(scriptName) {
  execSync(`${NPM_RUN_PREFIX} ${scriptName}`, { cwd: ROOT, stdio: 'inherit' });
}

function rebuildBuiltArtifacts() {
  console.log('[package-release] rebuilding dist artifacts via npm run build:web');
  runRepositoryScript('build:web');
}

function ensureNodeModules() {
  const marker = path.join(ROOT, 'node_modules', 'express');
  if (!fs.existsSync(marker)) {
    throw new Error('node_modules is missing required runtime dependencies. Run `npm install` first.');
  }
}

function resolveWindowsRuntimeDir() {
  const configured = process.env.MINIMAX_WINDOWS_NODE_RUNTIME_DIR;
  const candidates = [
    configured,
    path.join(ROOT, 'vendor', 'node-win-x64'),
    path.join(ROOT, 'vendor', 'node-runtime-win-x64'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (fs.existsSync(path.join(absolute, 'node.exe'))) {
      return absolute;
    }
  }
  throw new Error(
    [
      'Windows Node runtime not found.',
      'Please place runtime at vendor/node-win-x64 (contains node.exe),',
      'or set MINIMAX_WINDOWS_NODE_RUNTIME_DIR to that directory.',
    ].join(' ')
  );
}

function copyFileOrThrow(relativePath, targetRoot) {
  const sourcePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required file: ${relativePath}`);
  }
  const targetPath = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDirOrThrow(relativePath, targetRoot) {
  const sourcePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing required directory: ${relativePath}`);
  }
  const targetPath = path.join(targetRoot, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function createZipFromFolder(sourceFolder, zipPath) {
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  const escapedSource = sourceFolder.replace(/'/g, "''");
  const escapedZip = zipPath.replace(/'/g, "''");
  const command = `powershell -NoProfile -Command "Compress-Archive -Path '${escapedSource}\\*' -DestinationPath '${escapedZip}' -Force"`;
  execSync(command, { stdio: 'inherit' });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function buildRuntimeManifest(nodeRuntimeDir, releaseRoot) {
  const nodeExe = path.join(nodeRuntimeDir, 'node.exe');
  const npmCmd = path.join(nodeRuntimeDir, 'npm.cmd');
  const runtimeManifest = {
    runtimeDir: 'node-runtime',
    nodeExe: 'node-runtime/node.exe',
    npmCmd: fs.existsSync(npmCmd) ? 'node-runtime/npm.cmd' : null,
    nodeVersion: execSync(`"${nodeExe}" -v`, { encoding: 'utf8' }).trim(),
    generatedAt: new Date().toISOString(),
    sha256: {
      'node.exe': sha256File(nodeExe),
    },
  };
  if (fs.existsSync(npmCmd)) {
    runtimeManifest.sha256['npm.cmd'] = sha256File(npmCmd);
  }
  const manifestPath = path.join(releaseRoot, 'node-runtime', 'runtime-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(runtimeManifest, null, 2), 'utf8');
}

function buildStandardRelease(stamp, commit) {
  const releaseName = `minimax-agent-release-${stamp}-${commit}`;
  const releaseRoot = path.join(RELEASES_DIR, releaseName);
  const zipPath = `${releaseRoot}.zip`;

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(releaseRoot, { recursive: true });

  for (const file of STANDARD_FILES) {
    copyFileOrThrow(file, releaseRoot);
  }
  for (const dir of STANDARD_DIRS) {
    copyDirOrThrow(dir, releaseRoot);
  }
  createZipFromFolder(releaseRoot, zipPath);

  return { releaseRoot, zipPath };
}

function buildEasyRunRelease(stamp, commit) {
  ensureNodeModules();
  const nodeRuntimeDir = resolveWindowsRuntimeDir();

  const releaseName = `minimax-agent-windows-easy-run-${stamp}-${commit}`;
  const releaseRoot = path.join(RELEASES_DIR, releaseName);
  const zipPath = `${releaseRoot}.zip`;
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(releaseRoot, { recursive: true });

  for (const file of EASY_RUN_FILES) {
    copyFileOrThrow(file, releaseRoot);
  }
  for (const dir of EASY_RUN_DIRS) {
    copyDirOrThrow(dir, releaseRoot);
  }

  const runtimeTarget = path.join(releaseRoot, 'node-runtime');
  fs.cpSync(nodeRuntimeDir, runtimeTarget, { recursive: true });
  buildRuntimeManifest(nodeRuntimeDir, releaseRoot);

  createZipFromFolder(releaseRoot, zipPath);
  return { releaseRoot, zipPath };
}

function main() {
  rebuildBuiltArtifacts();
  fs.mkdirSync(RELEASES_DIR, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const commit = getShortCommit();
  const enableEasyRun = process.argv.includes('--easy-run');

  const standard = buildStandardRelease(stamp, commit);

  console.log(`[package-release] standard folder: ${standard.releaseRoot}`);
  console.log(`[package-release] standard zip: ${standard.zipPath}`);
  if (enableEasyRun) {
    const easyRun = buildEasyRunRelease(stamp, commit);
    console.log(`[package-release] easy-run folder: ${easyRun.releaseRoot}`);
    console.log(`[package-release] easy-run zip: ${easyRun.zipPath}`);
  } else {
    console.log('[package-release] easy-run package skipped (pass --easy-run to enable).');
  }
}

main();
