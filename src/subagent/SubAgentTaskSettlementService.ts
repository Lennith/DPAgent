import type { ContextRef, SubAgentResult } from '../types.js';
import type { SubAgentExecutionOutput, SubAgentQueuedTask, SubAgentRecord, SubAgentRegistryState } from './types.js';

export interface SubAgentTaskSettlementServiceOptions {
  getState: () => SubAgentRegistryState;
  removeTaskFromQueue: (parentKey: string, taskId: string) => void;
  updateQueuePositions: (parentKey: string) => void;
  persistState: () => void;
  applyTerminalRecord: (input: {
    record: SubAgentRecord;
    status: SubAgentExecutionOutput['status'];
    summary: string;
    artifacts: SubAgentExecutionOutput['artifacts'];
    finishReason?: string;
    usage?: SubAgentExecutionOutput['usage'];
    error?: string;
    startedAt: string;
    completedAt: string;
  }) => SubAgentResult;
  writeParentContextResult: (parentContext: ContextRef, result: SubAgentResult, parentTurnId?: string) => void;
  writeParentContextIndex: (parentContext: ContextRef, parentTurnId?: string) => void;
  resolveWaiters: (subagentId: string, runSeq: number) => void;
  processAllQueues: () => void;
}

export class SubAgentTaskSettlementService {
  private readonly options: SubAgentTaskSettlementServiceOptions;

  constructor(options: SubAgentTaskSettlementServiceOptions) {
    this.options = options;
  }

  settleMissingTask(task: SubAgentQueuedTask, taskId: string): void {
    const state = this.options.getState();
    this.options.removeTaskFromQueue(task.parentKey, taskId);
    delete state.tasks[taskId];
    this.options.updateQueuePositions(task.parentKey);
    this.options.persistState();
    this.options.processAllQueues();
  }

  settleCompletedTask(input: {
    task: SubAgentQueuedTask;
    taskId: string;
    record: SubAgentRecord;
    output: SubAgentExecutionOutput;
    alreadyTerminal: boolean;
  }): void {
    const state = this.options.getState();
    if (!input.alreadyTerminal) {
      this.options.applyTerminalRecord({
        record: input.record,
        status: input.output.status,
        summary: input.output.summary,
        artifacts: input.output.artifacts,
        finishReason: input.output.finishReason,
        usage: input.output.usage,
        error: input.output.error,
        startedAt: input.output.startedAt,
        completedAt: input.output.completedAt,
      });
    }

    this.options.removeTaskFromQueue(input.task.parentKey, input.taskId);
    delete state.tasks[input.taskId];
    this.options.updateQueuePositions(input.task.parentKey);
    this.options.persistState();

    if (input.record.latestResult) {
      this.options.writeParentContextResult(
        input.record.parentContext,
        input.record.latestResult,
        input.task.parentTurnId ?? input.record.parentTurnId
      );
    }
    this.options.writeParentContextIndex(input.record.parentContext, input.task.parentTurnId ?? input.record.parentTurnId);
    this.options.resolveWaiters(input.record.id, input.record.runSeq);
    this.options.processAllQueues();
  }

  settleImmediateResult(record: SubAgentRecord, result: SubAgentResult): void {
    this.options.persistState();
    this.options.writeParentContextResult(record.parentContext, result, record.parentTurnId);
    this.options.writeParentContextIndex(record.parentContext, record.parentTurnId);
    this.options.resolveWaiters(record.id, record.runSeq);
  }
}
