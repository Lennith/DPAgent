#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const [, , npmScript, stdoutPathArg, stderrPathArg] = process.argv;
  if (!npmScript) {
    console.error('Usage: node scripts/run-with-logs.js <npm-script> [stdout-log] [stderr-log]');
    process.exit(1);
  }

  const stdoutPath = path.resolve(stdoutPathArg ?? `logs/${npmScript}.out.log`);
  const stderrPath = path.resolve(stderrPathArg ?? `logs/${npmScript}.err.log`);
  ensureParentDir(stdoutPath);
  ensureParentDir(stderrPath);

  const stdoutFile = fs.createWriteStream(stdoutPath, { flags: 'a' });
  const stderrFile = fs.createWriteStream(stderrPath, { flags: 'a' });
  const banner = `[${new Date().toISOString()}] npm run ${npmScript}\n`;
  stdoutFile.write(banner);
  stderrFile.write(banner);

  console.log(`[run-with-logs] stdout -> ${stdoutPath}`);
  console.log(`[run-with-logs] stderr -> ${stderrPath}`);

  const child = spawn('npm', ['run', npmScript], {
    cwd: process.cwd(),
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    stdoutFile.write(chunk);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    stderrFile.write(chunk);
  });

  child.on('exit', (code) => {
    stdoutFile.end();
    stderrFile.end();
    process.exit(code ?? 1);
  });
}

main();
