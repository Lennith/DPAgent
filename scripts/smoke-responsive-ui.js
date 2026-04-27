#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const VIEWPORTS = [
  { name: '4k-16x9', width: 3840, height: 2160 },
  { name: '2k-16x9', width: 2560, height: 1440 },
  { name: '1080p-16x9', width: 1920, height: 1080 },
  { name: 'portrait-9x16', width: 1080, height: 1920 },
  { name: 'half-8x9', width: 960, height: 1080 },
  { name: 'tall-half', width: 1280, height: 1440 },
];

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
    return payload?.status === 'ok';
  } catch {
    return false;
  }
}

function resolveNpmLauncher() {
  const npmExecPath = String(process.env.npm_execpath || '').trim();
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
    shell: process.platform === 'win32',
  };
}

async function waitForServer(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(baseUrl)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function ensureServer(baseUrl) {
  if (await isServerReady(baseUrl)) {
    return null;
  }
  const launcher = resolveNpmLauncher();
  const port = new URL(baseUrl).port || '53721';
  const child = spawn(launcher.command, [...launcher.args, 'run', 'start:web'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    shell: launcher.shell,
    env: {
      ...process.env,
      MINIMAX_PORT: String(port),
      MINIMAX_ALLOW_MISSING_API_KEY_AT_BOOT: '1',
    },
  });
  await waitForServer(baseUrl, 45000);
  return child;
}

async function stopServer(child) {
  if (!child) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
    return;
  }
  child.kill('SIGTERM');
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) {
      throw error;
    }
    for (const channel of ['chrome', 'msedge']) {
      try {
        console.warn(`[responsive-ui] bundled Chromium missing; falling back to ${channel}`);
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

async function assertBoxInViewport(page, selector, label) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) {
    throw new Error(`${label} is missing`);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('viewport unavailable');
  }
  if (box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    throw new Error(`${label} overflows viewport: ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`);
  }
  return box;
}

async function assertComposerActionInViewport(page, viewportName) {
  const action = page.locator('[data-testid="chat-send"], [data-testid="chat-stop"]').first();
  const box = await action.boundingBox({ timeout: 30000 });
  if (!box) {
    throw new Error(`${viewportName} composer action is missing`);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('viewport unavailable');
  }
  if (box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    throw new Error(`${viewportName} composer action overflows viewport: ${JSON.stringify(box)} in ${JSON.stringify(viewport)}`);
  }
  if (box.width < 40 || box.height < 40) {
    throw new Error(`${viewportName} composer action target too small: ${JSON.stringify(box)}`);
  }
}

async function assertComposerControls(page, viewportName) {
  const llmBox = await assertBoxInViewport(page, '[data-testid="composer-llm-slot"]', `${viewportName} LLM control`);
  const ralphBox = await assertBoxInViewport(page, '[data-testid="composer-ralph-slot"]', `${viewportName} Ralph control`);
  if (ralphBox.width > 190) {
    throw new Error(`${viewportName} Ralph control is too wide: ${JSON.stringify(ralphBox)}`);
  }
  const llmRight = llmBox.x + llmBox.width;
  if (llmRight > ralphBox.x + 2) {
    throw new Error(`${viewportName} LLM and Ralph controls overlap: ${JSON.stringify({ llmBox, ralphBox })}`);
  }
}

async function assertLlmPopoverInViewport(page, viewportName) {
  const trigger = page.locator('[data-testid="session-llm-compact"] button').first();
  await trigger.click();
  const popoverBox = await assertBoxInViewport(page, '[data-testid="session-llm-popover"]', `${viewportName} LLM popover`);
  const hasInternalScrollbar = await page.locator('[data-testid="session-llm-popover"]').first().evaluate((element) => {
    return element.scrollHeight > element.clientHeight + 1;
  });
  if (hasInternalScrollbar) {
    throw new Error(`${viewportName} LLM popover should not create an internal scrollbar.`);
  }
  await page.getByTestId('session-llm-profile-trigger').first().click();
  await page.getByTestId('session-llm-profile-menu').first().waitFor({ timeout: 3000, state: 'visible' });
  await page.getByTestId('session-llm-model-trigger').first().click();
  await page.getByTestId('session-llm-model-menu').first().waitFor({ timeout: 3000, state: 'visible' });
  const profileMenuStillVisible = await page.getByTestId('session-llm-profile-menu').first().isVisible().catch(() => false);
  if (profileMenuStillVisible) {
    throw new Error(`${viewportName} LLM dropdown menus must be mutually exclusive.`);
  }
  const reasoningTrigger = page.getByTestId('session-llm-reasoning-trigger').first();
  await reasoningTrigger.click();
  const triggerBox = await reasoningTrigger.boundingBox();
  const menuBox = await assertBoxInViewport(page, '[data-testid="session-llm-reasoning-menu"]', `${viewportName} reasoning menu`);
  if (triggerBox && menuBox.y + menuBox.height > triggerBox.y + 1) {
    throw new Error(`${viewportName} reasoning menu should expand upward: ${JSON.stringify({ triggerBox, menuBox, popoverBox })}`);
  }
  await page.mouse.click(4, 4);
}

async function runViewport(page, baseUrl, viewport, outputDir) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(600);

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  if (Math.max(overflow.body, overflow.root) > overflow.viewport + 1) {
    throw new Error(`${viewport.name} has horizontal overflow: ${JSON.stringify(overflow)}`);
  }

  await assertComposerActionInViewport(page, viewport.name);
  await assertComposerControls(page, viewport.name);
  await assertLlmPopoverInViewport(page, viewport.name);

  const screenshotPath = path.join(outputDir, `responsive-${viewport.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`[responsive-ui] ${viewport.name} ok: ${screenshotPath}`);
}

async function main() {
  const baseUrl = process.env.RESPONSIVE_SMOKE_URL || 'http://localhost:53721';
  const outputDir = process.env.RESPONSIVE_SMOKE_OUTPUT_DIR || path.join(process.cwd(), 'logs', 'responsive-ui');
  fs.mkdirSync(outputDir, { recursive: true });
  const server = await ensureServer(baseUrl);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    for (const viewport of VIEWPORTS) {
      await runViewport(page, baseUrl, viewport, outputDir);
    }
    console.log(`[responsive-ui] PASS: ${baseUrl}`);
  } finally {
    await browser.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(`[responsive-ui] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
