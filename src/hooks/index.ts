export type {
  HookEvent,
  HookContext,
  HookResult,
  HookHandler,
  HookConfigEntry,
  HookConfigFile,
  LoadedHook,
  TurnStartHookContext,
  InputToLLMHookContext,
  LLMResponseHookContext,
  BeforeToolCallHookContext,
  AfterToolCallHookContext,
  TurnEndHookContext,
} from './types.js';

export { HOOK_EVENTS, DEFAULT_HOOK_PRIORITY } from './types.js';

export { HookRunner } from './HookRunner.js';
export type { HookExecutionResult } from './HookRunner.js';

export { HookRegistry } from './HookRegistry.js';

import { HookRegistry } from './HookRegistry.js';

/**
 * Convenience bootstrap: create a HookRegistry and load hooks from the
 * given workspace directory. Returns the registry for further configuration.
 */
export function loadHooksFromConfig(workspaceDir: string): HookRegistry {
  const registry = new HookRegistry();
  registry.loadFromWorkspace(workspaceDir);
  return registry;
}
