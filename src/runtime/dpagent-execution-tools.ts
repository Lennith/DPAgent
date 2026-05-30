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
  createSendFileToUserTool,
  ToolsetRegistry,
  PermissionManager,
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamilyForTool,
  type ToolSource,
  type SendFileToUserLinkIssuer,
} from '../tools/index.js';
import { ContextManager } from '../context/index.js';
import { ScheduleTaskTool } from '../tools/ScheduleTaskTool.js';
import { ArenaStore, ArenaSubmitResultTool } from '../arena/index.js';
import type { AutomationStore } from '../automation/AutomationStore.js';
import { SubAgentManager } from '../subagent/SubAgentManager.js';
import { SkillLoader } from '../skills/SkillLoader.js';
import { SkillWriteStore } from '../skills/SkillWriteStore.js';
import type { MemoryMutationInput, MemoryMutationResult } from '../memory/memory-promotion-contracts.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { SessionSearchIndex } from '../memory/SessionSearchIndex.js';
import { TodoStore } from '../todo/index.js';
import type {
  AgentConfig,
  AgentCallback,
  ContextRef,
  SessionPlanningState,
} from '../types.js';

export interface ExecutionToolRegistryOptions {
  context: ContextRef;
  turnId: string;
  workspaceDir: string;
  callback?: AgentCallback;
  planningState?: SessionPlanningState;
  includeContextManage: boolean;
  includeSubAgentManage: boolean;
  toolsetName?: string;
  allowedTools?: string[];
  agentSkillDir?: string;
  includeGlobalSkills?: boolean;
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
  writeSkill: (input: Parameters<SkillWriteStore['writeSkill']>[0]) => ReturnType<SkillWriteStore['writeSkill']>;
  memoryStore: MemoryStore;
  mutateMemory: (payload: MemoryMutationInput) => Promise<MemoryMutationResult>;
  sessionSearchIndex: SessionSearchIndex;
  todoStore: TodoStore;
  resolveSubAgentAllowedTools: () => string[];
  downloadLinkIssuer?: SendFileToUserLinkIssuer | null;
  automationStore: AutomationStore;
  arenaStore?: ArenaStore;
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
  writeSkill,
  memoryStore,
  mutateMemory,
  sessionSearchIndex,
  todoStore,
  resolveSubAgentAllowedTools,
  downloadLinkIssuer,
  automationStore,
  arenaStore,
  input,
}: BuildExecutionToolRegistryInput): ToolRegistry {
  const turnRegistry = new ToolRegistry();
  const registrationState = createToolRegistrationState();
  const requestedToolsetName = String(input.toolsetName ?? '').trim();
  const activeToolset = requestedToolsetName
    ? toolsetRegistry.requireToolset(requestedToolsetName, 'explicit toolsetName').name
    : resolveToolsetName(input.context);
  const normalizedAllowedTools = input.allowedTools
    ? new Set(input.allowedTools.map((toolName) => toolName.trim().toLowerCase()).filter((toolName) => toolName.length > 0))
    : null;
  const planDraftingAllowedTools =
    input.planningState === 'plan_drafting'
      ? new Set([
          'read_file',
          'list_directory',
          'glob',
          'grep',
          'read_tool_result',
          'session_search',
          'skills_list',
          'skills_view',
          'context_manage',
          'request_user_input',
          'finalize_plan',
          'web_fetch',
        ])
      : null;
  const resolveActivePlanId = (): string | undefined => {
    const planId = contextManager.getNamespaceInfo(input.context).planningState?.activeExecutionPlanId;
    return String(planId ?? '').trim() || undefined;
  };
  const shouldRegisterTool = (tool: Tool): boolean => {
    if (!toolsetRegistry.allowsTool(activeToolset, tool)) {
      return false;
    }
    if (planDraftingAllowedTools && !planDraftingAllowedTools.has(tool.name.trim().toLowerCase())) {
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
    if (downloadLinkIssuer) {
      registerTurnScopedTool(
        createSendFileToUserTool({
          workspaceDir: input.workspaceDir,
          checkPermission: permissionChecker,
          exemptDirs: extraReadableDirs,
          linkIssuer: downloadLinkIssuer,
        }),
        'core'
      );
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

  if (input.context.scope === 'session') {
    registerTurnScopedTool(
      new ScheduleTaskTool({
        getSessionId: () => input.context.namespace,
        getDefaultWorkspaceDir: () => input.workspaceDir,
        store: automationStore,
      }),
      'core'
    );
  }

  if (input.includeContextManage) {
    registerTurnScopedTool(
      createContextManageTool({
        contextManager,
        resolveActiveContext: () => input.context,
        resolveActiveTurnId: () => input.turnId,
        readOnly: input.planningState === 'plan_drafting',
      }),
      'other'
    );
  }

  if (input.includeSubAgentManage) {
    registerTurnScopedTool(
      createSubAgentManageTool({
        manager: subAgentManager,
        resolveActiveContext: () => input.context,
        resolveActiveTurnId: () => input.turnId,
        resolveDefaultWorkspaceDir: () => input.workspaceDir,
        resolveAllowedTools: () => resolveSubAgentAllowedTools(),
      }),
      'other'
    );
  }

  const [skillsListTool, skillsViewTool, skillManageTool] = createSkillTools({
    skillLoader,
    writeSkill,
    resolveWorkspaceDir: () => input.workspaceDir,
    resolveAgentSkillDir: () => input.agentSkillDir,
    resolveIncludeGlobalSkills: () => input.includeGlobalSkills,
    resolveSessionId: () => (input.context.scope === 'session' ? input.context.namespace : undefined),
    resolveToolsetName: () => activeToolset,
    globalSkillsDir: config.agent.skillsDir,
  });
  registerTurnScopedTool(skillsListTool, 'other');
  registerTurnScopedTool(skillsViewTool, 'other');
  registerTurnScopedTool(skillManageTool, 'other');

  registerTurnScopedTool(
    createMemoryTool({
      memoryStore,
      resolveWorkspaceDir: () => input.workspaceDir,
      resolveSessionId: () => (input.context.scope === 'session' ? input.context.namespace : undefined),
      mutateMemory,
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
      resolveActivePlanId,
    }),
    'other'
  );

  const namespaceMeta = input.context.scope === 'session'
    ? contextManager.getEventStore().loadMeta(input.context.scope, input.context.namespace)
    : undefined;
  if (arenaStore && namespaceMeta?.arenaBranch) {
    registerTurnScopedTool(
      new ArenaSubmitResultTool({
        context: input.context,
        meta: namespaceMeta,
        arenaStore,
        todoStore,
      }),
      'other'
    );
  }

  const planInputHandler = input.planningState === 'plan_drafting'
    ? input.callback?.onRequestUserInput
    : undefined;
  if (planInputHandler) {
    const planModeTools = createPlanModeTools({
      contextManager,
      resolveActiveContext: () => input.context,
      resolveActiveTurnId: () => input.turnId,
      requestUserInput: planInputHandler,
      requestPlanApproval: planInputHandler,
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

export interface DPAgentExecutionToolRegistryFactoryHost {
  getBaseToolRegistry: () => ToolRegistry | null;
  getConfig: () => AgentConfig;
  getRuntimeDataDir: () => string;
  getExtraReadableDirs: (context: ContextRef) => string[];
  getToolsetRegistry: () => ToolsetRegistry;
  resolveToolsetName: (context: ContextRef) => string;
  getContextManager: () => ContextManager;
  getSubAgentManager: () => SubAgentManager;
  getSkillLoader: () => SkillLoader;
  writeSkill: (input: Parameters<SkillWriteStore['writeSkill']>[0]) => ReturnType<SkillWriteStore['writeSkill']>;
  getMemoryStore: () => MemoryStore;
  mutateMemory: (payload: MemoryMutationInput) => Promise<MemoryMutationResult>;
  getSessionSearchIndex: () => SessionSearchIndex;
  getTodoStore: () => TodoStore;
  getAutomationStore: () => AutomationStore;
  getArenaStore?: () => ArenaStore | undefined;
  getDownloadLinkIssuer: () => SendFileToUserLinkIssuer | null | undefined;
}

export interface SubAgentExecutionToolRegistryInput {
  context: ContextRef;
  turnId: string;
  workspaceDir: string;
  allowedTools?: string[];
  toolsetName?: string;
  agentSkillDir?: string;
  includeGlobalSkills?: boolean;
}

export class DPAgentExecutionToolRegistryFactory {
  constructor(private readonly host: DPAgentExecutionToolRegistryFactoryHost) {}

  build(input: ExecutionToolRegistryOptions): ToolRegistry {
    const baseToolRegistry = this.host.getBaseToolRegistry();
    if (!baseToolRegistry) {
      throw new Error('Tool registry not initialized');
    }
    return buildExecutionToolRegistry({
      baseToolRegistry,
      config: this.host.getConfig(),
      runtimeDataDir: this.host.getRuntimeDataDir(),
      extraReadableDirs: this.host.getExtraReadableDirs(input.context),
      toolsetRegistry: this.host.getToolsetRegistry(),
      resolveToolsetName: (context) => this.host.resolveToolsetName(context),
      contextManager: this.host.getContextManager(),
      subAgentManager: this.host.getSubAgentManager(),
      skillLoader: this.host.getSkillLoader(),
      writeSkill: (payload) => this.host.writeSkill(payload),
      memoryStore: this.host.getMemoryStore(),
      mutateMemory: (payload) => this.host.mutateMemory(payload),
      sessionSearchIndex: this.host.getSessionSearchIndex(),
      todoStore: this.host.getTodoStore(),
      resolveSubAgentAllowedTools: () =>
        this.createSubAgentRegistry({
          context: input.context,
          turnId: input.turnId,
          workspaceDir: input.workspaceDir,
        })
          .getAll()
          .map((tool) => tool.name),
      downloadLinkIssuer: this.host.getDownloadLinkIssuer(),
      automationStore: this.host.getAutomationStore(),
      arenaStore: this.host.getArenaStore?.(),
      input,
    });
  }

  createSubAgentRegistry(input: SubAgentExecutionToolRegistryInput): ToolRegistry {
    const registry = this.build({
      context: input.context,
      turnId: input.turnId,
      workspaceDir: input.workspaceDir,
      includeContextManage: false,
      includeSubAgentManage: false,
      toolsetName: input.toolsetName,
      allowedTools: input.allowedTools,
      agentSkillDir: input.agentSkillDir,
      includeGlobalSkills: input.includeGlobalSkills,
    });
    registry.unregister('todo');
    registry.unregister('schedule_task');
    return registry;
  }

  resolveSubAgentAllowedTools(
    context: ContextRef,
    workspaceDir: string,
    allowedTools?: string[]
  ): string[] | undefined {
    const executableTools = this.createSubAgentRegistry({
      context,
      turnId: `subagent-policy:${context.scope}:${context.namespace}`,
      workspaceDir,
    })
      .getAll()
      .map((tool) => tool.name);
    if (!allowedTools || allowedTools.length === 0) {
      return executableTools;
    }
    const executableMap = new Map(
      executableTools.map((toolName) => [toolName.trim().toLowerCase(), toolName] as const)
    );
    const resolved = allowedTools
      .map((toolName) => executableMap.get(toolName.trim().toLowerCase()))
      .filter((toolName): toolName is string => typeof toolName === 'string');
    return resolved;
  }
}
