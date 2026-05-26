import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';

const OUTPUT_DIR = path.join('logs', 'release-plan-mode-ux-e2e');

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

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
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

function renderChatShell(): string {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const pendingPlanInput = {
    requestId: 'req-release-plan-approval',
    planPreview: {
      planId: 'plan-release',
      title: 'Release Gate Strengthening',
      summary: 'Plan Mode approval, CLI isolation, and long-session checks.',
      markdown: '### Release Gate Strengthening\n\nValidate release behavior before publishing.',
      steps: [
        {
          planStepId: 'step-001',
          work: 'Validate draft to approval transition.',
          detectionStandard: 'Approval card accepts only explicit execution approval.',
          priority: 'high' as const,
          tags: ['plan-mode'],
        },
        {
          planStepId: 'step-002',
          work: 'Validate CLI observe-only isolation.',
          detectionStandard: 'Web controls are disabled while CLI owns the active run.',
          priority: 'high' as const,
          tags: ['cli'],
        },
      ],
      testPlan: ['release-plan-mode-lifecycle', 'release-cli-long-session'],
      assumptions: ['No CLI public interface change'],
      updatedAt: '2026-05-03T00:00:00.000Z',
    },
    questions: [
      {
        header: 'Execution',
        id: 'plan_execution_approval',
        question: 'Review the finalized plan. Approve execution or provide revision feedback.',
        options: [
          { label: 'Approve execution', description: 'Create todos and start plan execution.' },
          { label: 'Request changes', description: 'Keep drafting with feedback.' },
          { label: 'Do not execute', description: 'Stop at the finalized plan.' },
        ],
      },
    ],
  };

  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(ChatContainer, {
          messages: [],
          liveEvents: [],
          pendingPlanInput,
          pendingPlanInputError: null,
          onSubmitPlanInput: () => undefined,
          input: '',
          setInput: () => undefined,
          onSend: () => undefined,
          onCancel: () => undefined,
          isRunning: true,
          canCancel: false,
          isInteractionLocked: true,
          interactionState: { mode: 'observe_only', reason: 'cli_active_run', owner: 'cli' },
          error: null,
          interruptedArtifact: null,
          sessionId: 'release-cli-session',
          planningState: 'plan_drafting',
          llmSelection: {
            profileId: 'release',
            model: 'release-model',
            reasoningPreset: 'off',
            updatedAt: '2026-05-03T00:00:00.000Z',
          },
          currentLlmRuntime: {
            profileId: 'release',
            provider: 'anthropic',
            model: 'release-model',
            reasoningPreset: 'off',
          },
        })
      )
    )
  );
}

async function loadPage(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.setContent(
    [
      '<!doctype html>',
      '<html><head><meta charset="utf-8" />',
      '<style>',
      '* { box-sizing: border-box; }',
      'body { margin: 0; font-family: Inter, Segoe UI, Arial, sans-serif; background: #0f172a; }',
      '.chat-panel-root { height: 100vh; display: flex; flex-direction: column; }',
      '.chat-messages-viewport { flex: 1; overflow: auto; }',
      '.chat-transcript { max-width: 900px; margin: 0 auto; }',
      '.message-width-assistant { max-width: 780px; }',
      '.rounded-2xl { border-radius: 16px; }',
      '.rounded-xl { border-radius: 12px; }',
      '.rounded-lg { border-radius: 8px; }',
      '.border { border: 1px solid rgba(148, 163, 184, 0.35); }',
      '.p-2 { padding: 8px; } .p-3 { padding: 12px; } .p-4 { padding: 16px; }',
      '.px-3 { padding-left: 12px; padding-right: 12px; } .px-4 { padding-left: 16px; padding-right: 16px; }',
      '.py-2 { padding-top: 8px; padding-bottom: 8px; } .py-3 { padding-top: 12px; padding-bottom: 12px; }',
      '.space-y-2 > * + * { margin-top: 8px; } .space-y-3 > * + * { margin-top: 12px; } .space-y-4 > * + * { margin-top: 16px; }',
      '.flex { display: flex; } .flex-1 { flex: 1 1 auto; } .justify-start { justify-content: flex-start; } .justify-end { justify-content: flex-end; }',
      '.items-center { align-items: center; } .items-start { align-items: flex-start; } .justify-between { justify-content: space-between; }',
      '.gap-2 { gap: 8px; } .w-full { width: 100%; } .min-h-\\[70px\\] { min-height: 70px; }',
      '.text-xs { font-size: 12px; } .text-sm { font-size: 14px; } .font-medium, .font-semibold { font-weight: 600; }',
      '.uppercase { text-transform: uppercase; } .mt-1 { margin-top: 4px; } .mt-3 { margin-top: 12px; }',
      'textarea { max-width: 100%; } button:disabled, input:disabled, textarea:disabled { cursor: not-allowed; }',
      '</style></head><body>',
      renderChatShell(),
      '</body></html>',
    ].join('')
  );
}

async function assertReadOnlyPlanInput(page: Page): Promise<void> {
  const card = page.getByTestId('plan-input-card');
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('cli-observe-only-banner').waitFor({ state: 'visible', timeout: 5000 });
  await assert.rejects(
    async () => {
      await page.getByTestId('composer-llm-slot').waitFor({ state: 'visible', timeout: 500 });
    },
    /Timeout/
  );
  assert.equal(await card.getAttribute('aria-disabled'), 'true');
  assert.match(await card.innerText(), /This session is running from CLI/);
  assert.match(await card.innerText(), /Release Gate Strengthening/);
  assert.equal(await card.locator('input[type="radio"]').first().isDisabled(), true);
  assert.equal(await card.locator('textarea').first().isDisabled(), true);
  assert.equal(await card.locator('button').last().isDisabled(), true);
}

async function assertNoOverlaps(page: Page): Promise<void> {
  const boxes = await page.evaluate(`
    (() => {
      function pick(selector) {
        const node = document.querySelector(selector);
        if (!node) {
          return null;
        }
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return {
        banner: pick('[data-testid="cli-observe-only-banner"]'),
        card: pick('[data-testid="plan-input-card"]'),
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()
  `);
  assert.ok(boxes.banner);
  assert.ok(boxes.card);
  assert.equal(boxes.scrollWidth <= boxes.viewportWidth + 2, true, 'plan input layout should not overflow horizontally');
  assert.equal(
    (boxes.banner!.y + boxes.banner!.height) <= boxes.card!.y + 24,
    true,
    'observe-only banner should not overlap the plan input card'
  );
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  try {
    await loadPage(page, 1366, 900);
    await assertReadOnlyPlanInput(page);
    await assertNoOverlaps(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop.png'), fullPage: true });

    await loadPage(page, 390, 844);
    await assertReadOnlyPlanInput(page);
    await assertNoOverlaps(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'mobile.png'), fullPage: true });

    assert.deepEqual(consoleErrors, []);
    console.log('release-plan-mode-ux e2e passed');
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
