#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { chromium } = require('playwright');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null);
    return payload && payload.status === 'ok';
  } catch {
    return false;
  }
}

function resolveNpmLauncher() {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath],
      shell: false,
    };
  }

  const bundledNpmCli = path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundledNpmCli)) {
    return {
      command: process.execPath,
      args: [bundledNpmCli],
      shell: false,
    };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
    shell: process.platform === 'win32',
  };
}

async function waitForServerReady(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(baseUrl)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for smoke server: ${baseUrl}`);
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
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function readProjectApiConfig() {
  const configPath = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'));
    if (parsed && parsed.api && typeof parsed.api === 'object') {
      return parsed.api;
    }
  } catch {
    // ignore invalid config during smoke fallback resolution
  }
  return {};
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

function isLocalSmokeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve local smoke port.')));
        return;
      }
      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function ensureSmokeServer(baseUrl) {
  const parsedUrl = new URL(baseUrl);
  const host = parsedUrl.hostname;
  const isLocalhost = host === '127.0.0.1' || host === 'localhost';
  if (await isServerReady(baseUrl)) {
    return { child: null, startedLocally: false, baseUrl };
  }
  if (!isLocalhost) {
    throw new Error(`Smoke target is unavailable and not local: ${baseUrl}`);
  }

  const port = await reserveLocalPort();
  const actualBaseUrl = `${parsedUrl.protocol}//127.0.0.1:${port}`;
  const launcher = resolveNpmLauncher();
  const child = spawn(launcher.command, [...launcher.args, 'run', 'start:web'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: {
      ...process.env,
      MINIMAX_PORT: String(port),
      MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT: '1',
    },
    shell: launcher.shell,
  });

  let outputBuffer = '';
  const captureChunk = (chunk) => {
    outputBuffer = `${outputBuffer}${String(chunk || '')}`.slice(-4000);
  };
  child.stdout?.on('data', captureChunk);
  child.stderr?.on('data', captureChunk);

  try {
    await waitForServerReady(actualBaseUrl, 45000);
    return { child, startedLocally: true, baseUrl: actualBaseUrl };
  } catch (error) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const suffix = outputBuffer.trim() ? `\nserver output:\n${outputBuffer.trim()}` : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}

async function stopSmokeServer(child) {
  if (!child) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      // ignore
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }

  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          shell: false,
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk || '');
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function extractTextFromAnthropicContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        return block.content;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function resolveMockAssistantText(messages) {
  const lastUserMessage = Array.isArray(messages)
    ? [...messages].reverse().find((message) => message && message.role === 'user')
    : null;
  const userText = extractTextFromAnthropicContent(lastUserMessage?.content).trim();
  const exactReplyMatch = userText.match(/reply with exactly:\s*([\s\S]+)/i);
  if (exactReplyMatch && exactReplyMatch[1]) {
    return exactReplyMatch[1].trim();
  }
  if (userText) {
    return `smoke-echo: ${userText.slice(0, 120)}`;
  }
  return 'smoke-ui-ok';
}

