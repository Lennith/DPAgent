#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');

const ROOT = process.cwd();
const DEFAULT_PORT = 53721;
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_API_BASE = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7-highspeed';
const REQUIRED_MARKERS = ['【完成！】', '【汇报结束！】'];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function timestampSlug(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
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

  return {
    port: Number.parseInt(String(map.get('port') || DEFAULT_PORT), 10) || DEFAULT_PORT,
    headless: parseBooleanArg(map.get('headless'), true),
    provider: String(map.get('provider') || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER,
    apiBase: String(map.get('api-base') || DEFAULT_API_BASE).trim() || DEFAULT_API_BASE,
    model: String(map.get('model') || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    outputRoot: path.resolve(
      String(map.get('output-root') || path.join(ROOT, 'logs', `minimax-openai-ux-${timestampSlug()}`))
    ),
  };
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${String(text || '')}\n`, 'utf8');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
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
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function readYamlApiKey(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    return String(parsed?.api?.apiKey || '').trim();
  } catch {
    return '';
  }
}

function readEnvFileApiKey(filePath) {
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

function resolveApiKey() {
  const candidates = [
    process.env.UX_API_KEY,
    process.env.MINIMAX_API_KEY,
    readYamlApiKey(path.join(ROOT, 'config.yaml')),
    readEnvFileApiKey(path.join(ROOT, '.env')),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const selected = candidates.find((item) => item.length >= 20);
  if (!selected) {
    throw new Error('No usable MiniMax API key found. Set UX_API_KEY/MINIMAX_API_KEY or populate config.yaml.');
  }
  return selected;
}

function normalizeLower(value) {
  return String(value || '').trim().toLowerCase();
}

function hasRequiredMarker(value) {
  const normalized = String(value || '').replace(/\s+$/u, '');
  return REQUIRED_MARKERS.some((marker) => normalized.endsWith(marker));
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildRunnerSmokeScenario() {
  return {
    name: 'UX Runner Default Smoke',
    description: 'Verify the updated ux-runner works against the current default provider without selector drift.',
    prompts: [
      {
        id: 'runner-smoke-01',
        text: '这是 ux-runner 冒烟验证。请只回复：runner-smoke-01【完成！】',
        expectedTokens: ['runner-smoke-01'],
        requireCompletionMarker: true,
        captureScreenshot: true,
        postWaitMs: 800,
      },
      {
        id: 'runner-smoke-02',
        text: '继续冒烟验证。请只回复：runner-smoke-02 prev runner-smoke-01【完成！】',
        expectedTokens: ['runner-smoke-02', 'runner-smoke-01'],
        requireCompletionMarker: true,
        postWaitMs: 800,
      },
    ],
  };
}

function buildThirtyRoundScenario() {
  const prompts = [];
  for (let round = 1; round <= 30; round += 1) {
    const current = `round-${String(round).padStart(2, '0')}`;
    const expectedTokens = [current];
    let text = `这是 OpenAI 协议连续验证第 ${round} 轮。`;
    if (round === 1) {
      text += `请只回复：${current}【完成！】`;
    } else {
      const prev = `round-${String(round - 1).padStart(2, '0')}`;
      expectedTokens.push(prev);
      const remembers = [];
      if (round === 10) remembers.push('round-01');
      if (round === 20) remembers.push('round-10');
      if (round === 30) remembers.push('round-20', 'round-01');
      expectedTokens.push(...remembers);
      const rememberText = remembers.length > 0 ? ` remember ${remembers.join(' ')}` : '';
      text += `请回复：${current} prev ${prev}${rememberText}【完成！】`;
    }
    prompts.push({
      id: current,
      text,
      expectedTokens,
      requireCompletionMarker: true,
      captureScreenshot: round === 1 || round === 10 || round === 20 || round === 30,
      postWaitMs: 900,
    });
  }
  return {
    name: 'MiniMax OpenAI 30-Round UX Validation',
    description: '30 deterministic turns validating context continuity over the MiniMax OpenAI-compatible endpoint.',
    prompts,
  };
}

function buildToolUseScenario() {
  return {
    name: 'MiniMax OpenAI Tool Use Validation',
    description: 'Minimal deterministic tool-use validation over the MiniMax OpenAI-compatible endpoint.',
    prompts: [
      {
        id: 'tool-use-01',
        text: [
          '这是 OpenAI 协议最小 tool-use 验证。',
          '必须先调用 list_directory 查看当前工作区，再调用 read_file 读取 qa-anchor.txt。',
          '最后只回复：tool-use-ok qa-anchor.txt tool-read-ok【完成！】',
        ].join(' '),
        expectedTokens: ['tool-use-ok', 'qa-anchor.txt', 'tool-read-ok'],
        requireCompletionMarker: true,
        captureScreenshot: true,
        postWaitMs: 900,
      },
    ],
  };
}

async function runUxRunner(input) {
  const runnerPath = path.join(ROOT, 'scripts', 'ux-runner.js');
  const args = [
    runnerPath,
    '--round', input.roundTag,
    '--ux-root', input.uxRoot,
    '--scenario', input.scenarioPath,
    '--report-dir', input.reportDir,
    '--headless', String(input.headless),
    '--port', String(input.port),
    '--prompt-timeout-ms', String(input.promptTimeoutMs || 180000),
    '--expect-existing', 'false',
    '--restore-after-run', 'true',
    '--start-new-chat', 'true',
    '--workspace-dir', input.workspaceDir,
    '--set-default-workspace', 'false',
  ];
  if (String(input.apiKey || '').trim().length > 0) {
    args.push('--api-key', input.apiKey);
  }
  if (input.provider) {
    args.push('--provider', input.provider);
  }
  if (input.apiBase) {
    args.push('--api-base', input.apiBase);
  }
  if (input.model) {
    args.push('--model', input.model);
  }

  const result = await runCommand(process.execPath, args, { cwd: ROOT, streamOutput: true });
  if (result.code !== 0) {
    throw new Error(`ux-runner failed for ${input.roundTag} with code=${result.code}`);
  }
  const reportPath = path.join(input.reportDir, 'ux-report.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error(`ux-runner report missing: ${reportPath}`);
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function resolveEventsPath(uxRoot, sessionId) {
  return path.join(uxRoot, 'contexts', 'session', encodeURIComponent(sessionId), 'events.jsonl');
}

function readContextEvents(uxRoot, sessionId) {
  const eventsPath = resolveEventsPath(uxRoot, sessionId);
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Missing context events for session ${sessionId}: ${eventsPath}`);
  }
  const lines = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    eventsPath,
    events: lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  };
}

