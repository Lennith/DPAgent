import * as path from 'path';
import { ContextEventStore, ContextManager } from '../context/index.js';
import { GovernanceAuditStore } from '../governance/AuditStore.js';
import { ToolsetPresetStore } from '../governance/ToolsetPresetStore.js';
import { MemoryPromotionCoordinator } from '../memory/MemoryPromotionCoordinator.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { SessionSearchIndex } from '../memory/SessionSearchIndex.js';
import { SkillPackStore } from '../skills/SkillPackStore.js';
import { SkillWriteStore } from '../skills/SkillWriteStore.js';
import { TodoStore } from '../todo/index.js';
import type { LLMRuntime } from '../llm/index.js';

export interface DPAgentCoreServices {
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  governanceAuditStore: GovernanceAuditStore;
  memoryPromotionCoordinator: MemoryPromotionCoordinator;
  sessionSearchIndex: SessionSearchIndex;
  toolsetPresetStore: ToolsetPresetStore;
  skillWriteStore: SkillWriteStore;
  skillPackStore: SkillPackStore;
  todoStore: TodoStore;
}

export interface CreateDPAgentCoreServicesInput {
  contextDir: string;
  runtimeDataDir: string;
  getLlmClient: () => LLMRuntime | null;
}

export function createDPAgentCoreServices(
  input: CreateDPAgentCoreServicesInput
): DPAgentCoreServices {
  const contextManager = new ContextManager(new ContextEventStore(input.contextDir));
  const memoryStore = new MemoryStore(path.join(input.runtimeDataDir, 'memory'));
  const governanceAuditStore = new GovernanceAuditStore(path.join(input.runtimeDataDir, 'audit'));
  const memoryPromotionCoordinator = new MemoryPromotionCoordinator({
    contextManager,
    memoryStore,
    governanceAuditStore,
    getLlmClient: input.getLlmClient,
  });

  return {
    contextManager,
    memoryStore,
    governanceAuditStore,
    memoryPromotionCoordinator,
    sessionSearchIndex: new SessionSearchIndex(path.join(input.runtimeDataDir, 'session-search')),
    toolsetPresetStore: new ToolsetPresetStore(path.join(input.runtimeDataDir, 'toolset-presets')),
    skillWriteStore: new SkillWriteStore(path.join(input.runtimeDataDir, 'skills')),
    skillPackStore: new SkillPackStore(path.join(input.runtimeDataDir, 'skill-packs')),
    todoStore: new TodoStore(path.join(input.runtimeDataDir, 'todos')),
  };
}
