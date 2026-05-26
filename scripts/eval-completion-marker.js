#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.yaml');
const REQUIRED_MARKERS = ['\u3010\u5b8c\u6210\uff01\u3011', '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011'];
const CASE_COUNT = Number.parseInt(process.env.EVAL_CASE_COUNT || '20', 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.EVAL_TIMEOUT_MS || '180000', 10);
const DEFAULT_PORT = Number.parseInt(process.env.EVAL_PORT || '53721', 10);
const MAX_LEAK_RATE = Number.parseFloat(process.env.EVAL_MAX_LEAK_RATE || '0.1');

function normalizeTail(value) {
  return String(value || '').replace(/\s+$/u, '');
}

function hasRequiredMarker(value) {
  const normalized = normalizeTail(value);
  return REQUIRED_MARKERS.some((marker) => normalized.endsWith(marker));
}

function readYamlConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file: ${CONFIG_PATH}`);
  }
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
}

function resolveContextDir(config) {
  const agent = config.agent && typeof config.agent === 'object' ? config.agent : {};
  const workspaceDir = typeof agent.workspaceDir === 'string' && agent.workspaceDir.trim()
    ? path.resolve(ROOT, agent.workspaceDir)
    : path.join(ROOT, 'workspace');
  if (typeof agent.contextDir === 'string' && agent.contextDir.trim()) {
    return path.resolve(ROOT, agent.contextDir);
  }
  return path.join(workspaceDir, '.dpagent', 'contexts');
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function writeFileExact(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

function readFileExact(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function createTextCase(index, relativePath, content) {
  const token = `EVAL-${String(index).padStart(2, '0')}-OK`;
  return {
    id: token.toLowerCase(),
    token,
    prepare: (_workspaceDir) => undefined,
    prompt: [
      `In the current workspace, create \`${relativePath}\` with exact content \`${content}\`.`,
      'Verify the file by reading it back before you conclude.',
      `Include the token \`${token}\` in your final report.`,
    ].join(' '),
    verify: (workspaceDir, finalOutput) => {
      const targetPath = path.join(workspaceDir, relativePath);
      return fs.existsSync(targetPath) && readFileExact(targetPath) === content && String(finalOutput || '').includes(token);
    },
  };
}

function createCopyCase(index, seedPath, seedContent, outputPath) {
  const token = `EVAL-${String(index).padStart(2, '0')}-OK`;
  return {
    id: token.toLowerCase(),
    token,
    prepare: (workspaceDir) => {
      writeFileExact(path.join(workspaceDir, seedPath), seedContent);
    },
    prompt: [
      `Read \`${seedPath}\`, create \`${outputPath}\` with the exact same content, and verify the copy by reading it back.`,
      `Include the token \`${token}\` in your final report.`,
    ].join(' '),
    verify: (workspaceDir, finalOutput) => {
      const targetPath = path.join(workspaceDir, outputPath);
      return fs.existsSync(targetPath) && readFileExact(targetPath) === seedContent && String(finalOutput || '').includes(token);
    },
  };
}

function createMultiFileCase(index, fileSpecs) {
  const token = `EVAL-${String(index).padStart(2, '0')}-OK`;
  return {
    id: token.toLowerCase(),
    token,
    prepare: (_workspaceDir) => undefined,
    prompt: [
      `Create the following files in the current workspace: ${fileSpecs.map((item) => `\`${item.relativePath}\` = \`${item.content}\``).join(', ')}.`,
      'Verify each file by reading it back before you conclude.',
      `Include the token \`${token}\` in your final report.`,
    ].join(' '),
    verify: (workspaceDir, finalOutput) => {
      const filesOk = fileSpecs.every((item) => {
        const targetPath = path.join(workspaceDir, item.relativePath);
        return fs.existsSync(targetPath) && readFileExact(targetPath) === item.content;
      });
      return filesOk && String(finalOutput || '').includes(token);
    },
  };
}

