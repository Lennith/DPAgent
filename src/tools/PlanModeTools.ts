import { ContextManager } from '../context/index.js';
import type {
  ContextRef,
  FinalizedPlanStep,
  FinalizedPlanStepPriority,
  FinalizedPlanView,
  PlanInputAnswer,
  PlanInputRequest,
  PlanOption,
  PlanQuestion,
  ToolResult,
} from '../types.js';
import { Tool, errorResult, successResult } from './Tool.js';

const PLAN_FINAL_MARKDOWN_KEY = 'plan_mode.final_plan_markdown';
const PLAN_FINAL_SNAPSHOT_KEY = 'plan_mode.final_plan_snapshot';
const PLAN_FINAL_STEPS_KEY = 'plan_mode.final_plan_steps';
const PLAN_PENDING_ID_KEY = 'plan_mode.pending_plan_id';

export interface PlanModeToolsOptions {
  contextManager: ContextManager;
  resolveActiveContext: () => ContextRef | null;
  resolveActiveTurnId: () => string | null;
  requestUserInput?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;
  requestPlanApproval?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;
}

interface NormalizeQuestionsResult {
  ok: true;
  questions: PlanQuestion[];
}

interface NormalizeFinalPlanStepsResult {
  ok: true;
  steps: FinalizedPlanStep[];
}

function createRequestId(): string {
  return `plan-input-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createPlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeOptions(value: unknown, questionIndex: number): PlanOption[] | { error: string } {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return { error: `questions[${questionIndex}].options must be an array` };
  }
  if (value.length > 3) {
    return { error: `questions[${questionIndex}].options must contain 0 to 3 items` };
  }
  const options: PlanOption[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (!raw || typeof raw !== 'object') {
      return { error: `questions[${questionIndex}].options[${i}] must be an object` };
    }
    const item = raw as { label?: unknown; description?: unknown };
    const label = String(item.label ?? '').trim();
    const description = String(item.description ?? '').trim();
    if (!label) {
      return { error: `questions[${questionIndex}].options[${i}].label is required` };
    }
    if (!description) {
      return { error: `questions[${questionIndex}].options[${i}].description is required` };
    }
    options.push({ label, description });
  }
  return options;
}

function normalizeQuestions(args: Record<string, unknown>): NormalizeQuestionsResult | { ok: false; error: string } {
  if (!Array.isArray(args.questions)) {
    return { ok: false, error: 'questions must be an array' };
  }
  if (args.questions.length < 1 || args.questions.length > 3) {
    return { ok: false, error: 'questions must contain 1 to 3 items' };
  }
  const seenIds = new Set<string>();
  const questions: PlanQuestion[] = [];
  for (let i = 0; i < args.questions.length; i += 1) {
    const raw = args.questions[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `questions[${i}] must be an object` };
    }
    const item = raw as {
      header?: unknown;
      id?: unknown;
      question?: unknown;
      options?: unknown;
    };
    const header = String(item.header ?? '').trim();
    const id = String(item.id ?? '').trim();
    const question = String(item.question ?? '').trim();
    const options = normalizeOptions(item.options, i);
    if (!header) {
      return { ok: false, error: `questions[${i}].header is required` };
    }
    if (!id) {
      return { ok: false, error: `questions[${i}].id is required` };
    }
    if (!question) {
      return { ok: false, error: `questions[${i}].question is required` };
    }
    if ('error' in options) {
      return { ok: false, error: options.error };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `questions[${i}].id must be unique` };
    }
    seenIds.add(id);
    questions.push({
      header,
      id,
      question,
      options,
    });
  }
  return { ok: true, questions };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

function normalizePriority(value: unknown): FinalizedPlanStepPriority | undefined {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'low' || text === 'medium' || text === 'high') {
    return text;
  }
  return undefined;
}

function normalizeFinalPlanSteps(args: Record<string, unknown>): NormalizeFinalPlanStepsResult | { ok: false; error: string } {
  if (!Array.isArray(args.steps) || args.steps.length === 0) {
    return { ok: false, error: 'steps must be a non-empty array' };
  }
  const steps: FinalizedPlanStep[] = [];
  for (let i = 0; i < args.steps.length; i += 1) {
    const raw = args.steps[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `steps[${i}] must be an object` };
    }
    const item = raw as {
      work?: unknown;
      detection_standard?: unknown;
      detectionStandard?: unknown;
      priority?: unknown;
      tags?: unknown;
    };
    const work = String(item.work ?? '').trim();
    const detectionStandard = String(item.detection_standard ?? item.detectionStandard ?? '').trim();
    if (!work) {
      return { ok: false, error: `steps[${i}].work is required` };
    }
    if (!detectionStandard) {
      return { ok: false, error: `steps[${i}].detection_standard is required` };
    }
    const priority = normalizePriority(item.priority);
    const tags = normalizeStringArray(item.tags);
    steps.push({
      planStepId: `step-${String(i + 1).padStart(3, '0')}`,
      work,
      detectionStandard,
      ...(priority ? { priority } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return { ok: true, steps };
}

function buildPlanMarkdown(args: Record<string, unknown>, steps: FinalizedPlanStep[]): string {
  const title = String(args.title ?? '').trim() || 'Implementation Plan';
  const summary = String(args.summary ?? '').trim();
  const testPlan = normalizeStringArray(args.test_plan);
  const assumptions = normalizeStringArray(args.assumptions);
  const notes = String(args.notes ?? '').trim();

  const lines: string[] = [`### ${title}`];
  if (summary) {
    lines.push('', '### Summary', summary);
  }
  if (steps.length > 0) {
    lines.push('', '### Implementation Steps');
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const priority = step.priority ? ` priority=${step.priority}` : '';
      lines.push(`${i + 1}. [${step.planStepId}] ${step.work}${priority}`);
      lines.push(`   - detection_standard: ${step.detectionStandard}`);
      if (step.tags && step.tags.length > 0) {
        lines.push(`   - tags: ${step.tags.join(', ')}`);
      }
    }
  }
  if (testPlan.length > 0) {
    lines.push('', '### Test Plan');
    for (const item of testPlan) {
      lines.push(`- ${item}`);
    }
  }
  if (assumptions.length > 0) {
    lines.push('', '### Assumptions');
    for (const item of assumptions) {
      lines.push(`- ${item}`);
    }
  }
  if (notes) {
    lines.push('', '### Notes', notes);
  }
  return lines.join('\n').trim();
}

