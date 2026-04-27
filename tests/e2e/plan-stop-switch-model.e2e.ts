import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:53722/';
const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? path.join('logs', 'plan-stop-switch-model-e2e');
const MAX_SWITCHES = Number.parseInt(process.env.E2E_PLAN_STOP_SWITCHES ?? '4', 10);
const STEP_TIMEOUT_MS = Number.parseInt(process.env.E2E_PLAN_STOP_TIMEOUT_MS ?? '900000', 10);

const MODEL_SEQUENCE = [
  { label: 'kimi-for-coding', profile: /Kimi/i, model: 'kimi-for-coding' },
  { label: 'deepseek-v4-flash', profile: /DeepSeek/i, model: 'deepseek-v4-flash' },
  { label: 'minimax', profile: /MiniMax/i, model: '' },
  { label: 'kimi-for-coding', profile: /Kimi/i, model: 'kimi-for-coding' },
];

async function launchBrowser() {
  const headless = process.env.E2E_HEADLESS !== 'false';
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Executable doesn't exist")) {
      throw error;
    }
    for (const channel of ['chrome', 'msedge']) {
      try {
        console.warn(`[plan-stop-switch-e2e] bundled Chromium missing; falling back to ${channel}`);
        return await chromium.launch({ headless, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

async function clickIfVisible(page: Page, selector: string, timeout = 1500): Promise<boolean> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click({ force: true });
    return true;
  } catch {
    return false;
  }
}

async function dismissBlockingDialogs(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await clickIfVisible(page, '[data-testid="workspace-confirm"]', 800)) {
      await page.waitForTimeout(250);
      continue;
    }
    const modal = page.getByTestId('config-modal-shell').first();
    if (await modal.isVisible().catch(() => false)) {
      const explicitClose = page.getByTestId('config-close').first();
      if (await explicitClose.isVisible().catch(() => false)) {
        await explicitClose.click({ force: true }).catch(() => undefined);
      } else {
        const buttons = modal.locator('button');
        const count = await buttons.count();
        for (let index = 0; index < count; index += 1) {
          const button = buttons.nth(index);
          const label = await button.innerText().catch(() => '');
          if (/关闭|Close/i.test(label)) {
            await button.click({ force: true }).catch(() => undefined);
            break;
          }
        }
      }
      await page.waitForTimeout(250);
      continue;
    }
    break;
  }
}

async function submitPrompt(page: Page, prompt: string): Promise<void> {
  await dismissBlockingDialogs(page);
  const textbox = page.getByTestId('chat-input-textarea');
  await textbox.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => {
      const activeTextarea = document.querySelector(
        '[data-testid="chat-input-textarea"]'
      ) as HTMLTextAreaElement | null;
      return Boolean(activeTextarea && !activeTextarea.disabled);
    },
    undefined,
    { timeout: 45000 }
  );
  await textbox.fill(prompt);
  await page.getByTestId('chat-send').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByTestId('chat-send').click();
}

async function waitForComposerReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const activeTextarea = document.querySelector(
        '[data-testid="chat-input-textarea"]'
      ) as HTMLTextAreaElement | null;
      return Boolean(activeTextarea && !activeTextarea.disabled);
    },
    undefined,
    { timeout: 180000 }
  );
}

async function openLlmPopover(page: Page): Promise<void> {
  await dismissBlockingDialogs(page);
  if (await page.locator('[data-testid="session-llm-popover"]:visible').first().isVisible().catch(() => false)) {
    return;
  }
  const trigger = page.getByTestId('session-llm-compact').locator('button').first();
  await trigger.waitFor({ state: 'visible', timeout: 10000 });
  await trigger.click();
  await page.getByTestId('session-llm-popover').waitFor({ state: 'visible', timeout: 5000 });
}

async function getVisibleLlmPopover(page: Page): Promise<Locator> {
  await openLlmPopover(page);
  const popover = page.locator('[data-testid="session-llm-popover"]:visible').last();
  await popover.waitFor({ state: 'visible', timeout: 5000 });
  return popover;
}

