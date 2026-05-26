import { applySessionLlmSelectionInput } from '../../llm/provider-profiles.js';
import type {
  AgentConfig,
  ContextNamespaceMeta,
  ContextRef,
  SessionLlmSelection,
  SessionLlmSelectionInput,
  SessionPlanningState,
} from '../../types.js';
import type { DPAgent } from '../../dpagent-runtime.js';
import type { ChatRequest } from './web-server-shared.js';
import { createSessionNamespace, isContextRef } from './web-server-shared.js';
import type { SessionRuntime } from './web-server-runtime-contracts.js';

export interface ContextResolutionServiceOptions {
  getRootAgent: () => DPAgent | undefined;
  getSessionRuntime: (sessionId: string) => SessionRuntime | undefined;
}

export interface WorkspaceDirInput {
  context: ContextRef;
  meta?: ContextNamespaceMeta;
}

export interface WorkspaceDirForRunInput extends WorkspaceDirInput {
  requestedWorkspaceDir?: string;
}

export class ContextResolutionService {
  constructor(private readonly options: ContextResolutionServiceOptions) {}

  resolveChatContext(data: ChatRequest): ContextRef {
    if (isContextRef(data.context)) {
      return {
        scope: data.context.scope,
        namespace: data.context.namespace.trim(),
      };
    }
    if (typeof data.sessionId === 'string' && data.sessionId.trim().length > 0) {
      return {
        scope: 'session',
        namespace: data.sessionId.trim(),
      };
    }
    return {
      scope: 'session',
      namespace: createSessionNamespace(),
    };
  }

  resolveAgentForContext(context: ContextRef): DPAgent | undefined {
    if (context.scope === 'session') {
      return this.options.getSessionRuntime(context.namespace)?.agent ?? this.options.getRootAgent();
    }
    return this.options.getRootAgent();
  }

  getContextNamespaceMeta(context: ContextRef): ContextNamespaceMeta | undefined {
    const agent = this.resolveAgentForContext(context);
    if (!agent) {
      return undefined;
    }
    const getter = (agent as { getContextNamespaceMeta?: (context: ContextRef) => ContextNamespaceMeta | undefined }).getContextNamespaceMeta;
    return typeof getter === 'function' ? getter.call(agent, context) : undefined;
  }

  updateContextNamespaceMeta(context: ContextRef, patch: Partial<ContextNamespaceMeta>): void {
    const agent = this.resolveAgentForContext(context);
    if (!agent) {
      return;
    }
    const updater = (agent as {
      updateContextNamespaceMeta?: (context: ContextRef, patch: Partial<ContextNamespaceMeta>) => void;
    }).updateContextNamespaceMeta;
    if (typeof updater === 'function') {
      updater.call(agent, context, patch);
    }
  }

  readPlanningState(context: ContextRef, meta?: ContextNamespaceMeta): SessionPlanningState {
    if (context.scope !== 'session') {
      return 'normal';
    }
    const state = meta?.planningState?.state;
    return state === 'plan_drafting' || state === 'plan_executing' ? state : 'normal';
  }

  buildPlanningStatePatch(
    existing: ContextNamespaceMeta['planningState'] | undefined,
    state: SessionPlanningState
  ): Pick<ContextNamespaceMeta, 'planningState'> {
    return {
      planningState: {
        ...existing,
        state,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  resolveWorkspaceDirForContext(input: WorkspaceDirInput): string {
    const workspaceFromMeta = String(input.meta?.workspaceDir ?? '').trim();
    if (workspaceFromMeta) {
      return workspaceFromMeta;
    }
    const contextAgent = this.resolveAgentForContext(input.context);
    const artifactWorkspaceDir = String(contextAgent?.getInterruptedArtifact?.(input.context)?.workspaceDir ?? '').trim();
    if (artifactWorkspaceDir) {
      return artifactWorkspaceDir;
    }
    if (input.context.scope === 'session') {
      const runtimeWorkspaceDir = String(
        this.options.getSessionRuntime(input.context.namespace)?.workspaceDir ?? ''
      ).trim();
      if (runtimeWorkspaceDir) {
        return runtimeWorkspaceDir;
      }
    }
    return this.options.getRootAgent()?.getConfig().agent.workspaceDir ?? './workspace';
  }

  resolveWorkspaceDirForRun(input: WorkspaceDirForRunInput): string {
    const existingWorkspaceDir = this.resolveWorkspaceDirForContext(input);
    const normalizedRequested = String(input.requestedWorkspaceDir ?? '').trim();
    const hasExistingWorkspace = existingWorkspaceDir.trim().length > 0;
    const hasRequestedWorkspace = normalizedRequested.length > 0;
    const hasStoredMetaWorkspace = String(input.meta?.workspaceDir ?? '').trim().length > 0;

    if (input.context.scope === 'session' && hasStoredMetaWorkspace) {
      return existingWorkspaceDir;
    }
    if (hasRequestedWorkspace) {
      return normalizedRequested;
    }
    if (hasExistingWorkspace) {
      return existingWorkspaceDir;
    }
    return this.options.getRootAgent()?.getConfig().agent.workspaceDir ?? './workspace';
  }

  resolveRequestedSessionLlmSelection(input: {
    config: AgentConfig;
    meta?: ContextNamespaceMeta;
    requestSelection?: SessionLlmSelectionInput;
  }): SessionLlmSelection {
    return applySessionLlmSelectionInput(
      input.config,
      input.meta?.llmSelection,
      input.requestSelection
    );
  }
}