function buildMockAnthropicMessage(body, responseText, messageId) {
  const model = String(body?.model || 'smoke-ui-model');
  const outputTokens = Math.max(1, Math.ceil(responseText.length / 4));
  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      {
        type: 'text',
        text: responseText,
        citations: null,
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: outputTokens,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startSmokeProviderServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { status: 'ok' });
        return;
      }
      if (
        req.method !== 'POST' ||
        (url.pathname !== '/messages' && url.pathname !== '/v1/messages' && url.pathname !== '/v1/v1/messages')
      ) {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }

      const body = await readJsonBody(req);
      const responseText = resolveMockAssistantText(body?.messages);
      const messageId = `msg_smoke_${randomUUID()}`;
      const requestId = `req_smoke_${randomUUID()}`;
      const message = buildMockAnthropicMessage(body, responseText, messageId);

      if (body?.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-request-id': requestId,
        });
        res.flushHeaders?.();

        writeSseEvent(res, 'message_start', {
          type: 'message_start',
          message: {
            ...message,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              ...message.usage,
              output_tokens: 0,
            },
          },
        });
        writeSseEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: '',
            citations: null,
          },
        });
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: responseText,
          },
        });
        writeSseEvent(res, 'content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        });
        writeSseEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: 'end_turn',
            stop_sequence: null,
          },
          usage: {
            output_tokens: message.usage.output_tokens,
          },
        });
        writeSseEvent(res, 'message_stop', {
          type: 'message_stop',
        });
        res.end();
        return;
      }

      writeJson(res, 200, message, { 'x-request-id': requestId });
    } catch (error) {
      writeJson(
        res,
        500,
        {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
        { 'x-request-id': `req_smoke_${randomUUID()}` }
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to resolve local smoke provider address.');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function stopSmokeProviderServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForNonEmptyAssistantMessage(page, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const blocks = await page
      .locator('.message-width-assistant .markdown-content, .message-width-assistant .prose')
      .allTextContents()
      .catch(() => []);
    const latest = Array.isArray(blocks)
      ? blocks
          .map((item) => String(item || '').trim())
          .filter((item) => item.length > 0)
          .pop() || ''
      : '';
    if (latest.length > 0) {
      return latest;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for assistant output after ${timeoutMs}ms.`);
}

function extractExpectedAssistantText(prompt) {
  const normalized = String(prompt || '').trim();
  const match = normalized.match(/^reply with exactly:\s*(.+)$/i);
  if (!match) {
    return '';
  }
  return String(match[1] || '').trim();
}

async function assertChatRailAlignment(page) {
  const composer = await page.locator('.chat-composer-card').first().boundingBox();
  const transcript = await page.locator('.chat-transcript').first().boundingBox();
  if (!composer || !transcript) {
    throw new Error('Chat rail alignment target is missing.');
  }
  const railTolerance = 3;
  if (Math.abs(composer.x - transcript.x) > railTolerance) {
    throw new Error(`Composer left edge is not aligned with transcript: ${composer.x} vs ${transcript.x}`);
  }
  if (Math.abs(composer.x + composer.width - (transcript.x + transcript.width)) > railTolerance) {
    throw new Error('Composer right edge is not aligned with transcript.');
  }

  const assistant = await page.locator('.message-width-assistant').last().boundingBox().catch(() => null);
  if (assistant) {
    if (Math.abs(assistant.x - transcript.x) > railTolerance) {
      throw new Error(`Assistant row left edge is not aligned with transcript: ${assistant.x} vs ${transcript.x}`);
    }
    if (Math.abs(assistant.x + assistant.width - (transcript.x + transcript.width)) > railTolerance) {
      throw new Error('Assistant row right edge is not aligned with transcript.');
    }
  }

  const user = await page.locator('.message-width-user').last().boundingBox().catch(() => null);
  if (user) {
    if (user.x + user.width > transcript.x + transcript.width + railTolerance) {
      throw new Error('User bubble overflows the transcript right edge.');
    }
    if (user.width > transcript.width / 3 + railTolerance) {
      throw new Error(`User bubble is wider than one third of transcript: ${user.width} > ${transcript.width / 3}`);
    }
  }
}

async function launchSmokeBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) {
      throw error;
    }
    for (const channel of ['chrome', 'msedge']) {
      try {
        console.warn(`[smoke-ui] bundled Chromium missing; falling back to ${channel}`);
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

async function openSettingsModal(page) {
  const saveButton = page.getByTestId('config-save-reload').first();
  if (await saveButton.isVisible().catch(() => false)) {
    return;
  }
  const settingsButton = page.getByTestId('open-config').first();
  await settingsButton.waitFor({ timeout: 10000, state: 'visible' });
  await settingsButton.click();
}

async function waitForConfigSettingsReady(page) {
  const otherTab = page.getByTestId('config-tab-other').first();
  await otherTab.waitFor({ timeout: 10000, state: 'visible' });
  await otherTab.click();
  const toggle = page.getByTestId('config-completion-marker-toggle').first();
  await toggle.waitFor({ timeout: 10000, state: 'visible' });
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="config-completion-marker-toggle"]');
      return input instanceof HTMLInputElement && input.disabled === false;
    },
    undefined,
    { timeout: 10000 }
  );
  return toggle;
}

async function saveConfigAndWaitForReload(page) {
  const saveButton = page.getByTestId('config-save-reload').first();
  await saveButton.waitFor({ timeout: 10000, state: 'visible' });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('[data-testid="config-save-reload"]');
      return button instanceof HTMLButtonElement && button.disabled === false;
    },
    undefined,
    { timeout: 10000 }
  );
  await saveButton.click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);
}

function readSmokeRuntimeConfig(explicitApiKey) {
  const configApi = readProjectApiConfig();
  return {
    apiKey: firstNonEmptyString(
      explicitApiKey,
      process.env.MINIMAX_API_KEY,
      parseEnvFileValue(path.join(process.cwd(), '.env'), 'MINIMAX_API_KEY'),
      configApi.apiKey
    ),
    apiBase: firstNonEmptyString(process.env.SMOKE_API_BASE, process.env.MINIMAX_API_BASE, configApi.apiBase),
    model: firstNonEmptyString(process.env.SMOKE_MODEL, process.env.MINIMAX_MODEL, configApi.model),
    provider: firstNonEmptyString(process.env.SMOKE_PROVIDER, process.env.MINIMAX_PROVIDER, configApi.provider),
    maxOutputTokens: firstNonEmptyString(
      process.env.SMOKE_MAX_OUTPUT_TOKENS,
      process.env.MINIMAX_MAX_OUTPUT_TOKENS,
      process.env.MINIMAX_API_MAX_OUTPUT_TOKENS,
      configApi.maxOutputTokens
    ),
  };
}

function hasRuntimeConfigOverride(runtimeConfig) {
  return Boolean(
    runtimeConfig.apiBase ||
      runtimeConfig.model ||
      runtimeConfig.provider ||
      runtimeConfig.maxOutputTokens
  );
}

async function applySmokeRuntimeConfig(baseUrl, runtimeConfig) {
  const body = {};
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (value) {
      if (key === 'maxOutputTokens') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          body[key] = parsed;
        }
      } else {
        body[key] = value;
      }
    }
  }
  if (Object.keys(body).length === 0) {
    return;
  }

  const response = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Unable to apply smoke runtime config: HTTP ${response.status}`);
  }
  console.log('[smoke-ui] applied runtime config for smoke target');
}

async function main() {
  const url = process.env.SMOKE_URL || 'http://localhost:53721';
  const explicitSmokeApiKey = String(process.env.SMOKE_API_KEY || '').trim();
  const configPath = path.join(process.cwd(), 'config.yaml');
  const originalConfigYaml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  const runtimeConfig = readSmokeRuntimeConfig(explicitSmokeApiKey);
  const noSettingsWrite = process.env.SMOKE_NO_SETTINGS_WRITE === '1';
  const outputDir = process.env.SMOKE_OUTPUT_DIR || path.join(process.cwd(), 'logs');
  const dispatchTimeoutMs = Number.parseInt(process.env.SMOKE_DISPATCH_TIMEOUT_MS || '10000', 10);
  const responseTimeoutMs = Number.parseInt(process.env.SMOKE_RESPONSE_TIMEOUT_MS || '90000', 10);
  const prompt = process.env.SMOKE_PROMPT || 'Reply with exactly: smoke-ui-ok';
  const expectedAssistantText = extractExpectedAssistantText(prompt);
  fs.mkdirSync(outputDir, { recursive: true });
  let smokeServer = { child: null, startedLocally: false, baseUrl: url };
  let mockProvider = null;
  let browser;
  let page;
  let smokeCreatedConfigYaml = null;
  try {
    smokeServer = await ensureSmokeServer(url);
    const targetUrl = smokeServer.baseUrl;
    if (!runtimeConfig.apiKey && isLocalSmokeUrl(targetUrl)) {
      mockProvider = await startSmokeProviderServer();
      runtimeConfig.apiKey = 'smoke-test-api-key-0123456789';
      runtimeConfig.apiBase = mockProvider.baseUrl;
      runtimeConfig.provider = 'anthropic';
      runtimeConfig.model = 'smoke-ui-model';
      if (!runtimeConfig.maxOutputTokens) {
        runtimeConfig.maxOutputTokens = '256';
      }
      console.log('[smoke-ui] using mock provider fallback for local smoke server');
    } else if (smokeServer.startedLocally) {
      console.log('[smoke-ui] using configured provider for local smoke target');
    }
    if (!noSettingsWrite && hasRuntimeConfigOverride(runtimeConfig)) {
      await applySmokeRuntimeConfig(targetUrl, runtimeConfig);
    }
    browser = await launchSmokeBrowser();
    page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(800);

    const firstBodyText = await page.textContent('body');
    if ((firstBodyText || '').includes('Cannot GET /')) {
      throw new Error('UI root route failed: server returned "Cannot GET /".');
    }

    let hasApiKey = false;
    try {
      const configResponse = await fetch(`${targetUrl}/api/config`);
      if (configResponse.ok) {
        const payload = await configResponse.json();
        hasApiKey = Boolean(payload?.hasApiKey || payload?.api?.hasApiKey);
      }
    } catch {
      // ignore config detection failure; fallback below
    }

    if (!noSettingsWrite && !hasApiKey && !runtimeConfig.apiKey) {
      throw new Error(
        'Existing smoke target has no API key. Set SMOKE_API_KEY explicitly or use an unused SMOKE_URL so smoke can start an isolated server.'
      );
    }

    if (!noSettingsWrite && !hasApiKey) {
      const passwordInput = page.locator('input[type="password"]').first();
      const modalAlreadyOpen = await passwordInput.isVisible().catch(() => false);
      if (!modalAlreadyOpen) {
        await openSettingsModal(page);
        await passwordInput.waitFor({ timeout: 10000 });
      }
      await passwordInput.fill(runtimeConfig.apiKey);
      await saveConfigAndWaitForReload(page);
    } else if (noSettingsWrite) {
      console.log('[smoke-ui] settings write disabled by SMOKE_NO_SETTINGS_WRITE=1');
    }
    if (originalConfigYaml === null && fs.existsSync(configPath)) {
      smokeCreatedConfigYaml = fs.readFileSync(configPath, 'utf8');
    }

    if (!noSettingsWrite) {
      const settingsResponse = await fetch(`${targetUrl}/api/settings`);
      if (!settingsResponse.ok) {
        throw new Error(`Unable to load settings for smoke verification: ${settingsResponse.status}`);
      }
      const settingsPayload = await settingsResponse.json();
      const originalCompletionMarker = settingsPayload?.agent?.completionMarkerEnforcementEnabled === true;
      const toggledCompletionMarker = !originalCompletionMarker;

      await openSettingsModal(page);
      let completionMarkerToggle = await waitForConfigSettingsReady(page);
      const initialCompletionMarker = await completionMarkerToggle.isChecked();
      if (initialCompletionMarker !== originalCompletionMarker) {
        throw new Error(
          `Completion marker toggle mismatch before save: expected ${originalCompletionMarker}, got ${initialCompletionMarker}.`
        );
      }
      if (toggledCompletionMarker) {
        await completionMarkerToggle.check();
      } else {
        await completionMarkerToggle.uncheck();
      }
      await saveConfigAndWaitForReload(page);

      await openSettingsModal(page);
      completionMarkerToggle = await waitForConfigSettingsReady(page);
      const persistedCompletionMarker = await completionMarkerToggle.isChecked();
      if (persistedCompletionMarker !== toggledCompletionMarker) {
        throw new Error(
          `Completion marker toggle did not persist: expected ${toggledCompletionMarker}, got ${persistedCompletionMarker}.`
        );
      }
      if (originalCompletionMarker) {
        await completionMarkerToggle.check();
      } else {
        await completionMarkerToggle.uncheck();
      }
      await saveConfigAndWaitForReload(page);
    }

    const expectedDefaultWorkspace = process.env.SMOKE_DEFAULT_WORKSPACE || './workspace-smoke-default';
    const newChatButton = page.getByTestId('sidebar-new-chat').first();
    const workspaceInput = page.getByTestId('workspace-dir-input').first();
    const workspaceDefaultToggle = page.getByTestId('workspace-default-toggle').first();
    const workspaceConfirm = page.getByTestId('workspace-confirm').first();
    const workspaceCancel = page.getByTestId('workspace-cancel').first();

    await newChatButton.waitFor({ timeout: 30000, state: 'visible' });
    await newChatButton.click();
    await workspaceInput.waitFor({ timeout: 10000, state: 'visible' });
    await workspaceInput.fill(expectedDefaultWorkspace);
    const isDefaultChecked = await workspaceDefaultToggle.isChecked().catch(() => false);
    if (!isDefaultChecked) {
      await workspaceDefaultToggle.check();
    }
    await workspaceConfirm.click();

    await newChatButton.click();
    await workspaceInput.waitFor({ timeout: 10000, state: 'visible' });
    const prefilledWorkspace = (await workspaceInput.inputValue()).trim();
    if (prefilledWorkspace !== expectedDefaultWorkspace) {
      throw new Error(
        `Default workspace mismatch: expected "${expectedDefaultWorkspace}", got "${prefilledWorkspace}".`
      );
    }
    await workspaceCancel.click();

    const automationNav = page.getByTestId('sidebar-open-automations').first();
    await automationNav.click();
    await page.getByTestId('automation-center').first().waitFor({ timeout: 10000, state: 'visible' });
    const automationName = `smoke-auto-${Date.now()}`;
    const minuteValue = (new Date().getMinutes() + 1) % 60;
    await page.getByTestId('automation-name-input').first().fill(automationName);
    await page.getByTestId('automation-prompt-input').first().fill('Reply with exactly: automation-smoke-ok');
    await page.getByTestId('automation-workspace-input').first().fill(expectedDefaultWorkspace);
    await page.getByTestId('automation-frequency-option-hourly').first().click();
    await page.getByTestId('automation-minute-input').first().fill(String(minuteValue));
    await page.getByTestId('automation-create-submit').first().click();
    await page.getByTestId('automation-job-item').first().waitFor({ timeout: 10000, state: 'visible' });
    const automationAppeared = await page
      .waitForFunction(
        (name) => String(document.body?.innerText || '').includes(String(name || '')),
        automationName,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!automationAppeared) {
      throw new Error('Automation creation did not appear in task list.');
    }
    const createdAutomation = page.getByTestId('automation-job-item').filter({ hasText: automationName }).first();
    await createdAutomation.click();
    let deleteDialogMessage = '';
    page.once('dialog', async (dialog) => {
      deleteDialogMessage = dialog.message();
      await dialog.accept();
    });
    await page.getByTestId('automation-delete').first().click();
    if (!deleteDialogMessage.includes(automationName)) {
      throw new Error(`Unexpected automation delete confirmation: ${deleteDialogMessage}`);
    }
    const automationDeleted = await page
      .waitForFunction(
        (name) => !String(document.body?.innerText || '').includes(String(name || '')),
        automationName,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!automationDeleted) {
      throw new Error('Automation deletion did not remove the task from the list.');
    }
    await newChatButton.click();
    await workspaceInput.waitFor({ timeout: 10000, state: 'visible' });
    await workspaceCancel.click();

    const chatInput = page.locator('textarea').first();
    const sendButton = page.getByTestId('chat-send').first();
    const stopButton = page.getByTestId('chat-stop').first();

    await chatInput.waitFor({ timeout: 30000, state: 'visible' });
    if (!(await sendButton.isVisible().catch(() => false))) {
      throw new Error('Primary send button is not visible before dispatch.');
    }

    await chatInput.fill(prompt);
    await sendButton.click();

    await Promise.race([
      stopButton.waitFor({ timeout: dispatchTimeoutMs, state: 'visible' }),
      page.locator('.markdown-content, .prose').first().waitFor({ timeout: dispatchTimeoutMs, state: 'visible' }),
    ]).catch(() => {
      throw new Error(`Chat dispatch did not surface stop state or assistant output within ${dispatchTimeoutMs}ms.`);
    });

    let latestAssistant = '';
    if (expectedAssistantText) {
      await page
        .waitForFunction(
          (expected) =>
            Array.from(document.querySelectorAll('.message-width-assistant')).some((node) =>
              String(node.textContent || '').includes(String(expected || ''))
            ),
          expectedAssistantText,
          { timeout: responseTimeoutMs }
        )
        .catch(() => {
          throw new Error(`Timed out waiting for assistant output after ${responseTimeoutMs}ms.`);
        });
      latestAssistant = expectedAssistantText;
    } else {
      latestAssistant = await waitForNonEmptyAssistantMessage(page, responseTimeoutMs);
    }
    await sendButton.waitFor({ timeout: 30000, state: 'visible' });

    const finalText = await page.textContent('body');
    if ((finalText || '').includes('API Key is not configured')) {
      throw new Error('Chat still blocked by missing API key after UI save.');
    }
    if (!String(finalText || '').includes(latestAssistant)) {
      throw new Error('Assistant output was not retained in final page text.');
    }
    await assertChatRailAlignment(page);

    const screenshotPath = path.join(outputDir, 'playwright-smoke-ui.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[smoke-ui] PASS: ${targetUrl}`);
    console.log(`[smoke-ui] assistant: ${latestAssistant.slice(0, 160)}`);
    console.log(`[smoke-ui] screenshot: ${screenshotPath}`);
  } finally {
    await browser?.close();
    await stopSmokeServer(smokeServer.child);
    const currentConfigYaml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
    if (originalConfigYaml === null && currentConfigYaml !== null && currentConfigYaml === smokeCreatedConfigYaml) {
      try {
        fs.rmSync(configPath, { force: true });
      } catch (error) {
        throw new Error(
          `[smoke-ui] failed to remove temporary ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (originalConfigYaml === null && currentConfigYaml !== null && smokeCreatedConfigYaml !== null) {
      console.warn(`[smoke-ui] leaving ${configPath} in place because it changed after smoke setup`);
    } else if (originalConfigYaml !== null && currentConfigYaml !== originalConfigYaml) {
      try {
        fs.writeFileSync(configPath, originalConfigYaml, 'utf8');
      } catch (error) {
        throw new Error(
          `[smoke-ui] failed to restore ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    await stopSmokeProviderServer(mockProvider?.server);
  }
}

main().catch((error) => {
  console.error(`[smoke-ui] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
