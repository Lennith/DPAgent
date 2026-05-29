import type { Request, Response } from 'express';
import {
  listUnexpectedTodoKeys,
  normalizeTodoPriority,
  normalizeTodoScope,
  normalizeTodoStatus,
  normalizeTodoTags,
} from './web-server-todo-route-utils.js';
import type { WebServerRouteRegistrationDependencies } from './web-server-route-contracts.js';
import { rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';
import {
  normalizeGovernanceRouteSessionId,
  resolveGovernanceRouteContext,
  resolveGovernanceRouteSession,
  resolveGovernanceRouteWorkspace,
} from './web-server-governance-context.js';

export function registerGovernanceRoutes(deps: WebServerRouteRegistrationDependencies): void {
  const { todoServices } = deps;

  deps.app.get('/api/memory', (req: Request, res: Response) => {
    const { workspaceDir } = resolveGovernanceRouteContext(deps, req.query.sessionId);
    const items = deps.agent.getMemoryStore().listEntries({
      workspaceDir,
      includeUser: true,
    });
    res.json({ items, workspaceDir });
  });

  const handleMemoryState = (req: Request, res: Response) => {
    const sessionId = normalizeGovernanceRouteSessionId(req.query.sessionId);
    res.json({
      items: [],
      state: sessionId ? deps.agent.getMemoryPromotionState(sessionId) : null,
    });
  };

  deps.app.get('/api/memory/state', handleMemoryState);
  deps.app.get('/api/memory/pending', handleMemoryState);

  deps.app.post('/api/memory/organize', async (req: Request, res: Response) => {
    try {
      const resolved = resolveGovernanceRouteSession(
        (req.body as { sessionId?: string }).sessionId ?? req.query.sessionId
      );
      const { context, sessionId } = resolved;
      if (!sessionId || !context) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }
      if (rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      const meta = deps.agent.getContextNamespaceMeta(context);
      if (!meta) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const record = await deps.agent.organizeSessionMemory({
        sessionId,
        workspaceDir: resolveGovernanceRouteWorkspace(deps, resolved),
      });
      res.json({
        success: true,
        ...record,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.get('/api/audit', (req: Request, res: Response) => {
    const { sessionId, workspaceDir } = resolveGovernanceRouteContext(deps, req.query.sessionId);
    const limit = Number.parseInt(String(req.query.limit ?? '40'), 10);
    const items = deps.agent.listGovernanceAudit({
      sessionId: sessionId || undefined,
      workspaceDir,
      limit: Number.isFinite(limit) ? limit : 40,
    });
    res.json({ items, workspaceDir });
  });

  deps.app.get('/api/todos', (req: Request, res: Response) => {
    const { sessionId, workspaceDir: resolvedWorkspaceDir } = resolveGovernanceRouteContext(
      deps,
      req.query.sessionId
    );
    const scope = normalizeTodoScope(
      req.query.scope,
      sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
    );
    const items = deps.agent.getTodoStore().listTodos({
      scope,
      sessionId: sessionId || undefined,
      workspaceDir: resolvedWorkspaceDir,
      includeCompleted: req.query.include_completed === 'true',
    });
    res.json({ items, workspaceDir: resolvedWorkspaceDir });
  });

  deps.app.post('/api/todos', (req: Request, res: Response) => {
    try {
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const action = String(rawBody.action ?? '').trim().toLowerCase();
      if (
        action !== 'add' &&
        action !== 'plan_set' &&
        action !== 'list' &&
        action !== 'clear_completed' &&
        action !== 'dismiss_unfinished'
      ) {
        res.status(400).json({
          error: 'Todo requests require action=add, action=plan_set, action=list, action=clear_completed, or action=dismiss_unfinished.',
        });
        return;
      }
      const resolved = resolveGovernanceRouteSession(rawBody.sessionId);
      const { context, sessionId } = resolved;
      if (context && rejectObserveOnlyIfNeeded(deps, context, res)) {
        return;
      }
      const resolvedWorkspaceDir = resolveGovernanceRouteWorkspace(deps, resolved);
      const scope = normalizeTodoScope(
        rawBody.scope,
        sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
      );
      const workspaceDir = resolvedWorkspaceDir;
      if (action === 'list') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope', 'include_completed'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo list does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const protocol = deps.agent.getTodoStore().getProtocolState({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        res.json({ success: true, action, scope, protocol, workspaceDir });
        return;
      }
      if (action === 'clear_completed') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo clear_completed does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const removed = deps.agent.getTodoStore().clearCompletedTodos({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        res.json({ success: true, action, removed });
        return;
      }
      if (action === 'dismiss_unfinished') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo dismiss_unfinished does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        if (!sessionId || scope !== 'session') {
          res.status(400).json({ error: 'Todo dismiss_unfinished requires a session scope and sessionId.' });
          return;
        }
        const dismissed = deps.agent.getTodoStore().dismissUnfinishedTodos({
          scope,
          sessionId,
          workspaceDir,
        });
        todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
        const protocol = deps.agent.getTodoStore().getProtocolState({
          scope,
          sessionId,
          workspaceDir,
        });
        res.json({
          success: true,
          action,
          dismissed: dismissed.length,
          items: dismissed,
          protocol,
        });
        return;
      }
      if (action === 'plan_set') {
        const unexpectedKeys = listUnexpectedTodoKeys(
          rawBody,
          new Set(['action', 'sessionId', 'scope', 'items'])
        );
        if (unexpectedKeys.length > 0) {
          res.status(400).json({
            error: `Todo plan_set does not accept: ${unexpectedKeys.join(', ')}.`,
          });
          return;
        }
        const rawItems = rawBody.items;
        if (!Array.isArray(rawItems)) {
          res.status(400).json({ error: 'Todo plan_set requires items[].' });
          return;
        }
        const normalizedItems = [];
        for (const [index, entry] of rawItems.entries()) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            res.status(400).json({ error: `Todo plan_set items[${index}] must be objects.` });
            return;
          }
          const item = entry as Record<string, unknown>;
          const unexpectedItemKeys = listUnexpectedTodoKeys(
            item,
            new Set(['work', 'detection_standard', 'priority', 'status', 'blocked_reason', 'tags'])
          );
          if (unexpectedItemKeys.length > 0) {
            res.status(400).json({
              error: `Todo plan_set items[${index}] do not accept: ${unexpectedItemKeys.join(', ')}.`,
            });
            return;
          }
          const normalizedStatus = normalizeTodoStatus(item.status);
          if (item.status !== undefined && normalizedStatus === undefined) {
            res.status(400).json({
              error: `Todo plan_set items[${index}] status must be pending, in_progress, or blocked.`,
            });
            return;
          }
          normalizedItems.push({
            work: String(item.work ?? '').trim(),
            detectionStandard: String(item.detection_standard ?? '').trim(),
            priority: normalizeTodoPriority(item.priority),
            status: normalizedStatus,
            blockedReason: String(item.blocked_reason ?? '').trim() || undefined,
            tags: normalizeTodoTags(item.tags),
          });
        }
        const items = deps.agent.getTodoStore().setTodoPlan({
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
          items: normalizedItems,
          sourceSessionId: sessionId || undefined,
        });
        if (scope === 'session' && sessionId) {
          todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
        }
        res.json({ success: true, items });
        return;
      }
      const unexpectedKeys = listUnexpectedTodoKeys(
        rawBody,
        new Set([
          'action',
          'sessionId',
          'scope',
          'work',
          'detection_standard',
          'priority',
          'tags',
        ])
      );
      if (unexpectedKeys.length > 0) {
        res.status(400).json({
          error: `Todo add does not accept: ${unexpectedKeys.join(', ')}.`,
        });
        return;
      }
      const item = deps.agent.getTodoStore().createTodo({
        scope,
        sessionId: sessionId || undefined,
        workspaceDir,
        work: String(rawBody.work ?? '').trim(),
        detectionStandard: String(rawBody.detection_standard ?? '').trim(),
        priority: normalizeTodoPriority(rawBody.priority),
        tags: normalizeTodoTags(rawBody.tags),
        sourceSessionId: sessionId || undefined,
      });
      if (scope === 'session' && sessionId) {
        todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
      }
      res.json({ success: true, item });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.post('/api/todos/:id', (req: Request, res: Response) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const resolved = resolveGovernanceRouteSession(rawBody.sessionId);
    const { context, sessionId } = resolved;
    if (context && rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    const resolvedWorkspaceDir = resolveGovernanceRouteWorkspace(deps, resolved);
    try {
      const action = String(rawBody.action ?? '').trim().toLowerCase();
      const scope = normalizeTodoScope(
        rawBody.scope,
        sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
      );
      const workspaceDir = resolvedWorkspaceDir;
      if (action !== 'update' && action !== 'set_status' && action !== 'delete' && action !== 'dismiss' && action !== 'resume') {
        res.status(400).json({
          error: 'Todo update requires action=update, action=set_status, action=delete, action=dismiss, or action=resume.',
        });
        return;
      }
      const unexpectedKeys = listUnexpectedTodoKeys(
        rawBody,
        action === 'update'
          ? new Set([
              'action',
              'sessionId',
              'scope',
              'work',
              'detection_standard',
              'priority',
              'tags',
            ])
          : action === 'set_status'
            ? new Set([
                'action',
                'sessionId',
                'scope',
                'status',
                'evidence',
                'blocked_reason',
              ])
            : action === 'dismiss' || action === 'resume'
              ? new Set(['action', 'sessionId', 'scope'])
            : new Set(['action', 'sessionId', 'scope'])
      );
      if (unexpectedKeys.length > 0) {
        res.status(400).json({
          error:
            action === 'update'
              ? `Todo update does not accept: ${unexpectedKeys.join(', ')}.`
              : action === 'set_status'
                ? `Todo set_status does not accept: ${unexpectedKeys.join(', ')}.`
                : action === 'dismiss'
                  ? `Todo dismiss does not accept: ${unexpectedKeys.join(', ')}.`
                  : action === 'resume'
                    ? `Todo resume does not accept: ${unexpectedKeys.join(', ')}.`
                    : `Todo delete does not accept: ${unexpectedKeys.join(', ')}.`,
        });
        return;
      }
      if (action === 'delete') {
        const success = deps.agent.getTodoStore().deleteTodo(req.params.id, {
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        if (!success) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        res.json({ success: true });
        return;
      }
      if (action === 'dismiss') {
        const item = deps.agent.getTodoStore().dismissTodo(req.params.id, {
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        if (!item) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        if (scope === 'session' && sessionId) {
          todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
        }
        res.json({ success: true, item });
        return;
      }
      if (action === 'resume') {
        const item = deps.agent.getTodoStore().resumeTodo(req.params.id, {
          scope,
          sessionId: sessionId || undefined,
          workspaceDir,
        });
        if (!item) {
          res.status(404).json({ error: 'Todo not found' });
          return;
        }
        if (scope === 'session' && sessionId) {
          todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
        }
        res.json({ success: true, item });
        return;
      }
      if (action === 'set_status' && rawBody.status === undefined) {
        res.status(400).json({
          error: 'Todo status updates must include an explicit status.',
        });
        return;
      }
      const normalizedStatus = normalizeTodoStatus(rawBody.status);
      if (action === 'set_status' && normalizedStatus === undefined) {
        res.status(400).json({
          error: 'Todo status updates must use a valid status.',
        });
        return;
      }
      const item = deps.agent.getTodoStore().updateTodo(req.params.id, {
        scope,
        sessionId: sessionId || undefined,
        workspaceDir,
        work: action === 'update' ? String(rawBody.work ?? '').trim() || undefined : undefined,
        detectionStandard:
          action === 'update'
            ? String(rawBody.detection_standard ?? '').trim() || undefined
            : undefined,
        priority: action === 'update' ? normalizeTodoPriority(rawBody.priority) : undefined,
        tags: action === 'update' ? normalizeTodoTags(rawBody.tags) : undefined,
        status: action === 'set_status' ? normalizedStatus : undefined,
        completionTaskId:
          action === 'set_status'
            ? String(req.params.id ?? '').trim() || undefined
            : undefined,
        evidence: action === 'set_status' && Array.isArray(rawBody.evidence) ? rawBody.evidence : undefined,
        blockedReason:
          action === 'set_status'
            ? String(rawBody.blocked_reason ?? '').trim() || undefined
            : undefined,
      });
      if (!item) {
        res.status(404).json({ error: 'Todo not found' });
        return;
      }
      if (scope === 'session' && sessionId) {
        todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
      }
      res.json({ success: true, item });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  deps.app.delete('/api/todos/:id', (req: Request, res: Response) => {
    const resolved = resolveGovernanceRouteSession(req.query.sessionId);
    const { context, sessionId } = resolved;
    if (context && rejectObserveOnlyIfNeeded(deps, context, res)) {
      return;
    }
    const resolvedWorkspaceDir = resolveGovernanceRouteWorkspace(deps, resolved);
    const scope = normalizeTodoScope(
      req.query.scope,
      sessionId ? 'session' : resolvedWorkspaceDir ? 'workspace' : 'user'
    );
    const success = deps.agent.getTodoStore().deleteTodo(req.params.id, {
      scope,
      sessionId: sessionId || undefined,
      workspaceDir: resolvedWorkspaceDir,
    });
    if (!success) {
      res.status(404).json({ error: 'Todo not found' });
      return;
    }
    res.json({ success: true });
  });

}
