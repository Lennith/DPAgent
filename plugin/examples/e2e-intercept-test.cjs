/**
 * E2E test hook plugin.
 *
 * Reads a JSON control file to decide whether to block specific events.
 * The control file path is supplied through DPAGENT_HOOK_E2E_CONTROL_FILE.
 */
const fs = require('fs');
const path = require('path');

const CONTROL_FILE = process.env.DPAGENT_HOOK_E2E_CONTROL_FILE || '';

function readControl() {
  try {
    if (!CONTROL_FILE || !fs.existsSync(CONTROL_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function logResult(logPath, entry) {
  if (!logPath) return;
  try {
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

async function onInputToLLM() {
  const ctrl = readControl();
  logResult(ctrl.logPath, { event: 'onInputToLLM', blockInputToLLM: ctrl.blockInputToLLM });

  if (ctrl.blockInputToLLM) {
    return {
      action: 'block',
      error: 'E2E test: LLM input blocked by intercept plugin.',
    };
  }
  return { action: 'continue' };
}

async function onBeforeToolCall(ctx) {
  const ctrl = readControl();
  logResult(ctrl.logPath, {
    event: 'onBeforeToolCall',
    toolName: ctx.toolName,
    blockToolCall: ctrl.blockToolCall,
  });

  if (ctrl.blockToolCall && ctx.toolName === ctrl.blockToolCall) {
    return {
      action: 'block',
      error: `E2E test: tool "${ctx.toolName}" blocked by intercept plugin.`,
    };
  }
  return { action: 'continue' };
}

async function onAfterToolCall(ctx) {
  const ctrl = readControl();
  logResult(ctrl.logPath, {
    event: 'onAfterToolCall',
    toolName: ctx.toolName,
    success: ctx.result.success,
  });
  return { action: 'continue' };
}

module.exports = { onInputToLLM, onBeforeToolCall, onAfterToolCall };
