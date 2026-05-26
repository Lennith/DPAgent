// AutomationCenter structure:
// - API/view types and form helpers.
// - Task list plus selected-task detail state.
// - Compact create/edit form with job-level model selection.
// - Run, enable/disable, delete, history, memory, and report panels.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentListItemView,
  LlmProfilesConfigView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from '../../app-shell-types.js';
import {
  applySessionLlmSelectionPatch,
  createNextSessionLlmSelectionUpdatedAt,
  resolveLlmProfileById,
  resolveSessionLlmSelectionView,
} from '../../llm-session-state.js';
import { useI18n } from '../../i18n/index.js';
import type { ThemeConfig } from '../../styles/theme/index.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';

type Frequency = 'interval' | 'hourly' | 'daily' | 'weekly';
type ApiFrequency = Frequency | 'once';
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 60 * 60 * 24 * 30;

interface AutomationScheduleView {
  frequency: ApiFrequency;
  intervalSeconds?: number;
  minute?: number;
  hour?: number;
  weekday?: number;
}

interface AutomationJobView {
  id: string;
  name: string;
  prompt: string;
  workspaceDir: string;
  skills: string[];
  agentName?: string;
  llmSelection?: SessionLlmSelectionView;
  schedule: AutomationScheduleView;
  timezone: string;
  enabled: boolean;
  jobSource?: 'user' | 'system';
  systemTask?: 'auto_generated_skill_governance';
  readOnly?: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

interface AutomationRunRecordView {
  id: string;
  jobId: string;
  sessionId: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  triggerAt: string;
  triggerSource?: 'schedule' | 'manual';
  resultSummary?: string;
  error?: string;
  skippedReason?: string;
  agentName?: string;
  effectiveAgentName?: string;
  agentFallbackReason?: string;
  reportPath?: string;
}

interface AutomationMemoryTemplateView {
  jobId: string;
  template: string;
  version: number;
  updatedAt: string;
  sourceSessionId?: string;
}

interface SkillView {
  name: string;
  description: string;
}

interface AutomationRunReportView {
  kind: 'auto_generated_skill_governance';
  generatedAt: string;
  fallback: boolean;
  fallbackReason?: string;
  summary: {
    scannedSkills: number;
    exactDuplicates: number;
    candidateDuplicates: number;
    autoArchived: number;
    reportOnly: number;
    boundaryFixed: number;
    conflicts: number;
  };
  items: unknown[];
}

interface AutomationCenterProps {
  workspaceDir: string;
  llmProfiles: LlmProfilesConfigView | null;
  onOpenSession: (sessionId: string) => void;
}

interface JobFormState {
  id?: string;
  name: string;
  prompt: string;
  workspaceDir: string;
  frequency: Frequency;
  intervalSeconds: number;
  intervalSecondsInput: string;
  minute: number;
  hour: number;
  weekday: number;
  timezone: string;
  skills: string[];
  agentName: string;
  llmSelection: SessionLlmSelectionView;
}

function nowTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function normalizeNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseIntervalSecondsInput(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < MIN_INTERVAL_SECONDS || parsed > MAX_INTERVAL_SECONDS) {
    return null;
  }
  return parsed;
}

function createDefaultFormState(
  workspaceDir: string,
  llmProfiles: LlmProfilesConfigView | null
): JobFormState {
  return {
    name: '',
    prompt: '',
    workspaceDir,
    frequency: 'interval',
    intervalSeconds: 3600,
    intervalSecondsInput: '3600',
    minute: 0,
    hour: 9,
    weekday: 1,
    timezone: nowTimezone(),
    skills: [],
    agentName: '',
    llmSelection: resolveSessionLlmSelectionView(llmProfiles),
  };
}

