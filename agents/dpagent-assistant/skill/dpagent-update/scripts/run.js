#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PACKAGE_NAME = '@dpvr/dpagent';
const DEFAULT_REGISTRY = process.env.DPAGENT_NPM_REGISTRY || 'https://registry.npmjs.org';
const DEFAULT_BASE_URL = process.env.DPAGENT_BASE_URL || `http://127.0.0.1:${process.env.DPAGENT_PORT || '53721'}`;

const COMMANDS = {
  schema: { write: false, summary: 'Return CLI command and payload schema.' },
  describe: { write: false, summary: 'Describe one command or the whole CLI.' },
  diagnose: { write: false, summary: 'Fetch /api/system/runtime-info.' },
  plan: { write: false, summary: 'Build an update plan without side effects.' },
  start: { write: true, summary: 'Start detached update worker, then request server shutdown.' },
  status: { write: false, summary: 'Read a detached worker status file.' },
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq >= 0) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function boolFlag(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function readJson(value) {
  if (!value) return {};
  const raw = String(value);
  const text = raw.startsWith('@')
    ? fs.readFileSync(path.resolve(raw.slice(1)), 'utf8')
    : raw;
  return JSON.parse(text);
}

function schema() {
  return {
    name: 'dpagent-update',
    commands: COMMANDS,
    auth: {
      baseUrl: 'DPAGENT_BASE_URL or --base-url',
      cookie: 'DPAGENT_SESSION_COOKIE or --cookie',
      password: 'DPAGENT_PASSWORD or --password, used through /api/auth/login',
    },
    globalFlags: {
      '--base-url': 'DPAgent server URL. Defaults to loopback port 53721.',
      '--json': 'Raw JSON string or @file. Flags override JSON fields.',
      '--output': 'json, ndjson, or text. Defaults to json.',
      '--fields': 'Comma-separated top-level or dotted fields to return.',
      '--dry-run': 'Build the update plan without shutdown/install/restart.',
      '--confirm': 'Must be yes for non-dry-run start.',
      '--target-version': 'Package version or latest.',
      '--registry': 'npm registry URL.',
      '--allow-source': 'Allow update attempt from source checkout.',
      '--status-file': 'Read worker status JSON.',
      '--approval-timeout-ms': 'Worker waits this long for accepted shutdown before refusing to install.',
    },
  };
}

function pickFields(value, fields) {
  if (!fields) return value;
  const output = {};
  for (const rawField of String(fields).split(',')) {
    const field = rawField.trim();
    if (!field) continue;
    const parts = field.split('.');
    let source = value;
    let target = output;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (source == null || !Object.prototype.hasOwnProperty.call(source, part)) break;
      if (i === parts.length - 1) {
        target[part] = source[part];
      } else {
        target[part] = target[part] || {};
        target = target[part];
        source = source[part];
      }
    }
  }
  return output;
}

function stringifyPayload(payload, output) {
  return output === 'text' ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

function emit(payload, flags) {
  const selected = pickFields(payload, flags.fields);
  const output = flags.output || 'json';
  process.stdout.write(`${stringifyPayload(selected, output)}\n`);
}

function error(code, message, details) {
  const err = new Error(message);
  err.payload = { success: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
  return err;
}

function describeCommand(target) {
  if (target && !COMMANDS[target]) {
    throw error('UNKNOWN_COMMAND', `Unknown command: ${target}`, { commands: Object.keys(COMMANDS) });
  }
  return target ? { name: target, ...COMMANDS[target] } : schema();
}

function quoteWindowsShellArg(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_/:@.+-]+$/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '\\"')}"`;
}

function resolveNpmInvocation(npmArgs) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, args: [candidate, ...npmArgs], shell: false };
    }
  }
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...npmArgs.map(quoteWindowsShellArg)].join(' ')],
      shell: false,
    };
  }
  return { command: 'npm', args: npmArgs, shell: false };
}

