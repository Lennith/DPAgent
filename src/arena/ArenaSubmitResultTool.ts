import { Tool, errorResult, successResult } from '../tools/Tool.js';
import type { TodoStore } from '../todo/index.js';
import type { ContextNamespaceMeta, ContextRef } from '../types.js';
import type { ArenaStore } from './ArenaStore.js';
import type { ArenaSubmission } from './types.js';

function trimString(value: unknown): string {
  return String(value ?? '').trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => trimString(item)).filter(Boolean)
    : [];
}

export interface ArenaSubmitResultToolOptions {
  context: ContextRef;
  meta: ContextNamespaceMeta;
  arenaStore: ArenaStore;
  todoStore: TodoStore;
}

export class ArenaSubmitResultTool extends Tool {
  constructor(private readonly options: ArenaSubmitResultToolOptions) {
    super();
  }

  get name(): string {
    return 'arena_submit_result';
  }

  get description(): string {
    return 'Submit the final result for this Arena branch. Use complete only after all branch Todo items are finished; use blocked with evidence when the branch cannot proceed.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['complete', 'blocked'] },
        summary: { type: 'string' },
        final_answer: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        changed_files: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
      },
      required: ['status', 'summary', 'evidence'],
      additionalProperties: false,
    };
  }

  async execute(args: Record<string, unknown>) {
    const branch = this.options.meta.arenaBranch;
    if (!branch || this.options.context.scope !== 'session') {
      return errorResult('arena_submit_result is only available inside an Arena branch session');
    }
    const status = trimString(args.status) as ArenaSubmission['status'];
    if (status !== 'complete' && status !== 'blocked') {
      return errorResult('status must be complete or blocked');
    }
    const summary = trimString(args.summary);
    if (!summary) {
      return errorResult('summary is required');
    }
    const evidence = stringArray(args.evidence);
    if (status === 'blocked' && evidence.length === 0) {
      return errorResult('blocked submissions require evidence');
    }
    if (status === 'complete') {
      const todoState = this.options.todoStore.getProtocolState({
        sessionId: this.options.context.namespace,
        scope: 'session',
        workspaceDir: this.options.meta.workspaceDir,
      });
      if (todoState.hasUnfinished) {
        return errorResult('complete submissions require unfinished Todo count to be 0');
      }
    }
    const run = this.options.arenaStore.submitBranchResult({
      arenaId: branch.arenaId,
      branchId: branch.branchId,
      submission: {
        status,
        summary,
        finalAnswer: trimString(args.final_answer),
        evidence,
        changedFiles: stringArray(args.changed_files),
        risks: stringArray(args.risks),
      },
    });
    return successResult(JSON.stringify({ success: true, arenaId: run.id, branchId: branch.branchId, status }, null, 2));
  }
}