function summarizeRunnerIssues(report) {
  const anomalyTypes = (report?.signals?.anomalies || []).map((item) => String(item.type || ''));
  return anomalyTypes.filter((type) => (
    type === 'ui_missing_textarea'
    || type === 'ui_missing_send_button'
    || type === 'send_button_unavailable'
    || type === 'send_click_failed'
    || type === 'composer_not_ready'
  ));
}

function analyzePromptResults(report) {
  const promptResults = Array.isArray(report?.signals?.promptResults) ? report.signals.promptResults : [];
  return promptResults.map((item) => {
    const expectedTokens = Array.isArray(item.expectedTokens) ? item.expectedTokens : [];
    const missingTokens = Array.isArray(item.missingTokens)
      ? item.missingTokens
      : expectedTokens.filter((token) => !normalizeLower(item.latestAssistant).includes(normalizeLower(token)));
    const completionMarkerMatched = typeof item.completionMarkerMatched === 'boolean'
      ? item.completionMarkerMatched
      : hasRequiredMarker(item.latestAssistant);
    return {
      id: String(item.id || ''),
      prompt: String(item.prompt || ''),
      response: String(item.latestAssistant || ''),
      expectedTokens,
      missingTokens,
      completionMarkerMatched,
      ok: missingTokens.length === 0 && completionMarkerMatched,
      screenshotPath: String(item.screenshotPath || ''),
    };
  });
}

function analyzeTurnSummaries(events) {
  const turnSummaries = events.filter((event) => event && event.type === 'turn_summary');
  return turnSummaries.map((event, index) => ({
    index: index + 1,
    finishReason: String(event?.data?.finishReason || ''),
    finalOutput: String(event?.data?.finalOutput || ''),
    hasRequiredMarker: hasRequiredMarker(String(event?.data?.finalOutput || '')),
  }));
}

