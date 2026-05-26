import type { Request, Response } from 'express';
import { autoLoopManager, type AutoLoopConfig } from '../../auto-loop/index.js';
import type { TodoProtocolState } from '../../todo/index.js';
import type { ContextNamespaceMeta, ContextRef, SessionInteractionState } from '../../types.js';
import { toSessionContext, type ActiveRunRouteView } from './web-server-route-contracts.js';
import { rejectObserveOnlyIfNeeded } from './web-server-route-guards.js';

type AutoLoopRouteDependencies = {
  app: {
    get: (path: string, handler: (req: Request, res: Response) => void) => void;
    post: (path: string, handler: (req: Request, res: Response) => void) => void;
  };
  agent: {
    getContextNamespaceMeta: (context: ContextRef) => ContextNamespaceMeta | undefined;
  };
  contextServices: {
    getContextNamespaceMetaSafe: (context: ContextRef) => ContextNamespaceMeta | undefined;
    getActiveRunState: (context: ContextRef) => ActiveRunRouteView | null;
    getInteractionStateForContext: (context: ContextRef) => SessionInteractionState;
    updateContextNamespaceMetaSafe: (
      context: ContextRef,
      patch: Partial<ContextNamespaceMeta>
    ) => void;
    resolveWorkspaceDirForContext: (context: ContextRef) => string;
  };
  todoServices: {
    ensureTodoDrivenAutoLoop: (sessionId: string, workspaceDir?: string) => void;
    getSessionTodoProtocolState: (sessionId: string, workspaceDir?: string) => TodoProtocolState;
  };
};

function resolveAutoLoopView(config: AutoLoopConfig, todoState: TodoProtocolState): {
  config: AutoLoopConfig;
  todoDriven: boolean;
} {
  const todoDriven = todoState.hasUnfinished || config.pendingPlanConfirmation === true;
  const ralphEnabled = config.ralphEnabled ?? (config.mode === 'todo' ? false : config.enabled);
  return {
    todoDriven,
    config: {
      ...config,
      mode: todoDriven ? 'todo' : 'ralph',
      ralphEnabled,
      enabled: todoDriven
        ? todoState.hasUnfinished && config.pausedByUser !== true && config.pendingPlanConfirmation !== true
        : ralphEnabled,
    },
  };
}

export function registerAutoLoopRoutes(deps: AutoLoopRouteDependencies): void {
  const { contextServices, todoServices } = deps;

  deps.app.get('/api/sessions/:id/autoloop', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const ref = toSessionContext(sessionId);
    const meta = contextServices.getContextNamespaceMetaSafe(ref);
    const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
    const workspaceDir = contextServices.resolveWorkspaceDirForContext(ref);
    const todoState = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const config = controller.getConfig();
    const view = resolveAutoLoopView(config, todoState);
    res.json({
      success: true,
      config: view.config,
      state: controller.getState(),
      todoDriven: view.todoDriven,
    });
  });

  deps.app.post('/api/sessions/:id/autoloop', (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const config = req.body as Partial<AutoLoopConfig>;
    const ref = toSessionContext(sessionId);
    if (rejectObserveOnlyIfNeeded(deps, ref, res)) {
      return;
    }
    const workspaceDir = contextServices.resolveWorkspaceDirForContext(ref);
    const meta = deps.agent.getContextNamespaceMeta(ref);
    const controller = autoLoopManager.getOrCreate(sessionId, meta?.autoLoopConfig);
    const normalizedUpdates: Partial<AutoLoopConfig> = { ...config };
    delete normalizedUpdates.pendingPlanConfirmation;
    const todoStateBeforeUpdate = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const currentConfig = controller.getConfig();
    const ralphEnabled = currentConfig.ralphEnabled ?? (currentConfig.mode === 'ralph' ? currentConfig.enabled : false);
    const todoControlled = todoStateBeforeUpdate.hasUnfinished || currentConfig.pendingPlanConfirmation === true;
    if (typeof config.enabled === 'boolean') {
      if (todoControlled && currentConfig.pendingPlanConfirmation === true && config.enabled === true) {
        const view = resolveAutoLoopView(currentConfig, todoStateBeforeUpdate);
        res.status(409).json({
          success: false,
          error: 'Plan confirmation is required before starting the todo loop.',
          config: view.config,
          todoDriven: view.todoDriven,
        });
        return;
      }
      normalizedUpdates.mode = todoControlled ? 'todo' : 'ralph';
      normalizedUpdates.ralphEnabled = todoControlled ? ralphEnabled : config.enabled;
      normalizedUpdates.pausedByUser = todoControlled ? !config.enabled : false;
      normalizedUpdates.pendingPlanConfirmation = currentConfig.pendingPlanConfirmation === true;
      normalizedUpdates.enabled = config.enabled;
    }
    controller.updateConfig(normalizedUpdates);
    if (normalizedUpdates.pausedByUser === true || normalizedUpdates.enabled === false) {
      controller.stop('user_stop');
    }
    contextServices.updateContextNamespaceMetaSafe(ref, {
      autoLoopConfig: controller.getConfig(),
    });
    todoServices.ensureTodoDrivenAutoLoop(sessionId, workspaceDir);
    const todoState = todoServices.getSessionTodoProtocolState(sessionId, workspaceDir);
    const view = resolveAutoLoopView(controller.getConfig(), todoState);
    res.json({
      success: true,
      config: view.config,
      todoDriven: view.todoDriven,
    });
  });

  deps.app.get('/api/autoloop/global', (_req: Request, res: Response) => {
    res.json({
      success: true,
      config: autoLoopManager.getGlobalConfig(),
    });
  });

  deps.app.post('/api/autoloop/global', (req: Request, res: Response) => {
    autoLoopManager.updateGlobalConfig(req.body as Partial<AutoLoopConfig>);
    res.json({
      success: true,
      config: autoLoopManager.getGlobalConfig(),
    });
  });
}
