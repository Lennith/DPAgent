import type {
  SubAgentAssignedAgent,
  SubAgentAssignedAgentProfile,
  ContextRef,
  SubAgentArtifact,
  SubAgentCreateParams,
  SubAgentLifecycleStatus,
  SubAgentResult,
  AgentProfileConfig,
} from '../types.js';

export type SubAgentOperation = 'create' | 'resume';

export interface SubAgentResumeRequest extends SubAgentCreateParams {
  subagentId: string;
}

export interface SubAgentQueuedTask {
  taskId: string;
  subagentId: string;
  parentKey: string;
  parentContext: ContextRef;
  parentTurnId?: string;
  subagentContext: ContextRef;
  operation: SubAgentOperation;
  prompt: string;
  agentName?: string;
  agentProfile?: SubAgentAssignedAgentProfile;
  agentConfig?: AgentProfileConfig;
  providerId: string;
  allowedTools?: string[];
  timeoutMs: number;
  workspaceDir?: string;
  createdAt: string;
}

export interface SubAgentRecord {
  id: string;
  parentContext: ContextRef;
  parentKey: string;
  parentTurnId?: string;
  context: ContextRef;
  status: SubAgentLifecycleStatus;
  runSeq: number;
  agent?: SubAgentAssignedAgent;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  providerId: string;
  prompt?: string;
  agentName?: string;
  agentProfile?: SubAgentAssignedAgentProfile;
  agentConfig?: AgentProfileConfig;
  allowedTools?: string[];
  timeoutMs?: number;
  workspaceDir?: string;
  queuePosition?: number;
  lastError?: string;
  lifecycleDiagnostic?: string;
  latestResult?: SubAgentResult;
}

export interface ParentQueueState {
  runningTaskIds: string[];
  queuedTaskIds: string[];
}

export interface SubAgentRegistryState {
  version: 2;
  records: Record<string, SubAgentRecord>;
  tasks: Record<string, SubAgentQueuedTask>;
  queues: Record<string, ParentQueueState>;
}

export interface SubAgentExecutionOutput {
  status: SubAgentLifecycleStatus;
  summary: string;
  artifacts: SubAgentArtifact;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
  startedAt: string;
  completedAt: string;
}
