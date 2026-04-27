/**
 * Unified Logger for MiniMax Agent
 * 
 * Log Levels: DEBUG < INFO < WARN < ERROR
 * Components: [WebServer] [Agent] [LLM] [Tool] [MCP] [Skill] [Session]
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogComponent = 
  | 'WebServer' 
  | 'MiniMaxAgent' 
  | 'Agent' 
  | 'LLM' 
  | 'Tool' 
  | 'MCP' 
  | 'Skill' 
  | 'Session' 
  | 'Config';

interface LoggerOptions {
  logDir?: string;
  console?: boolean;
  minLevel?: LogLevel;
  component?: LogComponent;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...(truncated ${value.length} chars)` : value;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForLog(item));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|password|secret|token|authorization/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (/content|input|prompt|command/i.test(key) && typeof entry === 'string' && entry.length > 200) {
      out[key] = `${entry.slice(0, 200)}...(truncated ${entry.length} chars)`;
      continue;
    }
    out[key] = sanitizeForLog(entry);
  }
  return out;
}

function safeJsonPreview(value: unknown, maxChars: number): string {
  const serialized =
    typeof value === 'string'
      ? sanitizeForLog(value)
      : JSON.stringify(sanitizeForLog(value));
  const text = String(serialized ?? '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...(truncated)` : text;
}

class Logger {
  private logDir: string;
  private enableConsole: boolean;
  private minLevel: LogLevel;
  private component?: LogComponent;

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? path.join(process.cwd(), 'logs');
    this.enableConsole = options.console ?? true;
    this.minLevel = options.minLevel ?? 'info';
    this.component = options.component;
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, component?: LogComponent): string {
    const timestamp = new Date().toISOString();
    const comp = component || this.component || 'App';
    return `[${timestamp}] [${level.toUpperCase()}] [${comp}] ${message}`;
  }

  private writeLog(level: LogLevel, message: string, component?: LogComponent): void {
    if (!this.shouldLog(level)) return;

    const formattedMessage = this.formatMessage(level, message, component);
    
    if (this.enableConsole) {
      const consoleMethod = level === 'error' ? console.error : 
                           level === 'warn' ? console.warn : 
                           console.log;
      consoleMethod(formattedMessage);
    }

    // Write to component-specific log file
    const comp = component || this.component || 'app';
    const logFile = path.join(this.logDir, `${comp.toLowerCase()}.log`);
    fs.appendFileSync(logFile, formattedMessage + '\n');

    // Also write to combined log
    const combinedLog = path.join(this.logDir, 'all.log');
    fs.appendFileSync(combinedLog, formattedMessage + '\n');
  }

  // Component-specific loggers
  withComponent(component: LogComponent): Logger {
    return new Logger({
      logDir: this.logDir,
      console: this.enableConsole,
      minLevel: this.minLevel,
      component,
    });
  }

  debug(message: string, component?: LogComponent): void {
    this.writeLog('debug', message, component);
  }

  info(message: string, component?: LogComponent): void {
    this.writeLog('info', message, component);
  }

  warn(message: string, component?: LogComponent): void {
    this.writeLog('warn', message, component);
  }

  error(message: string, component?: LogComponent): void {
    this.writeLog('error', message, component);
  }

  // Specialized logging methods
  toolCall(toolName: string, args: Record<string, unknown>): void {
    this.info(`TOOL_CALL: ${toolName} args=${safeJsonPreview(args, 1200)}`, 'Tool');
  }

  toolResult(toolName: string, result: unknown, durationMs: number): void {
    this.info(`TOOL_RESULT: ${toolName} duration=${durationMs}ms result=${safeJsonPreview(result, 400)}`, 'Tool');
  }

  toolError(toolName: string, error: unknown, durationMs: number): void {
    this.error(`TOOL_ERROR: ${toolName} duration=${durationMs}ms error=${error}`, 'Tool');
  }

  skillLoad(skillName: string, source: string): void {
    this.info(`SKILL_LOAD: ${skillName} from=${source}`, 'Skill');
  }

  skillPromptGenerated(skillCount: number, promptLength: number): void {
    this.info(`SKILL_PROMPT: generated=${skillCount} skills, length=${promptLength}`, 'Skill');
  }

  mcpConnect(serverName: string, status: 'connecting' | 'connected' | 'failed', details?: string): void {
    const icon = status === 'connected' ? 'CONNECTED' : status === 'connecting' ? 'CONNECTING' : 'FAILED';
    this.info(`${icon} MCP_CONNECT: ${serverName} status=${status}${details ? ` ${details}` : ''}`, 'MCP');
  }

  mcpToolCall(toolName: string, serverName: string): void {
    this.info(`MCP_TOOL_CALL: ${toolName} server=${serverName}`, 'MCP');
  }

  llmRequest(model: string, messageCount: number): void {
    this.info(`LLM_REQUEST: model=${model} messages=${messageCount}`, 'LLM');
  }

  llmStreamEvent(type: 'text' | 'thinking' | 'tool_use', preview: string): void {
    this.debug(`LLM_STREAM: type=${type} preview=${preview.substring(0, 50)}`, 'LLM');
  }

  llmResponseComplete(tokenCount: number, durationMs: number): void {
    this.info(`LLM_RESPONSE: tokens=${tokenCount} duration=${durationMs}ms`, 'LLM');
  }

  llmError(error: unknown): void {
    this.error(`LLM_ERROR: ${error}`, 'LLM');
  }

  sessionCreate(sessionId: string, workspaceDir: string): void {
    this.info(`SESSION_CREATE: ${sessionId} workspace=${workspaceDir}`, 'Session');
  }

  sessionLoad(sessionId: string, messageCount: number): void {
    this.info(`SESSION_LOAD: ${sessionId} messages=${messageCount}`, 'Session');
  }

  sessionSave(sessionId: string, newMessages: number): void {
    this.info(`SESSION_SAVE: ${sessionId} newMessages=${newMessages}`, 'Session');
  }

  configLoad(source: string, details?: string): void {
    this.info(`CONFIG_LOAD: from=${source}${details ? ` ${details}` : ''}`, 'Config');
  }

  websocket(event: 'connect' | 'disconnect' | 'message', clientId?: string): void {
    const icon = event === 'connect' ? 'WS_CONNECT' : event === 'disconnect' ? 'WS_DISCONNECT' : 'WS_MESSAGE';
    this.debug(`${icon}: client=${clientId || 'unknown'}`, 'WebServer');
  }

  process(message: string): void {
    this.info(`PROCESS: ${message}`, 'Tool');
  }

  // REQ-0025/0026: Context overflow and precompress logging
  contextOverflowSnapshot(
    stage: string,
    overflowCount: number,
    totalSnapshots: number,
    decision: string,
    beforeChars: number
  ): void {
    this.info(
      `CONTEXT_OVERFLOW: stage=${stage} overflowCount=${overflowCount} totalSnapshots=${totalSnapshots} decision=${decision} beforeChars=${beforeChars}`,
      'Agent'
    );
  }

  contextPrecompressSnapshot(
    triggerChars: number,
    triggerRatio: number,
    totalCharsBefore: number,
    totalCharsAfter: number,
    applied: boolean
  ): void {
    this.info(
      `CONTEXT_PRECOMPRESS: triggerChars=${triggerChars} ratio=${triggerRatio} before=${totalCharsBefore} after=${totalCharsAfter} applied=${applied}`,
      'Agent'
    );
  }

  contextUtilization(ratio: number, usedChars: number, limitChars: number): void {
    const percentage = Math.round(ratio * 100);
    const level = ratio >= 0.9 ? 'warn' : 'info';
    this[level](
      `CONTEXT_UTILIZATION: ${percentage}% (${usedChars}/${limitChars} chars)`,
      'Agent'
    );
  }
}

// Global logger instance
export const logger = new Logger();

// Component-specific loggers
export const webServerLogger = logger.withComponent('WebServer');
export const agentLogger = logger.withComponent('Agent');
export const llmLogger = logger.withComponent('LLM');
export const toolLogger = logger.withComponent('Tool');
export const mcpLogger = logger.withComponent('MCP');
export const skillLogger = logger.withComponent('Skill');
export const sessionLogger = logger.withComponent('Session');
export const configLogger = logger.withComponent('Config');
