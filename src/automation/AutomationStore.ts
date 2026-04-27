import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeNextRunAt } from './schedule.js';
import type {
  AutomationJob,
  AutomationMemoryTemplate,
  AutomationRunReport,
  AutomationRunRecord,
  AutomationSchedule,
} from './types.js';

interface CreateAutomationJobInput {
  name: string;
  prompt: string;
  workspaceDir: string;
  skills?: string[];
  llmSelection?: AutomationJob['llmSelection'];
  schedule: AutomationSchedule;
  timezone: string;
  enabled?: boolean;
  jobSource?: AutomationJob['jobSource'];
  systemTask?: AutomationJob['systemTask'];
  readOnly?: boolean;
}

interface UpdateAutomationJobInput {
  name?: string;
  prompt?: string;
  workspaceDir?: string;
  skills?: string[];
  llmSelection?: AutomationJob['llmSelection'];
  schedule?: AutomationSchedule;
  timezone?: string;
  enabled?: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  jobSource?: AutomationJob['jobSource'];
  systemTask?: AutomationJob['systemTask'];
  readOnly?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeSkills(skills: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (skills ?? [])
        .map((item) => String(item ?? '').trim())
        .filter((item) => item.length > 0)
    )
  ).slice(0, 64);
}

function normalizeSummary(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class AutomationStore {
  private readonly baseDir: string;
  private readonly jobsPath: string;
  private readonly runsDir: string;
  private readonly templatesDir: string;
  private readonly reportsDir: string;
  private readonly runRetention: number;

  constructor(baseDir: string, runRetention = 30) {
    this.baseDir = path.resolve(baseDir);
    this.jobsPath = path.join(this.baseDir, 'jobs.json');
    this.runsDir = path.join(this.baseDir, 'runs');
    this.templatesDir = path.join(this.baseDir, 'memory-templates');
    this.reportsDir = path.join(this.baseDir, 'reports');
    this.runRetention = Math.max(1, Math.trunc(runRetention));
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.templatesDir, { recursive: true });
    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  listJobs(): AutomationJob[] {
    const items = readJsonFile<AutomationJob[]>(this.jobsPath, []);
    return items
      .map((item) => ({
        ...item,
        skills: normalizeSkills(item.skills),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getJob(id: string): AutomationJob | undefined {
    const normalized = normalizeString(id);
    if (!normalized) {
      return undefined;
    }
    return this.listJobs().find((item) => item.id === normalized);
  }

  createJob(input: CreateAutomationJobInput): AutomationJob {
    const name = normalizeString(input.name);
    const prompt = normalizeString(input.prompt);
    const workspaceDir = normalizeString(input.workspaceDir);
    if (!name) {
      throw new Error('name is required');
    }
    if (!prompt) {
      throw new Error('prompt is required');
    }
    if (!workspaceDir) {
      throw new Error('workspaceDir is required');
    }
    const createdAt = nowIso();
    const enabled = input.enabled !== false;
    const nextRunAt = enabled
      ? computeNextRunAt(input.schedule, input.timezone, new Date(createdAt))
      : undefined;
    const next: AutomationJob = {
      id: uniqueId('automation'),
      name,
      prompt,
      workspaceDir,
      skills: normalizeSkills(input.skills),
      ...(input.llmSelection ? { llmSelection: input.llmSelection } : {}),
      schedule: input.schedule,
      timezone: input.timezone,
      enabled,
      jobSource: input.jobSource ?? 'user',
      systemTask: input.systemTask,
      readOnly: input.readOnly === true,
      createdAt,
      updatedAt: createdAt,
      nextRunAt,
    };
    const jobs = this.listJobs();
    jobs.push(next);
    this.saveJobs(jobs);
    return next;
  }

  updateJob(id: string, patch: UpdateAutomationJobInput): AutomationJob {
    const jobs = this.listJobs();
    const index = jobs.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new Error(`automation not found: ${id}`);
    }
    const current = jobs[index];
    const next: AutomationJob = {
      ...current,
      ...patch,
      name: patch.name !== undefined ? normalizeString(patch.name) : current.name,
      prompt: patch.prompt !== undefined ? normalizeString(patch.prompt) : current.prompt,
      workspaceDir:
        patch.workspaceDir !== undefined ? normalizeString(patch.workspaceDir) : current.workspaceDir,
      skills: patch.skills !== undefined ? normalizeSkills(patch.skills) : current.skills,
      llmSelection: patch.llmSelection !== undefined ? patch.llmSelection : current.llmSelection,
      schedule: patch.schedule ?? current.schedule,
      timezone: patch.timezone !== undefined ? normalizeString(patch.timezone) : current.timezone,
      enabled: patch.enabled ?? current.enabled,
      jobSource: patch.jobSource ?? current.jobSource ?? 'user',
      systemTask: patch.systemTask ?? current.systemTask,
      readOnly: patch.readOnly ?? current.readOnly,
      updatedAt: nowIso(),
    };
    if (!next.name) {
      throw new Error('name is required');
    }
    if (!next.prompt) {
      throw new Error('prompt is required');
    }
    if (!next.workspaceDir) {
      throw new Error('workspaceDir is required');
    }

    if (patch.enabled === false) {
      next.nextRunAt = undefined;
    } else if (patch.nextRunAt !== undefined) {
      next.nextRunAt = normalizeString(patch.nextRunAt) || undefined;
    } else if (patch.schedule || patch.timezone || patch.enabled === true) {
      next.nextRunAt = computeNextRunAt(next.schedule, next.timezone, new Date());
    }

    jobs[index] = next;
    this.saveJobs(jobs);
    return next;
  }

  deleteJob(id: string): boolean {
    const jobs = this.listJobs();
    const filtered = jobs.filter((item) => item.id !== id);
    if (filtered.length === jobs.length) {
      return false;
    }
    this.saveJobs(filtered);
    const runsPath = this.getRunsPath(id);
    if (fs.existsSync(runsPath)) {
      fs.rmSync(runsPath, { force: true });
    }
    const templatePath = this.getTemplatePath(id);
    if (fs.existsSync(templatePath)) {
      fs.rmSync(templatePath, { force: true });
    }
    for (const reportPath of this.listReportPathsForJob(id)) {
      fs.rmSync(reportPath, { force: true });
    }
    return true;
  }

  listRuns(jobId: string): AutomationRunRecord[] {
    const records = readJsonFile<AutomationRunRecord[]>(this.getRunsPath(jobId), []);
    return records.sort((left, right) => right.triggerAt.localeCompare(left.triggerAt));
  }

  appendRun(jobId: string, record: AutomationRunRecord): AutomationRunRecord[] {
    const next = [record, ...this.listRuns(jobId)]
      .sort((left, right) => right.triggerAt.localeCompare(left.triggerAt))
      .slice(0, this.runRetention);
    writeJsonFile(this.getRunsPath(jobId), next);
    return next;
  }

  updateRun(jobId: string, runId: string, patch: Partial<AutomationRunRecord>): AutomationRunRecord | null {
    const runs = this.listRuns(jobId);
    const index = runs.findIndex((item) => item.id === runId);
    if (index < 0) {
      return null;
    }
    const current = runs[index];
    const next: AutomationRunRecord = {
      ...current,
      ...patch,
      id: current.id,
      jobId: current.jobId,
      sessionId: current.sessionId,
      triggerAt: current.triggerAt,
      resultSummary:
        patch.resultSummary !== undefined
          ? normalizeSummary(String(patch.resultSummary ?? ''))
          : current.resultSummary,
      error: patch.error !== undefined ? normalizeSummary(String(patch.error ?? '')) : current.error,
    };
    runs[index] = next;
    runs.sort((left, right) => right.triggerAt.localeCompare(left.triggerAt));
    writeJsonFile(this.getRunsPath(jobId), runs.slice(0, this.runRetention));
    return next;
  }

  getMemoryTemplate(jobId: string): AutomationMemoryTemplate | undefined {
    return readJsonFile<AutomationMemoryTemplate | undefined>(this.getTemplatePath(jobId), undefined);
  }

  getRunReport(jobId: string, runId: string): AutomationRunReport | undefined {
    return readJsonFile<AutomationRunReport | undefined>(this.getReportPath(jobId, runId), undefined);
  }

  updateRunReport(jobId: string, runId: string, report: AutomationRunReport): AutomationRunReport {
    writeJsonFile(this.getReportPath(jobId, runId), report);
    return report;
  }

  findSystemJob(systemTask: NonNullable<AutomationJob['systemTask']>): AutomationJob | undefined {
    return this.listJobs().find(
      (item) => item.jobSource === 'system' && item.systemTask === systemTask
    );
  }

  upsertSystemJob(input: {
    systemTask: NonNullable<AutomationJob['systemTask']>;
    name: string;
    prompt: string;
    workspaceDir: string;
    schedule: AutomationSchedule;
    timezone: string;
  }): AutomationJob {
    const existing = this.findSystemJob(input.systemTask);
    if (!existing) {
      return this.createJob({
        ...input,
        enabled: true,
        jobSource: 'system',
        readOnly: true,
      });
    }
    return this.updateJob(existing.id, {
      name: input.name,
      prompt: input.prompt,
      workspaceDir: input.workspaceDir,
      schedule: input.schedule,
      timezone: input.timezone,
      enabled: true,
      jobSource: 'system',
      systemTask: input.systemTask,
      readOnly: true,
    });
  }

  updateMemoryTemplate(input: {
    jobId: string;
    template: string;
    sourceSessionId?: string;
  }): AutomationMemoryTemplate {
    const now = nowIso();
    const existing = this.getMemoryTemplate(input.jobId);
    const normalizedTemplate = String(input.template ?? '').trim();
    const next: AutomationMemoryTemplate = {
      jobId: input.jobId,
      template: normalizedTemplate,
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    };
    writeJsonFile(this.getTemplatePath(input.jobId), next);
    return next;
  }

  private saveJobs(items: AutomationJob[]): void {
    const sorted = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    writeJsonFile(this.jobsPath, sorted);
  }

  private getRunsPath(jobId: string): string {
    return path.join(this.runsDir, `${jobId}.json`);
  }

  private getTemplatePath(jobId: string): string {
    return path.join(this.templatesDir, `${jobId}.json`);
  }

  private getReportPath(jobId: string, runId: string): string {
    return path.join(this.reportsDir, `${jobId}-${runId}.json`);
  }

  private listReportPathsForJob(jobId: string): string[] {
    if (!fs.existsSync(this.reportsDir)) {
      return [];
    }
    const prefix = `${jobId}-`;
    return fs
      .readdirSync(this.reportsDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => path.join(this.reportsDir, name));
  }
}
