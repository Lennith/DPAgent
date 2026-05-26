import * as path from 'path';
import type { AgentConfig, ContextRef } from '../types.js';

export function sanitizeDroppedFileSessionToken(value: unknown): string {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
}

export function resolveDPAgentExtraReadableDirs(cfg: AgentConfig, context?: ContextRef): string[] {
  const dirs: string[] = [];
  const skillsDir = String(cfg.agent.skillsDir ?? '').trim();
  if (skillsDir) {
    dirs.push(skillsDir);
  }
  const globalAgentsDir = String(cfg.agent.globalAgentsDir ?? '').trim();
  if (globalAgentsDir) {
    dirs.push(globalAgentsDir);
  }
  const runtimeDataDir = String(cfg.agent.runtimeDataDir ?? '').trim();
  if (runtimeDataDir && context?.scope === 'session') {
    dirs.push(path.join(runtimeDataDir, 'dropped-files', sanitizeDroppedFileSessionToken(context.namespace)));
  }
  return dirs;
}