function buildCases() {
  return [
    createTextCase(1, 'case-01.txt', 'alpha-01'),
    createTextCase(2, 'notes/case-02.md', 'beta-02'),
    createTextCase(3, 'data/case-03.json', '{"case":3,"status":"ok"}'),
    createTextCase(4, 'nested/one/case-04.txt', 'delta-04'),
    createTextCase(5, 'math/case-05.txt', '17+25=42'),
    createCopyCase(6, 'seed-06.txt', 'mirror-06', 'copy-06.txt'),
    createCopyCase(7, 'seed/source-07.txt', 'mirror-07', 'copied/result-07.txt'),
    createMultiFileCase(8, [
      { relativePath: 'pair/a-08.txt', content: 'left-08' },
      { relativePath: 'pair/b-08.txt', content: 'right-08' },
    ]),
    createMultiFileCase(9, [
      { relativePath: 'triple/first-09.txt', content: 'one-09' },
      { relativePath: 'triple/second-09.txt', content: 'two-09' },
      { relativePath: 'triple/third-09.txt', content: 'three-09' },
    ]),
    createTextCase(10, 'report/case-10.txt', 'line-10-a\nline-10-b'),
    createCopyCase(11, 'input-11.txt', 'copy-me-11', 'verified/output-11.txt'),
    createTextCase(12, 'config/case-12.json', '{"id":"case-12","mode":"pass"}'),
    createMultiFileCase(13, [
      { relativePath: 'duo/one-13.txt', content: 'one-13' },
      { relativePath: 'duo/two-13.txt', content: 'two-13' },
    ]),
    createTextCase(14, 'logs/2026/case-14.log', 'log-14'),
    createCopyCase(15, 'seed/deep/input-15.txt', 'echo-15', 'seed/deep/output-15.txt'),
    createTextCase(16, 'summary/case-16.md', '# case-16'),
    createTextCase(17, 'table/case-17.csv', 'name,value\ncase17,17'),
    createMultiFileCase(18, [
      { relativePath: 'multi/a-18.txt', content: 'a-18' },
      { relativePath: 'multi/b-18.txt', content: 'b-18' },
      { relativePath: 'multi/c-18.txt', content: 'c-18' },
    ]),
    createCopyCase(19, 'input-19.txt', 'repeat-19', 'copied-19.txt'),
    createTextCase(20, 'final/case-20.txt', 'omega-20'),
  ];
}

function namespaceToken(namespace) {
  return encodeURIComponent(String(namespace || '').trim());
}

function readTurnSummaries(contextDir, sessionId) {
  const eventsPath = path.join(contextDir, 'session', namespaceToken(sessionId), 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    throw new Error(`Missing events file for session ${sessionId}: ${eventsPath}`);
  }
  const lines = fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && event.type === 'turn_summary');
}

function sendChatViaWebSocket({ port, prompt, sessionId, workspaceDir, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let currentRunId = '';
    const runIds = [];
    let timeout = null;
    let done = false;
    const startedAt = Date.now();

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

    const armTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => finish(new Error(`chat timeout after ${timeoutMs}ms`), true), timeoutMs);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'chat',
        data: {
          prompt,
          sessionId,
          workspaceDir,
        },
      }));
      armTimeout();
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
      const packetRunId = String(data.runId || '').trim();

      armTimeout();

      if (type === 'chat_started') {
        if (packetRunId) {
          currentRunId = packetRunId;
          if (!runIds.includes(packetRunId)) {
            runIds.push(packetRunId);
          }
        }
        return;
      }

      if (packetRunId && currentRunId && packetRunId !== currentRunId) {
        return;
      }

      if (type === 'error') {
        finish(new Error(String(data.error || 'unknown_error')), true);
        return;
      }

      if (type === 'complete') {
        finish({
          runId: currentRunId,
          runIds,
          content: String(data.content || ''),
          elapsedMs: Date.now() - startedAt,
        }, false);
      }
    });

    ws.on('error', (error) => finish(error, true));
  });
}

