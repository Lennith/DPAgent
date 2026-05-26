import { tokenizeWorkflowText } from '../utils/workflow-signal.js';
import type { SkillWriteRecord } from './skill-write-contracts.js';
import type { GovernanceSkillRecord } from './auto-generated-skill-governance-contracts.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizePlatformMetadata(value: string | undefined): string[] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'win32' || normalized === 'windows') {
    return ['windows'];
  }
  if (normalized === 'darwin' || normalized === 'macos') {
    return ['macos'];
  }
  if (normalized === 'linux') {
    return ['linux'];
  }
  return [];
}

export function extractJsonObject(raw: string): string | null {
  const source = String(raw ?? '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  return source.slice(start, end + 1);
}

export function similarityScore(left: GovernanceSkillRecord, right: GovernanceSkillRecord): number {
  const leftTokens = new Set(
    tokenizeWorkflowText(`${left.commands.join(' ')} ${left.checklist.join(' ')}`.trim()).slice(0, 48)
  );
  const rightTokens = new Set(
    tokenizeWorkflowText(`${right.commands.join(' ')} ${right.checklist.join(' ')}`.trim()).slice(0, 48)
  );
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

export function sortWriteRecordsByRecency(records: SkillWriteRecord[]): SkillWriteRecord[] {
  return [...records].sort((left, right) => {
    const leftTime = String(left.appliedAt ?? left.updatedAt ?? left.createdAt);
    const rightTime = String(right.appliedAt ?? right.updatedAt ?? right.createdAt);
    return rightTime.localeCompare(leftTime);
  });
}
