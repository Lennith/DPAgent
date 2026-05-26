import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { successResult, errorResult } from './Tool.js';
import { accessDeniedResult, ToolAccessBase, type ToolAccessBaseOptions } from './ToolAccessBase.js';
import type { ToolResult, ShellType } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  coerceShellTypeForPlatform,
  getDefaultShellType,
  getRuntimePlatformCapabilities,
  isShellSupportedOnPlatform,
} from '../runtime-platform.js';

// Process tracking log file path
function logProcessEvent(event: 'spawn' | 'kill' | 'exit', pid: number, command: string, details?: string): void {
  const sanitizedCommand = sanitizeShellCommandForLog(command);
  const logMessage = `[${event.toUpperCase()}] pid=${pid}, command="${sanitizedCommand.slice(0, 100)}..."${details ? `, ${details}` : ''}`;
  logger.process(logMessage);
}

function sanitizeShellCommandForLog(command: string): string {
  return String(command ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted-api-key]')
    .replace(
      /\b(authorization)\b(\s*[:=]\s*)(?:"Bearer\s+[^"]*"|'Bearer\s+[^']*'|Bearer\s+[^\s"'`;]+)/gi,
      (_match, key: string, sep: string) => `${key}${sep}[redacted]`
    )
    .replace(
      /(\B-{1,2}(?:api[-_]?key|token|secret|password|authorization)\b(?:\s*=\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s"'`;]+)/gi,
      '$1[redacted]'
    )
    .replace(
      /\b(api[-_]?key|token|secret|password|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'`;]+)/gi,
      (_match, key: string, sep: string) => `${key}${sep}[redacted]`
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:api[-_]?key|token|secret|password|authorization)[A-Za-z0-9_]*)\b(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'`;]+)/gi,
      (_match, key: string, sep: string) => `${key}${sep}[redacted]`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [redacted]');
}

export interface ShellToolOptions extends ToolAccessBaseOptions {
  shell?: ShellType;
  timeout?: number;
  outputIdleTimeout?: number;
  maxRunTime?: number;
  maxOutputSize?: number;
  logDir?: string;
  additionalWritableDirs?: string[];
  env?: Record<string, string>;
}

interface ShellExecutionLog {
  logId: string;
  timestamp: string;
  pid: number | undefined;
  command: string;
  shellType: ShellType;
  cwd: string;
  timeout: number;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  outputSize: number;
  killed: boolean;
  killReason: string | null;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_OUTPUT_IDLE_TIMEOUT = 120 * 1000;
const DEFAULT_MAX_RUN_TIME = 60 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

export class ShellTool extends ToolAccessBase {
  private defaultShell: ShellType;
  private defaultTimeout: number;
  private outputIdleTimeout: number;
  private maxRunTime: number;
  private maxOutputSize: number;
  private logDir: string;
  private extraEnv: Record<string, string>;
  private activeProcesses: Map<number, ReturnType<typeof spawn>> = new Map();

  constructor(options: ShellToolOptions) {
    super(options);
    this.defaultShell = coerceShellTypeForPlatform(options.shell);
    this.defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.outputIdleTimeout = options.outputIdleTimeout ?? DEFAULT_OUTPUT_IDLE_TIMEOUT;
    this.maxRunTime = options.maxRunTime ?? DEFAULT_MAX_RUN_TIME;
    this.maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
    this.logDir = options.logDir ?? path.join(options.workspaceDir, '.dpagent', 'shell-logs');
    this.extraEnv = options.env ?? {};
  }

  get name(): string {
    return 'shell_execute';
  }

  get description(): string {
    const runtime = getRuntimePlatformCapabilities();
    return `Execute shell commands on ${runtime.label} using ${runtime.supportedShells.join('/')} shells. Best for short or stepwise commands. Calls are bounded by per-request timeout plus idle-output, max-runtime, and output-size guardrails, so noisy or long-running commands may be stopped or truncated.`;
  }

  get parameters(): Record<string, unknown> {
    const runtime = getRuntimePlatformCapabilities();
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Single shell command to execute.',
        },
        shell: {
          type: 'string',
          enum: runtime.supportedShells,
          description: `The shell to use. Default is ${this.defaultShell}.`,
        },
        timeout: {
          type: 'number',
          description: 'Per-request timeout in milliseconds. Default is 30000. Commands may also stop because of idle-output, max-runtime, or max-output guardrails.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Default is workspace root.',
        },
      },
      required: ['command'],
    };
  }

  async execute(args: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<ToolResult> {
    const command = args.command as string;
    const requestedShell = args.shell as ShellType | undefined;
    if (requestedShell && !isShellSupportedOnPlatform(requestedShell)) {
      const runtime = getRuntimePlatformCapabilities();
      return errorResult(
        `Shell '${requestedShell}' is not available on ${runtime.label}. Supported shells: ${runtime.supportedShells.join(', ')}`
      );
    }
    const shell = coerceShellTypeForPlatform(requestedShell ?? this.defaultShell);
    const timeout = (args.timeout as number) ?? this.defaultTimeout;
    const cwd = this.resolveWorkspacePath((args.cwd as string) ?? '.');

    const accessDenied = accessDeniedResult(this.checkAccess(cwd, 'read'));
    if (accessDenied) {
      return accessDenied;
    }

    return this.executeCommand(command, shell, cwd, timeout, options.signal);
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private async appendLog(log: ShellExecutionLog): Promise<void> {
    try {
      this.ensureLogDir();
      const logFile = path.join(this.logDir, `${log.logId}.jsonl`);
      const logLine = JSON.stringify(log) + '\n';
      await fs.promises.appendFile(logFile, logLine);
      logger.info(
        `[ShellTool] Logged shell execution: pid=${log.pid}, command="${log.command.slice(0, 50)}...", exitCode=${log.exitCode}, killed=${log.killed}, logFile=${logFile}`
      );
    } catch (err) {
      logger.error(`[ShellTool] Failed to write log: ${(err as Error).message}`);
    }
  }

  private killProcessTree(pid: number): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        this.killProcessTreeWindows(pid, 3).then(resolve).catch(() => resolve());
        return;
      }

      this.killProcessTreeUnix(pid).then(resolve).catch(() => resolve());
    });
  }

  private async killProcessTreeWindows(pid: number, maxRetries: number): Promise<void> {
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logProcessEvent('kill', pid, 'taskkill', `attempt ${attempt}/${maxRetries}`);
      
      try {
        const success = await new Promise<boolean>((resolve) => {
          const killProc = this.spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'pipe',
          });

          const killPid = killProc.pid;
          if (killPid) {
            this.activeProcesses.set(killPid, killProc);
          }

          const killTimeout = setTimeout(() => {
            if (!killProc.killed) {
              killProc.kill();
            }
          }, 5000);

          let stderr = '';
          killProc.stderr?.on('data', (data) => {
            stderr += data.toString();
          });

          killProc.on('error', (err) => {
            clearTimeout(killTimeout);
            if (killPid) {
              this.activeProcesses.delete(killPid);
            }
            logger.error(`[ShellTool] taskkill error for pid ${pid} (attempt ${attempt}): ${err.message}`);
            resolve(false);
          });

          killProc.on('close', (code) => {
            clearTimeout(killTimeout);
            if (killPid) {
              this.activeProcesses.delete(killPid);
            }
            if (code === 0) {
              logger.info(`[ShellTool] Successfully killed process tree ${pid} on attempt ${attempt}`);
              resolve(true);
            } else {
              logger.warn(`[ShellTool] taskkill for pid ${pid} exited with code ${code} (attempt ${attempt}): ${stderr}`);
              resolve(false);
            }
          });
        });

        if (success) {
          return;
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await delay(500);
        }
      } catch (err) {
        logger.error(`[ShellTool] Unexpected error killing process tree ${pid} (attempt ${attempt}): ${(err as Error).message}`);
        if (attempt < maxRetries) {
          await delay(500);
        }
      }
    }

    logger.error(`[ShellTool] Failed to kill process tree ${pid} after ${maxRetries} attempts`);
  }

  private async killProcessTreeUnix(pid: number): Promise<void> {
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    
    // Try SIGTERM first (graceful shutdown)
    try {
      logProcessEvent('kill', pid, 'SIGTERM', 'sending SIGTERM to process group');
      process.kill(-pid, 'SIGTERM');
    } catch (err) {
      const errorMsg = (err as Error).message;
      // ESRCH = process doesn't exist, which is fine
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.error(`[ShellTool] Failed to send SIGTERM to process group ${pid}: ${errorMsg}`);
      }
      // Try direct pid as fallback
      try {
        process.kill(pid, 'SIGTERM');
        logger.info(`[ShellTool] Sent SIGTERM to pid ${pid} directly`);
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === 'ESRCH') {
          logger.info(`[ShellTool] Process ${pid} already terminated`);
          return;
        }
        logger.error(`[ShellTool] Failed to send SIGTERM to pid ${pid}: ${(fallbackErr as Error).message}`);
      }
    }

    // Wait for process to terminate
    await delay(2000);

    // Check if process still exists and use SIGKILL if necessary
    try {
      // Check if process still exists by sending signal 0
      process.kill(pid, 0);
      
      // Process still exists, send SIGKILL
      logProcessEvent('kill', pid, 'SIGKILL', 'process still alive, sending SIGKILL');
      try {
        process.kill(-pid, 'SIGKILL');
        logger.info(`[ShellTool] Sent SIGKILL to process group ${pid}`);
      } catch (err) {
        // Try direct kill
        try {
          process.kill(pid, 'SIGKILL');
          logger.info(`[ShellTool] Sent SIGKILL to pid ${pid} directly`);
        } catch (fallbackErr) {
          if ((fallbackErr as NodeJS.ErrnoException).code === 'ESRCH') {
            logger.info(`[ShellTool] Process ${pid} terminated after SIGTERM`);
            return;
          }
          throw fallbackErr;
        }
      }

      // Wait a bit more for SIGKILL to take effect
      await delay(500);
      
      // Final check
      try {
        process.kill(pid, 0);
        logger.error(`[ShellTool] Process ${pid} still exists after SIGKILL`);
      } catch {
        logger.info(`[ShellTool] Process ${pid} successfully terminated by SIGKILL`);
      }
    } catch {
      // Process doesn't exist anymore (terminated by SIGTERM)
      logger.info(`[ShellTool] Process ${pid} successfully terminated by SIGTERM`);
    }
  }

  protected spawnProcess(
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2]
  ): ReturnType<typeof spawn> {
    return spawn(command, args, options);
  }

  private executeCommand(command: string, shell: ShellType, cwd: string, timeout: number, signal?: AbortSignal): Promise<ToolResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      let lastOutputTime = Date.now();
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const logId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const startedAt = new Date().toISOString();
      const commandForLog = sanitizeShellCommandForLog(command);

      const shellArgs = this.getShellArgs(shell, command);
      const shellCmd = this.getShellCommand(shell);

      const env = {
        ...process.env,
        ...this.extraEnv,
      };

      const proc = this.spawnProcess(shellCmd, shellArgs, {
        cwd,
        env,
        shell: false,
        windowsHide: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });

      const pid = proc.pid;

      // Track active process for cleanup
      if (pid) {
        this.activeProcesses.set(pid, proc);
        logProcessEvent('spawn', pid, commandForLog);
      }

      const log: ShellExecutionLog = {
        logId,
        timestamp: startedAt,
        pid,
        command: commandForLog,
        shellType: shell,
        cwd,
        timeout,
        startedAt,
        exitCode: null,
        outputSize: 0,
        killed: false,
        killReason: null,
      };

      const cleanup = (reason: string | null, exitCode: number | null = null): Promise<void> => {
        if (resolved) return Promise.resolve();
        resolved = true;

        signal?.removeEventListener('abort', abortHandler);
        clearInterval(outputIdleTimer);
        clearTimeout(maxRunTimer);
        clearTimeout(commandTimer);

        // Remove from active processes
        if (pid) {
          this.activeProcesses.delete(pid);
          logProcessEvent('exit', pid, commandForLog, `reason=${reason}, exitCode=${exitCode}`);
        }

        log.finishedAt = new Date().toISOString();
        log.outputSize = stdout.length + stderr.length;
        log.killed = reason !== null;
        log.killReason = reason;
        log.exitCode = exitCode;

        this.appendLog(log).catch(() => {});
        if (pid && !proc.killed && proc.exitCode === null) {
          return this.killProcessTree(pid).catch(() => undefined);
        }
        return Promise.resolve();
      };

      const abortHandler = () => {
        void cleanup('cancelled').finally(() => {
          resolve(errorResult('Command cancelled'));
        });
      };

      const outputIdleTimer = setInterval(() => {
        if (Date.now() - lastOutputTime > this.outputIdleTimeout) {
          void cleanup('output_idle_timeout').finally(() => {
            resolve(errorResult(`Process killed: no output for ${this.outputIdleTimeout / 1000} seconds`));
          });
        }
      }, 5000);

      const maxRunTimer = setTimeout(() => {
        void cleanup('max_runtime_exceeded').finally(() => {
          resolve(errorResult(`Process killed: exceeded maximum runtime of ${this.maxRunTime / 1000} seconds`));
        });
      }, this.maxRunTime);

      const commandTimer = setTimeout(() => {
        void cleanup('command_timeout').finally(() => {
          resolve(errorResult(`Command timed out after ${timeout}ms`));
        });
      }, timeout);

      if (signal?.aborted) {
        abortHandler();
        return;
      }
      signal?.addEventListener('abort', abortHandler, { once: true });

      proc.stdout?.on('data', (data: Buffer) => {
        lastOutputTime = Date.now();
        if (!stdoutTruncated && stdout.length < this.maxOutputSize) {
          // Try UTF-8 first, fallback to GBK for Chinese Windows
          let newData: string;
          try {
            newData = data.toString('utf-8');
            // Check if it contains replacement characters (indicates wrong encoding)
            if (newData.includes('�') && process.platform === 'win32') {
              newData = data.toString('latin1');
            }
          } catch {
            newData = data.toString('latin1');
          }
          if (stdout.length + newData.length <= this.maxOutputSize) {
            stdout += newData;
          } else {
            stdout += newData.slice(0, this.maxOutputSize - stdout.length);
            stdoutTruncated = true;
            stdout += '\n[OUTPUT TRUNCATED - exceeded 50MB limit]';
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        lastOutputTime = Date.now();
        if (!stderrTruncated && stderr.length < this.maxOutputSize) {
          // Try UTF-8 first, fallback to GBK for Chinese Windows
          let newData: string;
          try {
            newData = data.toString('utf-8');
            // Check if it contains replacement characters (indicates wrong encoding)
            if (newData.includes('�') && process.platform === 'win32') {
              newData = data.toString('latin1');
            }
          } catch {
            newData = data.toString('latin1');
          }
          if (stderr.length + newData.length <= this.maxOutputSize) {
            stderr += newData;
          } else {
            stderr += newData.slice(0, this.maxOutputSize - stderr.length);
            stderrTruncated = true;
            stderr += '\n[OUTPUT TRUNCATED - exceeded 50MB limit]';
          }
        }
      });

      // Helper to truncate output for error messages (prevents sensitive info leaks)
      const truncateForError = (output: string, maxLen: number = 500): string => {
        if (output.length <= maxLen) {
          return output;
        }
        return output.slice(0, maxLen) + `...[truncated ${output.length - maxLen} chars]`;
      };

      proc.on('close', (code) => {
        if (resolved) return;

        void cleanup(null, code).finally(() => {
          if (code === 0) {
            resolve(successResult(stdout.trim() || '(no output)'));
          } else {
            const truncatedStdout = truncateForError(stdout, 500);
            const truncatedStderr = truncateForError(stderr, 500);
            resolve(errorResult(`Command exited with code ${code}\nStdout: ${truncatedStdout}\nStderr: ${truncatedStderr}`));
          }
        });
      });

      proc.on('error', (err) => {
        if (resolved) return;

        void cleanup('spawn_error', -1).finally(() => {
          resolve(errorResult(`Failed to execute command: ${err.message}`));
        });
      });
    });
  }

  /**
   * Cleanup all active processes. Called by DPAgent.cleanup() to prevent
   * memory leaks when agent session ends.
   */
  async cleanupAll(): Promise<void> {
    const activePids = Array.from(this.activeProcesses.keys());
    if (activePids.length === 0) {
      return;
    }

    logger.info(`[ShellTool] cleanupAll: killing ${activePids.length} active processes: ${activePids.join(', ')}`);
    logProcessEvent('kill', 0, 'cleanupAll', `killing ${activePids.length} processes: ${activePids.join(', ')}`);

    for (const pid of activePids) {
      const proc = this.activeProcesses.get(pid);
      if (proc && !proc.killed) {
        try {
          await this.killProcessTree(pid);
          logProcessEvent('kill', pid, 'cleanupAll', 'killed by cleanupAll');
        } catch (err) {
          logger.error(`[ShellTool] Failed to kill process ${pid}: ${(err as Error).message}`);
        }
      }
      this.activeProcesses.delete(pid);
    }
  }

  private getShellCommand(shell: ShellType): string {
    switch (shell) {
      case 'powershell':
        return 'powershell.exe';
      case 'cmd':
        return 'cmd.exe';
      case 'bash':
        return 'bash';
      case 'sh':
        return 'sh';
      default:
        return this.getShellCommand(getDefaultShellType());
    }
  }

  private getShellArgs(shell: ShellType, command: string): string[] {
    switch (shell) {
      case 'powershell':
        // Set UTF-8 code page before executing command to handle Chinese characters
        return ['-NoProfile', '-NonInteractive', '-Command', `chcp 65001 > $null; ${command}`];
      case 'cmd':
        return ['/c', command];
      case 'bash':
        return ['-lc', command];
      case 'sh':
        return ['-c', command];
      default:
        return this.getShellArgs(this.defaultShell, command);
    }
  }
}

export function createShellTool(options: ShellToolOptions): ShellTool {
  return new ShellTool(options);
}
