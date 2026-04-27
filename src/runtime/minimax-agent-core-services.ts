import * as path from 'path';
import { ContextEventStore, ContextManager } from '../context/index.js';
import { GovernanceAuditStore, ToolsetPresetStore } from '../governance/index.js';
import {
  MemoryPromotionCoordinator,
  MemoryStore,
  SessionSearchIndex,
} from '../memory/index.js';
import { SkillDraftStore, SkillPackStore } from '../skills/index.js';
import { TodoStore } from '../todo/index.js';
import type { LLMRuntime } from '../llm/index.js';

export interface MiniMaxAgentCoreServices {
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  governanceAuditStore: GovernanceAuditStore;
  memoryPromotionCoordinator: MemoryPromotionCoordinator;
  sessionSearchIndex: SessionSearchIndex;
  toolsetPresetStore: ToolsetPresetStore;
  skillDraftStore: SkillDraftStore;
  skillPackStore: SkillPackStore;
  todoStore: TodoStore;
}

export interface CreateMiniMaxAgentCoreServicesInput {
  contextDir: string;
  runtimeDataDir: string;
  getLlmClient: () => LLMRuntime | null;
}

export function createMiniMaxAgentCoreServices(
  input: CreateMiniMaxAgentCoreServicesInput
): MiniMaxAgentCoreServices {
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
    skillDraftStore: new SkillDraftStore(path.join(input.runtimeDataDir, 'skills')),
    skillPackStore: new SkillPackStore(path.join(input.runtimeDataDir, 'skill-packs')),
    todoStore: new TodoStore(path.join(input.runtimeDataDir, 'todos')),
  };
}
