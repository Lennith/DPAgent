import * as crypto from 'node:crypto';
import * as path from 'node:path';
import WebSocket from 'ws';
import { parseDpagentExecArgs, type ExecParsedArgs } from './dpagent-exec-args.js';

type JsonRecord = Record<string, unknown>;

const DEFAULT_DPAGENT_SERVER_URL = 'http://localhost:53721';
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

interface WebSocketRunDiagnostics {
  threadId: string;
  workspaceDir: string;
  wsUrl: string;
  opened: boolean;
  completed: boolean;
  failed: boolean;
  messageCount: number;
  ignoredMessageCount: number;
  acceptedRunId: string;
  lastIgnoredMessageType: string;
  lastIgnoredRunId: string;
  lastMessageType: string;
  lastCompleteMessageType: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      content += chunk;
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(content));
  });
}

function writeJsonl(event: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveServerUrl(parsed: ExecParsedArgs): URL {
  const configured =
    parsed.serverUrl?.trim() ||
    process.env.DPAGENT_SERVER_URL?.trim() ||
    DEFAULT_DPAGENT_SERVER_URL;
  return new URL(configured);
}

function resolveWebSocketUrl(serverUrl: URL): string {
  const wsUrl = new URL(serverUrl.toString());
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.pathname = wsUrl.pathname && wsUrl.pathname !== '/' ? wsUrl.pathname : '/';
  wsUrl.search = '';
  wsUrl.hash = '';
  return wsUrl.toString();
}

function resolveWorkspaceDir(parsed: ExecParsedArgs): string {
  const configured = parsed.workspaceDir?.trim() || process.env.DPAGENT_WORKSPACE_DIR?.trim();
  return configured ? path.resolve(configured) : process.cwd();
}

function installStdoutJsonlGuard(): () => void {
  const originalLog = console.log;
  const originalInfo = console.info;
  const redirect = (...args: unknown[]) => {
    process.stderr.write(`${args.map((item) => String(item)).join(' ')}\n`);
  };
  console.log = redirect;
  console.info = redirect;
  return () => {
    console.log = originalLog;
    console.info = originalInfo;
  };
}

function normalizeContent(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readMessageData(message: Record<string, unknown>): Record<string, unknown> {
  return normalizeObject(message.data);
}

function readMessageRunId(message: Record<string, unknown>): string {
  return normalizeContent(readMessageData(message).runId);
}

function resolveMessageAcceptance(
  message: Record<string, unknown>,
  threadId: string,
  acceptedRunId: string
): { accept: boolean; acceptedRunId: string } {
  const data = readMessageData(message);
  const runId = normalizeContent(data.runId);
  const context = normalizeObject(data.context);
  const namespace = normalizeContent(context.namespace);
  const sessionId = normalizeContent(data.sessionId);

  if (acceptedRunId) {
    return {
      accept: !runId || runId === acceptedRunId,
      acceptedRunId,
    };
  }

  if (namespace && namespace !== threadId) {
    return { accept: false, acceptedRunId };
  }
  if (sessionId && sessionId !== threadId) {
    return { accept: false, acceptedRunId };
  }

  return {
    accept: true,
    acceptedRunId: runId || acceptedRunId,
  };
}

function emitDpAgentMessageAsJsonl(message: Record<string, unknown>): { complete: boolean; failed: boolean } {
  const type = typeof message.type === 'string' ? message.type : '';
  const data = normalizeObject(message.data);

  switch (type) {
    case 'chat_started':
      writeJsonl({
        type: 'turn.started',
        timestamp: data.startedAt ?? nowIso(),
      });
      return { complete: false, failed: false };
    case 'step':
      writeJsonl({
        type: 'turn.started',
        step: data.step,
        max_steps: data.maxSteps,
      });
      return { complete: false, failed: false };
    case 'thinking': {
      const content = normalizeContent(data.thinking);
      if (content) {
        writeJsonl({
          type: 'item.completed',
          item: {
            type: 'reasoning',
            content,
          },
        });
      }
      return { complete: false, failed: false };
    }
    case 'tool_call':
      writeJsonl({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: data.toolCallId,
          tool: data.name,
          arguments: data.args ?? {},
        },
      });
      return { complete: false, failed: false };
    case 'tool_result':
      writeJsonl({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          tool: data.name,
          output: data.result,
        },
      });
      return { complete: false, failed: false };
    case 'message': {
      const role = normalizeContent(data.role);
      const content = normalizeContent(data.content);
      if (role === 'assistant' && content) {
        writeJsonl({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            content,
          },
        });
      }
      return { complete: false, failed: false };
    }
    case 'complete': {
      const content = normalizeContent(data.content);
      if (content) {
        writeJsonl({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            content,
          },
        });
      }
      return { complete: false, failed: false };
    }
    case 'run_terminal': {
      const terminalCode = normalizeContent(data.terminalCode);
      const reason = normalizeContent(data.errorSummary);
      if (terminalCode === 'completed') {
        writeJsonl({
          type: 'turn.completed',
          finish_reason: 'stop',
        });
        writeJsonl({
          type: 'task_complete',
        });
        return { complete: true, failed: false };
      }
      if (terminalCode === 'error' || terminalCode === 'cancelled') {
        writeJsonl({
          type: 'error',
          message: reason || terminalCode,
        });
        return { complete: true, failed: true };
      }
      return { complete: false, failed: false };
    }
    case 'error':
    case 'server_error':
      writeJsonl({
        type: 'error',
        message: normalizeContent(data.error) || normalizeContent(data.message) || type,
      });
      return { complete: true, failed: true };
    default:
      return { complete: false, failed: false };
  }
}

function formatWsCloseReason(reason: Buffer): string {
  const text = reason.toString('utf8').trim();
  return text.length > 0 ? text : '';
}

