import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  buildPromptFingerprint,
  extractChecklistItems,
  extractCommandCandidates,
  looksLikeFailure,
  normalizeWorkflowText,
  slugifyWorkflowText,
  tokenizeWorkflowText,
} from '../utils/workflow-signal.js';
import { readSkillVersion, renderSkillMarkdown, upsertSkillMetadata } from './skill-markdown.js';

export type SkillDraftTarget = 'workspace' | 'global';
export type SkillDraftAction = 'create' | 'update';

export interface SkillDraftRecord {
  id: string;
  name: string;
  description: string;
  content: string;
  action: SkillDraftAction;
  target: SkillDraftTarget;
  workspaceDir?: string;
  sourceSessionId?: string;
  targetPath: string;
  baseVersion?: string;
  nextVersion?: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  reviewNote?: string;
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
  sourceAction: 'approve' | 'rollback' | 'governance';
  createdAt: string;
}

interface SkillSuggestionPattern {
  key: string;
  fingerprint: string;
  workspaceDir?: string;
  target: SkillDraftTarget;
  count: number;
  promptExample: string;
  latestOutput: string;
  commands: string[];
  checklist: string[];
  suggestedDraftId?: string;
  lastSuggestedContentHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface SkillSuggestionState {
  patterns: Record<string, SkillSuggestionPattern>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function ensureSkillMarkdown(input: { name: string; description: string; content: string }): string {
  const trimmed = input.content.trim();
  if (trimmed.startsWith('---')) {
    return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  }
  return renderSkillMarkdown({
    name: input.name,
    description: input.description,
    metadata: {
      reviewStatus: 'pending',
    },
    body: trimmed,
  });
}

function hashContent(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function bumpVersion(value: string | undefined): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '1';
  }
  if (/^\d+$/.test(normalized)) {
    return String(Number.parseInt(normalized, 10) + 1);
  }
  const semverMatch = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (semverMatch) {
    return `${semverMatch[1]}.${semverMatch[2]}.${Number.parseInt(semverMatch[3], 10) + 1}`;
  }
  return `${normalized}.1`;
}

export class SkillDraftStore {
  private readonly baseDir: string;
  private readonly pendingDir: string;
  private readonly historyDir: string;
  private readonly stateFilePath: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.pendingDir = path.join(this.baseDir, 'pending');
    this.historyDir = path.join(this.baseDir, 'history');
    this.stateFilePath = path.join(this.baseDir, 'auto-suggestions.json');
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  createDraft(input: {
    name: string;
    description: string;
    content: string;
    action?: SkillDraftAction;
    target: SkillDraftTarget;
    workspaceDir?: string;
    sourceSessionId?: string;
    globalSkillsDir?: string;
    reason?: string;
    sourceFingerprint?: string;
    triggerCount?: number;
    triggerCommands?: string[];
    baseVersion?: string;
    nextVersion?: string;
    originToolset?: string;
    originPlatform?: string;
    generatedAt?: string;
  }): SkillDraftRecord {
    const name = input.name.trim() || 'Unnamed Skill';
    const description = input.description.trim() || 'Generated skill draft';
    const targetPath = this.resolveTargetPath({
      name,
      target: input.target,
      workspaceDir: input.workspaceDir,
      globalSkillsDir: input.globalSkillsDir,
    });
    const existing = this.findPendingDuplicate({
      targetPath,
      sourceFingerprint: input.sourceFingerprint,
      content: input.content,
    });
    if (existing) {
      return existing;
    }
    const draft: SkillDraftRecord = {
      id: `skill-draft-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      name,
      description,
      content: ensureSkillMarkdown({ name, description, content: input.content }),
      action: input.action ?? 'create',
      target: input.target,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      sourceSessionId: input.sourceSessionId,
      targetPath,
      baseVersion: input.baseVersion?.trim() || undefined,
      nextVersion: input.nextVersion?.trim() || undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'pending',
      reason: input.reason?.trim() || undefined,
      sourceFingerprint: input.sourceFingerprint?.trim() || undefined,
      triggerCount: input.triggerCount,
      triggerCommands: input.triggerCommands?.slice(0, 8),
      originToolset: input.originToolset?.trim() || undefined,
      originPlatform: input.originPlatform?.trim() || undefined,
      generatedAt: input.generatedAt?.trim() || nowIso(),
    };
    this.saveDraft(draft);
    return draft;
  }

  observeSuccessfulTurn(input: {
    sessionId: string;
    workspaceDir?: string;
    prompt: string;
    finalOutput: string;
    globalSkillsDir?: string;
    toolsetName?: string;
    platform?: string;
  }): SkillDraftRecord | null {
    const prompt = String(input.prompt ?? '').trim();
    const finalOutput = String(input.finalOutput ?? '').trim();
    if (!prompt || !finalOutput || looksLikeFailure(finalOutput)) {
      return null;
    }
    const commands = extractCommandCandidates(finalOutput);
    const checklist = extractChecklistItems(finalOutput);
    if (commands.length === 0 && checklist.length < 2) {
      return null;
    }
    const target: SkillDraftTarget = input.workspaceDir ? 'workspace' : 'global';
    const fingerprint = buildPromptFingerprint(prompt, commands);
    const state = this.loadState();
    const key = `${target}:${input.workspaceDir ? path.resolve(input.workspaceDir) : 'global'}:${fingerprint}`;
    const current = state.patterns[key] ?? {
      key,
      fingerprint,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      target,
      count: 0,
      promptExample: prompt,
      latestOutput: finalOutput,
      commands: [],
      checklist: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    current.count += 1;
    current.promptExample = prompt;
    current.latestOutput = finalOutput;
    current.commands = Array.from(new Set([...current.commands, ...commands])).slice(0, 8);
    current.checklist = Array.from(new Set([...current.checklist, ...checklist])).slice(0, 8);
    current.updatedAt = nowIso();
    state.patterns[key] = current;
    this.saveState(state);

    if (current.count < 2) {
      return null;
    }
    if (current.suggestedDraftId) {
      const previous = this.loadDraft(current.suggestedDraftId);
      if (previous && previous.status === 'pending') {
        return null;
      }
    }

    const skillName = this.deriveSkillName(current);
    const targetPath = this.resolveTargetPath({
      name: skillName,
      target,
      workspaceDir: input.workspaceDir,
      globalSkillsDir: input.globalSkillsDir,
    });
    const nextMarkdown = ensureSkillMarkdown({
      name: skillName,
      description: this.deriveDescription(current),
      content: this.buildAutoSkillMarkdown(current),
    });
    const nextContentHash = hashContent(nextMarkdown);
    if (current.lastSuggestedContentHash === nextContentHash) {
      const previous = current.suggestedDraftId ? this.loadDraft(current.suggestedDraftId) : null;
      if (previous && previous.status !== 'rejected') {
        return null;
      }
    }

    let action: SkillDraftAction = 'create';
    let baseVersion: string | undefined;
    let nextVersion = '1';
    if (fs.existsSync(targetPath)) {
      const existingContent = fs.readFileSync(targetPath, 'utf-8');
      if (normalizeWorkflowText(existingContent) === normalizeWorkflowText(nextMarkdown)) {
        return null;
      }
      action = 'update';
      baseVersion = readSkillVersion(existingContent);
      nextVersion = bumpVersion(baseVersion);
    }

    const draft = this.createDraft({
      name: skillName,
      description: this.deriveDescription(current),
      content: nextMarkdown,
      action,
      target,
      workspaceDir: input.workspaceDir,
      sourceSessionId: input.sessionId,
      globalSkillsDir: input.globalSkillsDir,
      reason: 'repeated_success_pattern',
      sourceFingerprint: fingerprint,
      triggerCount: current.count,
      triggerCommands: current.commands,
      baseVersion,
      nextVersion,
      originToolset: input.toolsetName,
      originPlatform: input.platform,
      generatedAt: nowIso(),
    });
    current.suggestedDraftId = draft.id;
    current.lastSuggestedContentHash = nextContentHash;
    current.updatedAt = nowIso();
    state.patterns[key] = current;
    this.saveState(state);
    return draft;
  }

  listPending(filters: { sessionId?: string; workspaceDir?: string } = {}): SkillDraftRecord[] {
    return this.listDrafts({
      ...filters,
      status: 'pending',
    });
  }

  listDrafts(filters: {
    status?: SkillDraftRecord['status'];
    sessionId?: string;
    workspaceDir?: string;
    reason?: string;
  } = {}): SkillDraftRecord[] {
    const out: SkillDraftRecord[] = [];
    for (const entry of fs.readdirSync(this.pendingDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.pendingDir, entry.name), 'utf-8')) as SkillDraftRecord;
        if (filters.status && record.status !== filters.status) {
          continue;
        }
        if (filters.sessionId && record.sourceSessionId !== filters.sessionId) {
          continue;
        }
        if (filters.workspaceDir && path.resolve(record.workspaceDir ?? '') !== path.resolve(filters.workspaceDir)) {
          continue;
        }
        if (filters.reason && record.reason !== filters.reason) {
          continue;
        }
        out.push(record);
      } catch {
        // ignore malformed records
      }
    }
    return out.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  approveDraft(id: string): SkillDraftRecord | null {
    const record = this.loadDraft(id);
    if (!record || record.status !== 'pending') {
      return null;
    }
    const targetDir = path.dirname(record.targetPath);
    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.existsSync(record.targetPath)) {
      const existingContent = fs.readFileSync(record.targetPath, 'utf-8');
      this.saveRevision({
        skillName: record.name,
        targetPath: record.targetPath,
        workspaceDir: record.workspaceDir,
        version: readSkillVersion(existingContent),
        content: existingContent,
        sourceAction: 'approve',
      });
    }
    const metadataPatch: Record<string, unknown> = {
      reviewStatus: 'approved',
      version: record.nextVersion ?? readSkillVersion(record.content) ?? (record.action === 'create' ? '1' : undefined),
      source: record.target === 'workspace' ? 'workspace' : 'global',
      updatedAt: nowIso(),
    };
    if (record.reason === 'repeated_success_pattern') {
      metadataPatch.generatedBy = 'auto-observe-turn';
      metadataPatch.generationReason = record.reason;
      metadataPatch.sourceFingerprint = record.sourceFingerprint;
      metadataPatch.sourceSessionId = record.sourceSessionId;
      metadataPatch.originToolset = record.originToolset;
      metadataPatch.originPlatform = record.originPlatform;
      metadataPatch.generatedAt = record.generatedAt ?? record.reviewedAt ?? record.updatedAt ?? record.createdAt;
      if (record.originToolset) {
        metadataPatch.toolsets = [record.originToolset];
      }
      if (record.originPlatform) {
        metadataPatch.platforms = [record.originPlatform];
      }
    }
    const approvedContent = upsertSkillMetadata(record.content, metadataPatch);
    fs.writeFileSync(record.targetPath, approvedContent, 'utf-8');
    const next: SkillDraftRecord = {
      ...record,
      content: approvedContent,
      status: 'approved',
      reviewedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.saveDraft(next);
    return next;
  }

  rejectDraft(id: string, reviewNote?: string): SkillDraftRecord | null {
    const record = this.loadDraft(id);
    if (!record || record.status !== 'pending') {
      return null;
    }
    const next: SkillDraftRecord = {
      ...record,
      status: 'rejected',
      reviewedAt: nowIso(),
      updatedAt: nowIso(),
      reviewNote: reviewNote?.trim() || undefined,
    };
    this.saveDraft(next);
    return next;
  }

  listHistory(filters: {
    targetPath?: string;
    workspaceDir?: string;
    limit?: number;
  } = {}): SkillRevisionRecord[] {
    if (!fs.existsSync(this.historyDir)) {
      return [];
    }
    const limit = Math.max(1, Math.min(100, Math.floor(filters.limit ?? 20)));
    const out: SkillRevisionRecord[] = [];
    for (const entry of fs.readdirSync(this.historyDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.historyDir, entry.name), 'utf-8')) as SkillRevisionRecord;
        if (filters.targetPath && path.resolve(record.targetPath) !== path.resolve(filters.targetPath)) {
          continue;
        }
        if (
          filters.workspaceDir &&
          path.resolve(record.workspaceDir ?? '') !== path.resolve(filters.workspaceDir)
        ) {
          continue;
        }
        out.push(record);
      } catch {
        // ignore malformed records
      }
    }
    return out
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  rollbackSkill(input: { targetPath: string; workspaceDir?: string; version?: string }): {
    targetPath: string;
    restoredVersion?: string;
    previousVersion?: string;
  } | null {
    const targetPath = path.resolve(input.targetPath);
    if (!fs.existsSync(targetPath)) {
      return null;
    }
    const history = this.listHistory({
      targetPath,
      workspaceDir: input.workspaceDir,
      limit: 100,
    });
    const selected =
      (input.version ? history.find((item) => item.version === input.version) : undefined) ?? history[0];
    if (!selected) {
      return null;
    }
    const currentContent = fs.readFileSync(targetPath, 'utf-8');
    this.saveRevision({
      skillName: selected.skillName,
      targetPath,
      workspaceDir: input.workspaceDir,
      version: readSkillVersion(currentContent),
      content: currentContent,
      sourceAction: 'rollback',
    });
    const restoredContent = upsertSkillMetadata(selected.content, {
      reviewStatus: 'approved',
      updatedAt: nowIso(),
    });
    fs.writeFileSync(targetPath, restoredContent, 'utf-8');
    return {
      targetPath,
      restoredVersion: selected.version,
      previousVersion: readSkillVersion(currentContent),
    };
  }

  recordSkillRevision(input: {
    skillName: string;
    targetPath: string;
    workspaceDir?: string;
    version?: string;
    content: string;
    sourceAction?: 'approve' | 'rollback' | 'governance';
  }): SkillRevisionRecord {
    return this.saveRevision({
      ...input,
      sourceAction: input.sourceAction ?? 'governance',
    });
  }

  private deriveSkillName(pattern: SkillSuggestionPattern): string {
    if (pattern.commands.length > 0) {
      return `workflow-${slugifyWorkflowText(pattern.commands[0], 'workflow', 40)}`;
    }
    return `workflow-${slugifyWorkflowText(pattern.promptExample, 'workflow', 40)}`;
  }

  private deriveDescription(pattern: SkillSuggestionPattern): string {
    const promptSummary = tokenizeWorkflowText(pattern.promptExample).slice(0, 6).join(' ');
    return `Suggested reusable workflow for ${promptSummary || 'repeated successful task'}`;
  }

  private buildAutoSkillMarkdown(pattern: SkillSuggestionPattern): string {
    const lines: string[] = [
      `When the user asks for this repeated workflow, follow these steps.`,
      '',
      '## Workflow',
    ];
    const workflowSteps = pattern.commands.length > 0 ? pattern.commands : pattern.checklist;
    workflowSteps.slice(0, 8).forEach((step, index) => {
      lines.push(`${index + 1}. ${step.startsWith('`') ? step : `\`${step}\``}`);
    });
    if (pattern.checklist.length > 0) {
      lines.push('', '## Notes');
      pattern.checklist.slice(0, 6).forEach((item) => {
        lines.push(`- ${item}`);
      });
    }
    lines.push('', '## Source Pattern');
    lines.push(`- Prompt example: ${pattern.promptExample}`);
    lines.push(`- Successful repetitions observed: ${pattern.count}`);
    return lines.join('\n');
  }

  private findPendingDuplicate(input: {
    targetPath: string;
    sourceFingerprint?: string;
    content: string;
  }): SkillDraftRecord | null {
    for (const record of this.listPending()) {
      if (path.resolve(record.targetPath) === path.resolve(input.targetPath)) {
        return record;
      }
      if (
        input.sourceFingerprint &&
        record.sourceFingerprint &&
        normalizeWorkflowText(record.sourceFingerprint) === normalizeWorkflowText(input.sourceFingerprint)
      ) {
        return record;
      }
      if (normalizeWorkflowText(record.content) === normalizeWorkflowText(input.content)) {
        return record;
      }
    }
    return null;
  }

  private resolveTargetPath(input: {
    name: string;
    target: SkillDraftTarget;
    workspaceDir?: string;
    globalSkillsDir?: string;
  }): string {
    const slug = slugify(input.name);
    if (input.target === 'workspace' && input.workspaceDir) {
      return path.join(path.resolve(input.workspaceDir), 'skills', slug, 'SKILL.md');
    }
    if (input.globalSkillsDir && input.globalSkillsDir.trim().length > 0) {
      return path.join(path.resolve(input.globalSkillsDir), slug, 'SKILL.md');
    }
    if (input.workspaceDir) {
      return path.join(path.resolve(input.workspaceDir), 'skills', slug, 'SKILL.md');
    }
    throw new Error('Unable to resolve skill target path');
  }

  private draftPath(id: string): string {
    return path.join(this.pendingDir, `${id}.json`);
  }

  private loadDraft(id: string): SkillDraftRecord | null {
    const filePath = this.draftPath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SkillDraftRecord;
    } catch {
      return null;
    }
  }

  private saveDraft(record: SkillDraftRecord): void {
    fs.writeFileSync(this.draftPath(record.id), JSON.stringify(record, null, 2), 'utf-8');
  }

  private revisionPath(id: string): string {
    return path.join(this.historyDir, `${id}.json`);
  }

  private saveRevision(input: {
    skillName: string;
    targetPath: string;
    workspaceDir?: string;
    version?: string;
    content: string;
    sourceAction: 'approve' | 'rollback' | 'governance';
  }): SkillRevisionRecord {
    const record: SkillRevisionRecord = {
      id: `skill-revision-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      skillName: input.skillName,
      targetPath: path.resolve(input.targetPath),
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      version: input.version?.trim() || undefined,
      content: input.content,
      sourceAction: input.sourceAction,
      createdAt: nowIso(),
    };
    fs.writeFileSync(this.revisionPath(record.id), JSON.stringify(record, null, 2), 'utf-8');
    return record;
  }

  private loadState(): SkillSuggestionState {
    if (!fs.existsSync(this.stateFilePath)) {
      return { patterns: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8')) as SkillSuggestionState;
      return {
        patterns: parsed?.patterns ?? {},
      };
    } catch {
      return { patterns: {} };
    }
  }

  private saveState(state: SkillSuggestionState): void {
    fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
