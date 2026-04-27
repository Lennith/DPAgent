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
        const items = this.store.listJobs();
        res.json({ items });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    app.post('/api/automations', (req: Request, res: Response) => {
      try {
        const body = req.body as {
          name?: string;
          prompt?: string;
          workspaceDir?: string;
          skills?: string[];
          schedule?: {
            frequency?: string;
            minute?: number;
            hour?: number;
            weekday?: number;
          };
          timezone?: string;
          enabled?: boolean;
          llmSelection?: SessionLlmSelectionInput;
        };
        const llmSelection = this.resolveAutomationLlmSelection(body.llmSelection);
        const timezone = normalizeAutomationTimezone(body.timezone);
        const schedule = normalizeAutomationSchedule({
          frequency: body.schedule?.frequency as 'hourly' | 'daily' | 'weekly',
          minute: body.schedule?.minute,
          hour: body.schedule?.hour,
          weekday: body.schedule?.weekday,
        });
        const item = this.store.createJob({
          name: String(body.name ?? '').trim(),
          prompt: String(body.prompt ?? '').trim(),
          workspaceDir: String(body.workspaceDir ?? '').trim() || this.getDefaultWorkspaceDir(),
          skills: Array.isArray(body.skills) ? body.skills : [],
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
        const existing = this.store.getJob(id);
        if (!existing) {
          res.status(404).json({ error: `automation not found: ${id}` });
          return;
        }
        if (existing.readOnly) {
          res.status(403).json({ error: 'system automation is read-only' });
          return;
        }
        const body = req.body as {
          name?: string;
          prompt?: string;
          workspaceDir?: string;
          skills?: string[];
          schedule?: {
            frequency?: string;
            minute?: number;
            hour?: number;
            weekday?: number;
          };
          timezone?: string;
          enabled?: boolean;
          llmSelection?: SessionLlmSelectionInput;
        };
        const patch: {
          name?: string;
          prompt?: string;
          workspaceDir?: string;
          skills?: string[];
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
          patch.skills = Array.isArray(body.skills) ? body.skills : [];
        }
        if (body.llmSelection !== undefined) {
          patch.llmSelection = this.resolveAutomationLlmSelection(body.llmSelection, existing.llmSelection);
        }
        if (body.schedule !== undefined) {
          patch.schedule = normalizeAutomationSchedule({
            frequency: body.schedule?.frequency as 'hourly' | 'daily' | 'weekly',
            minute: body.schedule?.minute,
            hour: body.schedule?.hour,
            weekday: body.schedule?.weekday,
          });
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
        const existing = this.store.getJob(id);
        if (!existing) {
          res.status(404).json({ error: `automation not found: ${id}` });
          return;
        }
        if (existing.readOnly) {
          res.status(403).json({ error: 'system automation is read-only' });
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
        const job = this.store.getJob(id);
        if (!job) {
          res.status(404).json({ error: `automation not found: ${id}` });
          return;
        }
        if (job.readOnly) {
          res.status(403).json({ error: 'system automation is read-only' });
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
          res.status(404).json({ error: `automation not found: ${id}` });
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
          res.status(404).json({ error: `automation not found: ${jobId}` });
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
}

