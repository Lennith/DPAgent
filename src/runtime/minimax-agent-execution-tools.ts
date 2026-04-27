import * as path from 'path';
import {
  type Tool,
  ToolRegistry,
  createFileTools,
  createShellTool,
  createMemoryTool,
  createToolResultArtifactTool,
  createSessionSearchTool,
  createTodoTool,
  createSkillTools,
  createContextManageTool,
  createSubAgentManageTool,
  createPlanModeTools,
  createExitAutoLoopTool,
  ToolsetRegistry,
  PermissionManager,
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamilyForTool,
  type ToolSource,
} from '../tools/index.js';
import { ContextManager } from '../context/index.js';
import { SubAgentManager } from '../subagent/index.js';
import { SkillDraftStore, SkillLoader, type SkillDraftRecord } from '../skills/index.js';
import {
  MemoryPromotionCoordinator,
  MemoryStore,
  SessionSearchIndex,
} from '../memory/index.js';
import { TodoStore } from '../todo/index.js';
import type { AgentConfig, AgentCallback, ContextRef } from '../types.js';

export interface ExecutionToolRegistryOptions {
  context: ContextRef;
  turnId: string;
  workspaceDir: string;
  callback?: AgentCallback;
  includeContextManage: boolean;
  includeSubAgentManage: boolean;
  allowedTools?: string[];
}

export interface BuildExecutionToolRegistryInput {
  baseToolRegistry: ToolRegistry;
  config: AgentConfig;
  runtimeDataDir: string;
  extraReadableDirs: string[];
  toolsetRegistry: ToolsetRegistry;
  resolveToolsetName: (context: ContextRef) => string;
  contextManager: ContextManager;
  subAgentManager: SubAgentManager;
  skillLoader: SkillLoader;
  skillDraftStore: SkillDraftStore;
  memoryStore: MemoryStore;
  memoryPromotionCoordinator: MemoryPromotionCoordinator;
  sessionSearchIndex: SessionSearchIndex;
  todoStore: TodoStore;
  approveSkillDraft: (id: string) => SkillDraftRecord | null;
  rejectSkillDraft: (id: string, reviewNote?: string) => SkillDraftRecord | null;
  resolveSubAgentAllowedTools: () => string[];
  input: ExecutionToolRegistryOptions;
}

