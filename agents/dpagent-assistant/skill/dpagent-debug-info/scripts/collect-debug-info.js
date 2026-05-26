#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const DEFAULT_LOG_FILES = [
  'all.log',
  'webserver.log',
  'agent.log',
  'llm.log',
  'mcp.log',
  'tool.log',
  'config.log',
  'app.log',
];

const FOCUS_PATTERNS = [
  /WS closed/i,
  /websocket/i,
  /Reject chat/i,
  /active run/i,
  /Chat input locked/i,
  /\[PlanMode\]/i,
  /plan_input/i,
  /pending plan/i,
  /ensureTodoDrivenAutoLoop/i,
  /Share URL resolved/i,
  /event loop/i,
  /runtime heartbeat/i,
  /heartbeat/i,
  /subagent/i,
  /waitTimedOut/i,
  /lock timeout/i,
  /port is occupied/i,
  /health/i,
  /Run start/i,
  /Run finished/i,
  /Run finalized/i,
  /Run failed/i,
];

const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_\-]{12,})/g,
  /(apiKey["'\s:=]+)([^"',\s}]+)/gi,
  /(password["'\s:=]+)([^"',\s}]+)/gi,
  /(passwordHash["'\s:=]+)([^"',\s}]+)/gi,
  /(passwordSalt["'\s:=]+)([^"',\s}]+)/gi,
  /(authorization["'\s:=]+)(Bearer\s+)?([^"',\s}]+)/gi,
  /(cookie["'\s:=]+)([^"'\n]+)/gi,
  /(token["'\s:=]+)([A-Za-z0-9_\-.=]{16,})/gi,
  /(dpagent-share\/)([A-Za-z0-9_\-.=]+)/gi,
];

function parseArgs(argv) {
  const args = {
    baseUrl: '',
    workspace: '',
    workspaceProvided: false,
    logDirs: [],
    sessionId: '',
    outputDir: '',
    sinceMinutes: 180,
    maxLogBytes: 2_000_000,
    headersJson: '',
    noZip: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    const next = argv[i + 1];
    if (item === '--base-url') {
      args.baseUrl = next || '';
      i += 1;
    } else if (item === '--workspace') {
      args.workspace = next || '';
      args.workspaceProvided = true;
      i += 1;
    } else if (item === '--log-dir') {
      if (next) args.logDirs.push(next);
      i += 1;
    } else if (item === '--session-id') {
      args.sessionId = next || '';
      i += 1;
    } else if (item === '--output-dir') {
      args.outputDir = next || '';
      i += 1;
    } else if (item === '--since-minutes') {
      args.sinceMinutes = Number(next || args.sinceMinutes);
      i += 1;
    } else if (item === '--max-log-bytes') {
      args.maxLogBytes = Number(next || args.maxLogBytes);
      i += 1;
    } else if (item === '--headers-json') {
      args.headersJson = next || '';
      i += 1;
    } else if (item === '--no-zip') {
      args.noZip = true;
    } else if (item === '--help' || item === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/collect-debug-info.js --base-url http://127.0.0.1:53721 [options]

Options:
  --workspace <path>       Optional local DPAgent install/log root. Not assumed by default.
  --log-dir <path>         Optional explicit local log directory. Can be repeated.
  --session-id <id>        Session id to collect detailed state for.
  --output-dir <path>      Output parent directory. Default: OS temp dpagent-debug-bundles.
  --since-minutes <n>      Focus window hint for summary. Default: 180.
  --max-log-bytes <n>      Max bytes per log tail. Default: 2000000.
  --headers-json <json>    Extra HTTP headers, e.g. {"Cookie":"..."}.
  --no-zip                 Skip zip creation.
`);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}

function redact(input) {
  let text = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...matches) => {
      if (pattern.source.includes('dpagent-share')) {
        return `${matches[1]}[REDACTED]`;
      }
      const prefix = matches[1] || '';
      const bearer = matches[2] && String(matches[2]).startsWith('Bearer') ? matches[2] : '';
      return `${prefix}${bearer}[REDACTED]`;
    });
  }
  return text;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, redact(String(content ?? '')), 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function parseHeaders(headersJson) {
  if (!headersJson) return {};
  try {
    const parsed = JSON.parse(headersJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return { __parseError: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

async function fetchJson(baseUrl, endpoint, headers) {
  const url = `${baseUrl}${endpoint}`;
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text
    }
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      url,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readFileTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function collectLogs(input, outDir, maxLogBytes) {
  const { workspace, explicitLogDirs, runtimeInfo } = input;
  const runtimeBody = runtimeInfo && typeof runtimeInfo.body === 'object' ? runtimeInfo.body : {};
  const candidates = [
    ...explicitLogDirs,
    workspace ? path.join(workspace, 'logs') : '',
    path.join(process.cwd(), 'logs'),
    runtimeBody.cwd ? path.join(String(runtimeBody.cwd), 'logs') : '',
    runtimeBody.packageRoot ? path.join(String(runtimeBody.packageRoot), 'logs') : '',
    runtimeBody.configPath ? path.join(path.dirname(String(runtimeBody.configPath)), 'logs') : '',
  ];
  const logDirs = Array.from(new Set(candidates.filter((dir) => fs.existsSync(dir))));
  const copied = [];
  const focused = [];
  for (const logDir of logDirs) {
    for (const name of DEFAULT_LOG_FILES) {
      const filePath = path.join(logDir, name);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const tail = readFileTail(filePath, maxLogBytes);
      const outputName = `${safeFilePart(path.basename(logDir))}-${name}.tail.log`;
      const outputPath = path.join(outDir, 'logs', outputName);
      writeText(outputPath, tail);
      copied.push({ source: filePath, output: outputPath, bytes: fs.statSync(filePath).size });
      const lines = tail.split(/\r?\n/);
      for (const line of lines) {
        if (FOCUS_PATTERNS.some((pattern) => pattern.test(line))) {
          focused.push(`[${name}] ${line}`);
        }
      }
    }
  }
  writeText(path.join(outDir, 'logs', 'focused-findings.log'), focused.join('\n'));
  return { logDirs, copied, focusedCount: focused.length };
}

function runCommand(name, command, args, outDir) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    writeText(path.join(outDir, 'process', `${name}.txt`), output);
    return { name, ok: true };
  } catch (error) {
    const output = [
      `command: ${command} ${args.join(' ')}`,
      `error: ${error instanceof Error ? error.message : String(error)}`,
      error.stdout ? `stdout:\n${error.stdout}` : '',
      error.stderr ? `stderr:\n${error.stderr}` : '',
    ].filter(Boolean).join('\n');
    writeText(path.join(outDir, 'process', `${name}.txt`), output);
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function collectProcessInfo(baseUrl, outDir) {
  const results = [];
  let port = '';
  try {
    port = new URL(baseUrl).port;
  } catch {
    // ignore
  }
  if (process.platform === 'win32') {
    if (port) {
      results.push(runCommand(`netstat-port-${port}`, 'netstat.exe', ['-ano'], outDir));
      results.push(runCommand(`powershell-tcp-${port}`, 'powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Format-List *`,
      ], outDir));
    }
    results.push(runCommand('tasklist-node', 'tasklist.exe', ['/FI', 'IMAGENAME eq node.exe', '/V'], outDir));
    results.push(runCommand('powershell-node-processes', 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "name = \'node.exe\'" | Select-Object ProcessId,CommandLine | Format-List',
    ], outDir));
  } else {
    if (port) {
      results.push(runCommand(`lsof-port-${port}`, 'sh', ['-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN || true`], outDir));
    }
    results.push(runCommand('ps-node', 'sh', ['-lc', 'ps aux | grep node | grep -v grep || true'], outDir));
  }
  return { port, commands: results };
}

function collectPackageInfo(workspace, outDir) {
  const info = {
    cwd: process.cwd(),
    workspace,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    userInfo: (() => {
      try {
        const user = os.userInfo();
        return { username: user.username, homedir: user.homedir };
      } catch {
        return null;
      }
    })(),
    package: null,
    git: {},
  };
  const packagePath = path.join(workspace, 'package.json');
  if (fs.existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      info.package = { name: pkg.name, version: pkg.version };
    } catch (error) {
      info.package = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const [key, command] of Object.entries({
    branch: 'git branch --show-current',
    head: 'git rev-parse HEAD',
    status: 'git status --short --branch',
  })) {
    try {
      info.git[key] = execSync(command, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
    } catch {
      // not a git workspace
    }
  }
  writeJson(path.join(outDir, 'system', 'package-and-git.json'), info);
  return info;
}

function createZip(outDir) {
  const zipPath = `${outDir}.zip`;
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${outDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    } else {
      execFileSync('zip', ['-r', zipPath, path.basename(outDir)], {
        cwd: path.dirname(outDir),
        encoding: 'utf8',
        timeout: 120_000,
      });
    }
    return zipPath;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const workspace = args.workspace ? path.resolve(args.workspace) : '';
  const outputRoot = path.resolve(
    args.outputDir ||
      (workspace ? path.join(workspace, 'debug-bundles') : path.join(os.tmpdir(), 'dpagent-debug-bundles'))
  );
  const outDir = path.join(outputRoot, `dpagent-debug-info-${timestampSlug()}`);
  fs.mkdirSync(outDir, { recursive: true });

  const headers = parseHeaders(args.headersJson);
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    workspace: workspace || null,
    collectorCwd: process.cwd(),
    sessionId: args.sessionId || '',
    sinceMinutes: args.sinceMinutes,
    outputDir: outDir,
    zipPath: null,
    warnings: [],
    http: {},
    logs: null,
    process: null,
    system: null,
  };

  if (headers.__parseError) {
    summary.warnings.push(`headers-json parse failed: ${headers.__parseError}`);
    delete headers.__parseError;
  }

  summary.system = collectPackageInfo(workspace || process.cwd(), outDir);
  summary.process = collectProcessInfo(baseUrl, outDir);

  if (!baseUrl) {
    summary.warnings.push('base-url was not provided; HTTP probes skipped.');
  } else {
    const endpoints = [
      ['/api/health', 'health'],
      ['/api/system/runtime-info', 'runtime-info'],
      ['/api/settings', 'settings'],
      ['/api/sessions', 'sessions'],
    ];
    if (args.sessionId) {
      const id = encodeURIComponent(args.sessionId);
      endpoints.push(
        [`/api/sessions/${id}`, 'session-detail'],
        [`/api/sessions/${id}/share`, 'session-share'],
        [`/api/sessions/${id}/autoloop`, 'session-autoloop'],
        [`/api/sessions/${id}/subagents`, 'session-subagents']
      );
    }
    for (const [endpoint, name] of endpoints) {
      const result = await fetchJson(baseUrl, endpoint, headers);
      summary.http[name] = {
        ok: result.ok,
        status: result.status,
        durationMs: result.durationMs,
        error: result.error,
      };
      writeJson(path.join(outDir, 'http', `${name}.json`), result);
      if (!result.ok) {
        summary.warnings.push(`HTTP probe failed: ${endpoint} status=${result.status} ${result.error || ''}`.trim());
      }
    }
  }

  const runtimeInfo = summary.http['runtime-info']
    ? JSON.parse(fs.readFileSync(path.join(outDir, 'http', 'runtime-info.json'), 'utf8'))
    : null;
  summary.logs = collectLogs(
    {
      workspace,
      explicitLogDirs: args.logDirs.map((item) => path.resolve(item)),
      runtimeInfo,
    },
    outDir,
    Math.max(10_000, Number(args.maxLogBytes) || 2_000_000)
  );

  if (!args.noZip) {
    summary.zipPath = createZip(outDir);
    if (!summary.zipPath) {
      summary.warnings.push('zip creation failed; use outputDir directly.');
    }
  }
  writeJson(path.join(outDir, 'summary.json'), summary);
  console.log(JSON.stringify({
    success: true,
    outputDir: outDir,
    zipPath: summary.zipPath,
    warnings: summary.warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    success: false,
    error: {
      code: 'COLLECT_DEBUG_INFO_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }, null, 2));
  process.exit(1);
});
