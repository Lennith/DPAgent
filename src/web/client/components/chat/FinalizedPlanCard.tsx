import { useThemeConfig } from '../providers/ThemeProvider.js';
import type { FinalizedPlanStepView, FinalizedPlanView } from '../../app-shell-types.js';
import { MarkdownContent } from './MarkdownContent.js';

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
}

function normalizePriority(value: unknown): FinalizedPlanStepView['priority'] | undefined {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'low' || text === 'medium' || text === 'high' ? text : undefined;
}

function normalizeSteps(value: unknown): FinalizedPlanStepView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const steps: FinalizedPlanStepView[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const work = String(item.work ?? '').trim();
    const detectionStandard = String(item.detectionStandard ?? item.detection_standard ?? '').trim();
    if (!work || !detectionStandard) {
      continue;
    }
    const planStepId = String(item.planStepId ?? item.plan_step_id ?? `step-${String(index + 1).padStart(3, '0')}`).trim();
    const priority = normalizePriority(item.priority);
    const tags = normalizeStringArray(item.tags);
    steps.push({
      planStepId,
      work,
      detectionStandard,
      ...(priority ? { priority } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return steps;
}

function buildPlanMarkdown(plan: Omit<FinalizedPlanView, 'markdown'>): string {
  const lines: string[] = [`### ${plan.title}`];
  if (plan.summary) {
    lines.push('', '### Summary', plan.summary);
  }
  if (plan.steps.length > 0) {
    lines.push('', '### Implementation Steps');
    plan.steps.forEach((step, index) => {
      const priority = step.priority ? ` priority=${step.priority}` : '';
      lines.push(`${index + 1}. [${step.planStepId}] ${step.work}${priority}`);
      lines.push(`   - detection_standard: ${step.detectionStandard}`);
      if (step.tags && step.tags.length > 0) {
        lines.push(`   - tags: ${step.tags.join(', ')}`);
      }
    });
  }
  if (plan.testPlan && plan.testPlan.length > 0) {
    lines.push('', '### Test Plan', ...plan.testPlan.map((item) => `- ${item}`));
  }
  if (plan.assumptions && plan.assumptions.length > 0) {
    lines.push('', '### Assumptions', ...plan.assumptions.map((item) => `- ${item}`));
  }
  if (plan.notes) {
    lines.push('', '### Notes', plan.notes);
  }
  return lines.join('\n').trim();
}

export function normalizeFinalizedPlanView(value: unknown): FinalizedPlanView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const steps = normalizeSteps(raw.steps);
  if (steps.length === 0) {
    return null;
  }
  const title = String(raw.title ?? '').trim() || 'Implementation Plan';
  const summary = String(raw.summary ?? '').trim();
  const notes = String(raw.notes ?? '').trim();
  const testPlan = normalizeStringArray(raw.testPlan ?? raw.test_plan);
  const assumptions = normalizeStringArray(raw.assumptions);
  const planWithoutMarkdown = {
    planId: String(raw.planId ?? raw.plan_id ?? '').trim() || undefined,
    title,
    summary,
    steps,
    testPlan,
    assumptions,
    notes,
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? '').trim() || undefined,
  };
  const markdown = String(raw.markdown ?? '').trim() || buildPlanMarkdown(planWithoutMarkdown);
  return {
    ...planWithoutMarkdown,
    markdown,
  };
}

export function FinalizedPlanCard({ plan }: { plan: FinalizedPlanView }) {
  const theme = useThemeConfig();
  return (
    <section
      data-testid="finalized-plan-card"
      className="rounded-2xl border p-4"
      style={{
        borderColor: theme.colors.primary.DEFAULT,
        backgroundColor: theme.colors.assistantMessage.bg,
        color: theme.colors.assistantMessage.text,
      }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className="rounded-md border px-2 py-0.5 text-[11px] font-semibold"
          style={{
            borderColor: theme.colors.primary.DEFAULT,
            backgroundColor: `${theme.colors.primary.DEFAULT}18`,
            color: theme.colors.primary.DEFAULT,
          }}
        >
          Final Plan
        </span>
        {plan.planId ? (
          <span className="font-mono text-[11px]" style={{ color: theme.colors.text.muted }}>
            {plan.planId}
          </span>
        ) : null}
      </div>
      <MarkdownContent content={plan.markdown} />
    </section>
  );
}