async function runCase(index, definition, contextDir, workRoot) {
  const workspaceDir = path.join(workRoot, `case-${String(index).padStart(2, '0')}`);
  const sessionId = `eval-completion-marker-${Date.now()}-${String(index).padStart(2, '0')}`;
  ensureDir(workspaceDir);
  definition.prepare(workspaceDir);

  console.log(`[eval] case ${String(index).padStart(2, '0')} start session=${sessionId}`);
  const response = await sendChatViaWebSocket({
    port: DEFAULT_PORT,
    prompt: definition.prompt,
    sessionId,
    workspaceDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  const turnSummaries = readTurnSummaries(contextDir, sessionId);
  const finalSummary = turnSummaries.at(-1);
  if (!finalSummary) {
    throw new Error(`Missing turn_summary for session ${sessionId}`);
  }

  const finalOutput = String(finalSummary.data?.finalOutput || '');
  const finalFinishReason = String(finalSummary.data?.finishReason || '');
  const finalMarkerMatched = hasRequiredMarker(finalOutput);
  const oraclePassed = definition.verify(workspaceDir, finalOutput);

  const earliestCompletedSummary = turnSummaries.find((event) => {
    const output = String(event?.data?.finalOutput || '');
    return String(event?.data?.finishReason || '') === 'end_turn' && output.includes(definition.token);
  }) || null;
  const leakedReport =
    Boolean(earliestCompletedSummary) &&
    !hasRequiredMarker(String(earliestCompletedSummary.data?.finalOutput || '')) &&
    oraclePassed;

  return {
    id: definition.id,
    token: definition.token,
    sessionId,
    elapsedMs: response.elapsedMs,
    runChainLength: Array.isArray(response.runIds) ? response.runIds.length : 0,
    completeEventChars: String(response.content || '').length,
    turnCount: turnSummaries.length,
    finalFinishReason,
    finalMarkerMatched,
    oraclePassed,
    leakedReport,
    finalOutputTail: normalizeTail(finalOutput).slice(-120),
  };
}

async function main() {
  const config = readYamlConfig();
  const contextDir = resolveContextDir(config);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-marker-eval-'));
  const outputDir = path.join(ROOT, 'logs');
  ensureDir(outputDir);

  const cases = buildCases();
  if (cases.length < CASE_COUNT) {
    throw new Error(`Expected at least ${CASE_COUNT} eval cases, got ${cases.length}.`);
  }

  const results = [];
  let fatalError = null;
  try {
    for (let index = 0; index < CASE_COUNT; index += 1) {
      const result = await runCase(index + 1, cases[index], contextDir, workRoot);
      results.push(result);
      console.log(
        `[eval] case ${String(index + 1).padStart(2, '0')} finishReason=${result.finalFinishReason} marker=${result.finalMarkerMatched} leaked=${result.leakedReport} run_chain=${result.runChainLength}`
      );
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  }

  const completedCases = results.filter((item) => item.oraclePassed).length;
  const endTurnCases = results.filter((item) => item.finalFinishReason === 'end_turn').length;
  const finalMarkerMisses = results.filter((item) => !item.finalMarkerMatched).length;
  const leakedReports = results.filter((item) => item.leakedReport).length;
  const leakRate = results.length > 0 ? leakedReports / results.length : 1;
  const summary = {
    generatedAt: new Date().toISOString(),
    port: DEFAULT_PORT,
    contextDir,
    caseCount: results.length,
    completedCases,
    endTurnCases,
    finalMarkerMisses,
    leakedReports,
    leakRate,
    maxLeakRate: MAX_LEAK_RATE,
    fatalError,
    results,
  };

  const outputPath = path.join(outputDir, `completion-marker-eval-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[eval] summary saved: ${outputPath}`);
  console.log(
    `[eval] cases=${summary.caseCount} end_turn=${endTurnCases} completed=${completedCases} final_marker_miss=${finalMarkerMisses} leaked=${leakedReports} leak_rate=${leakRate.toFixed(3)}`
  );

  if (fatalError) {
    throw new Error(fatalError);
  }
  if (summary.caseCount < CASE_COUNT) {
    throw new Error(`Expected ${CASE_COUNT} completed eval cases, got ${summary.caseCount}.`);
  }
  if (endTurnCases !== CASE_COUNT) {
    throw new Error(`Expected ${CASE_COUNT} end_turn cases, got ${endTurnCases}.`);
  }
  if (completedCases !== CASE_COUNT) {
    throw new Error(`Expected ${CASE_COUNT} oracle-passed cases, got ${completedCases}.`);
  }
  if (finalMarkerMisses > 0) {
    throw new Error(`Final completion marker missing in ${finalMarkerMisses} cases.`);
  }
  if (leakRate > MAX_LEAK_RATE) {
    throw new Error(`Completion-marker leak rate ${leakRate.toFixed(3)} exceeds threshold ${MAX_LEAK_RATE.toFixed(3)}.`);
  }
}

main().catch((error) => {
  console.error(`[eval] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