function findExecutionApprovalAnswer(answers: PlanInputAnswer[]): PlanInputAnswer | undefined {
  return answers.find((answer) => answer.id === 'plan_execution_approval');
}

function getPlanApprovalDecision(answers: PlanInputAnswer[]): 'approved' | 'revise' | 'rejected' {
  const answer = findExecutionApprovalAnswer(answers);
  const label = String(answer?.selectedLabel ?? '').trim().toLowerCase();
  if (label === 'approve execution') {
    return 'approved';
  }
  if (label === 'reject' || label === 'rejected' || label === 'do not execute') {
    return 'rejected';
  }
  return 'revise';
}

function getPlanApprovalFeedback(answers: PlanInputAnswer[]): string {
  const answer = findExecutionApprovalAnswer(answers);
  const freeText = String(answer?.freeText ?? '').trim();
  if (freeText) {
    return freeText;
  }
  return String(answer?.selectedLabel ?? '').trim();
}

abstract class PlanModeToolBase extends Tool {
  protected readonly contextManager: ContextManager;
  protected readonly resolveActiveContext: () => ContextRef | null;
  protected readonly resolveActiveTurnId: () => string | null;

  constructor(options: PlanModeToolsOptions) {
    super();
    this.contextManager = options.contextManager;
    this.resolveActiveContext = options.resolveActiveContext;
    this.resolveActiveTurnId = options.resolveActiveTurnId;
  }

  protected persistContextValue(key: string, value: string): { ok: true } | { ok: false; error: string } {
    const context = this.resolveActiveContext();
    if (!context) {
      return { ok: false, error: 'active context is not available' };
    }
    const activeTurnId = this.resolveActiveTurnId();
    if (activeTurnId) {
      const buffered = this.contextManager.recordContextPatch(activeTurnId, {
        op: 'set',
        key,
        value,
        source: 'plan_mode',
      });
      if (buffered) {
        return { ok: true };
      }
    }
    this.contextManager.writeNow(context, key, value);
    return { ok: true };
  }
}

export class RequestUserInputTool extends PlanModeToolBase {
  private readonly requestUserInput?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;

  constructor(options: PlanModeToolsOptions) {
    super(options);
    this.requestUserInput = options.requestUserInput;
  }

  get name(): string {
    return 'request_user_input';
  }

  get description(): string {
    return 'Request structured user input with 1-3 clarification questions and wait for user responses. Do not use this tool for execution approval.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to present. Each question supports single-choice and optional free-text.',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string' },
              id: { type: 'string' },
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['header', 'id', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.requestUserInput) {
      return errorResult('request_user_input callback is not available in current runtime');
    }
    const normalized = normalizeQuestions(args);
    if (!normalized.ok) {
      return errorResult(normalized.error);
    }
    const request: PlanInputRequest = {
      requestId: createRequestId(),
      source: 'request_user_input',
      questions: normalized.questions,
      turnId: this.resolveActiveTurnId() ?? undefined,
    };
    try {
      const answers = await this.requestUserInput(request);
      return successResult(
        JSON.stringify(
          {
            ok: true,
            requestId: request.requestId,
            answers,
            systemHint:
              'Use these answers to update the plan. If any high-impact requirement, boundary, tradeoff, assumption, edge case, or verification detail is still unclear, or if the user answers contradict prior input or verified project context, continue asking with request_user_input before calling finalize_plan. Do not fabricate missing answers or silently resolve contradictions.',
          },
          null,
          2
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`request_user_input failed: ${message}`);
    }
  }
}

export class FinalizePlanTool extends PlanModeToolBase {
  private readonly requestPlanApproval?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;

