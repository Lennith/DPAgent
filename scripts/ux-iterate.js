#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const net = require('net');
const yaml = require('js-yaml');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const ROOT = process.cwd();
const DEFAULT_PORT = 53721;
const DEFAULT_ROUNDS = 10;
const DEFAULT_PROMPTS_PER_ROUND = 6;
const DEFAULT_MODE = 'standard';
const DEFAULT_UI_FOCUSED_ROUNDS = 50;
const DEFAULT_UI_FOCUSED_PROMPTS_PER_ROUND = 5;
const DEFAULT_UI_FOCUSED_MIN_ROUNDS = 30;
const DEFAULT_UI_FOCUSED_MAX_ROUNDS = 150;
const DEFAULT_UI_FOCUSED_RUN_HOURS = 8;
const DEFAULT_UX_ROOT = path.join(ROOT, 'ux-workspace');
const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
const DEFAULT_CHAT_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_LONG_CONTEXT_ROUNDS = 2;
const DEFAULT_LONG_CONTEXT_PROMPTS_PER_ROUND = 20;
const DEFAULT_LONG_OUTPUT_MIN_CHARS = 40000;
const DEFAULT_VISUAL_AUDIT_MIN_SCREENSHOTS = 5;

const SEVERITY_RANK = {
  blocker: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const lowered = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(lowered)) {
    return true;
  }
  if (['0', 'false', 'no'].includes(lowered)) {
    return false;
  }
  return fallback;
}

function readPositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, 'true');
    }
  }

  const modeRaw = String(map.get('mode') || DEFAULT_MODE).trim().toLowerCase();
  let mode = DEFAULT_MODE;
  if (modeRaw === 'long-context') {
    mode = 'long-context';
  } else if (modeRaw === 'ui-focused') {
    mode = 'ui-focused';
  }
  const longContextRounds = readPositiveInt(map.get('long-context-rounds') || DEFAULT_LONG_CONTEXT_ROUNDS, DEFAULT_LONG_CONTEXT_ROUNDS);
  const longContextPromptsPerRound = readPositiveInt(
    map.get('long-context-prompts-per-round') || DEFAULT_LONG_CONTEXT_PROMPTS_PER_ROUND,
    DEFAULT_LONG_CONTEXT_PROMPTS_PER_ROUND
  );
  const longOutputMinChars = readPositiveInt(
    map.get('long-output-min-chars') || DEFAULT_LONG_OUTPUT_MIN_CHARS,
    DEFAULT_LONG_OUTPUT_MIN_CHARS
  );
  const roundsDefault = mode === 'long-context'
    ? longContextRounds
    : (mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_ROUNDS : DEFAULT_ROUNDS);
  const promptsDefault = mode === 'long-context'
    ? longContextPromptsPerRound
    : (mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_PROMPTS_PER_ROUND : DEFAULT_PROMPTS_PER_ROUND);
  const roundsRaw = readPositiveInt(map.get('rounds') || roundsDefault, roundsDefault);
  const startRound = readPositiveInt(map.get('start-round') || 1, 1);
  const promptsPerRoundRaw = readPositiveInt(map.get('prompts-per-round') || promptsDefault, promptsDefault);
  const minRounds = readPositiveInt(
    map.get('min-rounds') || (mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_MIN_ROUNDS : 1),
    mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_MIN_ROUNDS : 1
  );
  const maxRoundsRaw = readPositiveInt(
    map.get('max-rounds') || (mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_MAX_ROUNDS : roundsRaw),
    mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_MAX_ROUNDS : roundsRaw
  );
  const runHours = Number.parseFloat(String(map.get('run-hours') || (mode === 'ui-focused' ? DEFAULT_UI_FOCUSED_RUN_HOURS : 0)));
  const visualAuditMinScreenshots = readPositiveInt(
    map.get('visual-audit-min-screenshots') || DEFAULT_VISUAL_AUDIT_MIN_SCREENSHOTS,
    DEFAULT_VISUAL_AUDIT_MIN_SCREENSHOTS
  );
  const port = Number.parseInt(String(map.get('port') || DEFAULT_PORT), 10);
  const promptTimeoutMs = Number.parseInt(String(map.get('prompt-timeout-ms') || DEFAULT_PROMPT_TIMEOUT_MS), 10);
  const chatTimeoutMs = Number.parseInt(String(map.get('chat-timeout-ms') || DEFAULT_CHAT_TIMEOUT_MS), 10);
  const uxRoot = path.resolve(String(map.get('ux-root') || DEFAULT_UX_ROOT));
  const defaultIterationsRoot = path.join(
    uxRoot,
    mode === 'long-context'
      ? 'iterations-long-context'
      : (mode === 'ui-focused' ? 'iterations-ui-focused' : 'iterations')
  );

  const normalizedMinRounds = Math.max(1, minRounds);
  const normalizedMaxRounds = Math.max(normalizedMinRounds, maxRoundsRaw);
  const normalizedRounds = mode === 'ui-focused'
    ? Math.max(normalizedMinRounds, Math.min(roundsRaw, normalizedMaxRounds))
    : Math.max(1, roundsRaw);
  const normalizedPromptsPerRound = mode === 'ui-focused'
    ? Math.max(DEFAULT_UI_FOCUSED_PROMPTS_PER_ROUND, promptsPerRoundRaw)
    : Math.max(1, promptsPerRoundRaw);

  return {
    mode,
    rounds: normalizedRounds,
    startRound: Number.isFinite(startRound) ? Math.max(1, startRound) : 1,
    promptsPerRound: normalizedPromptsPerRound,
    minRounds: normalizedMinRounds,
    maxRounds: normalizedMaxRounds,
    runHours: Number.isFinite(runHours) && runHours > 0 ? runHours : 0,
    visualAuditMinScreenshots: Number.isFinite(visualAuditMinScreenshots)
      ? Math.max(1, visualAuditMinScreenshots)
      : DEFAULT_VISUAL_AUDIT_MIN_SCREENSHOTS,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    uxRoot,
    expectExisting: parseBoolean(map.get('expect-existing'), true),
    headless: parseBoolean(map.get('headless'), true),
    promptTimeoutMs: Number.isFinite(promptTimeoutMs) ? promptTimeoutMs : DEFAULT_PROMPT_TIMEOUT_MS,
    chatTimeoutMs: Number.isFinite(chatTimeoutMs) ? chatTimeoutMs : DEFAULT_CHAT_TIMEOUT_MS,
    applyFixes: parseBoolean(map.get('apply-fixes'), true),
    runSmoke: parseBoolean(map.get('run-smoke'), true),
    longContextRounds,
    longContextPromptsPerRound,
    longOutputMinChars,
    iterationsRoot: path.resolve(String(map.get('iterations-root') || defaultIterationsRoot)),
    repoWorkspace: path.resolve(String(map.get('repo-workspace') || ROOT)),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${String(text || '')}\n`, 'utf8');
}

function copyFileSafe(src, dest) {
  if (!src || !fs.existsSync(src)) {
    return false;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSeverity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'blocker' || raw === 'critical' || raw === 'p0') {
    return 'blocker';
  }
  if (raw === 'high' || raw === 'p1') {
    return 'high';
  }
  if (raw === 'medium' || raw === 'p2') {
    return 'medium';
  }
  return 'low';
}

function pickHigherSeverity(a, b) {
  const ra = SEVERITY_RANK[normalizeSeverity(a)] ?? 0;
  const rb = SEVERITY_RANK[normalizeSeverity(b)] ?? 0;
  return ra >= rb ? normalizeSeverity(a) : normalizeSeverity(b);
}

function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 6) {
    return '***';
  }
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function tryReadYaml(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readApiKeyFromYaml(filePath) {
  const parsed = tryReadYaml(filePath);
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }
  const api = parsed.api;
  if (!api || typeof api !== 'object') {
    return '';
  }
  return String(api.apiKey || '').trim();
}

function readApiKeyFromEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/^\s*MINIMAX_API_KEY\s*=\s*([^\r\n#]+)/im);
  if (!match) {
    return '';
  }
  return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
}

function scoreApiKey(source, key) {
  let score = Math.min(300, String(key).length);
  if (String(key).length >= 60) {
    score += 80;
  }
  if (/test|example|fake|placeholder|your_api_key/i.test(String(key))) {
    score -= 300;
  }
  if (source.includes('env:UX_API_KEY')) {
    score += 60;
  }
  if (source.includes(`${path.sep}config.yaml`)) {
    score += 20;
  }
  return score;
}

function resolveApiKey(args) {
  const candidates = [];
  const push = (source, value) => {
    const key = String(value || '').trim();
    if (!key) {
      return;
    }
    candidates.push({ source, key, score: scoreApiKey(source, key) });
  };

  push('env:UX_API_KEY', process.env.UX_API_KEY);
  push('env:MINIMAX_API_KEY', process.env.MINIMAX_API_KEY);
  push(`yaml:${path.join(args.uxRoot, 'config.yaml')}`, readApiKeyFromYaml(path.join(args.uxRoot, 'config.yaml')));
  push(`yaml:${path.join(ROOT, 'config.yaml')}`, readApiKeyFromYaml(path.join(ROOT, 'config.yaml')));
  push(`envfile:${path.join(ROOT, '.env')}`, readApiKeyFromEnvFile(path.join(ROOT, '.env')));

  if (candidates.length === 0) {
    throw new Error('No API key available. Set UX_API_KEY/MINIMAX_API_KEY or api.apiKey in config.yaml.');
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0];
  if (!selected || selected.key.length < 20) {
    throw new Error('API key candidates found but none passes validity check (length>=20).');
  }
  return selected;
}
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

async function waitForHttpReady(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(500);
  }
  throw new Error(`HTTP readiness timeout: ${url} (${lastError})`);
}

async function stopChildProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: false,
    });
    await new Promise((resolve) => {
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2000);
  });
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      shell: options.shell === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.streamOutput) {
        process.stdout.write(text);
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.streamOutput) {
        process.stderr.write(text);
      }
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function hasRunnableStaticClient(clientDir) {
  if (!clientDir || !fs.existsSync(clientDir)) {
    return false;
  }
  const indexPath = path.join(clientDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return false;
  }
  try {
    const html = fs.readFileSync(indexPath, 'utf8');
    return !html.includes('main.tsx');
  } catch {
    return false;
  }
}

async function ensureWebClientBuild() {
  const clientDir = path.join(ROOT, 'dist', 'web', 'client');
  if (hasRunnableStaticClient(clientDir)) {
    return;
  }
  const viteCli = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteCli)) {
    throw new Error(`Vite CLI not found: ${viteCli}. Run npm install first.`);
  }
  console.log('[ux-iterate] static web client missing/incomplete, running vite build ...');
  const result = await runCommand(process.execPath, [viteCli, 'build', '--config', 'vite.config.mts'], {
    cwd: ROOT,
    streamOutput: true,
  });
  if (result.code !== 0) {
    throw new Error(`Failed to build web client (vite build), exit=${result.code}`);
  }
  if (!hasRunnableStaticClient(clientDir)) {
    throw new Error(`Web client is still not runnable after build: ${clientDir}`);
  }
}

async function ensureServer(args) {
  const occupied = await isPortInUse(args.port);
  const baseUrl = `http://127.0.0.1:${args.port}`;

  if (occupied) {
    if (!args.expectExisting) {
      throw new Error(
        `Port ${args.port} is already in use while expect-existing=false. Stop existing server or use another --port.`
      );
    }
    await waitForHttpReady(`${baseUrl}/api/settings`, 30000);
    return { usingExisting: true, child: null, baseUrl };
  }

  if (args.expectExisting) {
    throw new Error(`Expected existing dev server on port ${args.port}, but it is not running.`);
  }

  const cliEntry = path.join(ROOT, 'dist', 'cli', 'dpagent.js');
  if (!fs.existsSync(cliEntry)) {
    throw new Error('Missing dist/cli/dpagent.js. Run npm run build first.');
  }
  await ensureWebClientBuild();

  const child = spawn(process.execPath, [cliEntry, '--no-open'], {
    cwd: args.uxRoot,
    env: { ...process.env, DPAGENT_PORT: String(args.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk.toString()));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk.toString()));

  await waitForHttpReady(`${baseUrl}/api/settings`, 40000);
  return { usingExisting: false, child, baseUrl };
}

