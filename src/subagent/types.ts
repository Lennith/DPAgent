import type {
  SubAgentAssignedAgent,
  SubAgentAssignedAgentProfile,
  ContextRef,
  SubAgentArtifact,
  SubAgentCreateParams,
  SubAgentLifecycleStatus,
  SubAgentResult,
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
  subagentContext: ContextRef;
  operation: SubAgentOperation;
  prompt: string;
  agentName?: string;
  agentProfile?: SubAgentAssignedAgentProfile;
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
  allowedTools?: string[];
  timeoutMs?: number;
  workspaceDir?: string;
  queuePosition?: number;
  lastError?: string;
  latestResult?: SubAgentResult;
  // REQ-0027: Track retry attempts for this subagent
  retryCount?: number;
}

export interface ParentQueueState {
  runningTaskIds: string[];
  queuedTaskIds: string[];
}

// REQ-0027: Retry queue entry for interrupted agents
export interface SubAgentRetryEntry {
  subagentId: string;
  parentContext: ContextRef;
  parentKey: string;
  operation: SubAgentOperation;
  prompt: string;
  providerId: string;
  agentName?: string;
  allowedTools?: string[];
  timeoutMs?: number;
  workspaceDir?: string;
  retryCount: number;
  lastFailedAt: string;
  failureReason: string;
}

export interface SubAgentRegistryState {
  version: 2;
  records: Record<string, SubAgentRecord>;
  tasks: Record<string, SubAgentQueuedTask>;
  queues: Record<string, ParentQueueState>;
  // REQ-0027: Retry queue for interrupted agents
  retryQueue: SubAgentRetryEntry[];
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
