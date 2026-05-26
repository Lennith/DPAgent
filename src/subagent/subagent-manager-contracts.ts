import type { ContextManager } from '../context/index.js';
import type {
  ContextRef,
  SubAgentProviderConfig,
  SubAgentResult,
  SubAgentStatus,
} from '../types.js';
import type { ManagedTimeout } from '../runtime/async-primitives.js';
import type { SubAgentTurnRunner } from './SubAgentTurnRunner.js';

export const MAX_QUEUED_TASKS_PER_PARENT = 3;
export const DEFAULT_TASK_TIMEOUT_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_RESULT_WAIT_TIMEOUT_MS = 300000;
export const HEARTBEAT_TIMEOUT_MS = 180000;
export const HEARTBEAT_PERSIST_TICK_MS = 2000;
export const DEFAULT_MAX_PARALLEL_PER_PARENT = 4;
export const DEFAULT_GLOBAL_MAX_PARALLEL = 10;
export const REGISTRY_VERSION = 2;

export interface WaitResult {
  status: SubAgentStatus;
  result?: SubAgentResult;
  timedOut?: boolean;
}

export interface ResultWaiter {
  runSeq: number;
  resolve: (value: WaitResult) => void;
  timer: ManagedTimeout;
}

export type SubAgentCreateOrResumeResult =
  | { ok: true; status: SubAgentStatus }
  | {
      ok: false;
      code:
        | 'invalid_prompt'
        | 'invalid_subagent_id'
        | 'subagent_not_found'
        | 'parent_mismatch'
        | 'subagent_busy'
        | 'agent_not_found'
        | 'queue_full';
      error: string;
      status?: SubAgentStatus;
    };

export interface SubAgentManagerOptions {
  contextManager: ContextManager;
  turnRunner: SubAgentTurnRunner;
  registryFilePath: string;
  getDefaultWorkspaceDir: () => string;
  getProviderConfigs: () => SubAgentProviderConfig[] | undefined;
  getGlobalAgentsDir: () => string | undefined;
  getMaxParallelPerParent: () => number;
  getGlobalMaxParallel: () => number;
  resolveAllowedTools?: (input: {
    parentContext: ContextRef;
    workspaceDir?: string;
    allowedTools?: string[];
  }) => string[] | undefined;
}
