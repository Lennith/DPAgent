import * as path from 'node:path';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { createRequire } from 'node:module';
import type {
  HookConfigEntry,
  HookConfigFile,
  HookEvent,
  HookHandler,
  LoadedHook,
} from './types.js';
import { HOOK_EVENTS, DEFAULT_HOOK_PRIORITY } from './types.js';
import { agentLogger } from '../utils/logger.js';

const HOOK_CONFIG_FILENAME = 'hook.config.yaml';

function requireFromPath(modulePath: string): unknown {
  const req = createRequire(modulePath);
  return req(modulePath);
}

// ── Validation ───────────────────────────────────────────────

function validateHookConfig(raw: unknown): HookConfigFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('hook.config.yaml must contain an object with a "hooks" array');
  }

  const obj = raw as Record<string, unknown>;
  const hooksRaw = obj.hooks;

  if (!Array.isArray(hooksRaw)) {
    throw new Error('hook.config.yaml "hooks" must be an array');
  }

  const hooks: HookConfigEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < hooksRaw.length; i += 1) {
    const entry = hooksRaw[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`hooks[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;

    const id = String(e.id ?? '').trim();
    if (!id) {
      throw new Error(`hooks[${i}] is missing "id"`);
    }
    if (seenIds.has(id)) {
      throw new Error(`hooks[${i}] duplicate id "${id}"`);
    }
    seenIds.add(id);

    const modulePath = String(e.module ?? '').trim();
    if (!modulePath) {
      throw new Error(`hooks[${i}] ("${id}") is missing "module"`);
    }

    const eventsRaw = e.events;
    if (!Array.isArray(eventsRaw) || eventsRaw.length === 0) {
      throw new Error(`hooks[${i}] ("${id}") must have a non-empty "events" array`);
    }

    const events: HookEvent[] = [];
    for (const evt of eventsRaw) {
      const evtStr = String(evt ?? '').trim();
      if (!(HOOK_EVENTS as readonly string[]).includes(evtStr)) {
        throw new Error(
          `hooks[${i}] ("${id}"): unknown event "${evtStr}". Valid: ${HOOK_EVENTS.join(', ')}`
        );
      }
      events.push(evtStr as HookEvent);
    }

    const priority =
      e.priority !== undefined ? Number(e.priority) : DEFAULT_HOOK_PRIORITY;
    if (!Number.isFinite(priority) || priority < 0) {
      throw new Error(`hooks[${i}] ("${id}"): priority must be a non-negative number`);
    }

    const enabled = e.enabled !== false;

    hooks.push({
      id,
      module: modulePath,
      events,
      priority,
      enabled,
    });
  }

  return { hooks };
}

// ── Hook Loading ─────────────────────────────────────────────

function loadHookModule(
  moduleSpec: string,
  workspaceDir: string,
  logger: { warn: (msg: string) => void }
): HookHandler | null {
  const resolved = path.isAbsolute(moduleSpec)
    ? moduleSpec
    : path.resolve(workspaceDir, moduleSpec);

  if (!fs.existsSync(resolved)) {
    logger.warn(`[HookRegistry] Hook module not found: ${resolved}`);
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = requireFromPath(resolved);
    const handler: unknown =
      mod && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)
        ? (mod as Record<string, unknown>).default
        : mod;

    if (!handler || typeof handler !== 'object') {
      logger.warn(
        `[HookRegistry] Hook module does not export an object: ${resolved}`
      );
      return null;
    }

    return handler as HookHandler;
  } catch (err) {
    logger.warn(
      `[HookRegistry] Failed to load hook module ${resolved}: ${String(err)}`
    );
    return null;
  }
}

// ── HookRegistry ─────────────────────────────────────────────

export class HookRegistry {
  private workspaceDir: string | null = null;
  private userEntries: HookConfigEntry[] = [];
  private systemEntryMap = new Map<string, LoadedHook>();
  private userCache = new Map<string, LoadedHook>();
  private loadError: string | null = null;

  // ── Public API ─────────────────────────────────────────────

  /**
   * Load and validate hook.config.yaml from the workspace root.
   * Call this after the workspaceDir is set (or changed).
   * Safe to call multiple times — revalidates and invalidates the user cache.
   */
  loadFromWorkspace(workspaceDir: string): void {
    this.workspaceDir = path.resolve(workspaceDir);
    const configPath = path.join(this.workspaceDir, HOOK_CONFIG_FILENAME);

    if (!fs.existsSync(configPath)) {
      agentLogger.info(
        `[HookRegistry] No hook.config.yaml found in ${this.workspaceDir} — user hooks disabled.`
      );
      this.userEntries = [];
      this.userCache.clear();
      this.loadError = null;
      return;
    }

    try {
      const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
      const config = validateHookConfig(raw);
      this.userEntries = config.hooks;
      this.userCache.clear();
      this.loadError = null;
      agentLogger.info(
        `[HookRegistry] Loaded ${this.userEntries.length} user hook(s) from ${configPath}`
      );
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      agentLogger.warn(
        `[HookRegistry] Failed to load ${configPath}: ${message}`
      );
      this.userEntries = [];
      this.userCache.clear();
      this.loadError = message;
    }
  }

  /**
   * Register a system-level hook. System hooks run AFTER user hooks
   * and represent core processing — they cannot be blocked by user hooks
   * but always execute.
   */
  registerSystemHook(entry: HookConfigEntry, handler: HookHandler): void {
    this.systemEntryMap.set(entry.id, {
      entry: { ...entry, priority: entry.priority ?? DEFAULT_HOOK_PRIORITY },
      handler,
      loadedAt: Date.now(),
    });
  }

  /**
   * Get all loaded hooks (user + system) that subscribe to a given event.
   * Returns them in the order they should execute: user hooks first
   * (sorted by priority asc), then system hooks.
   */
  getHooksForEvent(event: HookEvent): LoadedHook[] {
    const user = this.getUserHooksForEvent(event);
    const system = this.getSystemHooksForEvent(event);
    return [...user, ...system];
  }

  /**
   * Get only user hooks for an event.
   */
  getUserHooksForEvent(event: HookEvent): LoadedHook[] {
    if (!this.workspaceDir) {
      return [];
    }
    const matching: LoadedHook[] = [];
    for (const entry of this.userEntries) {
      if (!entry.events.includes(event)) {
        continue;
      }
      const cached = this.userCache.get(entry.id);
      if (cached) {
        matching.push(cached);
        continue;
      }
      const handler = loadHookModule(entry.module, this.workspaceDir, agentLogger);
      if (!handler) {
        continue;
      }
      const loaded: LoadedHook = {
        entry,
        handler,
        loadedAt: Date.now(),
      };
      this.userCache.set(entry.id, loaded);
      matching.push(loaded);
    }
    return matching;
  }

  /**
   * Get system hooks for an event.
   */
  getSystemHooksForEvent(event: HookEvent): LoadedHook[] {
    const matching: LoadedHook[] = [];
    for (const [, hook] of this.systemEntryMap) {
      if (hook.entry.events.includes(event)) {
        matching.push(hook);
      }
    }
    return matching;
  }

  /**
   * Whether user hooks are configured and loaded.
   */
  hasUserHooks(): boolean {
    return this.userEntries.length > 0;
  }

  /**
   * Whether loading failed.
   */
  getLoadError(): string | null {
    return this.loadError;
  }

  /**
   * Number of configured user hook entries.
   */
  getUserHookCount(): number {
    return this.userEntries.length;
  }

  /**
   * Number of registered system hooks.
   */
  getSystemHookCount(): number {
    return this.systemEntryMap.size;
  }
}
