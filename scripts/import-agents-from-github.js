#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function printUsage() {
  console.log(`Usage:
  node scripts/import-agents-from-github.js --repo <url> [--branch <name>] [--source <dir>] [--target <dir>] [--mode merge|replace]

Examples:
  node scripts/import-agents-from-github.js --repo https://github.com/owner/stack.git
  node scripts/import-agents-from-github.js --repo https://github.com/owner/stack.git --source agents --mode replace
`);
}

function parseArgs(argv) {
  const args = {
    repo: '',
    branch: '',
    source: 'agents',
    target: 'agents',
    mode: 'merge',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }
    if (!(key in args)) {
      throw new Error(`Unknown option: ${token}`);
    }
    args[key] = val;
    i += 1;
  }

  return args;
}

function runOrThrow(cmd, cmdArgs, cwd) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${cmdArgs.join(' ')}`);
  }
}

function copyDirectoryContent(srcDir, dstDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  fs.mkdirSync(dstDir, { recursive: true });

  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}

function listDirectories(baseDir) {
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function findAgentDirectories(baseDir) {
  const names = listDirectories(baseDir);
  const result = [];
  for (const name of names) {
    const agentDir = path.join(baseDir, name);
    const profilePath = path.join(agentDir, 'AGENTS.md');
    if (fs.existsSync(profilePath)) {
      result.push(name);
    }
  }
  return result;
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.repo) {
    throw new Error('Missing required --repo');
  }

  if (!['merge', 'replace'].includes(args.mode)) {
    throw new Error(`Invalid --mode: ${args.mode}. Expected merge or replace.`);
  }

  const targetDir = path.resolve(root, args.target);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagents-import-'));

  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (args.branch) {
      cloneArgs.push('--branch', args.branch);
    }
    cloneArgs.push(args.repo, tempDir);

    console.log(`[agents-import] Cloning ${args.repo}${args.branch ? ` (branch: ${args.branch})` : ''}`);
    runOrThrow('git', cloneArgs, root);

    const sourceDir = path.resolve(tempDir, args.source);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`Source directory not found in repo: ${args.source}`);
    }

    let incoming = findAgentDirectories(sourceDir);
    let importedFrom = `profiles under ${args.source}`;

    if (incoming.length === 0) {
      throw new Error(`No agent profile found under ${args.source}. Expected <name>/AGENTS.md directories.`);
    } else {
      if (args.mode === 'replace' && fs.existsSync(targetDir)) {
        console.log(`[agents-import] Replace mode enabled, clearing ${targetDir}`);
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      copyDirectoryContent(sourceDir, targetDir);
    }

    const imported = findAgentDirectories(targetDir);
    console.log(`[agents-import] Imported ${incoming.length} profiles from ${args.repo} (${importedFrom})`);
    console.log(`[agents-import] Current profiles in ${args.target}: ${imported.join(', ')}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[agents-import] Failed: ${msg}`);
  process.exit(1);
}