async function syncApiKeyToServer(baseUrl, apiKey) {
  const settingsResponse = await fetch(`${baseUrl}/api/settings`);
  if (!settingsResponse.ok) {
    throw new Error(`Failed to load settings before setting API key: HTTP ${settingsResponse.status}`);
  }
  const settings = await settingsResponse.json();
  const profiles = Array.isArray(settings?.llmProfiles?.profiles) ? settings.llmProfiles.profiles : [];
  const defaultProfileId = String(settings?.llmProfiles?.defaultProfileId || profiles[0]?.id || 'default');
  const nextProfiles = profiles.map((profile) => ({
    id: String(profile?.id || defaultProfileId),
    name: String(profile?.name || profile?.id || defaultProfileId),
    provider: profile?.provider,
    apiBase: profile?.apiBase,
    defaultModel: profile?.defaultModel,
    maxOutputTokens: profile?.maxOutputTokens,
    contextWindowTokens: profile?.contextWindowTokens,
    enabled: profile?.enabled !== false,
    capabilities: profile?.capabilities,
    apiKey: String(profile?.id || '') === defaultProfileId ? apiKey : undefined,
  }));
  if (!nextProfiles.some((profile) => profile.id === defaultProfileId)) {
    nextProfiles.push({
      id: defaultProfileId,
      name: defaultProfileId,
      provider: 'anthropic',
      apiBase: 'https://api.minimax.io',
      defaultModel: 'MiniMax-M2.5',
      enabled: true,
      apiKey,
    });
  }
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      defaultProfileId,
      profiles: nextProfiles,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to set API key: HTTP ${response.status} ${text}`);
  }
}

function createDynamicScenario(round, promptsPerRound, ledger) {
  const unresolved = [...ledger.items]
    .filter((item) => String(item.status || '').toLowerCase() !== 'closed')
    .sort((a, b) => (SEVERITY_RANK[normalizeSeverity(b.severity)] ?? 0) - (SEVERITY_RANK[normalizeSeverity(a.severity)] ?? 0));

  const unresolvedSummary = unresolved
    .slice(0, 3)
    .map((item) => `${item.req_id}(${item.severity}): ${item.title}`)
    .join('; ');

  const prompts = [
    {
      id: `round${round}-open-exploration`,
      text: [
        'You are a strict UX researcher. Pick one direction worth deep investigation.',
        'Return why it matters, how to validate it, and first risk seen now.',
      ].join('\n'),
      note: 'reason=open exploration; goal=establish round focus',
    },
    {
      id: `round${round}-subagent-collab-1`,
      text: [
        'Mandatory: call subagent_manage and create at least 2 parallel sub-agents.',
        'Sub-agent A: context continuity and long-chat stability.',
        'Sub-agent B: UI clarity and interaction friction.',
        'Wait both and return top-2 findings from each.',
      ].join('\n'),
      note: 'reason=subagent parallel validation; goal=cover subagent collaboration',
    },
    {
      id: `round${round}-ui-focus`,
      text: [
        'Focus on UI now: layout readability, discoverability, and interaction feedback.',
        'Provide 3 UI issues with evidence and minimum fix action.',
      ].join('\n'),
      note: 'reason=ui quality focus; goal=force UI issue discovery',
    },
    {
      id: `round${round}-context-focus`,
      text: [
        'Check context quality: loss, jumps, summary drift. Identify trigger path if found.',
        unresolvedSummary || 'No unresolved historical items.',
      ].join('\n'),
      note: 'reason=context quality check; goal=guard context behavior',
    },
    {
      id: `round${round}-subagent-collab-2`,
      text: [
        'Use subagent_manage again.',
        'Sub-agent A: error recovery path and messages.',
        'Sub-agent B: task completion efficiency.',
        'Mark mergeable vs net-new requirements in merged result.',
      ].join('\n'),
      note: 'reason=second subagent pass; goal=extract merge hints',
    },
    {
      id: `round${round}-priority-summary`,
      text: [
        'Return this round top-3 priorities with severity blocker/high/medium.',
        'Each item must contain evidence and a minimum viable fix.',
      ].join('\n'),
      note: 'reason=priority convergence; goal=feed implementation phase',
    },
  ];

  while (prompts.length < promptsPerRound) {
    prompts.push({
      id: `round${round}-extra-${prompts.length + 1}`,
      text: 'Add one high-value UX probe not yet covered and answer it.',
      note: 'reason=fill prompt budget; goal=keep fixed prompt count',
    });
  }

  return {
    name: `Round ${round} - Dynamic UX Iteration`,
    description: `Auto-generated scenario for round ${round}.`,
    prompts: prompts.slice(0, promptsPerRound).map((item) => ({ ...item, postWaitMs: 700 })),
  };
}

function createUiFocusedScenario(round, promptsPerRound, ledger) {
  const unresolved = [...ledger.items]
    .filter((item) => String(item.status || '').toLowerCase() !== 'closed')
    .sort((a, b) => (SEVERITY_RANK[normalizeSeverity(b.severity)] ?? 0) - (SEVERITY_RANK[normalizeSeverity(a.severity)] ?? 0))
    .slice(0, 5);

  const unresolvedLines = unresolved.length > 0
    ? unresolved.map((item) => `- ${item.req_id} [${item.severity}] ${item.title}`).join('\n')
    : '- None';

  const prompts = [
    {
      id: `round${round}-ui-regression-check`,
      text: [
        'You are a UX/UI reviewer. First verify unresolved UX items from previous rounds and state solved vs unsolved.',
        'Then perform one focused layout audit for current page hierarchy and spacing rhythm.',
        'Output concise checklist with evidence.',
        'Unresolved items:',
        unresolvedLines,
      ].join('\n'),
      note: 'phase=verify; goal=check previous fixes and layout baseline',
    },
    {
      id: `round${round}-ui-visual-hierarchy`,
      text: [
        'Focus on visual hierarchy and information density.',
        'Assess whether key information is concise but complete.',
        'List 3 improvements with severity and exact UI element references.',
      ].join('\n'),
      note: 'phase=visual; goal=hierarchy and density',
    },
    {
      id: `round${round}-ui-interaction-flow`,
      text: [
        'Focus on interaction flow: composer, send/cancel, quick actions, sidebar, and message readability.',
        'Identify friction points and propose interaction micro-adjustments.',
      ].join('\n'),
      note: 'phase=interaction; goal=flow friction analysis',
    },
    {
      id: `round${round}-ui-subagent-review`,
      text: [
        'Mandatory: call subagent_manage and create at least 2 sub-agents in parallel.',
        'Sub-agent A: visual layout and aesthetics.',
        'Sub-agent B: interaction usability and discoverability.',
        'Merge their findings and mark mergeable vs net-new requirements.',
      ].join('\n'),
      note: 'phase=parallel; goal=subagent visual/usability split review',
    },
    {
      id: `round${round}-ui-priority-plan`,
      text: [
        'Produce this round UI priority plan (blocker/high/medium).',
        'For each item include: symptom, evidence, proposed fix, and whether to implement now.',
      ].join('\n'),
      note: 'phase=plan; goal=actionable UI iteration plan',
    },
  ];

  while (prompts.length < promptsPerRound) {
    prompts.push({
      id: `round${round}-ui-extra-${prompts.length + 1}`,
      text: 'Add one extra UI usability probe and provide a concrete improvement proposal.',
      note: 'phase=extra; goal=keep prompt budget',
    });
  }

  return {
    name: `Round ${round} - UI Focused UX Iteration`,
    description: 'Frontend interaction and interface design focused UX iteration with screenshot-heavy evidence.',
    prompts: prompts.slice(0, promptsPerRound).map((item) => ({ ...item, postWaitMs: 700 })),
  };
}

function createLongContextScenario(round, promptsPerRound, longOutputMinChars) {
  const perPromptTarget = Math.max(1200, Math.floor(longOutputMinChars / Math.max(1, promptsPerRound)));
  const commonTail = [
    `Response length target: at least ${perPromptTarget} Chinese characters.`,
    'Use this structure: Executive summary + evidence table + risk matrix + action list.',
    'Keep the answer concrete, avoid generic filler.',
  ].join(' ');

  const prompts = [
    {
      id: `round${round}-lc-01-goal-frame`,
      text: `You are a UX long-context researcher. Define this round objective and success criteria for long-conversation UX under heavy output. ${commonTail}`,
      note: 'phase=setup; goal=objective framing',
    },
    {
      id: `round${round}-lc-02-memory-map`,
      text: `Build a memory map for this 20-turn session: key entities, constraints, open risks, and expected checkpoints. ${commonTail}`,
      note: 'phase=setup; goal=memory scaffolding',
    },
    {
      id: `round${round}-lc-03-web-search-a`,
      text: `Mandatory tool use: call web_search for long-context UX, context window overflow UX, and conversation continuity UX. Then synthesize patterns. ${commonTail}`,
      note: 'phase=research; goal=web_search batch A',
    },
    {
      id: `round${round}-lc-04-web-search-b`,
      text: `Mandatory tool use: call web_search for progressive disclosure UX, streaming feedback UX, and cancellation UX. Compare with previous findings. ${commonTail}`,
      note: 'phase=research; goal=web_search batch B',
    },
    {
      id: `round${round}-lc-05-web-fetch-a`,
      text: `Mandatory tool use: select 2 URLs from search results and call web_fetch. Extract concrete interaction patterns and failure cases. ${commonTail}`,
      note: 'phase=research; goal=web_fetch details A',
    },
    {
      id: `round${round}-lc-06-web-fetch-b`,
      text: `Mandatory tool use: call web_fetch on additional references and build a contradiction table vs earlier conclusions. ${commonTail}`,
      note: 'phase=research; goal=web_fetch details B',
    },
    {
      id: `round${round}-lc-07-write-initial`,
      text: `Mandatory tool use: create file ux_long_context_round_${round}_notes.md in workspace root using write_file, include full findings and checkpoints. Then summarize what was written. ${commonTail}`,
      note: 'phase=artifact; goal=file write',
    },
    {
      id: `round${round}-lc-08-edit-append`,
      text: `Mandatory tool use: update ux_long_context_round_${round}_notes.md with edit_file, append a section "Context Pressure Signals". Then report the exact appended section. ${commonTail}`,
      note: 'phase=artifact; goal=file edit',
    },
    {
      id: `round${round}-lc-09-state-check`,
      text: `Reconcile all previous outputs and list what should be remembered at turn 9. Include possible memory-loss symptoms and user-facing impact. ${commonTail}`,
      note: 'phase=stress; goal=memory retention check A',
    },
    {
      id: `round${round}-lc-10-state-check`,
      text: `Cross-check turn 2/4/6 conclusions without re-reading source files first. Then verify with tools and report drift deltas. ${commonTail}`,
      note: 'phase=stress; goal=memory retention check B',
    },
    {
      id: `round${round}-lc-11-subagent-a`,
      text: `Mandatory tool use: call subagent_manage and create 2 parallel subagents: A for context continuity, B for UI affordance under long chats. Wait for both and merge conclusions. ${commonTail}`,
      note: 'phase=parallel; goal=subagent pass A',
    },
    {
      id: `round${round}-lc-12-subagent-b`,
      text: `Mandatory tool use: run a second subagent pass for error recovery and progress feedback. Mark mergeable vs net-new concerns. ${commonTail}`,
      note: 'phase=parallel; goal=subagent pass B',
    },
    {
      id: `round${round}-lc-13-context-alerts`,
      text: `Focus on context usage progress bar and warnings. Propose concrete threshold behavior and copywriting for 70/80/90/95%. ${commonTail}`,
      note: 'phase=ux; goal=context alert UX',
    },
    {
      id: `round${round}-lc-14-cancel-flow`,
      text: `Focus on cancel/retry/resume UX in long tasks. Provide failure tree, expected state transitions, and anti-confusion microcopy. ${commonTail}`,
      note: 'phase=ux; goal=cancel flow',
    },
    {
      id: `round${round}-lc-15-composer-state`,
      text: `Evaluate composer/send button behavior under long-running and plan-input states. Provide deterministic UX rules and edge-case handling. ${commonTail}`,
      note: 'phase=ux; goal=composer consistency',
    },
    {
      id: `round${round}-lc-16-write-report`,
      text: `Mandatory tool use: write ux_long_context_round_${round}_report.md with top issues, severity, evidence, and fixes. Then return a compact table of file sections. ${commonTail}`,
      note: 'phase=artifact; goal=report write',
    },
    {
      id: `round${round}-lc-17-edit-report`,
      text: `Mandatory tool use: edit ux_long_context_round_${round}_report.md to add "Context Compression Before Trim Guard" section and verification checklist. ${commonTail}`,
      note: 'phase=artifact; goal=report edit',
    },
    {
      id: `round${round}-lc-18-regression-plan`,
      text: `Create a focused regression plan for long-context UX: include happy path, degraded path, overflow path, and recovery path. ${commonTail}`,
      note: 'phase=validation; goal=regression planning',
    },
    {
      id: `round${round}-lc-19-priority-converge`,
      text: `Converge to top priorities with blocker/high/medium labels and implementation slices that do not break architecture boundaries. ${commonTail}`,
      note: 'phase=converge; goal=priority convergence',
    },
    {
      id: `round${round}-lc-20-final`,
      text: `Produce final round summary: what improved, what regressed, what remains risky in long-context UX. Include explicit references to artifacts created in workspace. ${commonTail}`,
      note: 'phase=final; goal=round close',
    },
  ];

  while (prompts.length < promptsPerRound) {
    const index = prompts.length + 1;
    prompts.push({
      id: `round${round}-lc-extra-${index}`,
      text: `Run one extra long-context probe and provide at least ${perPromptTarget} Chinese characters with concrete evidence.`,
      note: 'phase=extra; goal=fill prompt budget',
    });
  }

  return {
    name: `Round ${round} - Long Context UX Stress`,
    description: `Long-context scenario with ${promptsPerRound} prompts and high-generation target.`,
    prompts: prompts.slice(0, promptsPerRound).map((item) => ({ ...item, postWaitMs: 900 })),
  };
}

function createScenarioForMode(args, round, ledger) {
  if (args.mode === 'long-context') {
    return createLongContextScenario(round, args.promptsPerRound, args.longOutputMinChars);
  }
  if (args.mode === 'ui-focused') {
    return createUiFocusedScenario(round, args.promptsPerRound, ledger);
  }
  return createDynamicScenario(round, args.promptsPerRound, ledger);
}

function shouldContinueUiFocusedRounds(args, startedAtMs, completedRounds, nextRound) {
  if (nextRound > args.maxRounds) {
    return false;
  }
  // Enforce explicit round cap even when run-hours is enabled.
  if (completedRounds >= args.rounds) {
    return false;
  }
  if (args.runHours <= 0) {
    return true;
  }
  const elapsedMs = Date.now() - startedAtMs;
  const deadlineMs = args.runHours * 60 * 60 * 1000;
  if (elapsedMs < deadlineMs) {
    return true;
  }
  return completedRounds < args.minRounds;
}

function normalizeRelativePath(filePath) {
  const text = String(filePath || '').trim();
  if (!text) {
    return '';
  }
  const resolved = path.isAbsolute(text) ? text : path.resolve(ROOT, text);
  return path.relative(ROOT, resolved).replace(/\\/g, '/');
}

function validateUiFocusedChangedFiles(changedFiles) {
  const allowedPrefixes = [
    'src/web/client/',
    'src/web/server/',
    'src/web/shared/',
    'tests/unit/',
    'scripts/ux-iterate.js',
    'scripts/ux-runner.js',
    'scripts/smoke-playwright-ui.js',
  ];
  const blockedPrefixes = [
    'src/agent/',
    'src/compression/',
    'src/config/',
    'src/context/',
    'src/llm/',
    'src/mcp/',
    'src/session/',
    'src/storage/',
    'src/tools/',
  ];

  const normalized = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((item) => normalizeRelativePath(item))
    .filter(Boolean);

  const violations = [];
  for (const file of normalized) {
    if (blockedPrefixes.some((prefix) => file.startsWith(prefix))) {
      violations.push(file);
      continue;
    }
    const allowed = allowedPrefixes.some((prefix) => file === prefix || file.startsWith(prefix));
    if (!allowed) {
      violations.push(file);
    }
  }
  return {
    normalizedFiles: normalized,
    violations,
  };
}

async function runUxRunner(input) {
  const runnerPath = path.join(ROOT, 'scripts', 'ux-runner.js');
  const args = [
    runnerPath,
    '--round', input.roundTag,
    '--ux-root', input.uxRoot,
    '--scenario', input.scenarioPath,
    '--headless', String(input.headless),
    '--port', String(input.port),
    '--prompt-timeout-ms', String(input.promptTimeoutMs),
    '--expect-existing', 'true',
    '--keep-server', 'true',
  ];
  if (String(input.apiKey || '').trim().length > 0) {
    args.push('--api-key', String(input.apiKey));
  }

  const result = await runCommand(process.execPath, args, {
    cwd: ROOT,
    streamOutput: true,
    env: {
      UX_API_KEY: input.apiKey,
    },
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const reportMatch = output.match(/\[ux-runner\]\s+report json:\s+(.+)/i);
  const reportJsonPath = reportMatch ? reportMatch[1].trim() : '';
  if (result.code !== 0) {
    throw new Error(`ux-runner failed with code=${result.code}`);
  }
  if (!reportJsonPath || !fs.existsSync(reportJsonPath)) {
    throw new Error('ux-runner succeeded but report path missing in output.');
  }
  return {
    reportJsonPath,
    reportMdPath: reportJsonPath.replace(/\.json$/i, '.md'),
  };
}

function extractAnomalies(report) {
  const anomalies = Array.isArray(report?.signals?.anomalies) ? report.signals.anomalies : [];
  if (anomalies.length === 0) {
    return '- None';
  }
  return anomalies.slice(0, 30).map((item) => `- [${item.type}] ${item.message}`).join('\n');
}

function extractHighlights(report) {
  const rows = Array.isArray(report?.signals?.promptResults) ? report.signals.promptResults : [];
  const lines = [];
  for (const item of rows.slice(0, 8)) {
    const highlights = Array.isArray(item.highlights) ? item.highlights : [];
    if (highlights.length > 0) {
      lines.push(`- ${item.id}: ${highlights.slice(0, 3).join(' | ')}`);
    }
  }
  return lines.join('\n') || '- No structured assistant highlights captured.';
}

function extractUiSignals(report) {
  const rows = Array.isArray(report?.signals?.uiObservations) ? report.signals.uiObservations : [];
  if (rows.length === 0) {
    return '- No UI observation rows captured.';
  }
  return rows.slice(-8).map((row) => {
    return `- ${row.label}: textarea=${row.hasTextarea}, send=${row.hasSendButton}, assistantBlocks=${row.assistantBlockCount}, apiKeyBanner=${row.apiKeyNotConfigured}, routeError=${row.routeError}`;
  }).join('\n');
}

function collectCheckpointScreenshots(report) {
  const checkpoints = Array.isArray(report?.signals?.checkpoints) ? report.signals.checkpoints : [];
  return checkpoints
    .map((item, index) => ({
      id: String(item?.name || `checkpoint-${index + 1}`),
      index,
      timestamp: String(item?.timestamp || ''),
      url: String(item?.url || ''),
      screenshot: String(item?.screenshot || '').trim(),
      note: String(item?.note || ''),
    }))
    .filter((item) => item.screenshot && fs.existsSync(item.screenshot));
}

function selectScreenshotSamples(screenshots, minCount) {
  const source = Array.isArray(screenshots) ? screenshots : [];
  if (source.length === 0) {
    return [];
  }
  if (source.length <= minCount) {
    return source;
  }
  const selected = [];
  const used = new Set();
  for (let i = 0; i < minCount; i += 1) {
    const idx = Math.round((i * (source.length - 1)) / Math.max(1, minCount - 1));
    if (used.has(idx)) {
      continue;
    }
    used.add(idx);
    selected.push(source[idx]);
  }
  if (selected.length < minCount) {
    for (let i = source.length - 1; i >= 0; i -= 1) {
      if (used.has(i)) {
        continue;
      }
      used.add(i);
      selected.push(source[i]);
      if (selected.length >= minCount) {
        break;
      }
    }
  }
  return selected.slice(0, minCount);
}

function formatVisualAuditEvidence(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return '- No screenshots captured.';
  }
  return samples
    .map((item, idx) => {
      const order = String(idx + 1).padStart(2, '0');
      return `- shot_${order}: id=${item.id}; timestamp=${item.timestamp || 'n/a'}; url=${item.url || 'n/a'}; path=${item.screenshot}; note=${item.note || 'n/a'}`;
    })
    .join('\n');
}
function buildReviewPrompt(input) {
  return [
    `Round ${input.round} UX review task.`,
    '',
    'Hard requirements:',
    '1) Must call subagent_manage first and create a reviewer sub-agent, then wait for result.',
    '2) Must compare this round requirements against history ledger and mark mergeable vs net-new.',
    '3) Must keep architecture boundary: LLM + Context + Tool + Prompt.',
    '4) Context rule: no hard trim before compression attempt.',
    `5) Must audit at least ${input.visualAuditMinScreenshots} screenshots from visual evidence and provide per-shot findings.`,
    '6) Output JSON object only.',
    '',
    'Round signals:',
    '## anomalies',
    input.anomalies,
    '## highlights',
    input.highlights,
    '## ui_signals',
    input.uiSignals,
    '## visual_evidence',
    input.visualEvidence,
    '',
    'History ledger snippet:',
    input.ledgerSummary,
    '',
    'Required JSON shape:',
    '{',
    '  "round": number,',
    '  "review_summary": string,',
    '  "requirements": [',
    '    {',
    '      "title": string,',
    '      "severity": "blocker" | "high" | "medium" | "low",',
    '      "area": string,',
    '      "intent": string,',
    '      "symptom": string,',
    '      "evidence": string,',
    '      "proposed_fix": string,',
    '      "status": "open" | "planned" | "implemented",',
    '      "merge_candidates": string[]',
    '    }',
    '  ],',
    '  "merge_suggestions": [',
    '    { "from_title": string, "to_req_id": string, "reason": string }',
    '  ],',
    '  "visual_findings": [',
    '    {',
    '      "shot_id": string,',
    '      "issue": string,',
    '      "severity": "blocker" | "high" | "medium" | "low",',
    '      "suggestion": string',
    '    }',
    '  ],',
    '  "iteration_actions": [',
    '    { "priority": "P0" | "P1" | "P2", "action": string, "owner": string }',
    '  ]',
    '}',
  ].join('\n');
}

function buildFixPrompt(input) {
  const reqLines = input.selectedRequirements.length
    ? input.selectedRequirements
        .map((item) => `- ${item.req_id} [${item.severity}] ${item.title}\n  area=${item.area}\n  symptom=${item.symptom}\n  proposed_fix=${item.proposed_fix}`)
        .join('\n')
    : '- none';

  return [
    `Execute round ${input.round} fixes.`,
    'Target: implement high-priority plus mergeable items with minimal safe edits.',
    '',
    'Hard constraints:',
    '1) Keep LLM + Context + Tool + Prompt architecture.',
    '2) Keep context policy: compress attempt before hard trim fallback.',
    '3) Run tests/checks and report results.',
    ...(input.mode === 'ui-focused'
      ? [
          '4) Only modify UI and interaction related files.',
          '5) Allowed paths: src/web/client/**, src/web/server/**, tests/unit/** (UI-related), and ux automation scripts.',
          '6) Forbidden: core agent/context/tool/llm/compression/session/storage modules.',
        ]
      : []),
    ...(input.mode === 'long-context'
      ? [
          `4) Only write/edit files inside workspace: ${input.workspaceDir}`,
          '5) Do not modify repository source code outside the UX workspace.',
        ]
      : []),
    '',
    'Selected requirements:',
    reqLines,
    '',
    'Output JSON only:',
    '{',
    '  "implemented_req_ids": string[],',
    '  "changed_files": string[],',
    '  "tests_run": string[],',
    '  "risks": string[],',
    '  "summary": string',
    '}',
  ].join('\n');
}

function summarizeLedgerForPrompt(ledger, maxItems = 12) {
  const sorted = [...ledger.items]
    .sort((a, b) => {
      const sa = SEVERITY_RANK[normalizeSeverity(a.severity)] ?? 0;
      const sb = SEVERITY_RANK[normalizeSeverity(b.severity)] ?? 0;
      if (sb !== sa) {
        return sb - sa;
      }
      return Number(a.first_seen_round || 0) - Number(b.first_seen_round || 0);
    })
    .slice(0, maxItems);

  if (sorted.length === 0) {
    return '- No previous requirements';
  }
  return sorted.map((item) => `- ${item.req_id} [${item.severity}] ${item.title} (area=${item.area}, status=${item.status})`).join('\n');
}

function extractJsonFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return null;
  }

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) {
    return direct;
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const parsed = tryParse(fencedMatch[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return tryParse(text.slice(first, last + 1));
  }
  return null;
}

function normalizeReviewRequirements(parsed, round) {
  const items = Array.isArray(parsed?.requirements) ? parsed.requirements : [];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const title = String(item.title || '').trim();
    if (!title) {
      continue;
    }
    out.push({
      local_id: `R${round}-${i + 1}`,
      title,
      severity: normalizeSeverity(item.severity),
      area: String(item.area || 'general').trim(),
      intent: String(item.intent || title).trim(),
      symptom: String(item.symptom || title).trim(),
      evidence: String(item.evidence || '').trim() || `round=${round}; source=subagent-review`,
      proposed_fix: String(item.proposed_fix || '').trim() || 'TBD',
      status: String(item.status || 'open').trim().toLowerCase() || 'open',
      merge_candidates: Array.isArray(item.merge_candidates)
        ? item.merge_candidates.map((x) => String(x || '').trim()).filter(Boolean)
        : [],
    });
  }
  return out;
}

function loadLedger(ledgerPath) {
  const parsed = readJson(ledgerPath, null);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [],
      rounds: [],
    };
  }
  return {
    version: 1,
    createdAt: parsed.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: Array.isArray(parsed.items) ? parsed.items : [],
    rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
  };
}

function collapseLedgerRounds(rounds) {
  const latestByRound = new Map();
  const source = Array.isArray(rounds) ? rounds : [];
  for (const item of source) {
    const round = Number(item?.round);
    if (!Number.isFinite(round) || round <= 0) {
      continue;
    }
    latestByRound.set(round, {
      round,
      finishedAt: String(item?.finishedAt || ''),
      sessionId: String(item?.sessionId || ''),
      newReqCount: Number(item?.newReqCount || 0),
      mergedReqCount: Number(item?.mergedReqCount || 0),
      selectedFixCount: Number(item?.selectedFixCount || 0),
      smokePass: Boolean(item?.smokePass),
    });
  }
  return [...latestByRound.values()].sort((a, b) => a.round - b.round);
}

function nextRequirementId(items) {
  let max = 0;
  for (const item of items) {
    const match = String(item.req_id || '').match(/^REQ-(\d+)$/);
    if (!match) {
      continue;
    }
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) {
      max = n;
    }
  }
  return `REQ-${String(max + 1).padStart(4, '0')}`;
}

function buildMergeKey(req) {
  return `${normalizeText(req.area)}|${normalizeText(req.intent)}|${normalizeText(req.symptom)}`.slice(0, 500);
}

function dedupeArray(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function mergeRequirementsIntoLedger(ledger, incoming, round) {
  const keyToReqId = new Map();
  const idToItem = new Map();
  for (const item of ledger.items) {
    if (item.merge_key) {
      keyToReqId.set(item.merge_key, item.req_id);
    }
    idToItem.set(item.req_id, item);
  }

  const newReqIds = [];
  const mergedReqIds = [];
  const touchedReqIds = [];

  for (const req of incoming) {
    const mergeKey = buildMergeKey(req);
    let targetReqId = null;

    for (const candidate of req.merge_candidates || []) {
      if (idToItem.has(candidate)) {
        targetReqId = candidate;
        break;
      }
    }
    if (!targetReqId && keyToReqId.has(mergeKey)) {
      targetReqId = keyToReqId.get(mergeKey);
    }

    if (targetReqId && idToItem.has(targetReqId)) {
      const existing = idToItem.get(targetReqId);
      existing.last_seen_round = round;
      existing.updatedAt = new Date().toISOString();
      existing.severity = pickHigherSeverity(existing.severity, req.severity);
      existing.status = existing.status === 'closed' ? 'open' : existing.status;
      existing.evidence = dedupeArray([...(existing.evidence || []), req.evidence]);
      existing.merged_from = dedupeArray([...(existing.merged_from || []), req.local_id]);
      if (req.proposed_fix && req.proposed_fix !== 'TBD') {
        const old = String(existing.proposed_fix || '').trim();
        existing.proposed_fix = old ? `${old}\n- ${req.proposed_fix}` : req.proposed_fix;
      }
      mergedReqIds.push(existing.req_id);
      touchedReqIds.push(existing.req_id);
      continue;
    }

    const reqId = nextRequirementId(ledger.items);
    const created = {
      req_id: reqId,
      title: req.title,
      severity: normalizeSeverity(req.severity),
      area: req.area || 'general',
      intent: req.intent || req.title,
      symptom: req.symptom || req.title,
      evidence: dedupeArray([req.evidence]),
      proposed_fix: req.proposed_fix || 'TBD',
      status: req.status || 'open',
      first_seen_round: round,
      last_seen_round: round,
      merge_key: mergeKey,
      merged_from: dedupeArray([req.local_id]),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ledger.items.push(created);
    keyToReqId.set(mergeKey, reqId);
    idToItem.set(reqId, created);
    newReqIds.push(reqId);
    touchedReqIds.push(reqId);
  }

  const touched = touchedReqIds.map((id) => idToItem.get(id)).filter(Boolean);
  touched.sort((a, b) => (SEVERITY_RANK[normalizeSeverity(b.severity)] ?? 0) - (SEVERITY_RANK[normalizeSeverity(a.severity)] ?? 0));

  const selectedFixIds = [];
  for (const item of touched) {
    if (selectedFixIds.includes(item.req_id)) {
      continue;
    }
    if (['blocker', 'high'].includes(normalizeSeverity(item.severity))) {
      selectedFixIds.push(item.req_id);
    }
  }
  if (selectedFixIds.length < 3) {
    for (const item of touched) {
      if (selectedFixIds.includes(item.req_id)) {
        continue;
      }
      if (normalizeSeverity(item.severity) === 'medium') {
        selectedFixIds.push(item.req_id);
      }
      if (selectedFixIds.length >= 3) {
        break;
      }
    }
  }

  ledger.updatedAt = new Date().toISOString();
  return {
    newReqIds: dedupeArray(newReqIds),
    mergedReqIds: dedupeArray(mergedReqIds),
    selectedFixIds: dedupeArray(selectedFixIds),
  };
}
function evaluateContextBoundary(report) {
  const anomalies = Array.isArray(report?.signals?.anomalies) ? report.signals.anomalies : [];
  const truncatedHits = anomalies.filter((item) => String(item.type || '') === 'context_truncated').length;

  const messages = Array.isArray(report?.session?.detail?.messages) ? report.session.detail.messages : [];
  const flattened = messages.map((msg) => (typeof msg?.content === 'string' ? msg.content : '')).join('\n');
  const hasPrecompressEvidence = flattened.includes('[CONTEXT_PRECOMPRESSED');

  return {
    truncatedHits,
    hasPrecompressEvidence,
    violated: truncatedHits > 0 && !hasPrecompressEvidence,
  };
}

function findContextOverflowSnapshots(uxRoot, sessionId) {
  const dir = path.join(uxRoot, 'contexts', 'session', sessionId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^context_overflow_.*\.json$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function buildRoundPlanMarkdown(input) {
  return [
    `# Round ${input.round} Iteration Plan`,
    '',
    `- Session: ${input.sessionId || 'n/a'}`,
    `- New requirements: ${input.newReqIds.length}`,
    `- Merged requirements: ${input.mergedReqIds.length}`,
    `- Selected fixes: ${input.selectedRequirements.length}`,
    `- Screenshot coverage: ${input.screenshotCount}/${input.visualAuditMinScreenshots}`,
    `- Context boundary violated: ${input.contextBoundary.violated}`,
    '',
    '## Selected Requirements',
    ...(input.selectedRequirements.length > 0
      ? input.selectedRequirements.map((item) => `- ${item.req_id} [${item.severity}] ${item.title}`)
      : ['- None']),
    '',
    '## Fix Execution',
    `- applied: ${input.fixExecution.applied}`,
    `- success: ${input.fixExecution.success}`,
    `- run_id: ${input.fixExecution.runId || 'n/a'}`,
  ].join('\n');
}

