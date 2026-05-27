import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Page } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DPAgent } from '../../src/index.js';
import type { LLMRequestOptions, LLMStreamEvent } from '../../src/llm/index.js';
import { OpenAICompatibleAdapter } from '../../src/llm/providers/OpenAICompatibleAdapter.js';
import type { PreparedProviderPayload } from '../../src/llm/runtime-types.js';
import type { ContextRef, LLMResponse, Message, ToolSchema } from '../../src/types.js';
import {
  loadWorkspaceAgentProfile,
  scanGlobalAgentProfiles,
  type AgentProfile,
} from '../../src/agents/AgentProfiles.js';
import { ChatContainer } from '../../src/web/client/components/chat/ChatContainer.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import { projectSessionMessages } from '../../src/web/client/chat-message-projection.js';
import {
  mergeAgentInjectionState,
  resolvePromptWithProfiles,
} from '../../src/web/server/prompt-resolution.js';
import { saveDroppedSessionFile } from '../../src/web/server/session-dropped-file-store.js';
import { resolveShareUrlForRequest } from '../../src/web/server/session-share-url-resolver.js';

const OUTPUT_DIR = path.join('logs', 'release-agent-web-regression-e2e');
const TRUE_ASSISTANT_TIME = '2026-05-10T02:00:00.000Z';
const PLAN_MODE_PROMPT_PREFIX = '[PLAN_MODE_REQUIRED]\nUse plan mode.\n[/PLAN_MODE_REQUIRED]';

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

  clear(): void {
    this.store.clear();
  }
}

const localStorageStub = new MemoryStorageStub();
const sessionStorageStub = new MemoryStorageStub();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageStub,
  configurable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: sessionStorageStub,
  configurable: true,
});

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

function sectionBetween(systemPrompt: string, startMarker: string, endMarker: string): string {
  const start = systemPrompt.indexOf(startMarker);
  if (start < 0) {
    return '';
  }
  const end = systemPrompt.indexOf(endMarker, start + startMarker.length);
  return end > start ? systemPrompt.slice(start, end) : systemPrompt.slice(start);
}

function activeAgentSection(systemPrompt: string): string {
  return sectionBetween(systemPrompt, '## Active Agent Role', '## Workspace Instructions');
}

function workspaceInstructionsSection(systemPrompt: string): string {
  return sectionBetween(systemPrompt, '## Workspace Instructions', '## Toolset');
}

