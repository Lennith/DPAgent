export type SkillWriteTarget = 'workspace' | 'global';
export type SkillWriteAction = 'create' | 'update';

export interface SkillWriteRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  action: SkillWriteAction;
  target: SkillWriteTarget;
  workspaceDir?: string;
  sourceSessionId?: string;
  targetPath: string;
  baseVersion?: string;
  nextVersion?: string;
  createdAt: string;
  updatedAt: string;
  status: 'applied';
  appliedAt: string;
  reason?: string;
  sourceFingerprint?: string;
  triggerCount?: number;
  triggerCommands?: string[];
  originToolset?: string;
  originPlatform?: string;
  generatedAt?: string;
}

export interface SkillRevisionRecord {
  id: string;
  skillName: string;
  targetPath: string;
  workspaceDir?: string;
  version?: string;
  content: string;
  sourceAction: 'write' | 'rollback' | 'governance' | 'edit';
  createdAt: string;
}

export interface SkillSuggestionPattern {
  key: string;
  fingerprint: string;
  workspaceDir?: string;
  target: SkillWriteTarget;
  count: number;
  promptExample: string;
  latestOutput: string;
  commands: string[];
  checklist: string[];
  lastWriteRecordId?: string;
  lastWrittenContentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSuggestionState {
  patterns: Record<string, SkillSuggestionPattern>;
}
