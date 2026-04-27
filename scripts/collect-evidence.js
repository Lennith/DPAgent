#!/usr/bin/env node
/**
 * Evidence collector for context events and tool executions.
 * Usage: node scripts/collect-evidence.js <sessionId>
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function loadRuntimePaths() {
  const configPath = path.join(process.cwd(), 'config.yaml');
  let parsed = {};
  if (fs.existsSync(configPath)) {
    parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  }
  return {
    contextDir: path.resolve(process.cwd(), parsed.agent?.contextDir || './contexts'),
    runtimeDataDir: path.resolve(process.cwd(), parsed.agent?.runtimeDataDir || './runtime'),
  };
}

function sessionPathFromId(contextDir, sessionId) {
  return path.join(contextDir, 'session', sessionId);
}

function readJsonSafely(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getSessionHistory(contextDir, sessionId) {
  const sessionPath = sessionPathFromId(contextDir, sessionId);
  if (!fs.existsSync(sessionPath)) {
    return { error: `Session not found: ${sessionPath}` };
  }

  const metaPath = path.join(sessionPath, 'meta.json');
  const eventsPath = path.join(sessionPath, 'events.jsonl');
  const latestInputPath = path.join(sessionPath, 'latest_llm_input_messages.json');

  const meta = fs.existsSync(metaPath) ? readJsonSafely(metaPath, null) : null;
  const latestInput = fs.existsSync(latestInputPath) ? readJsonSafely(latestInputPath, null) : null;

  const events = [];
  if (fs.existsSync(eventsPath)) {
    const lines = fs
      .readFileSync(eventsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
  }

  return {
    meta,
    events,
    latestInput,
    sessionPath,
    eventsPath,
  };
}

function extractToolCalls(events) {
  return events
    .filter((event) => event.type === 'tool_call' || event.type === 'tool_result')
    .map((event) => ({
      timestamp: event.timestamp,
      type: event.type,
      turnId: event.turnId,
      name: event.data?.name || '',
      args: event.type === 'tool_call' ? event.data?.args : undefined,
      contentPreview:
        event.type === 'tool_result' && typeof event.data?.content === 'string'
          ? event.data.content.slice(0, 240)
          : undefined,
    }));
}

function getLatestLogTail(logFilePath, maxLines = 40) {
  if (!fs.existsSync(logFilePath)) {
    return [];
  }
  const lines = fs.readFileSync(logFilePath, 'utf8').split('\n');
  return lines.slice(-maxLines);
}

function main() {
  const sessionId = process.argv[2];
  const { contextDir, runtimeDataDir } = loadRuntimePaths();

  if (!sessionId) {
    const sessionRoot = path.join(contextDir, 'session');
    console.log('Usage: node scripts/collect-evidence.js <sessionId>');
    console.log('\nRecent sessions:');
    if (!fs.existsSync(sessionRoot)) {
      console.log(`- no session directory found (${sessionRoot})`);
      process.exit(0);
    }

    const sessions = fs
      .readdirSync(sessionRoot)
      .map((name) => {
        const meta = readJsonSafely(path.join(sessionRoot, name, 'meta.json'), {});
        return { id: name, updatedAt: meta.updatedAt || '' };
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 8);

    for (const session of sessions) {
      console.log(`- ${session.id} (updated: ${session.updatedAt || 'unknown'})`);
    }
    process.exit(0);
  }

  const history = getSessionHistory(contextDir, sessionId);
  if (history.error) {
    console.error(history.error);
    process.exit(1);
  }

  const toolCalls = extractToolCalls(history.events);
  const logTail = getLatestLogTail(path.join(process.cwd(), 'logs', 'all.log'), 80);
  const shellLogRoot = path.join(runtimeDataDir, 'shell-logs');

  console.log('\n========================================');
  console.log('Evidence Collector');
  console.log('========================================');
  console.log(`Session: ${sessionId}`);
  console.log(`Session Path: ${history.sessionPath}`);
  console.log(`Events: ${history.events.length}`);
  console.log(`Tool events: ${toolCalls.length}`);
  console.log(`Shell logs dir: ${shellLogRoot}`);

  console.log('\n--- Session Meta ---');
  console.log(JSON.stringify(history.meta || {}, null, 2));

  console.log('\n--- Tool Events ---');
  for (const [index, item] of toolCalls.entries()) {
    console.log(`[${index + 1}] ${item.timestamp} ${item.type} ${item.name}`);
    if (item.args) {
      console.log(`  args: ${JSON.stringify(item.args)}`);
    }
    if (item.contentPreview) {
      console.log(`  result: ${item.contentPreview}`);
    }
  }

  console.log('\n--- logs/all.log tail ---');
  for (const line of logTail) {
    console.log(line);
  }

  const outputPath = path.join(process.cwd(), 'logs', `evidence-${sessionId}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    contextDir,
    runtimeDataDir,
    sessionId,
    sessionPath: history.sessionPath,
    meta: history.meta,
    eventsCount: history.events.length,
    toolEvents: toolCalls,
    latestLlmInputExists: Boolean(history.latestInput),
    logTail,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\nEvidence saved: ${outputPath}`);
  console.log('========================================\n');
}

main();