  constructor(options: PlanModeToolsOptions) {
    super(options);
    this.requestPlanApproval = options.requestPlanApproval;
  }

  get name(): string {
    return 'finalize_plan';
  }

  get description(): string {
    return 'Freeze the final plan, show the execution approval card, and wait for the user approval or revision decision.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Plan title. Defaults to "Implementation Plan".',
        },
        summary: {
          type: 'string',
          description: 'Short summary paragraph.',
        },
        steps: {
          type: 'array',
          description: 'Final executable plan steps. Each step must be independently verifiable.',
          items: {
            type: 'object',
            properties: {
              work: {
                type: 'string',
                description: 'Concrete work to perform in this step.',
              },
              detection_standard: {
                type: 'string',
                description: 'External verification standard for completing this step.',
              },
              priority: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['work', 'detection_standard'],
          },
        },
        test_plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test cases and scenarios.',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Assumptions and defaults.',
        },
        notes: {
          type: 'string',
          description: 'Optional free-form notes.',
        },
      },
      required: ['steps'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const normalizedSteps = normalizeFinalPlanSteps(args);
    if (!normalizedSteps.ok) {
      return errorResult(normalizedSteps.error);
    }
    if (!this.requestPlanApproval) {
      return errorResult('finalize_plan approval callback is not available in current runtime');
    }
    const markdown = buildPlanMarkdown(args, normalizedSteps.steps);
    const planId = createPlanId();
    const finalSnapshot: FinalizedPlanView = {
      planId,
      title: String(args.title ?? '').trim() || 'Implementation Plan',
      summary: String(args.summary ?? '').trim(),
      steps: normalizedSteps.steps,
      testPlan: normalizeStringArray(args.test_plan),
      assumptions: normalizeStringArray(args.assumptions),
      notes: String(args.notes ?? '').trim(),
      markdown,
      updatedAt: new Date().toISOString(),
    };

    const saveMarkdown = this.persistContextValue(PLAN_FINAL_MARKDOWN_KEY, markdown);
    if (!saveMarkdown.ok) {
      return errorResult(saveMarkdown.error);
    }
    const saveSnapshot = this.persistContextValue(PLAN_FINAL_SNAPSHOT_KEY, JSON.stringify(finalSnapshot));
    if (!saveSnapshot.ok) {
      return errorResult(saveSnapshot.error);
    }
    const saveSteps = this.persistContextValue(PLAN_FINAL_STEPS_KEY, JSON.stringify(normalizedSteps.steps));
    if (!saveSteps.ok) {
      return errorResult(saveSteps.error);
    }
    const savePlanRecord = this.persistContextValue(`plan_mode.plans.${planId}`, JSON.stringify(finalSnapshot));
    if (!savePlanRecord.ok) {
      return errorResult(savePlanRecord.error);
    }
    const savePendingId = this.persistContextValue(PLAN_PENDING_ID_KEY, planId);
    if (!savePendingId.ok) {
      return errorResult(savePendingId.error);
    }
    const request: PlanInputRequest = {
      requestId: createRequestId(),
      source: 'finalize_plan_approval',
      turnId: this.resolveActiveTurnId() ?? undefined,
      planPreview: finalSnapshot,
      questions: [
        {
          header: 'Execute Plan',
          id: 'plan_execution_approval',
          question: 'Review the finalized plan. Approve execution or provide revision feedback.',
          options: [
            {
              label: 'Approve execution',
              description: 'Create Todo items from this plan and start execution after this planning turn ends.',
            },
            {
              label: 'Request changes',
              description: 'Return feedback to revise the plan before execution.',
            },
          ],
        },
      ],
    };
    try {
      const answers = await this.requestPlanApproval(request);
      const decision = getPlanApprovalDecision(answers);
      const feedback = getPlanApprovalFeedback(answers);
      return successResult(
        JSON.stringify(
          {
            ok: true,
            planId,
            requestId: request.requestId,
            decision,
            markdown,
            steps: normalizedSteps.steps,
            answers,
            ...(decision === 'approved'
              ? {
                  executionContinuation: 'approved_new_turn',
                  message:
                    'The user approved execution. Do not implement or call more tools in this planning turn. Briefly acknowledge approval and end the current planning turn; the server will create todos and start the execution loop after this turn completes.',
                }
              : decision === 'rejected'
                ? {
                    feedback,
                    message:
                      'The user rejected execution. Do not execute the plan. Ask for next direction or stop planning.',
                  }
                : {
                    feedback,
                    message:
                      'The user requested changes. Revise the plan using the feedback, then call finalize_plan again with the updated final plan.',
                  }),
          },
          null,
          2
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`finalize_plan approval failed: ${message}`);
    }
  }
}

export function createPlanModeTools(options: PlanModeToolsOptions): Tool[] {
  return [
    new RequestUserInputTool(options),
    new FinalizePlanTool(options),
  ];
}
