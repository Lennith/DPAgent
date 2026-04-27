#!/usr/bin/env node
/**
 * Diagnostic tool for MiniMax Agent runtime.
 * Reads config.yaml, logs/, contexts/, and runtime/shell-logs.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function readYamlConfig() {
  const configPath = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    return { configPath, config: null };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  return { configPath, config: yaml.load(raw) || null };
}

function readLogFile(filePath, maxLines = 100) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, path: filePath, error: 'File not found' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  return {
    exists: true,
    path: filePath,
    totalLines: lines.length,
    content: lines.slice(-maxLines).join('\n'),
  };
}

function listRecentSessions(contextDir, maxSessions = 5) {
  const sessionRoot = path.join(contextDir, 'session');
  if (!fs.existsSync(sessionRoot)) {
    return [];
  }

  const sessions = fs
    .readdirSync(sessionRoot)
    .map((name) => {
      const sessionPath = path.join(sessionRoot, name);
      const metaPath = path.join(sessionPath, 'meta.json');
      const eventsPath = path.join(sessionPath, 'events.jsonl');
      let meta = null;
      if (fs.existsSync(metaPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {
          meta = null;
        }
      }
      return {
        id: name,
        sessionPath,
        eventsExists: fs.existsSync(eventsPath),
        updatedAt: meta?.updatedAt || 'unknown',
        workspaceDir: meta?.workspaceDir || '',
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, maxSessions);

  return sessions;
}

function listRecentShellLogs(runtimeDataDir, maxLogs = 5) {
  const shellDir = path.join(runtimeDataDir, 'shell-logs');
  if (!fs.existsSync(shellDir)) {
    return [];
  }
  return fs
    .readdirSync(shellDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const filePath = path.join(shellDir, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))
    .slice(0, maxLogs);
}

function collectDiagnostics() {
  const { configPath, config } = readYamlConfig();
  const logsDir = path.join(process.cwd(), 'logs');
  const contextDir = path.resolve(process.cwd(), config?.agent?.contextDir || './contexts');
  const runtimeDataDir = path.resolve(process.cwd(), config?.agent?.runtimeDataDir || './runtime');

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      configPath,
      configExists: fs.existsSync(configPath),
      contextDir,
      runtimeDataDir,
    },
    logs: {
      all: readLogFile(path.join(logsDir, 'all.log'), 80),
      webserver: readLogFile(path.join(logsDir, 'webserver.log'), 80),
      agent: readLogFile(path.join(logsDir, 'agent.log'), 80),
      llm: readLogFile(path.join(logsDir, 'llm.log'), 80),
      tool: readLogFile(path.join(logsDir, 'tool.log'), 80),
      devOut: readLogFile(path.join(logsDir, 'dev-web.out.log'), 50),
      devErr: readLogFile(path.join(logsDir, 'dev-web.err.log'), 50),
      startOut: readLogFile(path.join(logsDir, 'start-web.out.log'), 50),
      startErr: readLogFile(path.join(logsDir, 'start-web.err.log'), 50),
    },
    sessions: listRecentSessions(contextDir),
    shellLogs: listRecentShellLogs(runtimeDataDir),
  };
  return report;
}

function printReport(report) {
  console.log('\n========================================');
  console.log('MiniMax Agent Diagnostic Report');
  console.log('========================================');
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`config.yaml: ${report.config.configPath}`);
  console.log(`contextDir: ${report.config.contextDir}`);
  console.log(`runtimeDataDir: ${report.config.runtimeDataDir}`);

  console.log('\n--- Sessions ---');
  for (const session of report.sessions) {
    console.log(`- ${session.id} | updated=${session.updatedAt} | events=${session.eventsExists}`);
  }

  console.log('\n--- Shell Logs ---');
  for (const entry of report.shellLogs) {
    console.log(`- ${entry.name} | modified=${entry.modifiedAt}`);
  }

  console.log('\n--- Log Files ---');
  for (const [name, info] of Object.entries(report.logs)) {
    if (!info.exists) {
      console.log(`- ${name}: missing`);
      continue;
    }
    console.log(`- ${name}: ${info.path} (lines=${info.totalLines})`);
  }

  console.log('\n========================================\n');
}

if (require.main === module) {
  const report = collectDiagnostics();
  printReport(report);

  const outPath = path.join(process.cwd(), 'logs', 'diagnostic-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Report saved: ${outPath}`);
}

module.exports = {
  collectDiagnostics,
  printReport,
};
