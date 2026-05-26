import express, { Request } from 'express';
import { WebSocketServer } from 'ws';
import type { AgentProfile } from '../../agents/AgentProfiles.js';
import type { AsrLifecycleStatus, AsrTranscriptionInput, AsrTranscriptionResult } from '../../asr/index.js';
import type { AutomationRoutes } from '../../automation/AutomationRoutes.js';
import type { DPAgent } from '../../dpagent-runtime.js';
import type { TodoProtocolState } from '../../todo/index.js';
import type {
  AgentConfig,
  ContextNamespaceMeta,
  ContextRef,
  LlmProfileIntrospection,
  LlmProviderProfileConfig,
  SessionInteractionState,
  SessionOrigin,
  WorkspaceSkillGovernanceReport,
} from '../../types.js';
import { toInterruptedArtifactView } from './interrupted-artifact-view.js';
import type { DownloadLinkService } from './download-link-service.js';
import type { CreatedSessionShare, ResolvedSessionShare, SessionShareRecordView } from './session-share-service.js';

export interface ActiveRunRouteView {
  runId: string;
  runFamilyId?: string;
  draftId?: string;
  context: ContextRef;
  startedAt: string;
  lastActivityAt: string;
  currentStep: number;
  maxSteps?: number;
  owner: SessionOrigin;
  origin: SessionOrigin;
  interactionState: SessionInteractionState;
  llmRuntime?: {
    profileId: string;
    provider: 'anthropic' | 'openai';
    model: string;
    reasoningPreset: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
}

export interface WebServerRouteRegistrationDependencies {
  app: express.Express;
  wss: WebSocketServer;
  agent: DPAgent;
  automationRoutes: AutomationRoutes;
  configServices: {
    hasUsableApiKey: () => boolean;
    persistConfigFile: (nextConfig: AgentConfig) => void;
    setBootMissingApiKey: (value: boolean) => void;
    refreshConfigDependentRuntimes: () => Promise<void>;
  };
  systemServices?: {
    getRuntimeInfo: () => {
      version: string;
      pid: number;
      cwd: string;
      configPath: string;
      port: number;
      packageRoot: string;
      installMode: string;
      packageManager: string;
    };
    getRuntimeDiagnostics?: () => Record<string, unknown>;
    requestShutdown: (request: { delayMs: number; reason?: string }) => void;
  };
  agentCatalogServices: {
    refreshGlobalAgentCatalog: () => void;
    getGlobalAgentProfiles: () => AgentProfile[];
  };
  llmServices: {
    discoverProfileModels: (profile: LlmProviderProfileConfig) => Promise<LlmProfileIntrospection>;
  };
  governanceServices: {
    runWorkspaceSkillGovernance: (input: { workspaceDir: string }) => Promise<WorkspaceSkillGovernanceReport>;
    getLatestWorkspaceSkillGovernanceReport: (workspaceDir: string) => WorkspaceSkillGovernanceReport | null;
  };
  downloadServices?: {
    downloadLinks: DownloadLinkService;
  };
  contextServices: {
    getContextNamespaceMetaSafe: (context: ContextRef) => ContextNamespaceMeta | undefined;
    getPendingPlanInputView: (
      context: ContextRef,
      meta: ContextNamespaceMeta | null | undefined
    ) => ContextNamespaceMeta['pendingPlanInput'] | null;
    getActiveRunState: (context: ContextRef) => ActiveRunRouteView | null;
    listActiveSessionRunStates: () => ActiveRunRouteView[];
    getInteractionStateForContext: (context: ContextRef) => SessionInteractionState;
    getInterruptedArtifact: (context: ContextRef) => ReturnType<typeof toInterruptedArtifactView>;
    updateContextNamespaceMetaSafe: (
      context: ContextRef,
      patch: Partial<ContextNamespaceMeta>
    ) => void;
    resolveWorkspaceDirForContext: (context: ContextRef) => string;
    resolveAgentForContext: (context: ContextRef) => DPAgent;
    cleanupSessionRuntime: (sessionId: string) => Promise<void>;
  };
  todoServices: {
    ensureTodoDrivenAutoLoop: (sessionId: string, workspaceDir?: string) => void;
    getSessionTodoProtocolState: (sessionId: string, workspaceDir?: string) => TodoProtocolState;
  };
  authServices: {
    isLoopback: (req: Request) => boolean;
    isAuthenticatedForRemoteAccess: (req: Request) => boolean;
    handleLogin: (password: string, req: Request) => { success: boolean; cookie?: string };
    handleLogout: () => string;
    getStatus: (req: Request) => { required: boolean; authenticated: boolean; local: boolean; configured: boolean };
  };
  shareServices?: {
    createSessionShare: (sessionId: string) => CreatedSessionShare;
    getSessionShareStatus: (sessionId: string) => SessionShareRecordView;
    revokeSessionShare: (sessionId: string) => SessionShareRecordView;
    resolveShareToken: (token: string | null | undefined) => ResolvedSessionShare | null;
    buildShareUrl: (token: string) => string;
  };
  accessServices?: {
    getSharedAccessSessionId: (req: Request) => string | null;
    getSharedAccessToken?: (req: Request) => string | null;
    canAccessSession: (req: Request, sessionId: string) => boolean;
    hasFullAccess: (req: Request) => boolean;
  };
  asrServices?: {
    getStatus: () => AsrLifecycleStatus;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    transcribe: (input: AsrTranscriptionInput) => Promise<AsrTranscriptionResult>;
  };
}

export function toSessionContext(sessionId: string): ContextRef {
  return { scope: 'session', namespace: sessionId };
}
