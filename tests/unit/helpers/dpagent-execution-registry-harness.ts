import * as path from 'node:path';
import { DPAgent } from '../../../src/index.js';
import {
  DPAgentExecutionToolRegistryFactory,
  type ExecutionToolRegistryOptions,
  type SubAgentExecutionToolRegistryInput,
} from '../../../src/runtime/dpagent-execution-tools.js';
import { resolveDPAgentExtraReadableDirs } from '../../../src/runtime/dpagent-readable-dirs.js';
import type { SendFileToUserLinkIssuer } from '../../../src/tools/index.js';

export function createDPAgentExecutionRegistryFactory(
  agent: DPAgent,
  downloadLinkIssuer?: SendFileToUserLinkIssuer | null
): DPAgentExecutionToolRegistryFactory {
  return new DPAgentExecutionToolRegistryFactory({
    getBaseToolRegistry: () => agent.getToolRegistry(),
    getConfig: () => agent.getConfig(),
    getRuntimeDataDir: () =>
      agent.getConfig().agent.runtimeDataDir ?? path.join(agent.getConfig().agent.workspaceDir, '.dpagent', 'runtime'),
    getExtraReadableDirs: (context) => resolveDPAgentExtraReadableDirs(agent.getConfig(), context),
    getToolsetRegistry: () => agent.getToolsetRegistry(),
    resolveToolsetName: (context) => agent.resolveToolsetName(context),
    getContextManager: () => agent.getContextManager(),
    getSubAgentManager: () => agent.getSubAgentManager(),
    getSkillLoader: () => agent.getSkillLoader(),
    writeSkill: (payload) => agent.writeSkill(payload),
    getMemoryStore: () => agent.getMemoryStore(),
    mutateMemory: (payload) => agent.mutateMemory(payload),
    getSessionSearchIndex: () => agent.getSessionSearchIndex(),
    getTodoStore: () => agent.getTodoStore(),
    getAutomationStore: () => agent.getAutomationStore(),
    getDownloadLinkIssuer: () => downloadLinkIssuer,
  });
}

export function buildDPAgentExecutionToolRegistry(
  factory: DPAgentExecutionToolRegistryFactory,
  input: ExecutionToolRegistryOptions
) {
  return factory.build(input);
}

export function buildDPAgentSubAgentExecutionToolRegistry(
  factory: DPAgentExecutionToolRegistryFactory,
  input: SubAgentExecutionToolRegistryInput
) {
  return factory.createSubAgentRegistry(input);
}