function buildReviewMarkdown(input) {
  return [
    `# Round ${input.round} Subagent Review`,
    '',
    `- Session: ${input.sessionId}`,
    `- subagent_manage_called: ${input.subagentManageCalled}`,
    `- run_id: ${input.runId}`,
    `- screenshot_coverage: ${input.screenshotCount}/${input.visualAuditMinScreenshots}`,
    '',
    '## Summary',
    `- ${input.reviewSummary || '(empty)'}`,
    '',
    '## Requirements',
    ...(input.requirements.length > 0
      ? input.requirements.map((item) => `- [${item.severity}] ${item.title} (area=${item.area})`)
      : ['- None']),
    '',
    '## Visual Findings',
    ...(Array.isArray(input.visualFindings) && input.visualFindings.length > 0
      ? input.visualFindings.map((item) => `- [${normalizeSeverity(item.severity)}] ${item.shot_id}: ${item.issue} -> ${item.suggestion}`)
      : ['- None']),
  ].join('\n');
}

function buildSummaryMarkdown(input) {
  const totals = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const item of input.ledger.items) {
    totals[normalizeSeverity(item.severity)] += 1;
  }

  const topOpen = [...input.ledger.items]
    .filter((item) => String(item.status || '').toLowerCase() !== 'closed')
    .sort((a, b) => (SEVERITY_RANK[normalizeSeverity(b.severity)] ?? 0) - (SEVERITY_RANK[normalizeSeverity(a.severity)] ?? 0))
    .slice(0, 10);

  const title = input.mode === 'long-context'
    ? '# UX Iteration Summary (Long Context)'
    : (input.mode === 'ui-focused' ? '# UX Iteration Summary (UI Focused)' : '# UX Iteration Summary');

  const lines = [
    title,
    '',
    `- Started: ${input.startedAt}`,
    `- Finished: ${input.finishedAt}`,
    `- Total rounds: ${input.rounds.length}`,
    ...(input.mode === 'ui-focused'
      ? [`- Run hours target: ${input.runHours > 0 ? input.runHours : 'n/a'}`]
      : []),
    '',
    '## Totals',
    `- blocker: ${totals.blocker}`,
    `- high: ${totals.high}`,
    `- medium: ${totals.medium}`,
    `- low: ${totals.low}`,
    '',
    '## Rounds',
    ...input.rounds.map((item) => `- round ${item.round}: new=${item.newReqCount}, merged=${item.mergedReqCount}, selected=${item.selectedFixCount}, smokePass=${item.smokePass}`),
    '',
    '## Top Open',
    ...(topOpen.length > 0
      ? topOpen.map((item) => `- ${item.req_id} [${item.severity}] ${item.title}`)
      : ['- None']),
  ];

  if (input.mode === 'long-context' && Array.isArray(input.longContextMetrics) && input.longContextMetrics.length > 0) {
    lines.push(
      '',
      '## Long Context Metrics',
      `- output threshold: >= ${input.longOutputMinChars} chars per round`,
      ...input.longContextMetrics.map((metric) => {
        const toolSummary = [
          `web_search=${metric.toolUsageCounts.web_search || 0}`,
          `web_fetch=${metric.toolUsageCounts.web_fetch || 0}`,
          `write_file=${metric.toolUsageCounts.write_file || 0}`,
          `edit_file=${metric.toolUsageCounts.edit_file || 0}`,
        ].join(', ');
        const contextSummary = [
          `truncated=${metric.contextSignals.contextTruncatedCount}`,
          `overflow=${metric.contextSignals.contextOverflowCount}`,
          `precompressEvidence=${metric.contextSignals.precompressEvidenceCount}`,
          `snapshots=${metric.contextSignals.overflowSnapshotCount}`,
        ].join(', ');
        return `- round ${metric.round}: totalChars=${metric.assistantTotalChars}, avgChars=${metric.avgCharsPerPrompt}, thresholdMet=${metric.thresholdMet}, tools[${toolSummary}], context[${contextSummary}]`;
      })
    );
  }

  return lines.join('\n');
}