async function login(baseUrl, flags) {
  const existing = flags.cookie || process.env.DPAGENT_SESSION_COOKIE;
  if (existing) return existing;
  const password = flags.password || process.env.DPAGENT_PASSWORD;
  if (!password) return '';
  const response = await fetch(new URL('/api/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw error('AUTH_FAILED', `Login failed with HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw error('AUTH_COOKIE_MISSING', 'Login succeeded but no session cookie was returned.');
  return cookie;
}

async function requestJson(baseUrl, flags, method, route, body, extraHeaders) {
  const cookie = await login(baseUrl, flags);
  const headers = { accept: 'application/json', ...(extraHeaders || {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw error('HTTP_ERROR', `HTTP ${response.status} from ${route}`, payload);
  return payload;
}

function npmLatestVersion(registry) {
  const npm = resolveNpmInvocation(['view', `${PACKAGE_NAME}@latest`, 'version', '--registry', registry]);
  const result = spawnSync(npm.command, npm.args, {
    encoding: 'utf8',
    shell: npm.shell,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw error('NPM_VIEW_FAILED', 'Failed to resolve latest DPAgent version.', {
      stderr: (result.stderr || '').trim(),
    });
  }
  return (result.stdout || '').trim();
}

function findNodeModulesAppRoot(packageRoot) {
  const parts = path.resolve(packageRoot).split(path.sep);
  const index = parts.map((part) => part.toLowerCase()).lastIndexOf('node_modules');
  if (index <= 0) return path.resolve(packageRoot);
  return parts.slice(0, index).join(path.sep) || path.parse(packageRoot).root;
}

function buildPlan(runtimeInfo, flags, payload) {
  const registry = flags.registry || payload.registry || DEFAULT_REGISTRY;
  const requested = flags['target-version'] || payload.targetVersion || 'latest';
  const targetVersion = requested === 'latest' ? npmLatestVersion(registry) : String(requested);
  const allowSource = boolFlag(flags['allow-source']) || payload.allowSource === true;
  if (runtimeInfo.installMode === 'source' && !allowSource) {
    throw error('UNSUPPORTED_INSTALL_MODE', 'Source checkout update is refused unless --allow-source true is supplied.', {
      installMode: runtimeInfo.installMode,
      packageRoot: runtimeInfo.packageRoot,
    });
  }
  const appRoot = runtimeInfo.installMode === 'npm-local'
    ? findNodeModulesAppRoot(runtimeInfo.packageRoot)
    : runtimeInfo.packageRoot;
  const statusFile = path.resolve(
    flags['status-file'] || payload.statusFile || path.join(os.tmpdir(), `dpagent-update-${runtimeInfo.pid}-${Date.now()}.json`)
  );
  const approvalFile = path.resolve(
    payload.approvalFile || path.join(os.tmpdir(), `dpagent-update-approval-${runtimeInfo.pid}-${Date.now()}.json`)
  );
  return {
    packageName: PACKAGE_NAME,
    currentVersion: runtimeInfo.version,
    targetVersion,
    registry,
    baseUrl: flags['base-url'] || DEFAULT_BASE_URL,
    configPath: runtimeInfo.configPath,
    port: runtimeInfo.port,
    packageRoot: runtimeInfo.packageRoot,
    appRoot,
    installMode: runtimeInfo.installMode,
    packageManager: runtimeInfo.packageManager || 'npm',
    statusFile,
    approvalFile,
    approvalTimeoutMs: Number(flags['approval-timeout-ms'] || payload.approvalTimeoutMs || 30000),
    waitForStopMs: Number(flags['wait-for-stop-ms'] || payload.waitForStopMs || 60000),
    waitForStartMs: Number(flags['wait-for-start-ms'] || payload.waitForStartMs || 120000),
  };
}

function workerSource() {
  return `
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const plan = JSON.parse(process.argv[2]);
function quoteWindowsShellArg(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_/:@.+-]+$/.test(raw)) return raw;
  return '"' + raw.replace(/"/g, '\\\\"') + '"';
}
function resolveNpmInvocation(npmArgs) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, args: [candidate].concat(npmArgs), shell: false };
    }
  }
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm'].concat(npmArgs.map(quoteWindowsShellArg)).join(' ')],
      shell: false
    };
  }
  return { command: 'npm', args: npmArgs, shell: false };
}
function write(status, extra) {
  fs.mkdirSync(path.dirname(plan.statusFile), { recursive: true });
  fs.writeFileSync(plan.statusFile, JSON.stringify({ status, updatedAt: new Date().toISOString(), plan, ...(extra || {}) }, null, 2));
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitApproval() {
  const deadline = Date.now() + Math.max(1000, plan.approvalTimeoutMs || 30000);
  while (Date.now() < deadline) {
    if (fs.existsSync(plan.approvalFile)) return true;
    await sleep(500);
  }
  return false;
}
async function waitDown() {
  const deadline = Date.now() + Math.max(1000, plan.waitForStopMs);
  while (Date.now() < deadline) {
    try {
      await fetch(new URL('/api/health', plan.baseUrl));
      await sleep(1000);
    } catch {
      return true;
    }
  }
  return false;
}
async function waitUp() {
  const deadline = Date.now() + Math.max(1000, plan.waitForStartMs);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL('/api/health', plan.baseUrl));
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}
(async () => {
  try {
    write('waiting_for_shutdown_approval');
    const approved = await waitApproval();
    if (!approved) {
      write('shutdown_not_approved');
      process.exit(3);
    }
    write('waiting_for_shutdown');
    const stopped = await waitDown();
    if (!stopped) {
      write('shutdown_timeout');
      process.exit(4);
    }
    write('installing');
    const spec = plan.targetVersion ? plan.packageName + '@' + plan.targetVersion : plan.packageName + '@latest';
    const npm = resolveNpmInvocation(['install', spec, '--registry', plan.registry]);
    const install = spawnSync(npm.command, npm.args, {
      cwd: plan.appRoot,
      encoding: 'utf8',
      shell: npm.shell,
      windowsHide: true,
    });
    if (install.status !== 0) {
      write('install_failed', {
        error: install.error && install.error.message ? install.error.message : undefined,
        stderr: (install.stderr || '').trim(),
        stdout: (install.stdout || '').trim()
      });
      process.exit(1);
    }
    write('restarting');
    const cliPath = path.join(plan.appRoot, 'node_modules', '@dpvr', 'dpagent', 'dist', 'cli', 'dpagent.js');
    const child = spawn(process.execPath, [cliPath, '--no-open'], {
      cwd: plan.appRoot,
      env: { ...process.env, DPAGENT_CONFIG_PATH: plan.configPath, DPAGENT_PORT: String(plan.port) },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const healthy = await waitUp();
    write(healthy ? 'complete' : 'restart_unverified', { restartPid: child.pid });
    process.exit(healthy ? 0 : 2);
  } catch (err) {
    write('failed', { error: err && err.message ? err.message : String(err) });
    process.exit(1);
  }
})();`;
}

function startWorker(plan) {
  const workerPath = path.join(os.tmpdir(), `dpagent-update-worker-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(workerPath, workerSource(), 'utf8');
  const child = spawn(process.execPath, [workerPath, JSON.stringify(plan)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { workerPath, workerPid: child.pid };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0] || 'schema';
  const baseUrl = flags['base-url'] || DEFAULT_BASE_URL;
  if (!COMMANDS[command]) throw error('UNKNOWN_COMMAND', `Unknown command: ${command}`, { commands: Object.keys(COMMANDS) });
  if (command === 'schema') {
    emit({ success: true, command, data: schema() }, flags);
    return;
  }
  if (command === 'describe') {
    emit({ success: true, command, data: describeCommand(flags._[1]) }, flags);
    return;
  }
  if (command === 'status') {
    const statusFile = flags['status-file'];
    if (!statusFile) throw error('STATUS_FILE_REQUIRED', '--status-file is required.');
    const data = JSON.parse(fs.readFileSync(path.resolve(statusFile), 'utf8'));
    emit({ success: true, command, data }, flags);
    return;
  }
  const runtimeInfo = await requestJson(baseUrl, flags, 'GET', '/api/system/runtime-info');
  if (command === 'diagnose') {
    emit({ success: true, command, data: runtimeInfo, meta: { baseUrl } }, flags);
    return;
  }
  const payload = readJson(flags.json);
  const plan = buildPlan(runtimeInfo, flags, payload);
  if (command === 'plan' || boolFlag(flags['dry-run'])) {
    emit({ success: true, command, data: plan, meta: { dryRun: true } }, flags);
    return;
  }
  if (command === 'start') {
    if (flags.confirm !== 'yes') throw error('CONFIRM_REQUIRED', 'confirm must be "yes" for non-dry-run update.');
    const worker = startWorker(plan);
    try {
      await requestJson(
        baseUrl,
        flags,
        'POST',
        '/api/system/shutdown',
        { delayMs: 500, reason: 'dpagent-update skill' },
        { 'x-dpagent-shutdown-confirm': 'yes' }
      );
      fs.mkdirSync(path.dirname(plan.approvalFile), { recursive: true });
      fs.writeFileSync(plan.approvalFile, JSON.stringify({ acceptedAt: new Date().toISOString() }), 'utf8');
    } catch (err) {
      throw error('SHUTDOWN_REQUEST_FAILED', 'Shutdown request failed; update worker will not install.', {
        worker,
        statusFile: plan.statusFile,
        cause: err && err.payload ? err.payload : err instanceof Error ? err.message : String(err),
      });
    }
    emit({ success: true, command, data: { ...plan, ...worker }, meta: { shutdownRequested: true } }, flags);
  }
}

main().catch((err) => {
  const payload = err && err.payload
    ? err.payload
    : { success: false, error: { code: 'UNEXPECTED_ERROR', message: err instanceof Error ? err.message : String(err) } };
  emit(payload, parseArgs(process.argv.slice(2)));
  process.exitCode = 1;
});
