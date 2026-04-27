import { ContextManager } from '../context/index.js';
import type {
  ContextRef,
  PlanDocument,
  PlanInputAnswer,
  PlanInputRequest,
  PlanOption,
  PlanQuestion,
  PlanStep,
  PlanStepStatus,
  ToolResult,
} from '../types.js';
import { Tool, errorResult, successResult } from './Tool.js';

const PLAN_CURRENT_KEY = 'plan_mode.current_plan';
const PLAN_FINAL_MARKDOWN_KEY = 'plan_mode.final_plan_markdown';
const PLAN_FINAL_SNAPSHOT_KEY = 'plan_mode.final_plan_snapshot';

const ALLOWED_STEP_STATUS: PlanStepStatus[] = ['pending', 'in_progress', 'completed'];

export interface PlanModeToolsOptions {
  contextManager: ContextManager;
  resolveActiveContext: () => ContextRef | null;
  resolveActiveTurnId: () => string | null;
  requestUserInput?: (request: PlanInputRequest) => Promise<PlanInputAnswer[]>;
}

interface NormalizePlanResult {
  ok: true;
  steps: PlanStep[];
  explanation?: string;
}

interface NormalizeQuestionsResult {
  ok: true;
  questions: PlanQuestion[];
}

function createRequestId(): string {
  return `plan-input-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeStepStatus(value: unknown): PlanStepStatus | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if ((ALLOWED_STEP_STATUS as string[]).includes(text)) {
    return text as PlanStepStatus;
  }
  return null;
}

function normalizePlan(args: Record<string, unknown>): NormalizePlanResult | { ok: false; error: string } {
  if (!Array.isArray(args.plan)) {
    return { ok: false, error: 'plan must be an array' };
  }
  const steps: PlanStep[] = [];
  for (let i = 0; i < args.plan.length; i += 1) {
    const raw = args.plan[i];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `plan[${i}] must be an object` };
    }
    const item = raw as { step?: unknown; status?: unknown };
    const step = String(item.step ?? '').trim();
    const status = normalizeStepStatus(item.status);
    if (!step) {
      return { ok: false, error: `plan[${i}].step is required` };
    }
    if (!status) {
      return {
        ok: false,
        error: `plan[${i}].status must be one of: ${ALLOWED_STEP_STATUS.join(', ')}`,
      };
    }
    steps.push({ step, status });
  }
  if (steps.length === 0) {
    return { ok: false, error: 'plan must contain at least one step' };
  }
  const inProgressCount = steps.filter((item) => item.status === 'in_progress').length;
  if (inProgressCount > 1) {
    return { ok: false, error: 'plan can contain at most one in_progress step' };
  }
  const explanationRaw = String(args.explanation ?? '').trim();
  return {
    ok: true,
    steps,
    explanation: explanationRaw.length > 0 ? explanationRaw : undefined,
  };
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

function buildPlanMarkdown(args: Record<string, unknown>): string {
  const title = String(args.title ?? '').trim() || 'Implementation Plan';
  const summary = String(args.summary ?? '').trim();
  const keyChanges = normalizeStringArray(args.key_changes);
  const testPlan = normalizeStringArray(args.test_plan);
  const assumptions = normalizeStringArray(args.assumptions);
  const notes = String(args.notes ?? '').trim();

  const lines: string[] = [`### ${title}`];
  if (summary) {
    lines.push('', '### Summary', summary);
  }
  if (keyChanges.length > 0) {
    lines.push('', '### Implementation Changes');
    for (const item of keyChanges) {
      lines.push(`- ${item}`);
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

export class UpdatePlanTool extends PlanModeToolBase {
  get name(): string {
    return 'update_plan';
  }

  get description(): string {
    return 'Update current plan steps with status. Validates plan and persists to context.';
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        explanation: {
          type: 'string',
          description: 'Optional explanation for why plan was updated.',
        },
        plan: {
          type: 'array',
          description: 'Plan steps. At most one step may be in_progress.',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: {
                type: 'string',
                enum: ALLOWED_STEP_STATUS,
              },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const normalized = normalizePlan(args);
    if (!normalized.ok) {
      return errorResult(normalized.error);
    }
    const document: PlanDocument = {
      explanation: normalized.explanation,
      plan: normalized.steps,
      updatedAt: new Date().toISOString(),
    };
    const persisted = this.persistContextValue(PLAN_CURRENT_KEY, JSON.stringify(document));
    if (!persisted.ok) {
      return errorResult(persisted.error);
    }
    return successResult(
      JSON.stringify(
        {
          ok: true,
          planKey: PLAN_CURRENT_KEY,
          document,
        },
        null,
        2
      )
    );
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
    return 'Request structured user input with 1-3 questions and wait for user responses.';
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
      questions: normalized.questions,
    };
    try {
      const answers = await this.requestUserInput(request);
      return successResult(
        JSON.stringify(
          {
            ok: true,
            requestId: request.requestId,
            answers,
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
  get name(): string {
    return 'finalize_plan';
  }

  get description(): string {
    return 'Generate final plan markdown and persist final plan snapshot to context.';
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
        key_changes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Implementation changes.',
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
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const markdown = buildPlanMarkdown(args);
    const finalSnapshot = {
      title: String(args.title ?? '').trim() || 'Implementation Plan',
      summary: String(args.summary ?? '').trim(),
      keyChanges: normalizeStringArray(args.key_changes),
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
    return successResult(markdown);
  }
}

export function createPlanModeTools(options: PlanModeToolsOptions): Tool[] {
  return [
    new UpdatePlanTool(options),
    new RequestUserInputTool(options),
    new FinalizePlanTool(options),
  ];
}