function collectLongContextMetrics(input) {
  const promptResults = Array.isArray(input.uxReport?.signals?.promptResults)
    ? input.uxReport.signals.promptResults
    : [];
  const perPromptChars = promptResults.map((item, index) => ({
    id: String(item?.id || `prompt-${index + 1}`),
    chars: String(item?.latestAssistant || '').length,
    durationMs: Number(item?.durationMs || 0),
  }));
  const assistantTotalChars = perPromptChars.reduce((sum, item) => sum + item.chars, 0);
  const avgCharsPerPrompt = perPromptChars.length > 0 ? Math.round(assistantTotalChars / perPromptChars.length) : 0;

  const toolUsageCounts = {
    web_search: 0,
    web_fetch: 0,
    write_file: 0,
    edit_file: 0,
    subagent_manage: 0,
  };

  const sessionMessages = Array.isArray(input.uxReport?.session?.detail?.messages)
    ? input.uxReport.session.detail.messages
    : [];
  for (const msg of sessionMessages) {
    const toolCalls = Array.isArray(msg?.toolCalls) ? msg.toolCalls : [];
    for (const call of toolCalls) {
      const name = String(call?.function?.name || call?.name || '').trim();
      if (name && Object.prototype.hasOwnProperty.call(toolUsageCounts, name)) {
        toolUsageCounts[name] += 1;
      }
    }
  }

  const anomalies = Array.isArray(input.uxReport?.signals?.anomalies) ? input.uxReport.signals.anomalies : [];
  const contextTruncatedCount = anomalies.filter((item) => String(item?.type || '') === 'context_truncated').length;
  const contextOverflowCount = anomalies.filter((item) => String(item?.type || '') === 'context_overflow').length;

  const flattened = sessionMessages
    .map((msg) => (typeof msg?.content === 'string' ? msg.content : ''))
    .join('\n');
  const precompressEvidenceCount = (flattened.match(/\[CONTEXT_PRECOMPRESSED/gi) || []).length;

  return {
    round: input.round,
    sessionId: input.sessionId,
    promptCount: perPromptChars.length,
    assistantTotalChars,
    avgCharsPerPrompt,
    perPromptChars,
    threshold: input.longOutputMinChars,
    thresholdMet: assistantTotalChars >= input.longOutputMinChars,
    toolUsageCounts,
    contextSignals: {
      contextTruncatedCount,
      contextOverflowCount,
      precompressEvidenceCount,
      overflowSnapshotCount: Array.isArray(input.overflowSnapshots) ? input.overflowSnapshots.length : 0,
      contextBoundaryViolated: Boolean(input.contextBoundary?.violated),
    },
  };
}

function loadLongContextMetricsFromDisk(iterationsRoot, rounds) {
  const out = [];
  const source = Array.isArray(rounds) ? rounds : [];
  for (const item of source) {
    const round = Number(item?.round);
    if (!Number.isFinite(round) || round <= 0) {
      continue;
    }
    const filePath = path.join(iterationsRoot, `round-${String(round).padStart(2, '0')}`, 'long-context-metrics.json');
    const parsed = readJson(filePath, null);
    if (parsed && typeof parsed === 'object') {
      out.push(parsed);
    }
  }
  return out.sort((a, b) => Number(a?.round || 0) - Number(b?.round || 0));
}

async function sendChatViaWebSocket(input) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${input.port}`);
    let runId = '';
    let timeout = null;
    let done = false;
    const startedAt = Date.now();

    const events = {
      toolCalls: [],
      toolResults: [],
      messages: [],
      errors: [],
    };

    const finish = (result, isError) => {
      if (done) {
        return;
      }
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (isError) {
        reject(result instanceof Error ? result : new Error(String(result)));
      } else {
        resolve(result);
      }
    };

    ws.on('open', () => {
      const data = {
        prompt: input.prompt,
        context: input.context,
      };
      if (input.workspaceDir) {
        data.workspaceDir = input.workspaceDir;
      }
      ws.send(JSON.stringify({ type: 'chat', data }));
      timeout = setTimeout(() => finish(new Error(`chat timeout after ${input.timeoutMs}ms`), true), input.timeoutMs);
    });

    ws.on('message', (buffer) => {
      let packet = null;
      try {
        packet = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      const type = packet?.type;
      const data = packet?.data || {};

      if (type === 'chat_started' && !runId) {
        runId = String(data.runId || '').trim();
        return;
      }

      if (!runId || String(data.runId || '').trim() !== runId) {
        return;
      }

      if (type === 'tool_call') {
        events.toolCalls.push({ name: String(data.name || ''), args: data.args || {}, timestamp: new Date().toISOString() });
        return;
      }
      if (type === 'tool_result') {
        events.toolResults.push({ name: String(data.name || ''), timestamp: new Date().toISOString() });
        return;
      }
      if (type === 'message') {
        events.messages.push({ role: String(data.role || ''), content: String(data.content || ''), timestamp: new Date().toISOString() });
        return;
      }
      if (type === 'error') {
        const message = String(data.error || 'unknown_error');
        events.errors.push(message);
        finish(new Error(`chat error: ${message}`), true);
        return;
      }
      if (type === 'complete') {
        finish({
          runId,
          context: data.context || input.context,
          content: String(data.content || ''),
          elapsedMs: Date.now() - startedAt,
          events,
        }, false);
      }
    });

    ws.on('error', (error) => finish(error, true));
  });
}

async function runSmoke(roundDir, port, apiKey, options = {}) {
  const outputDir = path.join(roundDir, 'smoke');
  ensureDir(outputDir);
  const noSettingsWrite = options.noSettingsWrite === true;
  const result = await runCommand(process.execPath, [path.join(ROOT, 'scripts', 'smoke-playwright-ui.js')], {
    cwd: ROOT,
    env: {
      SMOKE_URL: `http://127.0.0.1:${port}`,
      SMOKE_OUTPUT_DIR: outputDir,
      SMOKE_API_KEY: apiKey,
      SMOKE_NO_SETTINGS_WRITE: noSettingsWrite ? '1' : '0',
    },
    streamOutput: true,
  });
  return {
    passed: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    outputDir,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  ensureDir(args.uxRoot);
  ensureDir(path.join(args.uxRoot, 'workspace'));
  ensureDir(path.join(args.uxRoot, 'reports'));

  const iterationsRoot = args.iterationsRoot;
  ensureDir(iterationsRoot);
  const ledgerPath = path.join(iterationsRoot, 'requirements-ledger.json');
  const ledger = loadLedger(ledgerPath);
  if (args.mode === 'ui-focused') {
    if (args.startRound > args.maxRounds) {
      throw new Error(`Invalid rounds: start-round (${args.startRound}) cannot exceed max-rounds (${args.maxRounds}).`);
    }
  } else if (args.startRound > args.rounds) {
    throw new Error(`Invalid rounds: start-round (${args.startRound}) cannot exceed rounds (${args.rounds}).`);
  }

  const server = await ensureServer(args);
  const protectExistingDevConfig = args.expectExisting && server.usingExisting;
  let keyChoice = null;
  if (protectExistingDevConfig) {
    console.log('[ux-iterate] protect-dev-config=on (reuse existing server, skip API key sync/write)');
  } else {
    keyChoice = resolveApiKey(args);
    await syncApiKeyToServer(server.baseUrl, keyChoice.key);
    console.log(`[ux-iterate] api key source=${keyChoice.source} key=${maskSecret(keyChoice.key)}`);
  }
  const uxApiKey = keyChoice ? keyChoice.key : '';

  const roundSummaries = [];
  const longContextMetricsByRound = [];

  const runStartedAtMs = Date.now();
  let round = args.startRound;
  let completedRounds = 0;
  const hardStopAtMs = args.mode === 'ui-focused' && args.runHours > 0
    ? runStartedAtMs + (args.runHours * 60 * 60 * 1000)
    : 0;

  try {
    while (true) {
      if (args.mode === 'ui-focused') {
        if (!shouldContinueUiFocusedRounds(args, runStartedAtMs, completedRounds, round)) {
          break;
        }
      } else if (round > args.rounds) {
        break;
      }

      const roundTag = `round${round}`;
      const roundDir = path.join(iterationsRoot, `round-${String(round).padStart(2, '0')}`);
      ensureDir(roundDir);

      const progressInfo = args.mode === 'ui-focused'
        ? `${completedRounds + 1} (nextRound=${round}, max=${args.maxRounds}, elapsed=${Math.floor((Date.now() - runStartedAtMs) / 60000)}m)`
        : `${round}/${args.rounds}`;
      console.log(`\n[ux-iterate] ===== Round ${progressInfo} =====`);

      const scenario = createScenarioForMode(args, round, ledger);
      const scenarioPath = path.join(roundDir, 'ux-scenario.json');
      writeJson(scenarioPath, scenario);

      const uxResult = await runUxRunner({
        roundTag,
        uxRoot: args.uxRoot,
        scenarioPath,
        headless: args.headless,
        port: args.port,
        promptTimeoutMs: args.promptTimeoutMs,
        apiKey: uxApiKey,
      });

      const uxReport = readJson(uxResult.reportJsonPath, null);
      if (!uxReport) {
        throw new Error(`Failed to read ux report: ${uxResult.reportJsonPath}`);
      }

      copyFileSafe(uxResult.reportJsonPath, path.join(roundDir, 'ux-report.json'));
      copyFileSafe(uxResult.reportMdPath, path.join(roundDir, 'ux-report.md'));

      const sessionId = String(uxReport?.session?.id || '').trim();
      if (!sessionId) {
        throw new Error(`Round ${round}: missing sessionId in ux report.`);
      }

      const overflowSnapshots = findContextOverflowSnapshots(args.uxRoot, sessionId);
      const contextBoundary = evaluateContextBoundary(uxReport);
      const allScreenshots = collectCheckpointScreenshots(uxReport);
      const selectedScreenshots = selectScreenshotSamples(allScreenshots, args.visualAuditMinScreenshots);
      const visualEvidence = formatVisualAuditEvidence(selectedScreenshots);
      const screenshotCoverageMet = allScreenshots.length >= args.visualAuditMinScreenshots;

      writeJson(path.join(roundDir, 'visual-audit.json'), {
        round,
        sessionId,
        visualAuditMinScreenshots: args.visualAuditMinScreenshots,
        screenshotCount: allScreenshots.length,
        sampledCount: selectedScreenshots.length,
        screenshotCoverageMet,
        sampledScreenshots: selectedScreenshots,
      });

      const reviewPrompt = buildReviewPrompt({
        round,
        anomalies: `${extractAnomalies(uxReport)}\n- overflow_snapshots=${overflowSnapshots.length}`,
        highlights: extractHighlights(uxReport),
        uiSignals: extractUiSignals(uxReport),
        visualEvidence,
        visualAuditMinScreenshots: args.visualAuditMinScreenshots,
        ledgerSummary: summarizeLedgerForPrompt(ledger),
      });

      let reviewResult = null;
      let reviewFailure = null;
      try {
        reviewResult = await sendChatViaWebSocket({
          port: args.port,
          context: { scope: 'session', namespace: sessionId },
          prompt: reviewPrompt,
          timeoutMs: args.chatTimeoutMs,
          workspaceDir: args.uxRoot,
        });
      } catch (error) {
        reviewFailure = error instanceof Error ? error.message : String(error);
      }

      const subagentManageCalled = reviewResult
        ? reviewResult.events.toolCalls.some((item) => item.name === 'subagent_manage')
        : false;
      const parsedReview = reviewResult ? (extractJsonFromText(reviewResult.content) || {}) : {};
      const visualFindings = Array.isArray(parsedReview?.visual_findings)
        ? parsedReview.visual_findings
            .map((item) => ({
              shot_id: String(item?.shot_id || '').trim(),
              issue: String(item?.issue || '').trim(),
              severity: normalizeSeverity(item?.severity),
              suggestion: String(item?.suggestion || '').trim(),
            }))
            .filter((item) => item.shot_id && item.issue)
        : [];
      const normalizedRequirements = normalizeReviewRequirements(parsedReview, round);
      if (reviewFailure) {
        normalizedRequirements.push({
          local_id: `R${round}-review-failed`,
          title: 'Subagent review failed to complete',
          severity: 'blocker',
          area: 'workflow',
          intent: 'keep UX iteration pipeline resilient under long-context load',
          symptom: `review phase failed: ${reviewFailure}`,
          evidence: `round=${round}; session=${sessionId}`,
          proposed_fix: 'Limit review payload size and add retry/fallback path for review stage.',
          status: 'open',
          merge_candidates: [],
        });
      }
      if (contextBoundary.violated) {
        normalizedRequirements.push({
          local_id: `R${round}-context-boundary`,
          title: 'Context boundary violated: truncation observed without precompress evidence',
          severity: 'blocker',
          area: 'context',
          intent: 'enforce compress-before-trim policy',
          symptom: '[CONTEXT_TRUNCATED] without precompress evidence',
          evidence: `round=${round}; truncated_hits=${contextBoundary.truncatedHits}; precompress=${contextBoundary.hasPrecompressEvidence}`,
          proposed_fix: 'Add strict guard and tests to enforce compress-first ordering.',
          status: 'open',
          merge_candidates: [],
        });
      }
      if (!screenshotCoverageMet) {
        normalizedRequirements.push({
          local_id: `R${round}-visual-evidence-missing`,
          title: 'Visual evidence is insufficient for UI audit',
          severity: 'blocker',
          area: 'ui-validation',
          intent: 'enforce screenshot-based UI review quality',
          symptom: `Only ${allScreenshots.length} screenshots captured, required ${args.visualAuditMinScreenshots}`,
          evidence: `round=${round}; session=${sessionId}; sampled=${selectedScreenshots.length}`,
          proposed_fix: 'Increase checkpoint coverage and enforce at least five screenshot audits per round.',
          status: 'open',
          merge_candidates: [],
        });
      }

      if (!subagentManageCalled) {
        normalizedRequirements.push({
          local_id: `R${round}-subagent-missing`,
          title: 'Subagent review did not execute subagent_manage',
          severity: 'blocker',
          area: 'workflow',
          intent: 'ensure in-code subagent review every round',
          symptom: 'No subagent_manage tool call observed',
          evidence: `round=${round}; run_id=${reviewResult ? reviewResult.runId : 'n/a'}`,
          proposed_fix: 'Harden review prompt and add workflow assertion for subagent_manage.',
          status: 'open',
          merge_candidates: [],
        });
      }

      const mergeOutcome = mergeRequirementsIntoLedger(ledger, normalizedRequirements, round);
      const selectedRequirements = ledger.items.filter((item) => mergeOutcome.selectedFixIds.includes(item.req_id));

      writeJson(path.join(roundDir, 'subagent-review.json'), {
        round,
        sessionId,
        runId: reviewResult ? reviewResult.runId : null,
        elapsedMs: reviewResult ? reviewResult.elapsedMs : null,
        reviewFailure,
        subagentManageCalled,
        screenshotCount: allScreenshots.length,
        visualAuditMinScreenshots: args.visualAuditMinScreenshots,
        sampledScreenshots: selectedScreenshots,
        visualFindings,
        contextOverflowSnapshots: overflowSnapshots,
        reviewSummary: String(parsedReview.review_summary || ''),
        requirements: normalizedRequirements,
        rawResponse: reviewResult ? reviewResult.content : '',
        toolCalls: reviewResult ? reviewResult.events.toolCalls : [],
      });
      writeText(path.join(roundDir, 'subagent-review.md'), buildReviewMarkdown({
        round,
        sessionId,
        runId: reviewResult ? reviewResult.runId : 'n/a',
        subagentManageCalled,
        screenshotCount: allScreenshots.length,
        visualAuditMinScreenshots: args.visualAuditMinScreenshots,
        reviewSummary: reviewFailure ? `review failed: ${reviewFailure}` : String(parsedReview.review_summary || ''),
        requirements: normalizedRequirements,
        visualFindings,
      }));

      writeJson(path.join(roundDir, 'merge-result.json'), {
        round,
        newReqIds: mergeOutcome.newReqIds,
        mergedReqIds: mergeOutcome.mergedReqIds,
        selectedFixIds: mergeOutcome.selectedFixIds,
        selectedRequirements,
      });

      let fixExecution = {
        applied: false,
        success: true,
        runId: null,
      };

      if (args.applyFixes && selectedRequirements.length > 0) {
        try {
          const fixWorkspaceDir = args.mode === 'long-context'
            ? path.join(args.uxRoot, 'workspace')
            : args.repoWorkspace;
          const fixPrompt = buildFixPrompt({
            round,
            selectedRequirements,
            mode: args.mode,
            workspaceDir: fixWorkspaceDir,
          });
          const longContextFixTimeoutMs = 4 * 60 * 1000;
          const fixTimeoutMs = args.mode === 'long-context'
            ? Math.min(args.chatTimeoutMs, longContextFixTimeoutMs)
            : Math.max(args.chatTimeoutMs, 12 * 60 * 1000);
          const fixResult = await sendChatViaWebSocket({
            port: args.port,
            context: { scope: 'session', namespace: sessionId },
            prompt: fixPrompt,
            timeoutMs: fixTimeoutMs,
            workspaceDir: fixWorkspaceDir,
          });
          const parsedFix = extractJsonFromText(fixResult.content) || {};
          const implementedReqIds = Array.isArray(parsedFix.implemented_req_ids)
            ? parsedFix.implemented_req_ids.map((item) => String(item || '').trim()).filter(Boolean)
            : [];
          const changedFiles = Array.isArray(parsedFix.changed_files) ? parsedFix.changed_files : [];
          let uiValidation = { normalizedFiles: [], violations: [] };
          if (args.mode === 'ui-focused') {
            uiValidation = validateUiFocusedChangedFiles(changedFiles);
          }

          const uiScopeViolated = args.mode === 'ui-focused' && uiValidation.violations.length > 0;

          if (!uiScopeViolated) {
            for (const reqId of implementedReqIds) {
              const item = ledger.items.find((entry) => entry.req_id === reqId);
              if (item) {
                item.status = 'implemented';
                item.updatedAt = new Date().toISOString();
              }
            }
          }

          fixExecution = {
            applied: true,
            success: !uiScopeViolated,
            runId: fixResult.runId,
            implementedReqIds,
            changedFiles,
            normalizedChangedFiles: uiValidation.normalizedFiles,
            uiScopeViolations: uiValidation.violations,
            testsRun: Array.isArray(parsedFix.tests_run) ? parsedFix.tests_run : [],
            risks: Array.isArray(parsedFix.risks) ? parsedFix.risks : [],
            summary: String(parsedFix.summary || ''),
            error: uiScopeViolated
              ? `UI scope violation detected in changed files: ${uiValidation.violations.join(', ')}`
              : null,
            rawResponse: fixResult.content,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fixExecution = {
            applied: false,
            success: false,
            runId: null,
            error: message,
          };
        }
      }

      writeJson(path.join(roundDir, 'fix-execution.json'), fixExecution);
      writeText(path.join(roundDir, 'iteration-plan.md'), buildRoundPlanMarkdown({
        round,
        sessionId,
        newReqIds: mergeOutcome.newReqIds,
        mergedReqIds: mergeOutcome.mergedReqIds,
        selectedRequirements,
        screenshotCount: allScreenshots.length,
        visualAuditMinScreenshots: args.visualAuditMinScreenshots,
        contextBoundary,
        fixExecution,
      }));

      let smoke = { passed: true, skipped: true };
      if (args.runSmoke) {
        smoke = await runSmoke(roundDir, args.port, uxApiKey, {
          noSettingsWrite: protectExistingDevConfig,
        });
      }
      writeJson(path.join(roundDir, 'smoke.json'), smoke);
      writeJson(path.join(roundDir, 'context-overflow-snapshots.json'), { round, sessionId, snapshots: overflowSnapshots });
      if (args.mode === 'long-context') {
        const metrics = collectLongContextMetrics({
          round,
          sessionId,
          uxReport,
          overflowSnapshots,
          contextBoundary,
          longOutputMinChars: args.longOutputMinChars,
        });
        writeJson(path.join(roundDir, 'long-context-metrics.json'), metrics);
        longContextMetricsByRound.push(metrics);
      }

      ledger.rounds.push({
        round,
        finishedAt: new Date().toISOString(),
        sessionId,
        newReqCount: mergeOutcome.newReqIds.length,
        mergedReqCount: mergeOutcome.mergedReqIds.length,
        selectedFixCount: mergeOutcome.selectedFixIds.length,
        smokePass: !!smoke.passed,
      });
      ledger.updatedAt = new Date().toISOString();
      writeJson(ledgerPath, ledger);

      roundSummaries.push({
        round,
        sessionId,
        newReqCount: mergeOutcome.newReqIds.length,
        mergedReqCount: mergeOutcome.mergedReqIds.length,
        selectedFixCount: mergeOutcome.selectedFixIds.length,
        smokePass: !!smoke.passed,
      });

      console.log(`[ux-iterate] round=${round} session=${sessionId} new=${mergeOutcome.newReqIds.length} merged=${mergeOutcome.mergedReqIds.length} selected=${mergeOutcome.selectedFixIds.length} smoke=${smoke.passed}`);
      completedRounds += 1;
      round += 1;

      if (args.mode === 'ui-focused' && hardStopAtMs > 0 && Date.now() >= hardStopAtMs && completedRounds >= args.minRounds) {
        console.log(`[ux-iterate] ui-focused time target reached (${args.runHours}h). stop after round=${round - 1}.`);
        break;
      }
    }

    const summaryRounds = collapseLedgerRounds(ledger.rounds);
    const summaryLongContextMetrics = args.mode === 'long-context'
      ? loadLongContextMetricsFromDisk(iterationsRoot, summaryRounds)
      : longContextMetricsByRound;
    writeText(path.join(iterationsRoot, 'iteration-summary.md'), buildSummaryMarkdown({
      startedAt,
      finishedAt: new Date().toISOString(),
      rounds: summaryRounds,
      ledger,
      mode: args.mode,
      runHours: args.runHours,
      longOutputMinChars: args.longOutputMinChars,
      longContextMetrics: summaryLongContextMetrics,
    }));

    console.log(`\n[ux-iterate] completed mode=${args.mode} roundsExecuted=${summaryRounds.length}`);
    console.log(`[ux-iterate] ledger=${ledgerPath}`);
    console.log(`[ux-iterate] summary=${path.join(iterationsRoot, 'iteration-summary.md')}`);
  } finally {
    if (server.child) {
      await stopChildProcess(server.child);
    }
  }
}

main().catch((error) => {
  console.error(`[ux-iterate] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
