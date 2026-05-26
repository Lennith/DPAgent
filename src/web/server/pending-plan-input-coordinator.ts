import { WebSocket } from 'ws';
import type {
  ContextNamespaceMeta,
  ContextPendingPlanInput,
  ContextRef,
  PlanInputAnswer,
  PlanInputRequest,
} from '../../types.js';
import { isSameContextRef, isSocketOpen, type PlanInputResponseRequest } from './web-server-shared.js';
import type {
  PendingPlanInput,
  ResolvedPlanInputResponseTarget,
} from './web-server-runtime-contracts.js';

export type PlanInputTargetResolution =
  | {
      ok: true;
      target: ResolvedPlanInputResponseTarget;
      reboundSocket: boolean;
      clearedDetachTimer: boolean;
    }
  | {
      ok: false;
      runId?: string;
      requestId?: string;
      error: string;
    };

export class PendingPlanInputCoordinator {
  private pendingByRunId: Map<string, PendingPlanInput>;

  constructor(
    private readonly reconnectGraceMs: number,
    pendingByRunId: Map<string, PendingPlanInput> = new Map<string, PendingPlanInput>()
  ) {
    this.pendingByRunId = pendingByRunId;
  }

  get pendingInputsForInspection(): Map<string, PendingPlanInput> {
    return this.pendingByRunId;
  }

  assertNoPendingInputForRun(runId: string): void {
    if (this.pendingByRunId.has(runId)) {
      throw new Error('request_user_input already pending for this run');
    }
  }

  buildPendingInputMeta(
    runId: string,
    request: PlanInputRequest,
    lastError?: string | null
  ): ContextPendingPlanInput {
    const next: ContextPendingPlanInput = {
      runId,
      requestId: request.requestId,
      ...(request.source ? { source: request.source } : {}),
      questions: request.questions.map((question) => ({
        header: question.header,
        id: question.id,
        question: question.question,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
      })),
      ...(request.planPreview ? { planPreview: request.planPreview } : {}),
      requestedAt: new Date().toISOString(),
    };
    if (lastError) {
      next.lastError = lastError;
    }
    return next;
  }

  buildClearPendingInputMetaPatch(
    existing: ContextNamespaceMeta['pendingPlanInput'],
    runId: string,
    requestId?: string
  ): Pick<ContextNamespaceMeta, 'pendingPlanInput'> | null {
    if (!existing || existing.runId !== runId) {
      return null;
    }
    if (requestId && existing.requestId !== requestId) {
      return null;
    }
    return { pendingPlanInput: undefined };
  }

  buildPendingInputErrorMeta(
    existing: ContextNamespaceMeta['pendingPlanInput'],
    runId: string,
    request: PlanInputRequest,
    error: string
  ): ContextPendingPlanInput | null {
    if (!existing || existing.runId !== runId || existing.requestId !== request.requestId) {
      return null;
    }
    return {
      ...existing,
      lastError: error,
    };
  }

  replacePendingInputs(pendingByRunId: Map<string, PendingPlanInput>): void {
    this.pendingByRunId = pendingByRunId;
  }

  getLivePendingInput(
    context: ContextRef,
    persisted: ContextPendingPlanInput | null | undefined
  ): ContextPendingPlanInput | null {
    if (!persisted) {
      return null;
    }
    const active = this.pendingByRunId.get(persisted.runId);
    if (!active || !isSameContextRef(active.context, context) || active.request.requestId !== persisted.requestId) {
      return null;
    }
    return persisted;
  }

  waitForResponse(input: {
    runId: string;
    context: ContextRef;
    ws: WebSocket;
    request: PlanInputRequest;
    onDetachedExpired: (runId: string, context: ContextRef) => void;
  }): Promise<PlanInputAnswer[]> {
    this.assertNoPendingInputForRun(input.runId);
    return new Promise<PlanInputAnswer[]>((resolve, reject) => {
      const pending: PendingPlanInput = {
        runId: input.runId,
        context: input.context,
        ws: input.ws,
        request: input.request,
        resolve,
        reject,
      };
      this.pendingByRunId.set(input.runId, pending);
      if (!isSocketOpen(input.ws)) {
        this.startDetachTimer(pending, input.onDetachedExpired);
      }
    });
  }