function readBuiltWebCss(): string {
  const assetsDir = path.resolve(process.cwd(), 'dist', 'web', 'client', 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error('Built web assets are required for this UX E2E. Run `npm run build:web` first.');
  }
  const cssFile = fs
    .readdirSync(assetsDir)
    .filter((file) => file.endsWith('.css'))
    .map((file) => ({
      file,
      mtimeMs: fs.statSync(path.join(assetsDir, file)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.file;
  if (!cssFile) {
    throw new Error('Built web CSS is required for this UX E2E. Run `npm run build:web` first.');
  }
  const css = fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8');
  assert.match(css, /\.composer-primary-controls/);
  assert.match(css, /\.composer-secondary-controls/);
  assert.match(css, /\.composer-display-filter-button/);
  assert.match(css, /\.composer-ralph-slot/);
  assert.match(css, /max-width:\s*720px/);
  return css.replace(/<\/style/gi, '<\\/style');
}

function createBundledProfile(name: string, filePath: string, content: string): AgentProfile {
  return {
    name,
    normalizedName: name.toLowerCase(),
    description: `${name} bundled profile`,
    mtime: new Date().toISOString(),
    path: filePath,
    content,
    source: 'bundled',
  };
}

async function runPromptLayeringE2E(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-agent-web-regression-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const globalAgentsDir = path.join(tempDir, 'external-agents');
  const bundledAgentsDir = path.join(tempDir, 'bundled-agents');
  const novelistDir = path.join(globalAgentsDir, 'Novelist');
  const reviewerDir = path.join(globalAgentsDir, 'Reviewer');
  const criticDir = path.join(bundledAgentsDir, 'Critic');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(novelistDir, { recursive: true });
  fs.mkdirSync(reviewerDir, { recursive: true });
  fs.mkdirSync(criticDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'AGENTS.md'),
    [
      '# Repo Rules',
      'Workspace-only rule: keep the release regression deterministic.',
      'This file constrains repository behavior and must not redefine persona.',
    ].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(novelistDir, 'AGENTS.md'),
    ['# Novelist Role', 'Novelist-only instruction.', 'Use concise literary scene craft.'].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(path.join(novelistDir, 'agent.yaml'), 'version: 1\nexposeAsSubagent: true\n', 'utf-8');
  fs.writeFileSync(
    path.join(reviewerDir, 'AGENTS.md'),
    ['# Reviewer Role', 'Reviewer-only instruction.', 'Focus on risk and evidence.'].join('\n'),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(criticDir, 'AGENTS.md'),
    ['# Critic Role', 'Bundled-only instruction.', 'Focus on packaged-agent behavior.'].join('\n'),
    'utf-8'
  );

  const originalGenerateStream = OpenAICompatibleAdapter.prototype.generateStream;
  const capturedPayloads: PreparedProviderPayload[] = [];
  let agent: DPAgent | null = null;

  try {
    OpenAICompatibleAdapter.prototype.generateStream = async function* (
      payload: PreparedProviderPayload,
      _tools?: ToolSchema[],
      _options?: LLMRequestOptions
    ): AsyncGenerator<LLMStreamEvent, LLMResponse, unknown> {
      capturedPayloads.push({
        ...payload,
        messages: cloneMessages(payload.messages),
      });
      const response: LLMResponse = {
        content: `release regression turn ${capturedPayloads.length} ok`,
        finishReason: 'end_turn',
      };
      yield { type: 'text', data: response.content };
      yield { type: 'complete', data: response };
      return response;
    };

    agent = new DPAgent({
      config: {
        api: {
          apiKey: 'test-api-key-0123456789012345',
          apiBase: 'https://openai-compatible.local/v1',
          model: 'gpt-4o-mini',
          provider: 'openai',
          maxOutputTokens: 4096,
        },
        llmProfiles: {
          defaultProfileId: 'openai-default',
          profiles: [
            {
              id: 'openai-default',
              name: 'OpenAI Default',
              provider: 'openai',
              apiKey: 'test-api-key-0123456789012345',
              apiBase: 'https://openai-compatible.local/v1',
              defaultModel: 'gpt-4o-mini',
              maxOutputTokens: 4096,
            },
          ],
        },
        agent: {
          workspaceDir,
          globalAgentsDir,
          contextReplayMinRounds: 8,
          contextReplayMaxRounds: 8,
        },
        tools: {
          enableFileTools: false,
          enableWeb: false,
          enableShell: false,
        },
        mcp: {
          enabled: false,
          servers: [],
        },
      },
      workspaceDir,
      runtimeDataDir,
      contextDir,
    });

    const context: ContextRef = {
      scope: 'session',
      namespace: 'release-agent-switching',
    };
    const globalProfiles = scanGlobalAgentProfiles(globalAgentsDir).profiles;
    const bundledProfile = createBundledProfile(
      'Critic',
      path.join(criticDir, 'AGENTS.md'),
      fs.readFileSync(path.join(criticDir, 'AGENTS.md'), 'utf-8')
    );
    const agentProfilesByName = new Map<string, AgentProfile>();
    for (const profile of [...globalProfiles, bundledProfile]) {
      agentProfilesByName.set(profile.normalizedName, profile);
    }
    let agentInjectionState: Parameters<typeof mergeAgentInjectionState>[0];
    const resolveTurn = (prompt: string, selectedAgentName = '') => {
      const resolved = resolvePromptWithProfiles({
        prompt,
        selectedAgentName,
        planningState: 'normal',
        currentAgentInjectionState: agentInjectionState,
        globalAgentProfilesByName: agentProfilesByName,
        loadWorkspaceProfile: () => loadWorkspaceAgentProfile(workspaceDir),
        planModePromptPrefix: PLAN_MODE_PROMPT_PREFIX,
      });
      assert.equal(resolved.ok, true);
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }
      agentInjectionState = mergeAgentInjectionState(agentInjectionState, resolved.agentInjectionState);
      assert.doesNotMatch(resolved.effectiveUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
      assert.doesNotMatch(resolved.historyUserPrompt, /\[AGENT_PROFILE_BODY_BEGIN\]/);
      return resolved;
    };
    const runResolvedTurn = async (resolved: ReturnType<typeof resolveTurn>) => {
      await agent!.runWithResult({
        prompt: resolved.effectiveUserPrompt,
        rawUserPrompt: resolved.displayPrompt,
        historyUserPrompt: resolved.historyUserPrompt,
        effectivePrompt: resolved.effectiveUserPrompt,
        promptReference: resolved.promptRef,
        hasSystemPromptInjection: resolved.hasSystemPromptInjection,
        context,
        workspaceDir,
        agentRuntimeOverrides: resolved.agentRuntimeOverrides,
      });
    };

    const defaultFirst = resolveTurn('Default turn 1.');
    assert.equal(defaultFirst.activeAgent, undefined);
    await runResolvedTurn(defaultFirst);

    const selectedNovelist = resolveTurn('Novelist turn 2.', 'Novelist');
    assert.equal(selectedNovelist.profileInjectionMode, 'initial');
    assert.equal(selectedNovelist.activeAgent?.source, 'global');
    assert.equal(selectedNovelist.activeAgent?.name, 'Novelist');
    await runResolvedTurn(selectedNovelist);

    const novelistFollowUp = resolveTurn('Novelist follow-up turn 3.', 'Novelist');
    assert.equal(novelistFollowUp.profileInjectionMode, 'none');
    assert.equal(novelistFollowUp.activeAgent?.name, 'Novelist');
    await runResolvedTurn(novelistFollowUp);

    const mentionedReviewer = resolveTurn('@Reviewer Reviewer turn 4.');
    assert.equal(mentionedReviewer.displayPrompt, 'Reviewer turn 4.');
    assert.equal(mentionedReviewer.profileInjectionMode, 'switch');
    assert.equal(mentionedReviewer.activeAgent?.name, 'Reviewer');
    await runResolvedTurn(mentionedReviewer);

    const clearedAgent = resolveTurn('Default turn 5 after clearing agent.');
    assert.equal(clearedAgent.activeAgent, undefined);
    assert.equal(clearedAgent.agentRuntimeOverrides, undefined);
    assert.match(clearedAgent.promptRef ?? '', /reason=cleared_agent/);
    await runResolvedTurn(clearedAgent);

    const clearedFollowUp = resolveTurn('Default turn 6 stays cleared.');
    assert.equal(clearedFollowUp.activeAgent, undefined);
    assert.equal(clearedFollowUp.agentRuntimeOverrides, undefined);
    await runResolvedTurn(clearedFollowUp);

    const reselectedNovelist = resolveTurn('Novelist turn 7 after reselect.', 'Novelist');
    assert.equal(reselectedNovelist.profileInjectionMode, 'initial');
    assert.equal(reselectedNovelist.activeAgent?.name, 'Novelist');
    await runResolvedTurn(reselectedNovelist);

    const selectedBundledCritic = resolveTurn('Bundled critic turn 8.', 'Critic');
    assert.equal(selectedBundledCritic.profileInjectionMode, 'switch');
    assert.equal(selectedBundledCritic.activeAgent?.source, 'bundled');
    assert.equal(selectedBundledCritic.activeAgent?.name, 'Critic');
    await runResolvedTurn(selectedBundledCritic);

    assert.equal(capturedPayloads.length, 8);
    const prompts = capturedPayloads.map((payload) => String(payload.systemPrompt ?? ''));
    assert.match(prompts[0], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[0], /## Active Agent Role/);
    assert.match(workspaceInstructionsSection(prompts[0]), /Workspace-only rule/);
    assert.match(workspaceInstructionsSection(prompts[0]), /must not redefine persona/);

    assert.match(prompts[1], /^You are running inside the DPAgent runtime\./);
    assert.match(activeAgentSection(prompts[1]), /Novelist-only instruction\./);
    assert.doesNotMatch(activeAgentSection(prompts[1]), /Reviewer-only instruction\./);
    assert.match(activeAgentSection(prompts[2]), /Novelist-only instruction\./);
    assert.match(workspaceInstructionsSection(prompts[2]), /Workspace-only rule/);

    assert.match(activeAgentSection(prompts[3]), /Reviewer-only instruction\./);
    assert.doesNotMatch(activeAgentSection(prompts[3]), /Novelist-only instruction\./);

    assert.match(prompts[4], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[4], /## Active Agent Role/);
    assert.match(prompts[5], /^You are a helpful AI assistant\./);
    assert.doesNotMatch(prompts[5], /## Active Agent Role/);
    assert.match(activeAgentSection(prompts[6]), /Novelist-only instruction\./);
    assert.match(activeAgentSection(prompts[7]), /Bundled-only instruction\./);
    assert.doesNotMatch(activeAgentSection(prompts[7]), /Novelist-only instruction\./);

    for (const payload of capturedPayloads) {
      assert.equal(payload.messages.some((message) => message.role === 'system'), false);
      const providerUserText = payload.messages.map((message) => String(message.content ?? '')).join('\n');
      assert.doesNotMatch(providerUserText, /\[AGENT_PROFILE_BODY_BEGIN\]/);
      assert.doesNotMatch(providerUserText, /Novelist-only instruction\./);
      assert.doesNotMatch(providerUserText, /Reviewer-only instruction\./);
      assert.doesNotMatch(providerUserText, /Bundled-only instruction\./);
    }
  } finally {
    OpenAICompatibleAdapter.prototype.generateStream = originalGenerateStream;
    if (agent) {
      await agent.cleanup();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildProjectedMessages() {
  const messages = projectSessionMessages('release-web-session', {
    id: 'release-web-session',
    messages: [
      {
        role: 'user',
        content: 'When did the server produce this answer?',
        createdAt: '2026-05-10T01:59:30.000Z',
      },
      {
        role: 'assistant',
        content: 'The timestamp shown in the footer comes from the context event.',
        createdAt: TRUE_ASSISTANT_TIME,
        thinking: 'server thinking trace',
        metadata: {
          llmModel: 'release-model',
        },
        toolCalls: [
          {
            id: 'tool-release-read',
            function: {
              name: 'read_file',
              arguments: {
                path: 'README.md',
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        name: 'read_file',
        toolCallId: 'tool-release-read',
        content: '{"ok":true,"source":"server"}',
        createdAt: '2026-05-10T02:00:01.000Z',
      },
    ],
  });
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.timestamp, Date.parse(TRUE_ASSISTANT_TIME));
  return messages;
}

function renderChatShell(): string {
  localStorageStub.clear();
  sessionStorageStub.clear();
  localStorageStub.setItem(LOCALE_STORAGE_KEY, 'en-US');
  const reactForSsr = React as typeof React & { useLayoutEffect: typeof React.useEffect };
  const originalUseLayoutEffect = reactForSsr.useLayoutEffect;
  reactForSsr.useLayoutEffect = React.useEffect;
  try {
    return renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(ChatContainer, {
            messages: buildProjectedMessages(),
            liveEvents: [],
            pendingPlanInput: null,
            pendingPlanInputError: null,
            onSubmitPlanInput: () => undefined,
            input: '',
            setInput: () => undefined,
            onSend: () => false,
            onCancel: () => undefined,
            isRunning: false,
            canCancel: false,
            isInteractionLocked: false,
            error: null,
            interruptedArtifact: null,
            sessionId: 'release-web-session',
            planningState: 'normal',
            llmProfiles: {
              defaultProfileId: 'release',
              profiles: [
                {
                  id: 'release',
                  name: 'Release',
                  provider: 'openai',
                  apiBase: 'https://openai-compatible.local/v1',
                  defaultModel: 'release-model',
                  availableModels: ['release-model'],
                  maxOutputTokens: 4096,
                  enabled: true,
                  hasApiKey: true,
                  capabilities: {
                    reasoningEffort: true,
                    thinkingBudget: false,
                    modelDiscovery: false,
                  },
                },
              ],
            },
            llmSelection: {
              profileId: 'release',
              model: 'release-model',
              reasoningPreset: 'off',
              updatedAt: '2026-05-10T02:00:00.000Z',
            },
            currentLlmRuntime: {
              profileId: 'release',
              provider: 'openai',
              model: 'release-model',
              reasoningPreset: 'off',
            },
            onChangeLlmSelection: () => undefined,
            shareActive: true,
            onToggleShare: () => undefined,
            showAutoLoopControl: true,
          })
        )
      )
    );
  } finally {
    reactForSsr.useLayoutEffect = originalUseLayoutEffect;
  }
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
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed system browser.
      }
    }
    throw error;
  }
}

async function loadUxPage(page: Page, width: number, height: number): Promise<void> {
  const builtCss = readBuiltWebCss();
  await page.setViewportSize({ width, height });
  await page.setContent(
    [
      '<!doctype html>',
      '<html><head><meta charset="utf-8" />',
      '<style>',
      builtCss,
      '</style></head><body>',
      renderChatShell(),
      '</body></html>',
    ].join('')
  );
}

async function assertTranscriptUx(page: Page): Promise<void> {
  await page.getByTestId('composer-display-filter-group').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('composer-display-filter-tb').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('composer-display-filter-tc').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByTestId('composer-display-filter-tr').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.getByTestId('composer-display-filter-tb').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('composer-display-filter-tc').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('composer-display-filter-tr').getAttribute('aria-pressed'), 'true');
  await page.getByTestId('composer-ralph-slot').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByText('Thought Process').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByText('Tool Call').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByText('Tool Result').waitFor({ state: 'visible', timeout: 5000 });
  await page.getByText('The timestamp shown in the footer comes from the context event.').waitFor({
    state: 'visible',
    timeout: 5000,
  });
  const expectedTime = String(await page.evaluate(`
    new Date(${JSON.stringify(TRUE_ASSISTANT_TIME)}).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  `));
  await page.getByText(expectedTime).waitFor({ state: 'visible', timeout: 5000 });

  const metrics = await page.evaluate(`
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
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        primary: pick('.composer-primary-controls'),
        secondary: pick('.composer-secondary-controls'),
        filters: pick('[data-testid="composer-display-filter-group"]'),
        ralph: pick('[data-testid="composer-ralph-slot"]'),
      };
    })()
  `);
  assert.equal(metrics.scrollWidth <= metrics.viewportWidth + 2, true, 'composer should not overflow horizontally');
  assert.ok(metrics.primary);
  assert.ok(metrics.secondary);
  assert.ok(metrics.filters);
  assert.ok(metrics.ralph);
  if (metrics.viewportWidth <= 720) {
    assert.equal(metrics.secondary!.y >= metrics.primary!.y + metrics.primary!.height - 2, true);
  }
}

async function runTranscriptUxE2E(): Promise<void> {
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
    await loadUxPage(page, 1366, 900);
    await assertTranscriptUx(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'desktop.png'), fullPage: true });

    await loadUxPage(page, 390, 844);
    await assertTranscriptUx(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'mobile.png'), fullPage: true });
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
  }
}

function runShareAndDroppedFileE2E(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-web-file-share-'));
  try {
    const saved = saveDroppedSessionFile({
      runtimeDataDir: tempDir,
      sessionId: 'sess/share\\slow',
      uploadId: 'upload/1',
      filename: '..\\bad:name?.txt',
      body: Buffer.from('dropped file content', 'utf-8'),
    });
    assert.equal(saved.filename, 'bad_name_.txt');
    assert.equal(saved.size, Buffer.byteLength('dropped file content'));
    assert.equal(fs.readFileSync(saved.path, 'utf-8'), 'dropped file content');
    const droppedRoot = path.resolve(tempDir, 'dropped-files');
    const relative = path.relative(droppedRoot, saved.path);
    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
    assert.equal(path.basename(path.dirname(saved.path)), 'upload_1');
    assert.equal(path.basename(path.dirname(path.dirname(saved.path))), 'sess_share_slow');

    const clashHost = resolveShareUrlForRequest({
      url: '/dpagent-share/token-123',
      requestHost: '198.18.0.10:53721',
      protocol: 'http',
      localIpv4Addresses: ['192.168.1.33'],
      localPort: 53721,
    });
    assert.equal(clashHost.diagnostics.reason, 'lan_fallback');
    assert.equal(clashHost.diagnostics.chosenHost, '192.168.1.33:53721');
    assert.equal(clashHost.url, 'http://192.168.1.33:53721/dpagent-share/token-123');

    const trustedLanHost = resolveShareUrlForRequest({
      url: '/dpagent-share/token-123',
      requestHost: '192.168.1.33:53721',
      protocol: 'http',
      localIpv4Addresses: ['192.168.1.33'],
      localPort: 53721,
    });
    assert.equal(trustedLanHost.diagnostics.reason, 'trusted_host');
    assert.equal(trustedLanHost.url, 'http://192.168.1.33:53721/dpagent-share/token-123');

    const configuredBaseUrl = resolveShareUrlForRequest({
      url: '/dpagent-share/token-123',
      requestHost: '198.18.0.10:53721',
      protocol: 'http',
      configuredPublicBaseUrl: 'https://dpagent.example.test/base/',
      localIpv4Addresses: ['192.168.1.33'],
      localPort: 53721,
    });
    assert.equal(configuredBaseUrl.diagnostics.reason, 'config');
    assert.equal(configuredBaseUrl.url, 'https://dpagent.example.test/base/dpagent-share/token-123');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runPromptLayeringE2E();
  runShareAndDroppedFileE2E();
  await runTranscriptUxE2E();
  console.log('release-agent-web-regression e2e passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