export function buildExecutionToolRegistry({
  baseToolRegistry,
  config,
  runtimeDataDir,
  extraReadableDirs,
  toolsetRegistry,
  resolveToolsetName,
  contextManager,
  subAgentManager,
  skillLoader,
  skillDraftStore,
  memoryStore,
  memoryPromotionCoordinator,
  sessionSearchIndex,
  todoStore,
  approveSkillDraft,
  rejectSkillDraft,
  resolveSubAgentAllowedTools,
  input,
}: BuildExecutionToolRegistryInput): ToolRegistry {
  const turnRegistry = new ToolRegistry();
  const registrationState = createToolRegistrationState();
  const activeToolset = resolveToolsetName(input.context);
  const normalizedAllowedTools = input.allowedTools
    ? new Set(input.allowedTools.map((toolName) => toolName.trim().toLowerCase()).filter((toolName) => toolName.length > 0))
    : null;
  const shouldRegisterTool = (tool: Tool): boolean => {
    if (!toolsetRegistry.allowsTool(activeToolset, tool)) {
      return false;
    }
    if (!normalizedAllowedTools) {
      return true;
    }
    return normalizedAllowedTools.has(tool.name.trim().toLowerCase());
  };

  const capabilityFamiliesAllowingMultipleNames = new Set(['skills_catalog']);

  const registerTurnScopedTool = (tool: Tool, source: ToolSource = 'other'): void => {
    if (shouldRegisterTool(tool)) {
      const capability = resolveToolCapabilityFamilyForTool(tool);
      if (capabilityFamiliesAllowingMultipleNames.has(capability)) {
        if (registrationState.byName.has(tool.name)) {
          return;
        }
        turnRegistry.register(tool);
        registrationState.byName.add(tool.name);
        return;
      }
      registerToolWithDedupe(turnRegistry, registrationState, tool, source);
    }
  };

  const enforceWorkspaceSandbox = activeToolset.trim().toLowerCase() !== 'full-access';
  const permissionChecker = (() => {
    if (!enforceWorkspaceSandbox) {
      return undefined;
    }
    const runtimePermissionManager = new PermissionManager({
      workspaceDir: input.workspaceDir,
      additionalWritableDirs: [],
    });
    for (const dir of extraReadableDirs) {
      runtimePermissionManager.addReadableDir(dir);
    }
    return runtimePermissionManager.createPermissionChecker();
  })();

  if (config.tools.enableFileTools) {
    const runtimeFileTools = createFileTools({
      workspaceDir: input.workspaceDir,
      checkPermission: permissionChecker,
      exemptDirs: extraReadableDirs,
    });
    for (const tool of runtimeFileTools) {
      registerTurnScopedTool(tool, 'core');
    }
  }

  registerTurnScopedTool(
    createToolResultArtifactTool({
      contextManager,
      resolveActiveContext: () => input.context,
    }),
    'core'
  );

  if (config.tools.enableShell) {
    const runtimeShellTool = createShellTool({
      workspaceDir: input.workspaceDir,
      shell: config.tools.shellType,
      timeout: config.tools.shellTimeout,
      outputIdleTimeout: 120000,
      maxRunTime: 3600000,
      maxOutputSize: 52428800,
      logDir: path.join(runtimeDataDir, 'shell-logs'),
      checkPermission: permissionChecker,
    });
    registerTurnScopedTool(runtimeShellTool, 'core');
  }

  for (const tool of baseToolRegistry.getAll()) {
    registerTurnScopedTool(tool, 'core');
  }

  if (input.includeContextManage) {
    registerTurnScopedTool(
      createContextManageTool({
        contextManager,
        resolveActiveContext: () => input.context,
        resolveActiveTurnId: () => input.turnId,
      }),
      'other'
    );
  }

  if (input.includeSubAgentManage) {
    registerTurnScopedTool(
      createSubAgentManageTool({
        manager: subAgentManager,
        resolveActiveContext: () => input.context,
        resolveDefaultWorkspaceDir: () => input.workspaceDir,
        resolveAllowedTools: () => resolveSubAgentAllowedTools(),
      }),
      'other'
    );
  }

  const [skillsListTool, skillsViewTool, skillManageTool] = createSkillTools({
    skillLoader,
    skillDraftStore,
    resolveWorkspaceDir: () => input.workspaceDir,
    resolveSessionId: () => (input.context.scope === 'session' ? input.context.namespace : undefined),
    resolveToolsetName: () => activeToolset,
    globalSkillsDir: config.agent.skillsDir,
    writeMode: config.agent.skillWriteMode ?? 'confirm',
    approveSkillDraft,
    rejectSkillDraft,
  });
  registerTurnScopedTool(skillsListTool, 'other');
  registerTurnScopedTool(skillsViewTool, 'other');
  registerTurnScopedTool(skillManageTool, 'other');

  registerTurnScopedTool(
    createMemoryTool({
      memoryStore,
      resolveWorkspaceDir: () => input.workspaceDir,
      resolveSessionId: () => (input.context.scope === 'session' ? input.context.namespace : undefined),
      mutateMemory: (payload) => memoryPromotionCoordinator.mutate(payload),
    }),
    'other'
  );
  registerTurnScopedTool(
    createSessionSearchTool({
      sessionSearchIndex,
      resolveWorkspaceDir: () => input.workspaceDir,
    }),
    'other'
  );
  registerTurnScopedTool(
    createTodoTool({
      todoStore,
      resolveSessionId: () => (input.context.scope === 'session' ? input.context.namespace : undefined),
      resolveWorkspaceDir: () => input.workspaceDir,
    }),
    'other'
  );

  const planInputHandler = input.callback?.onRequestUserInput;
  if (planInputHandler) {
    const planModeTools = createPlanModeTools({
      contextManager,
      resolveActiveContext: () => input.context,
      resolveActiveTurnId: () => input.turnId,
      requestUserInput: planInputHandler,
    });
    for (const tool of planModeTools) {
      registerTurnScopedTool(tool, 'other');
    }
  }

  if (input.callback?.isInAutoLoop && input.callback?.requestAutoLoopExit) {
    const exitAutoLoopTool = createExitAutoLoopTool({
      isInAutoLoop: input.callback.isInAutoLoop,
      requestAutoLoopExit: input.callback.requestAutoLoopExit,
    });
    registerTurnScopedTool(exitAutoLoopTool, 'other');
  }

  return turnRegistry;
}
