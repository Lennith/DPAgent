#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = process.cwd();
const DEFAULT_PORT = 53721;
const DEFAULT_UX_ROOT = path.join(ROOT, 'ux-workspace');
const DEFAULT_PROMPT_TIMEOUT_MS = 180000;
const DEFAULT_HEADLESS = true;
const REQUIRED_MARKERS = ['【完成！】', '【汇报结束！】'];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestampSlug(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function parseBooleanArg(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const lowered = String(value).trim().toLowerCase();
  if (lowered === '1' || lowered === 'true' || lowered === 'yes') {
    return true;
  }
  if (lowered === '0' || lowered === 'false' || lowered === 'no') {
    return false;
  }
  return fallback;
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

  const round = String(map.get('round') || 'round1').trim();
  const uxRoot = path.resolve(String(map.get('ux-root') || DEFAULT_UX_ROOT));
  const scenarioPath = path.resolve(
    String(map.get('scenario') || path.join(uxRoot, 'scenarios', `${round}.json`))
  );
  const headless = parseBooleanArg(map.get('headless'), DEFAULT_HEADLESS);
  const port = Number.parseInt(String(map.get('port') || DEFAULT_PORT), 10);
  const promptTimeoutMs = Number.parseInt(
    String(map.get('prompt-timeout-ms') || DEFAULT_PROMPT_TIMEOUT_MS),
    10
  );
  const keepServer = parseBooleanArg(map.get('keep-server'), false);
  const expectExisting = parseBooleanArg(map.get('expect-existing'), false);
  const apiKey = String(map.get('api-key') || process.env.UX_API_KEY || '').trim();
  const provider = String(map.get('provider') || '').trim().toLowerCase();
  const apiBase = String(map.get('api-base') || '').trim();
  const model = String(map.get('model') || '').trim();
  const restoreAfterRun = parseBooleanArg(map.get('restore-after-run'), true);
  const startNewChat = parseBooleanArg(map.get('start-new-chat'), false);
  const workspaceDir = String(map.get('workspace-dir') || '').trim();
  const setDefaultWorkspace = parseBooleanArg(map.get('set-default-workspace'), false);
  const reportDir = String(map.get('report-dir') || '').trim();

  return {
    round,
    uxRoot,
    scenarioPath,
    headless,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    promptTimeoutMs: Number.isFinite(promptTimeoutMs) ? promptTimeoutMs : DEFAULT_PROMPT_TIMEOUT_MS,
    keepServer,
    expectExisting,
    apiKey,
    provider: provider === 'openai' ? 'openai' : (provider === 'anthropic' ? 'anthropic' : ''),
    apiBase,
    model,
    restoreAfterRun,
    startNewChat,
    workspaceDir,
    setDefaultWorkspace,
    reportDir: reportDir ? path.resolve(reportDir) : '',
  };
}

function readScenario(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Scenario file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : [];
  if (prompts.length === 0) {
    throw new Error(`Scenario prompts is empty: ${filePath}`);
  }
  return {
    name: String(parsed.name || 'UX Round'),
    description: String(parsed.description || ''),
    prompts: prompts.map((item, index) => ({
      id: String(item.id || `prompt-${index + 1}`),
      text: String(item.text || '').trim(),
      timeoutMs: Number.isFinite(item.timeoutMs) ? Number(item.timeoutMs) : undefined,
      postWaitMs: Number.isFinite(item.postWaitMs) ? Number(item.postWaitMs) : 600,
      note: String(item.note || ''),
      expectedTokens: Array.isArray(item.expectedTokens)
        ? item.expectedTokens.map((token) => String(token || '').trim()).filter(Boolean)
        : [],
      requireCompletionMarker: item.requireCompletionMarker !== false,
      captureScreenshot: item.captureScreenshot === true,
    })),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
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
        return true;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(600);
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
  console.log('[ux-runner] static web client missing/incomplete, running vite build ...');
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

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function hasRequiredMarker(value) {
  const normalized = String(value || '').replace(/\s+$/u, '');
  return REQUIRED_MARKERS.some((marker) => normalized.endsWith(marker));
}

function buildConfigOverride(args) {
  const override = {};
  if (args.provider) {
    override.provider = args.provider;
  }
  if (args.apiBase) {
    override.apiBase = args.apiBase;
  }
  if (args.model) {
    override.model = args.model;
  }
  return Object.keys(override).length > 0 ? override : null;
}

async function fetchSettingsSnapshot(baseUrl) {
  const response = await fetch(`${baseUrl}/api/settings`);
  if (!response.ok) {
    throw new Error(`Failed to fetch settings snapshot: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const profiles = Array.isArray(payload?.llmProfiles?.profiles) ? payload.llmProfiles.profiles : [];
  const defaultProfileId = String(payload?.llmProfiles?.defaultProfileId || profiles[0]?.id || 'default');
  const defaultProfile =
    profiles.find((profile) => String(profile?.id || '') === defaultProfileId) || profiles[0] || {};
  return {
    defaultProfileId,
    profiles,
    apiBase: String(defaultProfile?.apiBase || '').trim(),
    model: String(defaultProfile?.defaultModel || '').trim(),
    provider: String(defaultProfile?.provider || '').trim(),
    hasApiKey: Boolean(payload?.hasApiKey || defaultProfile?.hasApiKey),
  };
}

async function putSettingsProfileOverride(baseUrl, snapshot, override) {
  const defaultProfileId = snapshot.defaultProfileId;
  const profiles = snapshot.profiles.length > 0 ? snapshot.profiles : [{ id: defaultProfileId }];
  const nextProfiles = profiles.map((profile) => {
    const isDefault = String(profile?.id || '') === defaultProfileId;
    return {
      id: String(profile?.id || defaultProfileId),
      name: String(profile?.name || profile?.id || defaultProfileId),
      provider: isDefault && override.provider !== undefined ? override.provider : profile?.provider,
      apiBase: isDefault && override.apiBase !== undefined ? override.apiBase : profile?.apiBase,
      defaultModel: isDefault && override.model !== undefined ? override.model : profile?.defaultModel,
      maxOutputTokens: profile?.maxOutputTokens,
      contextWindowTokens: profile?.contextWindowTokens,
      enabled: profile?.enabled !== false,
      capabilities: profile?.capabilities,
    };
  });
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
    throw new Error(`Failed to update runtime settings: HTTP ${response.status} ${text}`);
  }
}

function extractHighlights(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || line.includes('建议') || line.includes('问题'));
}

function messageContentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      if (typeof item.text === 'string') {
        return item.text;
      }
      if (typeof item.content === 'string') {
        return item.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const scenario = readScenario(args.scenarioPath);
  const cliEntry = path.join(ROOT, 'dist', 'cli', 'dpagent.js');
  if (!fs.existsSync(cliEntry)) {
    throw new Error('Missing dist/cli/dpagent.js. Run npm run build first.');
  }

  ensureDir(args.uxRoot);
  ensureDir(path.join(args.uxRoot, 'workspace'));
  ensureDir(path.join(args.uxRoot, 'scenarios'));
  ensureDir(path.join(args.uxRoot, 'reports'));

  const reportId = `${args.round}-${timestampSlug()}`;
  const reportDir = args.reportDir || path.join(args.uxRoot, 'reports', reportId);
  const screenshotDir = path.join(reportDir, 'screenshots');
  const traceDir = path.join(reportDir, 'trace');
  ensureDir(reportDir);
  ensureDir(screenshotDir);
  ensureDir(traceDir);

  const summary = {
    round: args.round,
    scenario: {
      path: args.scenarioPath,
      name: scenario.name,
      description: scenario.description,
      promptCount: scenario.prompts.length,
    },
    workspace: args.uxRoot,
    startedAt: new Date().toISOString(),
    configOverride: {
      requested: buildConfigOverride(args),
      applied: false,
      restored: false,
      original: null,
    },
    session: {
      requestedWorkspaceDir: args.workspaceDir || null,
      startedFresh: args.startNewChat || Boolean(args.workspaceDir),
    },
    signals: {
      anomalies: [],
      notes: [],
      checkpoints: [],
      actions: [],
      promptResults: [],
      uiObservations: [],
      console: [],
      requestFailures: [],
      pageErrors: [],
    },
    artifacts: {
      reportDir,
      screenshotDir,
      serverStdout: path.join(traceDir, 'server.out.log'),
      serverStderr: path.join(traceDir, 'server.err.log'),
    },
  };

  const serverStdout = fs.createWriteStream(summary.artifacts.serverStdout, { flags: 'a' });
  const serverStderr = fs.createWriteStream(summary.artifacts.serverStderr, { flags: 'a' });

  function addAnomaly(type, message, metadata = {}) {
    summary.signals.anomalies.push({
      timestamp: new Date().toISOString(),
      type,
      message,
      metadata,
    });
  }

  let child = null;
  let browser = null;
  let page = null;
  const baseUrl = `http://localhost:${args.port}`;
  let usingExistingServer = false;
  let expectedNavigationUntil = 0;
  let serverHasApiKey = false;
  let originalSettings = null;
  let overrideApplied = false;
  let stableSessionId = '';

  async function collectUiObservation(label) {
    if (!page) {
      return;
    }
    const bodyText = (await page.textContent('body')) || '';
    const textarea = page.locator('textarea').first();
    const sendButton = page.getByTestId('chat-send').first();
    const cancelButton = page.getByTestId('chat-stop').first();
    const settingsButton = page.getByTestId('open-config').first();
    const planInputCard = page.getByTestId('plan-input-card').first();
    const pendingPlanBanner = page.getByTestId('pending-plan-input-banner').first();
    const assistantBlocks = page.locator('.markdown-content, .prose');
    const checkpointCount = summary.signals.checkpoints.length;
    const promptCount = summary.signals.promptResults.length;

    const observation = {
      timestamp: new Date().toISOString(),
      label,
      url: page.url(),
      hasTextarea: await textarea.isVisible().catch(() => false),
      hasSendButton: await sendButton.isVisible().catch(() => false),
      hasCancelButton: await cancelButton.isVisible().catch(() => false),
      hasSettingsButton: await settingsButton.isVisible().catch(() => false),
      hasPlanInputCard: await planInputCard.isVisible().catch(() => false),
      hasPendingPlanBanner: await pendingPlanBanner.isVisible().catch(() => false),
      assistantBlockCount: await assistantBlocks.count().catch(() => 0),
      apiKeyNotConfigured: bodyText.includes('API Key is not configured'),
      routeError: bodyText.includes('Cannot GET /'),
      contextTruncated: bodyText.includes('[CONTEXT_TRUNCATED]'),
      checkpointCount,
      promptCount,
    };
    summary.signals.uiObservations.push(observation);

    if (!observation.hasTextarea) {
      addAnomaly('ui_missing_textarea', `UI observation "${label}" missing textarea.`);
    }
    if (!observation.hasSendButton && !observation.hasCancelButton && !observation.hasPlanInputCard) {
      addAnomaly('ui_missing_send_button', `UI observation "${label}" missing send button.`);
    }
  }

  async function checkpoint(name, note = '') {
    const step = String(summary.signals.checkpoints.length + 1).padStart(2, '0');
    const fileName = `${step}-${name.replace(/[^a-zA-Z0-9-_]/g, '_')}.png`;
    const output = path.join(screenshotDir, fileName);
    if (page) {
      await page.screenshot({ path: output, fullPage: true });
    }
    summary.signals.checkpoints.push({
      timestamp: new Date().toISOString(),
      name,
      note,
      screenshot: output,
      url: page ? page.url() : '',
    });
  }

  async function visualClick(locator, actionName) {
    await locator.waitFor({ timeout: 10000, state: 'visible' });
    const box = await locator.boundingBox();
    summary.signals.actions.push({
      timestamp: new Date().toISOString(),
      actionName,
      box,
    });
    await checkpoint(`${actionName}-before`, 'pre-click');
    await locator.click();
    await checkpoint(`${actionName}-after`, 'post-click');
  }

  async function resolvePendingPlanInputIfPresent(timeoutMs = 45000) {
    const header = page.getByTestId('plan-input-card').first();
    const visible = await header.isVisible().catch(() => false);
    if (!visible) {
      return false;
    }

    addAnomaly('plan_input_pending', 'Detected pending plan input. Runner will auto-answer with first options.');
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const stillVisible = await header.isVisible().catch(() => false);
      if (!stillVisible) {
        return true;
      }

      const questionCards = page
        .locator('div.rounded-xl.border.p-3.space-y-3')
        .filter({ has: page.locator('input[type="radio"]') });
      const questionCount = await questionCards.count().catch(() => 0);

      for (let i = 0; i < questionCount; i += 1) {
        const radio = questionCards.nth(i).locator('input[type="radio"]').first();
        const radioVisible = await radio.isVisible().catch(() => false);
        if (radioVisible) {
          await radio.click();
        }
      }

      const submit = page.getByRole('button', { name: /Submit Answers|提交答案/i }).first();
      const submitVisible = await submit.isVisible().catch(() => false);
      if (!submitVisible) {
        addAnomaly('plan_input_submit_missing', 'Plan input card is visible but Submit Answers button is missing.');
        return false;
      }

      await visualClick(submit, 'submit-plan-input');
      await wait(700);
    }

    addAnomaly('plan_input_submit_timeout', `Plan input card stayed visible after ${timeoutMs}ms.`);
    return false;
  }

  async function waitForTurnCompletion(timeoutMs) {
    const textarea = page.locator('textarea').first();
    const cancelButton = page.getByTestId('chat-stop').first();
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      await resolvePendingPlanInputIfPresent(30000);
      const editable = await textarea.isEditable().catch(() => false);
      const cancelVisible = await cancelButton.isVisible().catch(() => false);
      const planPending = await page
        .getByTestId('plan-input-card')
        .first()
        .isVisible()
        .catch(() => false);

      if (editable && !cancelVisible && !planPending) {
        return true;
      }
      await wait(500);
    }

    return false;
  }

  async function waitForComposerReady(timeoutMs) {
    const textarea = page.locator('textarea').first();
    const cancelButton = page.getByTestId('chat-stop').first();
    const startedAt = Date.now();
    let cancelTriggered = false;

    while (Date.now() - startedAt < timeoutMs) {
      await resolvePendingPlanInputIfPresent(30000);
      const visible = await textarea.isVisible().catch(() => false);
      const editable = await textarea.isEditable().catch(() => false);
      if (visible && editable) {
        return true;
      }

      if (!cancelTriggered && Date.now() - startedAt > 20000) {
        const cancelVisible = await cancelButton.isVisible().catch(() => false);
        if (cancelVisible) {
          cancelTriggered = true;
          addAnomaly('previous_turn_force_cancel', 'Composer disabled for >20s, force canceled previous turn.');
          try {
            await visualClick(cancelButton, 'force-cancel-previous-turn');
          } catch (error) {
            addAnomaly(
              'force_cancel_click_failed',
              `Force-cancel click failed: ${error instanceof Error ? error.message : String(error)}.`
            );
          }
        }
      }
      await wait(500);
    }
    return false;
  }

  async function startFreshSessionIfNeeded() {
    if (!args.startNewChat && !args.workspaceDir) {
      return;
    }
    const newChatButton = page.getByTestId('sidebar-new-chat').first();
    const workspaceInput = page.getByTestId('workspace-dir-input').first();
    const workspaceDefaultToggle = page.getByTestId('workspace-default-toggle').first();
    const workspaceConfirm = page.getByTestId('workspace-confirm').first();

    await visualClick(newChatButton, 'start-new-chat');
    await workspaceInput.waitFor({ timeout: 15000, state: 'visible' });
    if (args.workspaceDir) {
      await workspaceInput.fill(args.workspaceDir);
    }
    const toggleVisible = await workspaceDefaultToggle.isVisible().catch(() => false);
    if (toggleVisible) {
      const checked = await workspaceDefaultToggle.isChecked().catch(() => false);
      if (args.setDefaultWorkspace && !checked) {
        await workspaceDefaultToggle.check();
      }
      if (!args.setDefaultWorkspace && checked) {
        await workspaceDefaultToggle.uncheck();
      }
    }
    await visualClick(workspaceConfirm, 'confirm-new-chat-workspace');
    await page.locator('textarea').first().waitFor({ timeout: 30000, state: 'visible' });
    await checkpoint('new-session-ready');
    await collectUiObservation('new-session-ready');
  }

  async function resolveCurrentSessionDetail() {
    let targetSessionId = String(summary.session?.id || '').trim();

    if (!targetSessionId) {
      const sessionsResponse = await fetch(`${baseUrl}/api/sessions`);
      if (!sessionsResponse.ok) {
        addAnomaly('sessions_api_error', `Failed to fetch /api/sessions: HTTP ${sessionsResponse.status}`);
        return null;
      }
      const sessionsPayload = await sessionsResponse.json();
      const sessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
      sessions.sort((a, b) => {
        const ta = Date.parse(String(a.updatedAt || ''));
        const tb = Date.parse(String(b.updatedAt || ''));
        return Number.isFinite(tb) && Number.isFinite(ta) ? tb - ta : 0;
      });
      if (sessions.length === 0) {
        return null;
      }
      let latest = sessions[0];
      if (args.workspaceDir) {
        const requestedWorkspaceDir = path.resolve(args.workspaceDir);
        const matchedByWorkspace = sessions.find(
          (item) => path.resolve(String(item.workspaceDir || '')) === requestedWorkspaceDir
        );
        if (matchedByWorkspace) {
          latest = matchedByWorkspace;
        }
      }
      targetSessionId = String(latest.id || '').trim();
      if (!targetSessionId) {
        return null;
      }
      summary.session = {
        ...summary.session,
        id: latest.id,
        updatedAt: latest.updatedAt || null,
        workspaceDir: latest.workspaceDir || null,
      };
    }

    const detailResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(targetSessionId)}`);
    if (!detailResponse.ok) {
      addAnomaly('session_detail_error', `Failed to fetch session detail for ${targetSessionId}: HTTP ${detailResponse.status}`);
      return null;
    }

    const detail = await detailResponse.json();
    if (!stableSessionId) {
      stableSessionId = targetSessionId;
    } else if (stableSessionId !== targetSessionId) {
      addAnomaly('session_changed_during_run', `Active session changed from ${stableSessionId} to ${targetSessionId}.`, {
        previousSessionId: stableSessionId,
        nextSessionId: targetSessionId,
      });
      stableSessionId = targetSessionId;
    }

    summary.session = {
      ...summary.session,
      id: targetSessionId,
      updatedAt: detail.updatedAt || summary.session?.updatedAt || null,
      workspaceDir: detail.workspaceDir || summary.session?.workspaceDir || null,
      detail,
    };
    return detail;
  }

  function extractLatestAssistantFromDetail(detail) {
    const messages = Array.isArray(detail?.messages) ? detail.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (String(message?.role || '') !== 'assistant') {
        continue;
      }
      const text = messageContentToText(message?.content).trim();
      if (text.length > 0) {
        return text;
      }
    }
    return '';
  }

  try {
    let serverReady = false;
    try {
      await waitForHttpReady(`${baseUrl}/api/settings`, 5000);
      serverReady = true;
    } catch {
      serverReady = false;
    }

    if (serverReady) {
      if (!args.expectExisting) {
        throw new Error(
          `Port ${args.port} already has a running server while expect-existing=false. Stop it or pass --expect-existing true.`
        );
      }
      usingExistingServer = true;
      summary.signals.notes.push({
        timestamp: new Date().toISOString(),
        type: 'reuse_existing_server',
        message: `Port ${args.port} is already in use. UX runner reused existing server.`,
        metadata: { port: args.port },
      });
    } else {
      if (args.expectExisting) {
        throw new Error(`Expected existing dev server on port ${args.port}, but it is not running.`);
      }
      const occupied = await isPortInUse(args.port);
      if (occupied) {
        throw new Error(`Port ${args.port} appears occupied, but /api/settings is not reachable.`);
      }
      await ensureWebClientBuild();
      child = spawn(process.execPath, [cliEntry, '--no-open'], {
        cwd: args.uxRoot,
        env: { ...process.env, DPAGENT_PORT: String(args.port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(serverStdout);
      child.stderr.pipe(serverStderr);
      child.on('error', (error) => {
        addAnomaly('server_spawn_error', error instanceof Error ? error.message : String(error));
      });
    }

    await waitForHttpReady(`${baseUrl}/api/settings`, 35000);
    try {
      originalSettings = await fetchSettingsSnapshot(baseUrl);
      serverHasApiKey = originalSettings.hasApiKey;
      summary.configOverride.original = {
        provider: originalSettings.provider,
        apiBase: originalSettings.apiBase,
        model: originalSettings.model,
      };
    } catch {
      // ignore and fallback to previous behavior
    }

    browser = await chromium.launch({ headless: args.headless });
    page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.setDefaultTimeout(30000);

    page.on('console', (msg) => {
      const level = msg.type();
      const text = msg.text();
      summary.signals.console.push({
        timestamp: new Date().toISOString(),
        level,
        text,
      });
      if (level === 'error') {
        addAnomaly('console_error', text);
      }
    });
    page.on('pageerror', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      summary.signals.pageErrors.push({
        timestamp: new Date().toISOString(),
        message,
      });
      addAnomaly('page_error', message);
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      const reason = failure ? failure.errorText : 'unknown';
      const isExpectedAbort = reason.includes('ERR_ABORTED') && Date.now() <= expectedNavigationUntil;
      const item = {
        timestamp: new Date().toISOString(),
        url: request.url(),
        method: request.method(),
        reason,
        ignored: isExpectedAbort,
      };
      summary.signals.requestFailures.push(item);
      if (!isExpectedAbort) {
        addAnomaly('request_failed', `${item.method} ${item.url}`, item);
      }
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await wait(800);
    await checkpoint('home-loaded');
    await collectUiObservation('home-loaded');

    const bodyText = (await page.textContent('body')) || '';
    if (bodyText.includes('Cannot GET /')) {
      addAnomaly('route_error', 'Main page returned "Cannot GET /".');
    }

    if (args.apiKey && !serverHasApiKey) {
      const passwordInput = page.locator('input[type="password"]').first();
      const modalAlreadyOpen = await passwordInput.isVisible().catch(() => false);
      if (!modalAlreadyOpen) {
        const settingsButton = page.getByTestId('open-config').first();
        await visualClick(settingsButton, 'open-settings');
      }
      await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
      await passwordInput.fill(args.apiKey);
      await checkpoint('api-key-filled');
      const saveButton = page.getByTestId('config-save-reload').first();
      expectedNavigationUntil = Date.now() + 8000;
      await visualClick(saveButton, 'save-settings');
      await page.waitForLoadState('domcontentloaded');
      await wait(1200);
      await checkpoint('settings-saved');
    } else if (args.apiKey && serverHasApiKey) {
      summary.signals.notes.push({
        timestamp: new Date().toISOString(),
        type: 'api_key_already_configured',
        message: 'Server already has API key configured. UX runner skipped settings write.',
        metadata: {},
      });
    } else {
      if (!usingExistingServer) {
        addAnomaly(
          'missing_api_key',
          'UX_API_KEY is empty. Runner continues in observe-only mode and chat may be blocked.',
          { env: 'UX_API_KEY' }
        );
      } else {
        summary.signals.notes.push({
          timestamp: new Date().toISOString(),
          type: 'api_key_not_injected',
          message:
            'UX_API_KEY is empty, but existing dev server is reused. Runner assumes dev server already has usable key.',
          metadata: {},
        });
      }
    }

    const requestedOverride = buildConfigOverride(args);
    if (requestedOverride) {
      if (!originalSettings) {
        originalSettings = await fetchSettingsSnapshot(baseUrl);
        summary.configOverride.original = {
          provider: originalSettings.provider,
          apiBase: originalSettings.apiBase,
          model: originalSettings.model,
        };
      }
      const needsOverride =
        requestedOverride.provider !== undefined && requestedOverride.provider !== originalSettings.provider
        || requestedOverride.apiBase !== undefined && requestedOverride.apiBase !== originalSettings.apiBase
        || requestedOverride.model !== undefined && requestedOverride.model !== originalSettings.model;
      if (needsOverride) {
        await putSettingsProfileOverride(baseUrl, originalSettings, requestedOverride);
        overrideApplied = true;
        summary.configOverride.applied = true;
        expectedNavigationUntil = Date.now() + 8000;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await wait(1200);
        await checkpoint('config-override-applied');
        await collectUiObservation('config-override-applied');
      }
    }

    await startFreshSessionIfNeeded();

    const textarea = page.locator('textarea').first();

    for (const prompt of scenario.prompts) {
      if (!prompt.text) {
        addAnomaly('empty_prompt', `Prompt "${prompt.id}" is empty and skipped.`);
        continue;
      }
      const promptStart = Date.now();
      const perPromptTimeout = prompt.timeoutMs || args.promptTimeoutMs;
      const composerReady = await waitForComposerReady(Math.max(30000, Math.min(perPromptTimeout, 240000)));
      if (!composerReady) {
        addAnomaly('composer_not_ready', `Prompt "${prompt.id}" skipped because composer stayed disabled.`);
        await checkpoint(`prompt-${prompt.id}-composer-not-ready`);
        continue;
      }
      await resolvePendingPlanInputIfPresent(30000);
      await textarea.fill(prompt.text);
      await checkpoint(`prompt-${prompt.id}-filled`, prompt.note || '');

      const sendButton = page.getByTestId('chat-send').first();
      const sendVisible = await sendButton.isVisible().catch(() => false);
      if (!sendVisible) {
        await resolvePendingPlanInputIfPresent(30000);
      }
      const sendVisibleAfterResolve = await sendButton.isVisible().catch(() => false);
      if (!sendVisibleAfterResolve) {
        addAnomaly('send_button_unavailable', `Prompt "${prompt.id}" skipped because send button is unavailable.`);
        await checkpoint(`prompt-${prompt.id}-send-unavailable`);
        continue;
      }
      try {
        await visualClick(sendButton, `prompt-${prompt.id}-send`);
      } catch (error) {
        addAnomaly(
          'send_click_failed',
          `Prompt "${prompt.id}" send click failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await checkpoint(`prompt-${prompt.id}-send-failed`);
        continue;
      }

      const cancelButton = page.getByTestId('chat-stop').first();
      let started = false;
      try {
        await cancelButton.waitFor({ state: 'visible', timeout: 8000 });
        started = true;
      } catch {
        started = false;
      }

      if (started) {
        const completed = await waitForTurnCompletion(perPromptTimeout);
        if (!completed) {
          addAnomaly('run_finish_timeout', `Prompt "${prompt.id}" did not finish within ${perPromptTimeout}ms.`);
        }
      } else {
        await wait(1200);
        const remainingInput = (await textarea.inputValue()).trim();
        if (remainingInput.length > 0) {
          addAnomaly(
            'send_not_dispatched',
            `Prompt "${prompt.id}" may not be dispatched (input remained non-empty after send click).`,
            { remainingInputLength: remainingInput.length }
          );
        }
      }

      await wait(prompt.postWaitMs);
      const durationMs = Date.now() - promptStart;
      if (durationMs > 60000) {
        addAnomaly('slow_response', `Prompt "${prompt.id}" took ${durationMs}ms.`, { durationMs });
      }

      const pageSnapshot = (await page.textContent('body')) || '';
      if (pageSnapshot.includes('API Key is not configured')) {
        addAnomaly('chat_blocked', `Prompt "${prompt.id}" blocked by API key check.`);
      }
      if (pageSnapshot.includes('[CONTEXT_TRUNCATED]')) {
        addAnomaly('context_truncated', `Prompt "${prompt.id}" page content includes [CONTEXT_TRUNCATED].`);
      }
      if (pageSnapshot.toLowerCase().includes('context window exceeded')) {
        addAnomaly('context_overflow', `Prompt "${prompt.id}" surfaced context overflow message.`);
      }

      const sessionDetail = await resolveCurrentSessionDetail();
      const assistantBlocks = await page.locator('.markdown-content, .prose').allTextContents();
      const latestAssistantFromUi = assistantBlocks.length > 0 ? assistantBlocks[assistantBlocks.length - 1] : '';
      const latestAssistant = extractLatestAssistantFromDetail(sessionDetail) || latestAssistantFromUi;
      const highlights = extractHighlights(latestAssistant).slice(0, 10);
      const missingTokens = prompt.expectedTokens.filter(
        (token) => !normalizeLower(latestAssistant).includes(normalizeLower(token))
      );
      const completionMarkerMatched = prompt.requireCompletionMarker ? hasRequiredMarker(latestAssistant) : null;
      const promptOk = missingTokens.length === 0 && (completionMarkerMatched === null || completionMarkerMatched === true);
      let promptScreenshotPath = null;
      if (prompt.captureScreenshot) {
        promptScreenshotPath = path.join(screenshotDir, `${prompt.id.replace(/[^a-zA-Z0-9-_]/g, '_')}.png`);
        await page.screenshot({ path: promptScreenshotPath, fullPage: true });
      }
      if (missingTokens.length > 0) {
        addAnomaly('prompt_expected_tokens_missing', `Prompt "${prompt.id}" missed expected tokens.`, {
          promptId: prompt.id,
          missingTokens,
        });
      }
      if (prompt.requireCompletionMarker && completionMarkerMatched === false) {
        addAnomaly('completion_marker_missing', `Prompt "${prompt.id}" missing required completion marker.`, {
          promptId: prompt.id,
        });
      }

      summary.signals.promptResults.push({
        id: prompt.id,
        note: prompt.note,
        prompt: prompt.text,
        durationMs,
        latestAssistant,
        highlights,
        expectedTokens: prompt.expectedTokens,
        missingTokens,
        completionMarkerMatched,
        ok: promptOk,
        screenshotPath: promptScreenshotPath,
      });
      await checkpoint(`prompt-${prompt.id}-done`);
      await collectUiObservation(`prompt-${prompt.id}-done`);
    }

    const hasAssistantOutput = summary.signals.promptResults.some(
      (item) => String(item.latestAssistant || '').trim().length > 0
    );
    if (!hasAssistantOutput) {
      addAnomaly(
        'no_assistant_output',
        'No assistant markdown blocks were captured from this run. Check API key validity, model access, and backend errors.'
      );
    }

    await resolveCurrentSessionDetail();
  } finally {
    if (overrideApplied && args.restoreAfterRun && originalSettings) {
      try {
        await putSettingsProfileOverride(baseUrl, originalSettings, {
          provider: originalSettings.provider,
          apiBase: originalSettings.apiBase,
          model: originalSettings.model,
        });
        summary.configOverride.restored = true;
      } catch (error) {
        addAnomaly(
          'config_restore_failed',
          `Failed to restore config override: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (page) {
      try {
        await checkpoint('runner-finished');
        await collectUiObservation('runner-finished');
      } catch {
        // ignore
      }
    }
    if (browser) {
      await browser.close();
    }
    if (!args.keepServer && child) {
      await stopChildProcess(child);
    }
    serverStdout.end();
    serverStderr.end();
    summary.finishedAt = new Date().toISOString();
    summary.server = {
      reusedExistingServer: usingExistingServer,
      keepServer: args.keepServer,
    };
    summary.metrics = {
      promptCount: summary.signals.promptResults.length,
      promptPassCount: summary.signals.promptResults.filter((item) => item.ok).length,
      promptFailCount: summary.signals.promptResults.filter((item) => item.ok === false).length,
      missingTokenCount: summary.signals.promptResults.reduce(
        (count, item) => count + (Array.isArray(item.missingTokens) ? item.missingTokens.length : 0),
        0
      ),
      completionMarkerMissCount: summary.signals.promptResults.filter(
        (item) => item.completionMarkerMatched === false
      ).length,
      anomalyCount: summary.signals.anomalies.length,
      consoleErrorCount: summary.signals.console.filter((item) => item.level === 'error').length,
      requestFailureCount: summary.signals.requestFailures.filter((item) => item.ignored !== true).length,
    };

    const reportJsonPath = path.join(reportDir, 'ux-report.json');
    writeJson(reportJsonPath, summary);

    const markdownLines = [
      `# UX Iteration Report - ${args.round}`,
      '',
      `- Scenario: ${scenario.name}`,
      `- Workspace: ${args.uxRoot}`,
      `- Started: ${summary.startedAt}`,
      `- Finished: ${summary.finishedAt}`,
      `- Prompt Count: ${summary.metrics.promptCount}`,
      `- Prompt Pass Count: ${summary.metrics.promptPassCount}`,
      `- Prompt Fail Count: ${summary.metrics.promptFailCount}`,
      `- Missing Token Count: ${summary.metrics.missingTokenCount}`,
      `- Completion Marker Miss Count: ${summary.metrics.completionMarkerMissCount}`,
      `- Anomaly Count: ${summary.metrics.anomalyCount}`,
      '',
      '## Anomalies',
    ];
    if (summary.signals.anomalies.length === 0) {
      markdownLines.push('- None observed');
    } else {
      for (const item of summary.signals.anomalies) {
        markdownLines.push(`- [${item.type}] ${item.message}`);
      }
    }
    markdownLines.push('', '## Prompt Highlights');
    if (summary.signals.promptResults.length === 0) {
      markdownLines.push('- No prompt result captured');
    } else {
      for (const result of summary.signals.promptResults) {
        markdownLines.push(
          `- ${result.id} (${result.durationMs}ms) ok=${result.ok} missing=${Array.isArray(result.missingTokens) ? result.missingTokens.join(',') || 'none' : 'none'} marker=${result.completionMarkerMatched}`
        );
        if (result.highlights.length > 0) {
          for (const line of result.highlights.slice(0, 4)) {
            markdownLines.push(`  - ${line}`);
          }
        } else {
          markdownLines.push('  - (No structured bullet-like highlights detected)');
        }
        if (result.screenshotPath) {
          markdownLines.push(`  - screenshot: ${result.screenshotPath}`);
        }
      }
    }
    markdownLines.push('', '## UI Observations');
    if (summary.signals.uiObservations.length === 0) {
      markdownLines.push('- None captured');
    } else {
      for (const item of summary.signals.uiObservations.slice(-10)) {
        markdownLines.push(
          `- ${item.label}: textarea=${item.hasTextarea}, send=${item.hasSendButton}, assistantBlocks=${item.assistantBlockCount}, apiKeyBanner=${item.apiKeyNotConfigured}, routeError=${item.routeError}`
        );
      }
    }
    markdownLines.push(
      '',
      '## Config Override',
      `- Requested: ${summary.configOverride.requested ? JSON.stringify(summary.configOverride.requested) : 'none'}`,
      `- Applied: ${summary.configOverride.applied}`,
      `- Restored: ${summary.configOverride.restored}`,
      '',
      '## Artifacts',
      `- JSON: ${reportJsonPath}`,
      `- Screenshots: ${screenshotDir}`,
      `- Server stdout: ${summary.artifacts.serverStdout}`,
      `- Server stderr: ${summary.artifacts.serverStderr}`
    );

    const reportMdPath = path.join(reportDir, 'ux-report.md');
    fs.writeFileSync(reportMdPath, `${markdownLines.join('\n')}\n`, 'utf8');

    console.log(`[ux-runner] round=${args.round}`);
    console.log(`[ux-runner] report json: ${reportJsonPath}`);
    console.log(`[ux-runner] report md: ${reportMdPath}`);
    console.log(`[ux-runner] anomalies observed: ${summary.metrics.anomalyCount}`);
    if (summary.metrics.anomalyCount > 0) {
      console.log('[ux-runner] note: anomalies are observational signals, not hard release gates.');
    }
  }
}

run().catch((error) => {
  console.error(`[ux-runner] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