async function waitForLlmSelectionReady(page: Page): Promise<Locator> {
  const popover = await getVisibleLlmPopover(page);
  await page.waitForFunction(
    () => {
      const popovers = Array.from(document.querySelectorAll('[data-testid="session-llm-popover"]')) as HTMLElement[];
      const visiblePopovers = popovers.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      const visiblePopover = visiblePopovers[visiblePopovers.length - 1];
      const trigger = visiblePopover?.querySelector('[data-testid="session-llm-profile-trigger"]') as HTMLButtonElement | null;
      return Boolean(trigger && !trigger.disabled);
    },
    undefined,
    { timeout: 45000 }
  );
  return popover;
}

async function switchModel(page: Page, target: { profile: RegExp; model: string }): Promise<void> {
  const popover = await waitForLlmSelectionReady(page);
  const profileTrigger = popover.getByTestId('session-llm-profile-trigger');
  await profileTrigger.click();
  const profileMenu = popover.getByTestId('session-llm-profile-menu');
  await profileMenu.waitFor({ state: 'visible', timeout: 5000 });
  await profileMenu.getByRole('button', { name: target.profile }).first().click();

  if (target.model) {
    const modelInput = popover.getByTestId('session-llm-model-input');
    await modelInput.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(
      () => {
        const popovers = Array.from(document.querySelectorAll('[data-testid="session-llm-popover"]')) as HTMLElement[];
        const visiblePopovers = popovers.filter((node) => {
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const visiblePopover = visiblePopovers[visiblePopovers.length - 1];
        const input = visiblePopover?.querySelector('[data-testid="session-llm-model-input"]') as HTMLInputElement | null;
        return Boolean(input && !input.disabled);
      },
      undefined,
      { timeout: 45000 }
    );
    await modelInput.fill(target.model);
    await modelInput.press('Enter');
  }
  await page.mouse.click(8, 8);
}

async function switchToMissingVerificationModel(page: Page, modelSwitches: string[]): Promise<void> {
  const used = new Set(modelSwitches);
  const missingTarget = MODEL_SEQUENCE.find((item) => !used.has(item.label));
  if (!missingTarget) {
    return;
  }
  await switchModel(page, missingTarget);
  modelSwitches.push(missingTarget.label);
  await submitPrompt(page, 'Reply exactly: plan-stop-switch-e2e-ok');
  await waitForComposerReady(page);
  await assertVisibleState(page);
}

async function stopIfRunning(page: Page): Promise<boolean> {
  const stopButtons = page.getByTestId('chat-stop');
  const count = await stopButtons.count();
  let clicked = false;
  for (let index = 0; index < count; index += 1) {
    const stopButton = stopButtons.nth(index);
    const visible = await stopButton.isVisible().catch(() => false);
    const enabled = await stopButton.isEnabled().catch(() => false);
    if (visible && enabled) {
      await stopButton.click({ force: true });
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    const textareaDisabled = await page.getByTestId('chat-input-textarea').isDisabled().catch(() => false);
    if (textareaDisabled) {
      const enabledStop = page.getByTestId('chat-stop').locator(':enabled').first();
      await enabledStop.waitFor({ state: 'visible', timeout: 15000 });
      await enabledStop.click({ force: true });
      clicked = true;
    } else {
      return false;
    }
  }
  await page.waitForFunction(
    () => {
      const stopButtons = Array.from(document.querySelectorAll('[data-testid="chat-stop"]')) as HTMLButtonElement[];
      return stopButtons.every((button) => button.offsetParent === null || button.disabled);
    },
    undefined,
    { timeout: 45000 }
  );
  return true;
}

interface TodoSnapshot {
  completed: number;
  unfinished: number | null;
  allComplete: boolean;
}

interface TodoApiItem {
  status?: string;
}

async function readCurrentSessionId(page: Page): Promise<string> {
  await page.waitForFunction(
    () => {
      const root = document.querySelector('.chat-panel-root') as HTMLElement | null;
      return Boolean(root?.dataset.currentSessionId?.trim());
    },
    undefined,
    { timeout: 30000 }
  );
  return page.locator('.chat-panel-root').first().evaluate((node) => {
    const root = node as HTMLElement;
    return root.dataset.currentSessionId ?? '';
  });
}

async function readTodoApiSnapshot(page: Page): Promise<TodoSnapshot> {
  const sessionId = await readCurrentSessionId(page);
  const payload = await page.evaluate(async (activeSessionId) => {
    const response = await fetch(`/api/todos?sessionId=${encodeURIComponent(activeSessionId)}&include_completed=true`);
    return response.json() as Promise<{ items?: TodoApiItem[] }>;
  }, sessionId);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const completed = items.filter((item) => item.status === 'completed').length;
  const unfinished = items.filter((item) => item.status !== 'completed').length;
  return {
    completed,
    unfinished,
    allComplete: items.length > 0 && unfinished === 0,
  };
}

async function waitForTodoProgress(page: Page, previousCompleted: number): Promise<TodoSnapshot> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await readTodoApiSnapshot(page);
    if (snapshot.completed > previousCompleted || (snapshot.allComplete && (snapshot.completed > 0 || previousCompleted > 0))) {
      return snapshot;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out waiting for a completed todo after count=${previousCompleted}`);
}

async function assertVisibleState(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('content[].thinking') || bodyText.includes('thinking mode must be passed back')) {
    throw new Error('thinking replay 400 is visible in the UI');
  }
  if ((bodyText.match(/Task cancelled by user\./g) ?? []).length > 1) {
    throw new Error('duplicate cancellation output is visible in the UI');
  }
  await page.getByTestId('composer-llm-slot').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('composer-ralph-slot').waitFor({ state: 'visible', timeout: 5000 });
}

async function assertTodoPanelClearedWhenComplete(page: Page): Promise<void> {
  const snapshot = await readTodoApiSnapshot(page);
  if (!snapshot.allComplete) {
    return;
  }
  const todoPanelVisible = await page.getByTestId('todo-panel').first().isVisible().catch(() => false);
  if (todoPanelVisible) {
    throw new Error('todo panel remains visible after all todos completed');
  }
}

async function run(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  const modelSwitches: string[] = [];
  try {
    const appFolder = `GestureE2E-${Date.now()}`;
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => undefined);
    await dismissBlockingDialogs(page);
    await clickIfVisible(page, '[data-testid="sidebar-new-chat"]');
    await switchModel(page, MODEL_SEQUENCE[0]);
    modelSwitches.push(MODEL_SEQUENCE[0].label);
    await submitPrompt(
      page,
      `请制作一个 Android 的手势识别应用，项目目录必须使用 ${appFolder}，需要先建立计划，然后开始实施。请拆成至少 3 个可验收 Todo 步骤。为保证本轮 UX 验收可收敛，只做最小静态实现：不要下载网络依赖，不运行 Gradle 或耗时构建；每个 Todo 的验收以文件存在、关键代码 grep、静态说明为准。每完成一个 Todo 后必须立即调用 todo set_status completed。`
    );

    let completedCount = 0;
    let allTodosComplete = false;
    for (let index = 0; index < MAX_SWITCHES; index += 1) {
      const snapshot = await waitForTodoProgress(page, completedCount);
      completedCount = snapshot.completed;
      allTodosComplete = snapshot.allComplete;
      await assertVisibleState(page);
      if (allTodosComplete) {
        break;
      }
      await stopIfRunning(page);
      const nextModel = MODEL_SEQUENCE[(index + 1) % MODEL_SEQUENCE.length];
      await switchModel(page, nextModel);
      modelSwitches.push(nextModel.label);
      await submitPrompt(page, '继续执行下一步');
      await assertVisibleState(page);
    }

    await assertVisibleState(page);
    await assertTodoPanelClearedWhenComplete(page);
    if (!allTodosComplete) {
      throw new Error(`todo list did not complete within ${MAX_SWITCHES} stop/switch cycles`);
    }
    await waitForComposerReady(page);
    await assertVisibleState(page);
    await switchToMissingVerificationModel(page, modelSwitches);
    await waitForComposerReady(page);
    await assertVisibleState(page);
    await assertTodoPanelClearedWhenComplete(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'final.png'), fullPage: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          baseUrl: BASE_URL,
          modelSwitches,
          completedCount,
          appFolder,
          consoleErrors,
        },
        null,
        2
      )
    );
  } catch (error) {
    await stopIfRunning(page).catch(() => undefined);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'failure.png'), fullPage: true }).catch(() => undefined);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'result.json'),
      JSON.stringify(
        {
          ok: false,
          baseUrl: BASE_URL,
          modelSwitches,
          consoleErrors,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
