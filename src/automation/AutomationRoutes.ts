import type { Express, Request, Response } from 'express';
import { computeNextRunAt, normalizeAutomationSchedule, normalizeAutomationTimezone } from './schedule.js';
import { applySessionLlmSelectionInput, findResolvedLlmProfile } from '../llm/provider-profiles.js';
import type { AgentConfig, AutomationJob, SessionLlmSelectionInput } from '../types.js';
import type { AutomationStore } from './AutomationStore.js';
import type { AutomationExecutionService } from './AutomationExecutionService.js';

interface AutomationRoutesDeps {
  store: AutomationStore;
  executionService: AutomationExecutionService;
  getDefaultWorkspaceDir: () => string;
  getConfig: () => AgentConfig;
}

interface AutomationScheduleRouteInput {
  frequency?: string;
  intervalSeconds?: number;
  minute?: number;
  hour?: number;
  weekday?: number;
}

interface AutomationJobRouteInput {
  name?: string;
  prompt?: string;
  workspaceDir?: string;
  skills?: string[];
  agentName?: string | null;
  schedule?: AutomationScheduleRouteInput;
  timezone?: string;
  enabled?: boolean;
  llmSelection?: SessionLlmSelectionInput;
}

export class AutomationRoutes {
  private readonly store: AutomationStore;
  private readonly executionService: AutomationExecutionService;
  private readonly getDefaultWorkspaceDir: () => string;
  private readonly getConfig: () => AgentConfig;

  constructor(deps: AutomationRoutesDeps) {
    this.store = deps.store;
    this.executionService = deps.executionService;
    this.getDefaultWorkspaceDir = deps.getDefaultWorkspaceDir;
    this.getConfig = deps.getConfig;
  }