function buildMarkdown(summary) {
  const lines = [
    '# MiniMax OpenAI UX Validation',
    '',
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Provider: ${summary.provider}`,
    `- API Base: ${summary.apiBase}`,
    `- Model: ${summary.model}`,
    '',
    '## Runner Smoke',
    `- Session: ${summary.runnerSmoke.sessionId}`,
    `- Passed prompts: ${summary.runnerSmoke.passCount}/${summary.runnerSmoke.promptCount}`,
    `- Runner issue count: ${summary.runnerSmoke.runnerIssueCount}`,
    '',
    '## 30 Rounds',
    `- Session: ${summary.thirtyRounds.sessionId}`,
    `- Passed rounds: ${summary.thirtyRounds.passCount}/${summary.thirtyRounds.roundCount}`,
    `- Missing token count: ${summary.thirtyRounds.missingTokenCount}`,
    `- Marker misses: ${summary.thirtyRounds.markerMissCount}`,
    `- turn_summary end_turn count: ${summary.thirtyRounds.endTurnCount}`,
    '',
    '## Tool Use',
    `- Session: ${summary.toolUse.sessionId}`,
    `- Passed prompts: ${summary.toolUse.passCount}/${summary.toolUse.promptCount}`,
    `- Tool calls: ${summary.toolUse.toolCallCount}`,
    `- Tool results: ${summary.toolUse.toolResultCount}`,
    `- Final finish reason: ${summary.toolUse.finalFinishReason}`,
    '',
    '## Key Screenshots',
  ];
  for (const item of summary.keyScreenshots) {
    lines.push(`- ${item.label}: ${item.path}`);
  }
  lines.push('', '## Notes');
  lines.push(`- Console errors: ${summary.aggregate.consoleErrorCount}`);
  lines.push(`- Page errors: ${summary.aggregate.pageErrorCount}`);
  lines.push(`- Request failures: ${summary.aggregate.requestFailureCount}`);
  if (summary.failures.length === 0) {
    lines.push('- No validation failures detected.');
  } else {
    for (const failure of summary.failures) {
      lines.push(`- ${failure}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const apiKey = resolveApiKey();

  const scenariosDir = path.join(args.outputRoot, 'scenarios');
  const reportsDir = path.join(args.outputRoot, 'reports');
  const workspacesDir = path.join(args.outputRoot, 'workspaces');
  const uxRoot = path.join(args.outputRoot, 'ux-root');
  const runnerSmokePort = args.port + 100;
  const thirtyRoundPort = args.port + 110;
  const toolUsePort = args.port + 120;
  ensureDir(scenariosDir);
  ensureDir(reportsDir);
  ensureDir(workspacesDir);
  ensureDir(uxRoot);

  const runnerSmokeScenarioPath = path.join(scenariosDir, 'runner-smoke.json');
  const thirtyRoundScenarioPath = path.join(scenariosDir, 'openai-30-rounds.json');
  const toolUseScenarioPath = path.join(scenariosDir, 'openai-tool-use.json');
  writeJson(runnerSmokeScenarioPath, buildRunnerSmokeScenario());
  writeJson(thirtyRoundScenarioPath, buildThirtyRoundScenario());
  writeJson(toolUseScenarioPath, buildToolUseScenario());

  const runnerSmokeWorkspace = path.join(workspacesDir, 'runner-smoke');
  const thirtyRoundWorkspace = path.join(workspacesDir, 'openai-30-rounds');
  const toolUseWorkspace = path.join(workspacesDir, 'openai-tool-use');
  ensureDir(runnerSmokeWorkspace);
  ensureDir(thirtyRoundWorkspace);
  ensureDir(toolUseWorkspace);
  fs.writeFileSync(path.join(toolUseWorkspace, 'qa-anchor.txt'), 'tool-read-ok\n', 'utf8');

  const summary = {
    startedAt,
    finishedAt: null,
    provider: args.provider,
    apiBase: args.apiBase,
    model: args.model,
    outputRoot: args.outputRoot,
    failures: [],
    runnerSmoke: {},
    thirtyRounds: {},
    toolUse: {},
    keyScreenshots: [],
    aggregate: {
      consoleErrorCount: 0,
      pageErrorCount: 0,
      requestFailureCount: 0,
    },
  };

  try {
    const runnerSmokeReport = await runUxRunner({
      roundTag: 'runner-smoke',
      uxRoot,
      scenarioPath: runnerSmokeScenarioPath,
      reportDir: path.join(reportsDir, 'runner-smoke'),
      workspaceDir: runnerSmokeWorkspace,
      apiKey,
      headless: args.headless,
      port: runnerSmokePort,
    });
    const runnerSmokeResults = analyzePromptResults(runnerSmokeReport);
    const runnerIssues = summarizeRunnerIssues(runnerSmokeReport);
    summary.runnerSmoke = {
      sessionId: String(runnerSmokeReport?.session?.id || ''),
      promptCount: runnerSmokeResults.length,
      passCount: runnerSmokeResults.filter((item) => item.ok).length,
      runnerIssueCount: runnerIssues.length,
      runnerIssues,
      reportPath: path.join(reportsDir, 'runner-smoke', 'ux-report.json'),
    };
    assertCondition(summary.runnerSmoke.promptCount === 2, 'Runner smoke prompt count mismatch.');
    assertCondition(summary.runnerSmoke.passCount === 2, 'Runner smoke prompts did not all pass.');
    assertCondition(summary.runnerSmoke.runnerIssueCount === 0, `Runner smoke exposed runner issues: ${runnerIssues.join(', ')}`);

    const thirtyRoundReport = await runUxRunner({
      roundTag: 'openai-30-rounds',
      uxRoot,
      scenarioPath: thirtyRoundScenarioPath,
      reportDir: path.join(reportsDir, 'openai-30-rounds'),
      workspaceDir: thirtyRoundWorkspace,
      apiKey,
      headless: args.headless,
      port: thirtyRoundPort,
      provider: args.provider,
      apiBase: args.apiBase,
      model: args.model,
    });
    const thirtyRoundResults = analyzePromptResults(thirtyRoundReport);
    const thirtyRoundContext = readContextEvents(uxRoot, String(thirtyRoundReport?.session?.id || ''));
    const thirtyRoundSummaries = analyzeTurnSummaries(thirtyRoundContext.events);
    const thirtyRoundMarkerMissCount = thirtyRoundResults.filter((item) => !item.completionMarkerMatched).length;
    const thirtyRoundMissingTokenCount = thirtyRoundResults.reduce((count, item) => count + item.missingTokens.length, 0);
    summary.thirtyRounds = {
      sessionId: String(thirtyRoundReport?.session?.id || ''),
      roundCount: thirtyRoundResults.length,
      passCount: thirtyRoundResults.filter((item) => item.ok).length,
      missingTokenCount: thirtyRoundMissingTokenCount,
      markerMissCount: thirtyRoundMarkerMissCount,
      endTurnCount: thirtyRoundSummaries.filter((item) => item.finishReason === 'end_turn').length,
      turnSummaryCount: thirtyRoundSummaries.length,
      reportPath: path.join(reportsDir, 'openai-30-rounds', 'ux-report.json'),
      eventsPath: thirtyRoundContext.eventsPath,
      results: thirtyRoundResults,
    };
    assertCondition(summary.thirtyRounds.roundCount === 30, `Expected 30 rounds, got ${summary.thirtyRounds.roundCount}.`);
    assertCondition(summary.thirtyRounds.passCount === 30, `30-round validation failed in ${30 - summary.thirtyRounds.passCount} rounds.`);
    assertCondition(summary.thirtyRounds.missingTokenCount === 0, '30-round validation has missing continuity tokens.');
    assertCondition(summary.thirtyRounds.markerMissCount === 0, '30-round validation has completion marker misses.');
    assertCondition(summary.thirtyRounds.endTurnCount >= 30, `Expected at least 30 end_turn summaries, got ${summary.thirtyRounds.endTurnCount}.`);

    const toolUseReport = await runUxRunner({
      roundTag: 'openai-tool-use',
      uxRoot,
      scenarioPath: toolUseScenarioPath,
      reportDir: path.join(reportsDir, 'openai-tool-use'),
      workspaceDir: toolUseWorkspace,
      apiKey,
      headless: args.headless,
      port: toolUsePort,
      provider: args.provider,
      apiBase: args.apiBase,
      model: args.model,
    });
    const toolUseResults = analyzePromptResults(toolUseReport);
    const toolUseContext = readContextEvents(uxRoot, String(toolUseReport?.session?.id || ''));
    const toolUseEvents = toolUseContext.events;
    const toolUseSummaries = analyzeTurnSummaries(toolUseEvents);
    const toolCallEvents = toolUseEvents.filter((event) => event && event.type === 'tool_call');
    const toolResultEvents = toolUseEvents.filter((event) => event && event.type === 'tool_result');
    const finalToolSummary = toolUseSummaries[toolUseSummaries.length - 1] || null;
    summary.toolUse = {
      sessionId: String(toolUseReport?.session?.id || ''),
      promptCount: toolUseResults.length,
      passCount: toolUseResults.filter((item) => item.ok).length,
      toolCallCount: toolCallEvents.length,
      toolResultCount: toolResultEvents.length,
      toolCalls: toolCallEvents.map((event) => String(event?.data?.name || event?.name || '')),
      finalFinishReason: finalToolSummary ? finalToolSummary.finishReason : '',
      finalMarkerMatched: finalToolSummary ? finalToolSummary.hasRequiredMarker : false,
      reportPath: path.join(reportsDir, 'openai-tool-use', 'ux-report.json'),
      eventsPath: toolUseContext.eventsPath,
      results: toolUseResults,
    };
    assertCondition(summary.toolUse.promptCount === 1, 'Tool-use scenario prompt count mismatch.');
    assertCondition(summary.toolUse.passCount === 1, 'Tool-use scenario prompt verification failed.');
    assertCondition(summary.toolUse.toolCallCount > 0, 'Tool-use scenario did not emit any tool_call.');
    assertCondition(summary.toolUse.toolResultCount > 0, 'Tool-use scenario did not emit any tool_result.');
    assertCondition(summary.toolUse.finalFinishReason === 'end_turn', `Tool-use final finish reason is ${summary.toolUse.finalFinishReason || 'empty'}.`);
    assertCondition(summary.toolUse.finalMarkerMatched === true, 'Tool-use final output is missing the completion marker.');

    const keyScreenshots = [];
    for (const label of ['round-01', 'round-10', 'round-20', 'round-30']) {
      const match = summary.thirtyRounds.results.find((item) => item.id === label && item.screenshotPath);
      if (match) {
        keyScreenshots.push({ label, path: match.screenshotPath });
      }
    }
    const toolShot = summary.toolUse.results.find((item) => item.screenshotPath);
    if (toolShot) {
      keyScreenshots.push({ label: 'tool-use', path: toolShot.screenshotPath });
    }
    summary.keyScreenshots = keyScreenshots;
    assertCondition(summary.keyScreenshots.length >= 5, `Expected 5 key screenshots, got ${summary.keyScreenshots.length}.`);

    summary.aggregate = {
      consoleErrorCount:
        (thirtyRoundReport?.metrics?.consoleErrorCount || 0)
        + (toolUseReport?.metrics?.consoleErrorCount || 0)
        + (runnerSmokeReport?.metrics?.consoleErrorCount || 0),
      pageErrorCount:
        (runnerSmokeReport?.signals?.pageErrors || []).length
        + (thirtyRoundReport?.signals?.pageErrors || []).length
        + (toolUseReport?.signals?.pageErrors || []).length,
      requestFailureCount:
        (runnerSmokeReport?.metrics?.requestFailureCount || 0)
        + (thirtyRoundReport?.metrics?.requestFailureCount || 0)
        + (toolUseReport?.metrics?.requestFailureCount || 0),
    };
  } catch (error) {
    summary.failures.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(args.outputRoot, 'summary.json');
    writeJson(summaryPath, summary);
    writeText(path.join(args.outputRoot, 'summary.md'), buildMarkdown(summary));
    console.log(`[openai-ux] summary json: ${summaryPath}`);
    console.log(`[openai-ux] summary md: ${path.join(args.outputRoot, 'summary.md')}`);
  }
}

main().catch((error) => {
  console.error(`[openai-ux] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