function toFormState(job: AutomationJobView, llmProfiles: LlmProfilesConfigView | null): JobFormState {
  return {
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    workspaceDir: job.workspaceDir,
    frequency: job.schedule.frequency === 'once' ? 'interval' : job.schedule.frequency,
    intervalSeconds: normalizeNumber(job.schedule.intervalSeconds ?? 3600, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
    intervalSecondsInput: String(normalizeNumber(job.schedule.intervalSeconds ?? 3600, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)),
    minute: normalizeNumber(job.schedule.minute ?? 0, 0, 59),
    hour: normalizeNumber(job.schedule.hour ?? 0, 0, 23),
    weekday: normalizeNumber(job.schedule.weekday ?? 1, 0, 6),
    timezone: job.timezone,
    skills: [...job.skills],
    agentName: job.agentName ?? '',
    llmSelection: resolveSessionLlmSelectionView(llmProfiles, job.llmSelection),
  };
}

function formatWhen(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function summarizeRun(run: AutomationRunRecordView): string {
  return run.resultSummary || run.error || run.skippedReason || '-';
}

function twoDigit(value: number): string {
  return String(normalizeNumber(value, 0, 99)).padStart(2, '0');
}

function fieldSurface(theme: ThemeConfig): React.CSSProperties {
  return {
    borderColor: theme.colors.border.DEFAULT,
    backgroundColor: theme.colors.bg.tertiary,
    color: theme.colors.text.primary,
  };
}

function selectProxyStyle(): React.CSSProperties {
  return {
    display: 'none',
  };
}

async function readApiError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';
  const fallback = `HTTP ${response.status}`;
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof payload?.error === 'string' ? payload.error.trim() : '';
    return message || fallback;
  }
  const text = (await response.text().catch(() => '')).trim();
  const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  const cleaned = (preMatch?.[1] || text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function AutomationCenter({ workspaceDir, llmProfiles, onOpenSession }: AutomationCenterProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [jobs, setJobs] = useState<AutomationJobView[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [agents, setAgents] = useState<AgentListItemView[]>([]);
  const [form, setForm] = useState<JobFormState>(() => createDefaultFormState(workspaceDir, llmProfiles));
  const [submitting, setSubmitting] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRunRecordView[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [template, setTemplate] = useState<AutomationMemoryTemplateView | null>(null);
  const [selectedRunSessionId, setSelectedRunSessionId] = useState('');
  const [memoryNote, setMemoryNote] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [selectedReportRunId, setSelectedReportRunId] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<AutomationRunReportView | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((item) => item.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );
  const formJob = useMemo(
    () => (form.id ? jobs.find((item) => item.id === form.id) ?? null : null),
    [form.id, jobs]
  );
  const formReadOnly = Boolean(formJob?.readOnly);
  const currentProfile = resolveLlmProfileById(llmProfiles, form.llmSelection.profileId);
  const profileOptions = llmProfiles?.profiles ?? [];
  const usingDefaultAgent = form.agentName.trim().length === 0;
  const resolvedIntervalSeconds = parseIntervalSecondsInput(form.intervalSecondsInput);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    setJobsError(null);
    try {
      const response = await fetch('/api/automations');
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { items?: AutomationJobView[] };
      setJobs(payload.items ?? []);
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const response = await fetch('/api/skills');
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { skills?: SkillView[] };
      setSkills(payload.skills ?? []);
    } catch {
      setSkills([]);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const response = await fetch('/api/agents');
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { agents?: AgentListItemView[] };
      setAgents((payload.agents ?? []).filter((item) => item.source === 'bundled' || item.source === 'global'));
    } catch {
      setAgents([]);
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string) => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(jobId)}/runs`);
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as {
        items?: AutomationRunRecordView[];
        template?: AutomationMemoryTemplateView | null;
      };
      setRuns(payload.items ?? []);
      setTemplate(payload.template ?? null);
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : String(error));
      setRuns([]);
      setTemplate(null);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadReport = useCallback(async (jobId: string, runId: string) => {
    setReportLoading(true);
    setReportError(null);
    try {
      const response = await fetch(
        `/api/automations/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/report`
      );
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { report?: AutomationRunReportView | null };
      setSelectedReport(payload.report ?? null);
      setSelectedReportRunId(runId);
      setReportOpen(true);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : String(error));
      setSelectedReport(null);
      setSelectedReportRunId(runId);
      setReportOpen(true);
    } finally {
      setReportLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
    void loadSkills();
    void loadAgents();
  }, [loadAgents, loadJobs, loadSkills]);

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      workspaceDir: prev.workspaceDir || workspaceDir,
      llmSelection: resolveSessionLlmSelectionView(llmProfiles, prev.llmSelection),
    }));
  }, [llmProfiles, workspaceDir]);

  useEffect(() => {
    if (!selectedJobId) {
      setRuns([]);
      setTemplate(null);
      setSelectedReportRunId(null);
      setSelectedReport(null);
      setReportError(null);
      return;
    }
    void loadRuns(selectedJobId);
  }, [loadRuns, selectedJobId]);

  const resetForm = useCallback(() => {
    setForm(createDefaultFormState(workspaceDir, llmProfiles));
    setSelectedJobId(null);
    setSelectedRunSessionId('');
    setMemoryNote('');
    setMemoryOpen(false);
    setReportOpen(false);
    setSelectedReportRunId(null);
    setSelectedReport(null);
    setReportError(null);
  }, [llmProfiles, workspaceDir]);

  const updateFormLlmSelection = useCallback(
    (patch: SessionLlmSelectionPatch) => {
      setForm((prev) => ({
        ...prev,
        llmSelection: applySessionLlmSelectionPatch(llmProfiles, prev.llmSelection, {
          ...patch,
          updatedAt: createNextSessionLlmSelectionUpdatedAt(prev.llmSelection.updatedAt),
        }),
      }));
    },
    [llmProfiles]
  );

  const handleSelectJob = useCallback(
    (job: AutomationJobView) => {
      setSelectedJobId(job.id);
      setForm(toFormState(job, llmProfiles));
      setSelectedRunSessionId('');
      setMemoryNote('');
      setMemoryOpen(false);
      setReportOpen(false);
      setSelectedReportRunId(null);
      setSelectedReport(null);
      setReportError(null);
    },
    [llmProfiles]
  );

  const handleSubmit = useCallback(async () => {
    if (formReadOnly || !form.name.trim() || !form.prompt.trim() || !form.workspaceDir.trim()) {
      return;
    }
    const submitIntervalSeconds = parseIntervalSecondsInput(form.intervalSecondsInput);
    if (form.frequency === 'interval' && submitIntervalSeconds === null) {
      setJobsError(t('automation.form.intervalInvalid'));
      return;
    }
    const isEditing = Boolean(form.id);
    setSubmitting(true);
    try {
      const schedule: AutomationScheduleView =
        form.frequency === 'interval'
          ? {
              frequency: 'interval',
              intervalSeconds: submitIntervalSeconds ?? MIN_INTERVAL_SECONDS,
            }
          : {
              frequency: form.frequency,
              minute: normalizeNumber(form.minute, 0, 59),
            };
      if (form.frequency !== 'interval' && form.frequency !== 'hourly') {
        schedule.hour = normalizeNumber(form.hour, 0, 23);
      }
      if (form.frequency === 'weekly') {
        schedule.weekday = normalizeNumber(form.weekday, 0, 6);
      }
      const body = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        workspaceDir: form.workspaceDir.trim(),
        skills: form.skills,
        agentName: form.agentName.trim() || null,
        llmSelection: form.llmSelection,
        schedule,
        timezone: form.timezone.trim() || nowTimezone(),
        ...(!isEditing ? { enabled: true } : {}),
      };
      const response = await fetch(
        form.id ? `/api/automations/${encodeURIComponent(form.id)}` : '/api/automations',
        {
          method: form.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { item?: AutomationJobView };
      await loadJobs();
      const nextId = payload.item?.id ?? form.id ?? null;
      setSelectedJobId(nextId);
      if (payload.item) {
        setForm(toFormState(payload.item, llmProfiles));
      } else if (!isEditing) {
        setForm(createDefaultFormState(workspaceDir, llmProfiles));
      }
      if (nextId) {
        await loadRuns(nextId);
      }
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [form, formReadOnly, llmProfiles, loadJobs, loadRuns, t, workspaceDir]);

  const handleToggle = useCallback(
    async (job: AutomationJobView) => {
      if (job.readOnly) {
        return;
      }
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(job.id)}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !job.enabled }),
        });
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        await loadJobs();
      } catch (error) {
        setJobsError(error instanceof Error ? error.message : String(error));
      }
    },
    [loadJobs]
  );

  const handleDelete = useCallback(
    async (job: AutomationJobView) => {
      if (job.readOnly || !window.confirm(t('automation.delete.confirm', { name: job.name }))) {
        return;
      }
      setDeletingJobId(job.id);
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(job.id)}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        resetForm();
        await loadJobs();
      } catch (error) {
        setJobsError(error instanceof Error ? error.message : String(error));
      } finally {
        setDeletingJobId(null);
      }
    },
    [loadJobs, resetForm, t]
  );

  const handleRunNow = useCallback(
    async (job: AutomationJobView) => {
      setRunningJobId(job.id);
      setRunsError(null);
      try {
        const response = await fetch(`/api/automations/${encodeURIComponent(job.id)}/run`, {
          method: 'POST',
        });
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        await loadJobs();
        setSelectedJobId(job.id);
        await loadRuns(job.id);
      } catch (error) {
        setRunsError(error instanceof Error ? error.message : String(error));
      } finally {
        setRunningJobId(null);
      }
    },
    [loadJobs, loadRuns]
  );

  const handleSaveMemory = useCallback(async () => {
    if (!selectedJobId || !selectedRunSessionId.trim()) {
      return;
    }
    setMemorySaving(true);
    try {
      const response = await fetch(
        `/api/automations/${encodeURIComponent(selectedJobId)}/memory/from-session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: selectedRunSessionId.trim(),
            note: memoryNote.trim(),
          }),
        }
      );
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const payload = (await response.json()) as { template?: AutomationMemoryTemplateView | null };
      setTemplate(payload.template ?? null);
      setMemoryNote('');
      await loadRuns(selectedJobId);
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemorySaving(false);
    }
  }, [loadRuns, memoryNote, selectedJobId, selectedRunSessionId]);

  const weekdayOptions = [
    { value: 0, label: t('automation.weekday.sun') },
    { value: 1, label: t('automation.weekday.mon') },
    { value: 2, label: t('automation.weekday.tue') },
    { value: 3, label: t('automation.weekday.wed') },
    { value: 4, label: t('automation.weekday.thu') },
    { value: 5, label: t('automation.weekday.fri') },
    { value: 6, label: t('automation.weekday.sat') },
  ];
  const frequencyOptions = [
    { value: 'interval' as const, label: t('automation.frequency.interval') },
    { value: 'hourly' as const, label: t('automation.frequency.hourly') },
    { value: 'daily' as const, label: t('automation.frequency.daily') },
    { value: 'weekly' as const, label: t('automation.frequency.weekly') },
  ];
  const reasoningOptions = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  const scheduleSummary =
    form.frequency === 'interval'
      ? `${t('automation.frequency.interval')} ${resolvedIntervalSeconds ?? '-'}s`
      : form.frequency === 'hourly'
      ? `${t('automation.frequency.hourly')} 00:${twoDigit(form.minute)}`
      : form.frequency === 'daily'
        ? `${t('automation.frequency.daily')} ${twoDigit(form.hour)}:${twoDigit(form.minute)}`
        : `${t('automation.frequency.weekly')} ${weekdayOptions.find((item) => item.value === form.weekday)?.label ?? ''} ${twoDigit(form.hour)}:${twoDigit(form.minute)}`;
  const intervalNextRunPreview =
    form.frequency === 'interval'
      ? resolvedIntervalSeconds === null
        ? '-'
        : formatWhen(new Date(Date.now() + resolvedIntervalSeconds * 1000).toISOString())
      : '';

  const renderChoiceButton = (
    selected: boolean,
    label: string,
    onClick: () => void,
    disabled = formReadOnly,
    className = '',
    key?: React.Key,
    testId?: string
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={selected}
      className={`rounded-lg border px-3 py-2 text-sm transition-colors ${className}`}
      style={{
        borderColor: selected ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
        backgroundColor: selected ? `${theme.colors.primary.DEFAULT}14` : theme.colors.bg.secondary,
        color: selected ? theme.colors.primary.DEFAULT : theme.colors.text.secondary,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      data-testid="automation-center"
      className="h-full overflow-y-auto p-4 md:p-6"
      style={{ backgroundColor: theme.colors.bg.primary, color: theme.colors.text.primary }}
    >
      <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section
          className="rounded-2xl border p-4"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('automation.title')}</h2>
            <button
              type="button"
              data-testid="automation-reset-form"
              onClick={resetForm}
              className="rounded-lg border px-3 py-1.5 text-xs"
              style={{
                borderColor: theme.colors.border.DEFAULT,
                backgroundColor: theme.colors.bg.tertiary,
                color: theme.colors.text.secondary,
              }}
            >
              {t('automation.new')}
            </button>
          </div>

          {loadingJobs && <div className="text-xs">{t('automation.list.loading')}</div>}
          {jobsError && (
            <div className="mb-2 text-xs" style={{ color: theme.colors.toolResult.error.text }}>
              {jobsError}
            </div>
          )}

          <div className="space-y-2">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                data-testid="automation-job-item"
                onClick={() => handleSelectJob(job)}
                className="w-full rounded-xl border p-3 text-left transition-colors"
                style={{
                  borderColor:
                    selectedJobId === job.id ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                  backgroundColor: selectedJobId === job.id ? `${theme.colors.primary.DEFAULT}12` : theme.colors.bg.tertiary,
                  color: theme.colors.text.primary,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{job.name}</span>
                  <span
                    className="rounded px-2 py-0.5 text-[11px]"
                    style={{
                      backgroundColor: job.enabled ? 'rgba(34,197,94,0.16)' : 'rgba(148,163,184,0.16)',
                      color: job.enabled ? '#22c55e' : theme.colors.text.muted,
                    }}
                  >
                    {job.enabled ? t('automation.enabled') : t('automation.disabled')}
                  </span>
                </div>
                <div className="mt-2 text-[11px]" style={{ color: theme.colors.text.muted }}>
                  {t('automation.nextRun')}: {formatWhen(job.nextRunAt)}
                </div>
                <div className="mt-1 text-[11px]" style={{ color: theme.colors.text.muted }}>
                  {t('automation.agent')}: {job.agentName || t('automation.agent.default')}
                </div>
              </button>
            ))}
            {!loadingJobs && jobs.length === 0 && (
              <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                {t('automation.list.empty')}
              </div>
            )}
          </div>
        </section>

        <section
          className="rounded-2xl border p-4"
          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">
                {form.id ? form.name || t('automation.detail.title') : t('automation.form.title')}
              </h3>
              {selectedJob?.readOnly && (
                <div className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('automation.system')}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedJob && (
                <button
                  type="button"
                  data-testid="automation-run-now"
                  onClick={() => void handleRunNow(selectedJob)}
                  disabled={runningJobId === selectedJob.id}
                  className="rounded-lg px-3 py-2 text-xs font-medium"
                  style={{
                    backgroundColor: 'rgba(59,130,246,0.18)',
                    color: theme.colors.text.secondary,
                    opacity: runningJobId === selectedJob.id ? 0.6 : 1,
                  }}
                >
                  {runningJobId === selectedJob.id ? t('automation.runningNow') : t('automation.runNow')}
                </button>
              )}
              {selectedJob && !selectedJob.readOnly && (
                <button
                  type="button"
                  data-testid="automation-toggle-enabled"
                  onClick={() => void handleToggle(selectedJob)}
                  className="rounded-lg px-3 py-2 text-xs font-medium"
                  style={{
                    backgroundColor: selectedJob.enabled ? 'rgba(148,163,184,0.18)' : 'rgba(34,197,94,0.18)',
                    color: selectedJob.enabled ? theme.colors.text.secondary : '#22c55e',
                  }}
                >
                  {selectedJob.enabled ? t('automation.pause') : t('automation.enable')}
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-3 text-sm md:grid-cols-2">
            <input
              data-testid="automation-name-input"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={t('automation.form.name')}
              disabled={formReadOnly}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
            />
            <input
              data-testid="automation-workspace-input"
              value={form.workspaceDir}
              onChange={(event) => setForm((prev) => ({ ...prev, workspaceDir: event.target.value }))}
              placeholder={t('automation.form.workspace')}
              disabled={formReadOnly}
              className="rounded-lg border px-3 py-2"
              style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
            />
            <textarea
              data-testid="automation-prompt-input"
              value={form.prompt}
              onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
              placeholder={t('automation.form.prompt')}
              rows={5}
              disabled={formReadOnly}
              className="rounded-lg border px-3 py-2 md:col-span-2"
              style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
            />

            <div className="md:col-span-2">
              <select
                data-testid="automation-agent-select"
                value={form.agentName}
                disabled={formReadOnly}
                onChange={(event) => setForm((prev) => ({ ...prev, agentName: event.target.value }))}
                className="w-full rounded-lg border px-3 py-2"
                style={fieldSurface(theme)}
              >
                <option value="">{t('automation.form.agent.default')}</option>
                {agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
                {usingDefaultAgent
                  ? t('automation.form.agent.defaultHint')
                  : t('automation.form.agent.externalHint')}
              </div>
            </div>

            <div className="relative rounded-lg border p-1" style={fieldSurface(theme)}>
              <select
                data-testid="automation-llm-profile-select"
                value={form.llmSelection.profileId}
                disabled={formReadOnly}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => updateFormLlmSelection({ profileId: event.target.value })}
                style={selectProxyStyle()}
              >
                {profileOptions.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
                {profileOptions.length === 0 && <option value={form.llmSelection.profileId}>{t('app.llm.profile')}</option>}
              </select>
              <div className="flex flex-wrap gap-1.5">
                {profileOptions.length > 0
                  ? profileOptions.map((profile) =>
                      renderChoiceButton(
                        form.llmSelection.profileId === profile.id,
                        profile.name,
                        () => updateFormLlmSelection({ profileId: profile.id }),
                        formReadOnly,
                        'min-w-[5.5rem] flex-1',
                        profile.id
                      )
                    )
                  : renderChoiceButton(true, t('app.llm.profile'), () => undefined, true, 'w-full')}
              </div>
            </div>
            <input
              data-testid="automation-llm-model-input"
              value={form.llmSelection.model}
              disabled={formReadOnly}
              onChange={(event) => updateFormLlmSelection({ model: event.target.value })}
              placeholder={t('app.llm.model')}
              className="rounded-lg border px-3 py-2"
              style={fieldSurface(theme)}
            />
            <div className="relative rounded-lg border p-1" style={fieldSurface(theme)}>
              <select
                data-testid="automation-llm-reasoning-select"
                value={form.llmSelection.reasoningPreset}
                disabled={formReadOnly}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) =>
                  updateFormLlmSelection({
                    reasoningPreset: event.target.value as SessionLlmSelectionView['reasoningPreset'],
                  })
                }
                style={selectProxyStyle()}
              >
                {reasoningOptions.map((preset) => (
                  <option key={preset} value={preset}>
                    {t(`app.llm.reasoningPreset.${preset}` as never)}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-4 gap-1.5">
                {reasoningOptions.map((preset) =>
                  renderChoiceButton(
                    form.llmSelection.reasoningPreset === preset,
                    t(`app.llm.reasoningPreset.${preset}` as never),
                    () => updateFormLlmSelection({ reasoningPreset: preset }),
                    formReadOnly,
                    'px-2 text-xs',
                    preset
                  )
                )}
              </div>
            </div>
            {currentProfile?.capabilities?.thinkingBudget && (
              <input
                data-testid="automation-llm-thinking-budget-input"
                value={form.llmSelection.providerOptions?.anthropic?.thinkingBudgetTokens ?? ''}
                disabled={formReadOnly || form.llmSelection.reasoningPreset === 'off'}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  updateFormLlmSelection({
                    providerOptions: {
                      anthropic: {
                        thinkingBudgetTokens: value ? Number.parseInt(value, 10) || null : null,
                      },
                    },
                  });
                }}
                placeholder={t('app.llm.thinkingBudget')}
                className="rounded-lg border px-3 py-2"
                style={fieldSurface(theme)}
              />
            )}

            <div className="relative rounded-xl border p-2 md:col-span-2" style={fieldSurface(theme)}>
              <select
                data-testid="automation-frequency-select"
                value={form.frequency}
                disabled={formReadOnly}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => setForm((prev) => ({ ...prev, frequency: event.target.value as Frequency }))}
                style={selectProxyStyle()}
              >
                {frequencyOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <select
                data-testid="automation-weekday-select"
                value={form.weekday}
                disabled={formReadOnly}
                aria-hidden="true"
                tabIndex={-1}
                onChange={(event) => setForm((prev) => ({ ...prev, weekday: Number.parseInt(event.target.value, 10) || 0 }))}
                style={selectProxyStyle()}
              >
                {weekdayOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {frequencyOptions.map((item) =>
                    renderChoiceButton(
                      form.frequency === item.value,
                      item.label,
                      () => setForm((prev) => ({ ...prev, frequency: item.value })),
                      formReadOnly,
                      'px-2',
                      item.value,
                      `automation-frequency-option-${item.value}`
                    )
                  )}
                </div>
                <div className="rounded-lg px-3 py-2 text-sm font-medium" style={{ color: theme.colors.text.secondary }}>
                  {scheduleSummary}
                </div>
              </div>
              {form.frequency === 'interval' && (
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <input
                    data-testid="automation-interval-seconds-input"
                    type="number"
                    min={MIN_INTERVAL_SECONDS}
                    max={MAX_INTERVAL_SECONDS}
                    value={form.intervalSecondsInput}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        intervalSecondsInput: event.target.value,
                      }))
                    }
                    placeholder={t('automation.form.intervalSeconds')}
                    disabled={formReadOnly}
                    className="rounded-lg border px-3 py-2"
                    style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                  />
                  <div className="rounded-lg px-3 py-2 text-xs" style={{ color: theme.colors.text.muted }}>
                    {t('automation.nextRun')}: {intervalNextRunPreview}
                    {resolvedIntervalSeconds === null && (
                      <div style={{ color: theme.colors.toolResult.error.text }}>
                        {t('automation.form.intervalInvalid')}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {form.frequency === 'weekly' && (
                <div className="mt-2 grid grid-cols-7 gap-1.5">
                  {weekdayOptions.map((item) =>
                    renderChoiceButton(
                      form.weekday === item.value,
                      item.label,
                      () => setForm((prev) => ({ ...prev, weekday: item.value })),
                      formReadOnly,
                      'px-2 text-xs',
                      String(item.value)
                    )
                  )}
                </div>
              )}
              {form.frequency !== 'interval' && (
                <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                {form.frequency !== 'hourly' && (
                  <input
                    data-testid="automation-hour-input"
                    type="number"
                    min={0}
                    max={23}
                    value={form.hour}
                    onChange={(event) => setForm((prev) => ({ ...prev, hour: Number.parseInt(event.target.value, 10) || 0 }))}
                    placeholder={t('automation.form.hour')}
                    disabled={formReadOnly}
                    className="rounded-lg border px-3 py-2"
                    style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                  />
                )}
                <input
                  data-testid="automation-minute-input"
                  type="number"
                  min={0}
                  max={59}
                  value={form.minute}
                  onChange={(event) => setForm((prev) => ({ ...prev, minute: Number.parseInt(event.target.value, 10) || 0 }))}
                  placeholder={t('automation.form.minute')}
                  disabled={formReadOnly}
                  className="rounded-lg border px-3 py-2"
                  style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                />
                </div>
              )}
            </div>
            <input
              data-testid="automation-timezone-input"
              value={form.timezone}
              onChange={(event) => setForm((prev) => ({ ...prev, timezone: event.target.value }))}
              placeholder={t('automation.form.timezone')}
              disabled={formReadOnly}
              className="rounded-lg border px-3 py-2"
              style={fieldSurface(theme)}
            />
          </div>

          <div className="mt-3 max-h-28 space-y-1 overflow-y-auto rounded-lg border p-2" style={{ borderColor: theme.colors.border.DEFAULT }}>
            <div className="text-xs font-medium" style={{ color: theme.colors.text.secondary }}>
              {usingDefaultAgent ? t('automation.form.skills') : t('automation.form.skills.externalDisabled')}
            </div>
            {!usingDefaultAgent && (
              <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                {t('automation.form.skills.externalHint')}
              </div>
            )}
            {usingDefaultAgent && skills.length === 0 && (
              <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                {t('automation.form.noSkills')}
              </div>
            )}
            {usingDefaultAgent && skills.map((skill) => (
              <label key={skill.name} className="flex items-center gap-2 text-xs">
                <input
                  data-testid="automation-skill-checkbox"
                  type="checkbox"
                  checked={form.skills.includes(skill.name)}
                  disabled={formReadOnly}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      skills: event.target.checked
                        ? [...prev.skills, skill.name]
                        : prev.skills.filter((item) => item !== skill.name),
                    }))
                  }
                />
                <span>{skill.name}</span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="automation-create-submit"
              onClick={() => void handleSubmit()}
              disabled={submitting || formReadOnly}
              className="rounded-lg px-4 py-2 text-sm font-medium"
              style={{
                background: theme.colors.primary.gradient,
                color: theme.colors.text.inverse,
                opacity: submitting || formReadOnly ? 0.65 : 1,
              }}
            >
              {submitting ? t('automation.form.saving') : form.id ? t('automation.form.update') : t('automation.form.create')}
            </button>
            {selectedJob && (
              <button
                type="button"
                data-testid="automation-load-runs"
                onClick={() => void loadRuns(selectedJob.id)}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{
                  borderColor: theme.colors.border.DEFAULT,
                  backgroundColor: theme.colors.bg.tertiary,
                  color: theme.colors.text.secondary,
                }}
              >
                {t('automation.viewRuns')}
              </button>
            )}
            {selectedJob && !selectedJob.readOnly && (
              <button
                type="button"
                data-testid="automation-delete"
                onClick={() => void handleDelete(selectedJob)}
                disabled={deletingJobId === selectedJob.id}
                className="rounded-lg border px-4 py-2 text-sm"
                style={{
                  borderColor: theme.colors.toolResult.error.border,
                  backgroundColor: theme.colors.toolResult.error.bg,
                  color: theme.colors.toolResult.error.text,
                  opacity: deletingJobId === selectedJob.id ? 0.65 : 1,
                }}
              >
                {deletingJobId === selectedJob.id ? t('automation.delete.deleting') : t('automation.delete')}
              </button>
            )}
          </div>

          {selectedJob && (
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">{t('automation.runs.title', { name: selectedJob.name })}</h4>
                <span className="text-xs" style={{ color: theme.colors.text.muted }}>
                  {t('automation.lastRun')}: {formatWhen(selectedJob.lastRunAt)}
                </span>
              </div>
              {runsLoading && <div className="text-xs">{t('automation.runs.loading')}</div>}
              {runsError && (
                <div className="text-xs" style={{ color: theme.colors.toolResult.error.text }}>
                  {runsError}
                </div>
              )}
              <div className="space-y-2">
                {runs.map((run) => (
                  <div
                    key={run.id}
                    className="rounded-xl border p-3 text-xs"
                    style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{run.status}{run.triggerSource ? ` / ${run.triggerSource}` : ''}</span>
                      <span>{formatWhen(run.triggerAt)}</span>
                    </div>
                    <div className="mt-2 break-all" style={{ color: theme.colors.text.muted }}>
                      {summarizeRun(run)}
                    </div>
                    <div className="mt-1" style={{ color: theme.colors.text.muted }}>
                      {t('automation.agent')}: {run.effectiveAgentName || run.agentName || t('automation.agent.default')}
                      {run.agentFallbackReason ? ` (${run.agentFallbackReason})` : ''}
                    </div>
                    {(run.sessionId || run.reportPath) && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {run.sessionId && (
                          <>
                            <button
                              type="button"
                              data-testid="automation-open-session"
                              onClick={() => onOpenSession(run.sessionId)}
                              className="rounded border px-2 py-1"
                              style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                            >
                              {t('automation.openSession')}
                            </button>
                            {!selectedJob.readOnly && (
                              <button
                                type="button"
                                data-testid="automation-select-run-memory"
                                onClick={() => setSelectedRunSessionId(run.sessionId)}
                                className="rounded border px-2 py-1"
                                style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                              >
                                {t('automation.useForMemory')}
                              </button>
                            )}
                          </>
                        )}
                        {run.reportPath && (
                          <button
                            type="button"
                            data-testid="automation-view-report"
                            onClick={() => void loadReport(run.jobId, run.id)}
                            className="rounded border px-2 py-1"
                            style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.secondary }}
                          >
                            {t('automation.viewReport')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!runsLoading && runs.length === 0 && (
                  <div className="text-xs" style={{ color: theme.colors.text.muted }}>
                    {t('automation.runs.empty')}
                  </div>
                )}
              </div>

              {selectedJob.readOnly ? (
                <div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                  <button
                    type="button"
                    onClick={() => setReportOpen((prev) => !prev)}
                    className="text-sm font-semibold"
                    style={{ color: theme.colors.text.primary }}
                  >
                    {t('automation.report.title')}
                  </button>
                  {reportOpen && (
                    <div className="mt-3">
                      <div className="mb-2 text-xs" style={{ color: theme.colors.text.muted }}>
                        {reportLoading ? t('automation.report.loading') : reportError || (selectedReportRunId ? t('automation.report.loaded') : t('automation.report.empty'))}
                      </div>
                      <textarea
                        value={selectedReport ? JSON.stringify(selectedReport, null, 2) : ''}
                        readOnly
                        rows={10}
                        className="w-full rounded-lg border px-3 py-2 text-xs"
                        style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border.DEFAULT }}>
                  <button
                    type="button"
                    onClick={() => setMemoryOpen((prev) => !prev)}
                    className="text-sm font-semibold"
                    style={{ color: theme.colors.text.primary }}
                  >
                    {t('automation.memory.title')}
                  </button>
                  {memoryOpen && (
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <textarea
                        value={template?.template ?? ''}
                        readOnly
                        rows={8}
                        className="w-full rounded-lg border px-3 py-2 text-xs"
                        style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
                      />
                      <div>
                        <input
                          value={selectedRunSessionId}
                          onChange={(event) => setSelectedRunSessionId(event.target.value)}
                          placeholder={t('automation.memory.sessionId')}
                          className="mb-2 w-full rounded-lg border px-3 py-2 text-xs"
                          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
                        />
                        <textarea
                          value={memoryNote}
                          onChange={(event) => setMemoryNote(event.target.value)}
                          placeholder={t('automation.memory.note')}
                          rows={4}
                          className="w-full rounded-lg border px-3 py-2 text-xs"
                          style={{ borderColor: theme.colors.border.DEFAULT, backgroundColor: theme.colors.bg.tertiary }}
                        />
                        <button
                          type="button"
                          data-testid="automation-memory-save"
                          onClick={() => void handleSaveMemory()}
                          disabled={memorySaving || !selectedRunSessionId.trim()}
                          className="mt-2 rounded-lg px-3 py-2 text-xs font-medium"
                          style={{
                            background: theme.colors.primary.gradient,
                            color: theme.colors.text.inverse,
                            opacity: memorySaving || !selectedRunSessionId.trim() ? 0.6 : 1,
                          }}
                        >
                          {memorySaving ? t('automation.memory.saving') : t('automation.memory.save')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default AutomationCenter;