  register(app: Express): void {
    app.get('/api/automations', (_req: Request, res: Response) => {
      try {
        const items = this.store.listJobs().filter((item) => !item.systemTask);
        res.json({ items });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    app.post('/api/automations', (req: Request, res: Response) => {
      try {
        const body = req.body as AutomationJobRouteInput;
        const llmSelection = this.resolveAutomationLlmSelection(body.llmSelection);
        const timezone = normalizeAutomationTimezone(body.timezone);
        const schedule = this.resolveAutomationSchedule(body.schedule);
        const item = this.store.createJob({
          name: String(body.name ?? '').trim(),
          prompt: String(body.prompt ?? '').trim(),
          workspaceDir: String(body.workspaceDir ?? '').trim() || this.getDefaultWorkspaceDir(),
          skills: this.resolveAutomationSkills(body.skills),
          agentName: this.normalizeAutomationAgentName(body.agentName),
          llmSelection,
          schedule,
          timezone,
          enabled: body.enabled !== false,
          jobSource: 'user',
          readOnly: false,
        });
        res.json({ item });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    app.put('/api/automations/:id', (req: Request, res: Response) => {
      try {
        const id = String(req.params.id ?? '').trim();
        const existing = this.getMutableAutomationJobOrRespond(id, res);
        if (!existing) {
          return;
        }
        const body = req.body as AutomationJobRouteInput;
        const patch: {
          name?: string;
          prompt?: string;
          workspaceDir?: string;
          skills?: string[];
          agentName?: string;
          llmSelection?: AutomationJob['llmSelection'];
          schedule?: AutomationJob['schedule'];
          timezone?: string;
          enabled?: boolean;
        } = {};
        if (body.name !== undefined) {
          patch.name = String(body.name ?? '').trim();
        }
        if (body.prompt !== undefined) {
          patch.prompt = String(body.prompt ?? '').trim();
        }
        if (body.workspaceDir !== undefined) {
          patch.workspaceDir = String(body.workspaceDir ?? '').trim();
        }
        if (body.skills !== undefined) {
          patch.skills = this.resolveAutomationSkills(body.skills);
        }
        if (body.agentName !== undefined) {
          patch.agentName = this.normalizeAutomationAgentName(body.agentName);
        }
        if (body.llmSelection !== undefined) {
          patch.llmSelection = this.resolveAutomationLlmSelection(body.llmSelection, existing.llmSelection);
        }
        if (body.schedule !== undefined) {
          patch.schedule = this.resolveAutomationSchedule(body.schedule);
        }
        if (body.timezone !== undefined) {
          patch.timezone = normalizeAutomationTimezone(body.timezone);
        }
        if (body.enabled !== undefined) {
          patch.enabled = body.enabled === true;
        }
        const item = this.store.updateJob(id, patch);
        res.json({ item });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    app.delete('/api/automations/:id', (req: Request, res: Response) => {
      try {
        const id = String(req.params.id ?? '').trim();
        const existing = this.getMutableAutomationJobOrRespond(id, res);
        if (!existing) {
          return;
        }
        const success = this.store.deleteJob(id);
        res.json({ success });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    app.post('/api/automations/:id/toggle', (req: Request, res: Response) => {
      try {
        const id = String(req.params.id ?? '').trim();
        const body = req.body as { enabled?: boolean };
        const enabled = body.enabled === true;
        const job = this.getMutableAutomationJobOrRespond(id, res);
        if (!job) {
          return;
        }
        const item = this.store.updateJob(id, {
          enabled,
          nextRunAt: enabled ? computeNextRunAt(job.schedule, job.timezone, new Date()) : undefined,
        });
        res.json({ item });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    app.get('/api/automations/:id/runs', (req: Request, res: Response) => {
      try {
        const id = String(req.params.id ?? '').trim();
        const items = this.store.listRuns(id);
        const template = this.store.getMemoryTemplate(id) ?? null;
        res.json({ items, template });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    app.post('/api/automations/:id/run', async (req: Request, res: Response) => {
      try {
        const id = String(req.params.id ?? '').trim();
        const job = this.store.getJob(id);
        if (!job) {
          this.sendAutomationNotFound(res, id);
          return;
        }
        if (job.systemTask) {
          this.sendAutomationNotFound(res, id);
          return;
        }
        const run = await this.executionService.executeJob(job, new Date().toISOString(), {
          triggerSource: 'manual',
        });
        res.json({ run });
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });

    app.get('/api/automations/:id/runs/:runId/report', (req: Request, res: Response) => {
      try {
        const jobId = String(req.params.id ?? '').trim();
        const runId = String(req.params.runId ?? '').trim();
        const report = this.store.getRunReport(jobId, runId);
        if (!report) {
          res.status(404).json({ error: `report not found: ${jobId}/${runId}` });
          return;
        }
        res.json({ report });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    app.post('/api/automations/:id/memory/from-session', async (req: Request, res: Response) => {
      try {
        const jobId = String(req.params.id ?? '').trim();
        const body = req.body as { sessionId?: string; note?: string };
        const sessionId = String(body.sessionId ?? '').trim();
        if (!sessionId) {
          res.status(400).json({ error: 'sessionId is required' });
          return;
        }
        const job = this.store.getJob(jobId);
        if (!job) {
          this.sendAutomationNotFound(res, jobId);
          return;
        }
        const result = await this.executionService.saveManualCorrectionFromSession({
          job,
          sessionId,
          note: String(body.note ?? '').trim(),
        });
        res.json(result);
      } catch (error) {
        res.status(400).json({ error: String(error) });
      }
    });
  }

  private getMutableAutomationJobOrRespond(id: string, res: Response): AutomationJob | undefined {
    const job = this.store.getJob(id);
    if (!job) {
      this.sendAutomationNotFound(res, id);
      return undefined;
    }
    if (job.readOnly) {
      res.status(403).json({ error: 'system automation is read-only' });
      return undefined;
    }
    return job;
  }

  private sendAutomationNotFound(res: Response, id: string): void {
    res.status(404).json({ error: `automation not found: ${id}` });
  }

  private resolveAutomationSchedule(input?: AutomationScheduleRouteInput): AutomationJob['schedule'] {
    return normalizeAutomationSchedule({
      frequency: input?.frequency as AutomationJob['schedule']['frequency'],
      intervalSeconds: input?.intervalSeconds,
      minute: input?.minute,
      hour: input?.hour,
      weekday: input?.weekday,
    });
  }

  private resolveAutomationLlmSelection(
    input?: SessionLlmSelectionInput,
    current?: AutomationJob['llmSelection']
  ): AutomationJob['llmSelection'] {
    if (
      input?.reasoningPreset !== undefined &&
      input.reasoningPreset !== 'off' &&
      input.reasoningPreset !== 'low' &&
      input.reasoningPreset !== 'medium' &&
      input.reasoningPreset !== 'high'
    ) {
      throw new Error('Invalid llmSelection.reasoningPreset.');
    }
    const profileId = typeof input?.profileId === 'string' ? input.profileId.trim() : '';
    if (profileId && !findResolvedLlmProfile(this.getConfig(), profileId)) {
      throw new Error(`Unknown llmSelection.profileId: ${profileId}`);
    }
    return applySessionLlmSelectionInput(this.getConfig(), current, input ?? {});
  }

  private normalizeAutomationAgentName(value: unknown): string | undefined {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private resolveAutomationSkills(skills: unknown): string[] {
    return Array.isArray(skills) ? skills.map((item) => String(item ?? '')) : [];
  }
}

