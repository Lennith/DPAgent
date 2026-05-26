/**
 * full-hook-demo.cjs — Complete hook demo plugin for DPAgent v2.2.0
 *
 * Handles ALL 6 hook events and writes a JSON-lines audit log.
 * Place this file in your workspace and reference it from hook.config.yaml:
 *
 *   hooks:
 *     - id: "full-hook-demo"
 *       events: ["onTurnStart","onInputToLLM","onLLMResponse","onBeforeToolCall","onAfterToolCall","onTurnEnd"]
 *       module: "./examples/full-hook-demo.cjs"
 *       priority: 100
 *
 * The log is written to: <workspace>/logs/hook-demo/hook-demo.log
 */

const fs = require('fs');
const path = require('path');

// ── State ─────────────────────────────────────────────────────
let logDir = null;
let logStream = null;
let turnSeq = 0;

function resolveLogDir() {
  if (logDir) return logDir;
  // Try workspace root, fallback to cwd
  const candidates = [
    process.env.DPAGENT_WORKSPACE_DIR,
    process.cwd(),
  ].filter(Boolean);
  const root = candidates[0] || process.cwd();
  const dir = path.join(root, 'logs', 'hook-demo');
  fs.mkdirSync(dir, { recursive: true });
  logDir = dir;
  return dir;
}

function getLogPath() {
  return path.join(resolveLogDir(), 'hook-demo.log');
}

function logEntry(event, data) {
  if (!logStream) {
    const p = getLogPath();
    logStream = fs.createWriteStream(p, { flags: 'a' });
    // Write _init marker FIRST, then write the actual event
    const initEntry = {
      ts: new Date().toISOString(),
      event: '_init',
      turn: turnSeq,
      logPath: p,
      startedAt: new Date().toISOString(),
    };
    logStream.write(JSON.stringify(initEntry) + '\n');
  }
  const entry = {
    ts: new Date().toISOString(),
    event,
    turn: turnSeq,
    ...data,
  };
  logStream.write(JSON.stringify(entry) + '\n');
}

// ── Hook Handlers ─────────────────────────────────────────────

/**
 * onTurnStart — A new agent turn is starting.
 * Context: { sessionId, step, messages, systemPrompt? }
 */
async function onTurnStart(ctx) {
  turnSeq += 1;
  logEntry('onTurnStart', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    messageCount: ctx.messages.length,
    hasSystemPrompt: !!ctx.systemPrompt,
  });
  return { action: 'continue' };
}

/**
 * onInputToLLM — Input prepared, about to send to LLM.
 * Context: { sessionId, step, systemPrompt, contentMessages, precompressApplied }
 * Can block to return an error as assistant response.
 */
async function onInputToLLM(ctx) {
  const totalChars = ctx.contentMessages.reduce(
    (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );
  logEntry('onInputToLLM', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    messageCount: ctx.contentMessages.length,
    totalContentChars: totalChars,
    precompressApplied: ctx.precompressApplied,
    hasSystemPrompt: !!ctx.systemPrompt,
  });
  return { action: 'continue' };
}

/**
 * onLLMResponse — LLM responded, before assistant message is created.
 * Context: { sessionId, step, response: LLMResponse }
 */
async function onLLMResponse(ctx) {
  const resp = ctx.response;
  logEntry('onLLMResponse', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    finishReason: resp.finishReason,
    contentChars: resp.content?.length ?? 0,
    thinkingChars: resp.thinking?.length ?? 0,
    toolCallCount: resp.toolCalls?.length ?? 0,
    toolNames: resp.toolCalls?.map((tc) => tc.function.name) ?? [],
    hasUsage: !!resp.usage,
  });
  return { action: 'continue' };
}

/**
 * onBeforeToolCall — Before a tool is executed.
 * Context: { sessionId, step, toolCall, toolName, toolArgs }
 * Can block → tool_error injected into stream.
 *
 * Demonstrates blocking: blocks shell_execute with dangerous patterns.
 */
async function onBeforeToolCall(ctx) {
  const argsSummary = JSON.stringify(ctx.toolArgs).slice(0, 200);
  logEntry('onBeforeToolCall', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    toolCallId: ctx.toolCall.id,
    toolName: ctx.toolName,
    argChars: argsSummary.length,
    argsPreview: argsSummary,
  });

  // Example guard: block shell commands that look destructive
  if (ctx.toolName === 'shell_execute') {
    const cmd = String(ctx.toolArgs.command ?? '').toLowerCase();
    const blockedPatterns = ['rm -rf /', 'format c:', 'del /f /s'];
    for (const pattern of blockedPatterns) {
      if (cmd.includes(pattern)) {
        logEntry('onBeforeToolCall:blocked', {
          sessionId: ctx.sessionId,
          toolName: ctx.toolName,
          reason: `Blocked destructive pattern: ${pattern}`,
        });
        return {
          action: 'block',
          error: `Tool call blocked by hook policy: destructive command pattern detected`,
        };
      }
    }
  }

  return { action: 'continue' };
}

/**
 * onAfterToolCall — After tool completes, result is available.
 * Context: { sessionId, step, toolCall, toolName, result: ToolResult }
 */
async function onAfterToolCall(ctx) {
  logEntry('onAfterToolCall', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    toolCallId: ctx.toolCall.id,
    toolName: ctx.toolName,
    success: ctx.result.success,
    resultChars: ctx.result.content?.length ?? 0,
    hasError: !!ctx.result.error,
    errorPreview: ctx.result.error?.slice(0, 100) ?? null,
  });
  return { action: 'continue' };
}

/**
 * onTurnEnd — Turn ended (success, error, cancel, etc.).
 * Context: { sessionId, step, finishReason, content, usage? }
 */
async function onTurnEnd(ctx) {
  logEntry('onTurnEnd', {
    sessionId: ctx.sessionId,
    step: ctx.step,
    finishReason: ctx.finishReason,
    contentChars: ctx.content?.length ?? 0,
    promptTokens: ctx.usage?.promptTokens ?? 0,
    completionTokens: ctx.usage?.completionTokens ?? 0,
    totalTokens: ctx.usage?.totalTokens ?? 0,
  });
  return { action: 'continue' };
}

// ── Module Export ─────────────────────────────────────────────

module.exports = {
  onTurnStart,
  onInputToLLM,
  onLLMResponse,
  onBeforeToolCall,
  onAfterToolCall,
  onTurnEnd,
};
