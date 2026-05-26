import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildPromptFingerprint,
  extractChecklistItems,
  extractCommandCandidates,
  looksLikeFailure,
  normalizeWorkflowText,
  slugifyWorkflowText,
  tokenizeWorkflowText,
} from '../utils/workflow-signal.js';
import { readSkillVersion, upsertSkillMetadata } from './skill-markdown.js';
import type {
  SkillWriteAction,
  SkillWriteRecord,
  SkillWriteTarget,
  SkillRevisionRecord,
  SkillSuggestionPattern,
  SkillSuggestionState,
} from './skill-write-contracts.js';
import {
  bumpVersion,
  ensureSkillMarkdown,
  hashContent,
  nowIso,
  slugify,
} from './skill-write-utils.js';

export type {
  SkillWriteAction,
  SkillWriteRecord,
  SkillWriteTarget,
  SkillRevisionRecord,
} from './skill-write-contracts.js';

export class SkillWriteStore {
  private readonly baseDir: string;
  private readonly writesDir: string;
  private readonly historyDir: string;
  private readonly stateFilePath: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.writesDir = path.join(this.baseDir, 'writes');
    this.historyDir = path.join(this.baseDir, 'history');
    this.stateFilePath = path.join(this.baseDir, 'auto-suggestions.json');
    fs.mkdirSync(this.writesDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
  }

  writeSkill(input: {
    name: string;
    description: string;
    content: string;
    target: SkillWriteTarget;
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
  }): SkillWriteRecord {
    const name = input.name.trim() || 'Unnamed Skill';
    const description = input.description.trim() || 'Generated skill write';
    const targetPath = this.resolveTargetPath({
      name,
      target: input.target,
      workspaceDir: input.workspaceDir,
      globalSkillsDir: input.globalSkillsDir,
    });
    const targetExists = fs.existsSync(targetPath);
    const existingContent = targetExists ? fs.readFileSync(targetPath, 'utf-8') : undefined;
    const action = targetExists ? 'update' : 'create';
    const baseVersion = input.baseVersion?.trim() || (targetExists ? readSkillVersion(existingContent ?? '') : undefined);
    const nextVersion = input.nextVersion?.trim() || (action === 'update' ? bumpVersion(baseVersion) : '1');
    const createdAt = nowIso();
    const content = ensureSkillMarkdown({ name, description, content: input.content });
    if (targetExists && existingContent !== undefined) {
      this.saveRevision({
        skillName: name,
        targetPath,
        workspaceDir: input.workspaceDir,
        version: readSkillVersion(existingContent),
        content: existingContent,
        sourceAction: 'write',
      });
    }
    const metadataPatch: Record<string, unknown> = {
      reviewStatus: 'approved',
      version: nextVersion ?? readSkillVersion(content) ?? (action === 'create' ? '1' : undefined),
      source: input.target === 'workspace' ? 'workspace' : 'global',
      updatedAt: createdAt,
    };
    if (input.reason === 'repeated_success_pattern') {
      metadataPatch.generatedBy = 'auto-observe-turn';
      metadataPatch.generationReason = input.reason;
      metadataPatch.sourceFingerprint = input.sourceFingerprint?.trim() || undefined;
      metadataPatch.sourceSessionId = input.sourceSessionId;
      metadataPatch.originToolset = input.originToolset?.trim() || undefined;
      metadataPatch.originPlatform = input.originPlatform?.trim() || undefined;
      metadataPatch.generatedAt = input.generatedAt?.trim() || createdAt;
      if (input.originToolset?.trim()) {
        metadataPatch.toolsets = [input.originToolset.trim()];
      }
      if (input.originPlatform?.trim()) {
        metadataPatch.platforms = [input.originPlatform.trim()];
      }
    }
    const appliedContent = upsertSkillMetadata(content, metadataPatch);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, appliedContent, 'utf-8');
    const record: SkillWriteRecord = {
      id: `skill-write-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      name,
      description,
      content: appliedContent,
      action,
      target: input.target,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      sourceSessionId: input.sourceSessionId,
      targetPath,
      baseVersion,
      nextVersion,
      createdAt,
      updatedAt: createdAt,
      status: 'applied',
      appliedAt: createdAt,
      reason: input.reason?.trim() || undefined,
      sourceFingerprint: input.sourceFingerprint?.trim() || undefined,
      triggerCount: input.triggerCount,
      triggerCommands: input.triggerCommands?.slice(0, 8),
      originToolset: input.originToolset?.trim() || undefined,
      originPlatform: input.originPlatform?.trim() || undefined,
      generatedAt: input.generatedAt?.trim() || createdAt,
    };
    this.saveWriteRecord(record);
    return record;
  }

  observeSuccessfulTurn(input: {
    sessionId: string;
    workspaceDir?: string;
    prompt: string;
    finalOutput: string;
    globalSkillsDir?: string;
    toolsetName?: string;
    platform?: string;
  }): SkillWriteRecord | null {
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
    const target: SkillWriteTarget = input.workspaceDir ? 'workspace' : 'global';
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
    if (current.lastWrittenContentHash === nextContentHash) {
      const previous = current.lastWriteRecordId ? this.loadWriteRecord(current.lastWriteRecordId) : null;
      if (previous) {
        return null;
      }
    }

    let action: SkillWriteAction = 'create';
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

    const record = this.writeSkill({
      name: skillName,
      description: this.deriveDescription(current),
      content: nextMarkdown,
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
    current.lastWriteRecordId = record.id;
    current.lastWrittenContentHash = nextContentHash;
    current.updatedAt = nowIso();
    state.patterns[key] = current;
    this.saveState(state);
    return record;
  }

  listWriteRecords(filters: {
    status?: SkillWriteRecord['status'];
    sessionId?: string;
    workspaceDir?: string;
    reason?: string;
  } = {}): SkillWriteRecord[] {
    const out: SkillWriteRecord[] = [];
    for (const entry of fs.readdirSync(this.writesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.writesDir, entry.name), 'utf-8')) as SkillWriteRecord;
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
    sourceAction?: 'write' | 'rollback' | 'governance' | 'edit';
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

  private resolveTargetPath(input: {
    name: string;
    target: SkillWriteTarget;
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

  private writeRecordPath(id: string): string {
    return path.join(this.writesDir, `${id}.json`);
  }

  private loadWriteRecord(id: string): SkillWriteRecord | null {
    const filePath = this.writeRecordPath(id);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SkillWriteRecord;
    } catch {
      return null;
    }
  }

  private saveWriteRecord(record: SkillWriteRecord): void {
    fs.writeFileSync(this.writeRecordPath(record.id), JSON.stringify(record, null, 2), 'utf-8');
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
    sourceAction: 'write' | 'rollback' | 'governance' | 'edit';
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