  resolveResponseTarget(ws: WebSocket, request: PlanInputResponseRequest): PlanInputTargetResolution {
    const runId = String(request.runId ?? '').trim();
    if (!runId) {
      return {
        ok: false,
        error: 'runId is required for plan_input_response',
      };
    }
    const pending = this.pendingByRunId.get(runId);
    if (!pending) {
      return {
        ok: false,
        runId,
        error: 'no pending request_user_input for this run',
      };
    }
    const requestId = String(request.requestId ?? '').trim();
    if (!requestId || requestId !== pending.request.requestId) {
      return {
        ok: false,
        runId,
        error: 'requestId mismatch for plan_input_response',
      };
    }

    const wasDetached = pending.detachedAt !== undefined || pending.detachTimer !== undefined;
    if (pending.ws !== ws && !wasDetached) {
      return {
        ok: false,
        runId,
        requestId,
        error: 'plan_input_response must come from the pending request owner socket',
      };
    }
    return {
      ok: true,
      target: {
        runId,
        requestId,
        pending,
      },
      reboundSocket: pending.ws !== ws,
      clearedDetachTimer: wasDetached,
    };
  }

  adoptResponseSocket(target: ResolvedPlanInputResponseTarget, ws: WebSocket): {
    reboundSocket: boolean;
    clearedDetachTimer: boolean;
  } {
    const wasDetached = target.pending.detachedAt !== undefined || target.pending.detachTimer !== undefined;
    const reboundSocket = target.pending.ws !== ws;
    if (reboundSocket || wasDetached) {
      this.clearDetachTimer(target.pending);
    }
    if (reboundSocket) {
      target.pending.ws = ws;
    }
    return {
      reboundSocket,
      clearedDetachTimer: wasDetached,
    };
  }

  complete(
    target: ResolvedPlanInputResponseTarget,
    answers: PlanInputAnswer[],
    beforeResolve?: (pending: PendingPlanInput) => void
  ): PendingPlanInput {
    this.clearDetachTimer(target.pending);
    this.pendingByRunId.delete(target.runId);
    beforeResolve?.(target.pending);
    target.pending.resolve(answers);
    return target.pending;
  }

  rejectByRunId(
    runId: string,
    reason: string,
    beforeReject?: (pending: PendingPlanInput) => void
  ): PendingPlanInput | null {
    const pending = this.pendingByRunId.get(runId);
    if (!pending) {
      return null;
    }
    this.clearDetachTimer(pending);
    this.pendingByRunId.delete(runId);
    beforeReject?.(pending);
    pending.reject(new Error(reason));
    return pending;
  }

  rejectByContext(
    context: ContextRef,
    reason: string,
    beforeReject?: (pending: PendingPlanInput) => void
  ): PendingPlanInput[] {
    const rejected: PendingPlanInput[] = [];
    for (const [runId, pending] of this.pendingByRunId.entries()) {
      if (pending.context.scope !== context.scope || pending.context.namespace !== context.namespace) {
        continue;
      }
      const item = this.rejectByRunId(runId, reason, beforeReject);
      if (item) {
        rejected.push(item);
      }
    }
    return rejected;
  }

  cancelDetached(
    runId: string,
    context: ContextRef,
    reason: string,
    beforeReject?: (pending: PendingPlanInput) => void
  ): PendingPlanInput | null {
    const pending = this.pendingByRunId.get(runId);
    if (!pending || pending.detachedAt === undefined || !isSameContextRef(pending.context, context)) {
      return null;
    }
    return this.rejectByRunId(runId, reason, beforeReject);
  }

  detachSocket(
    ws: WebSocket,
    onDetachedExpired: (runId: string, context: ContextRef) => void
  ): number {
    let detachedCount = 0;
    for (const [, pending] of this.pendingByRunId.entries()) {
      if (pending.ws !== ws) {
        continue;
      }
      this.startDetachTimer(pending, onDetachedExpired);
      detachedCount += 1;
    }
    return detachedCount;
  }

  private startDetachTimer(
    pending: PendingPlanInput,
    onDetachedExpired: (runId: string, context: ContextRef) => void
  ): void {
    if (pending.detachTimer) {
      return;
    }
    pending.detachedAt = Date.now();
    pending.detachTimer = setTimeout(
      () => onDetachedExpired(pending.runId, pending.context),
      this.reconnectGraceMs
    );
    pending.detachTimer.unref?.();
  }

  private clearDetachTimer(pending: PendingPlanInput): void {
    if (pending.detachTimer) {
      clearTimeout(pending.detachTimer);
      pending.detachTimer = undefined;
    }
    pending.detachedAt = undefined;
  }
}