function buildRunDiagnosticMessage(prefix: string, diagnostics: WebSocketRunDiagnostics): string {
  return [
    prefix,
    `thread_id=${diagnostics.threadId}`,
    `opened=${diagnostics.opened}`,
    `completed=${diagnostics.completed}`,
    `failed=${diagnostics.failed}`,
    `messages=${diagnostics.messageCount}`,
    `ignored_messages=${diagnostics.ignoredMessageCount}`,
    `accepted_run_id=${diagnostics.acceptedRunId || 'none'}`,
    `last_ignored_message_type=${diagnostics.lastIgnoredMessageType || 'none'}`,
    `last_ignored_run_id=${diagnostics.lastIgnoredRunId || 'none'}`,
    `last_message_type=${diagnostics.lastMessageType || 'none'}`,
    `last_complete_message_type=${diagnostics.lastCompleteMessageType || 'none'}`,
    `workspace=${diagnostics.workspaceDir}`,
    `ws=${diagnostics.wsUrl}`,
  ].join('; ');
}

async function runViaWebServer(parsed: ExecParsedArgs, prompt: string, threadId: string): Promise<void> {
  const serverUrl = resolveServerUrl(parsed);
  const workspaceDir = resolveWorkspaceDir(parsed);
  const wsUrl = resolveWebSocketUrl(serverUrl);

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: serverUrl.origin,
        'X-DPAgent-Client-Kind': 'cli',
      },
    });
    let completed = false;
    let failed = false;
    let opened = false;
    let messageCount = 0;
    let ignoredMessageCount = 0;
    let acceptedRunId = '';
    let lastIgnoredMessageType = '';
    let lastIgnoredRunId = '';
    let lastMessageType = '';
    let lastCompleteMessageType = '';
    let sawCompleteEvent = false;
    const diagnostics = (): WebSocketRunDiagnostics => ({
      threadId,
      workspaceDir,
      wsUrl,
      opened,
      completed,
      failed,
      messageCount,
      ignoredMessageCount,
      acceptedRunId,
      lastIgnoredMessageType,
      lastIgnoredRunId,
      lastMessageType,
      lastCompleteMessageType,
    });
    const timeout = setTimeout(() => {
      failed = true;
      ws.close();
      reject(
        new Error(
          buildRunDiagnosticMessage(`DPAgent backend run timed out after ${DEFAULT_RUN_TIMEOUT_MS}ms`, diagnostics())
        )
      );
    }, DEFAULT_RUN_TIMEOUT_MS);

    ws.once('open', () => {
      opened = true;
      ws.send(
        JSON.stringify({
          type: 'chat',
          data: {
            clientKind: 'cli',
            prompt: parsed.maxSteps
              ? `${prompt.trim()}\n\nUse at most ${parsed.maxSteps} execution steps for this external run.`
              : prompt,
            context: {
              scope: 'session',
              namespace: threadId,
            },
            sessionId: threadId,
            workspaceDir,
            ...(parsed.llmSelection ? { llmSelection: parsed.llmSelection } : {}),
            ...(parsed.planMode ? { planningAction: 'enter_drafting' } : {}),
            ...(parsed.externalMcpServers ? { externalMcpServers: parsed.externalMcpServers } : {}),
          },
        })
      );
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messageCount += 1;
        lastMessageType = typeof message.type === 'string' ? message.type : '';
        const acceptance = resolveMessageAcceptance(message, threadId, acceptedRunId);
        if (!acceptance.accept) {
          ignoredMessageCount += 1;
          lastIgnoredMessageType = lastMessageType;
          lastIgnoredRunId = readMessageRunId(message);
          return;
        }
        acceptedRunId = acceptance.acceptedRunId;
        const result = emitDpAgentMessageAsJsonl(message);
        if (lastMessageType === 'complete') {
          sawCompleteEvent = true;
          lastCompleteMessageType = lastMessageType;
        }
        completed = completed || result.complete;
        failed = failed || result.failed;
        if (result.complete) {
          lastCompleteMessageType = lastMessageType;
          clearTimeout(timeout);
          ws.close();
          if (failed) {
            reject(new Error(buildRunDiagnosticMessage('DPAgent backend run failed', diagnostics())));
          } else {
            resolve();
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    });

    ws.once('error', (error) => {
      clearTimeout(timeout);
      if (!completed) {
        reject(new Error(buildRunDiagnosticMessage(`DPAgent backend websocket error: ${error.message}`, diagnostics())));
      }
    });

    ws.once('close', (code, reason) => {
      clearTimeout(timeout);
      if (!completed) {
        if (sawCompleteEvent && !failed) {
          writeJsonl({
            type: 'turn.completed',
            finish_reason: 'stop',
          });
          writeJsonl({
            type: 'task_complete',
          });
          completed = true;
          resolve();
          return;
        }
        const reasonText = formatWsCloseReason(reason);
        const closeSummary = `DPAgent backend connection closed before completion: code=${code}${
          reasonText ? ` reason=${reasonText}` : ''
        }`;
        reject(new Error(buildRunDiagnosticMessage(closeSummary, diagnostics())));
      }
    });
  });
}

export async function runDpagentExec(argv: string[]): Promise<void> {
  const parsed = parseDpagentExecArgs(argv);
  const restoreConsole = installStdoutJsonlGuard();
  const prompt = await readStdin();
  const threadId = (parsed.resumeSessionId || parsed.sessionId || crypto.randomUUID()).trim();

  writeJsonl({
    type: 'thread.started',
    thread_id: threadId,
    session_id: threadId,
    timestamp: nowIso(),
  });

  try {
    await runViaWebServer(parsed, prompt, threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJsonl({
      type: 'error',
      message,
    });
    process.exitCode = 1;
  } finally {
    restoreConsole();
  }
}
