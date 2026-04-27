import type { AgentConfig, CompletionMarkerStats } from './types.js';

export const REQUIRED_COMPLETION_MARKERS = [
  '\u3010\u5b8c\u6210\uff01\u3011',
  '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011',
] as const;

export function isCompletionMarkerEnforcementEnabled(
  agentConfig: Pick<AgentConfig['agent'], 'completionMarkerEnforcementEnabled'> | null | undefined
): boolean {
  return agentConfig?.completionMarkerEnforcementEnabled === true;
}

export function getCompletionMarkerRuleText(enabled: boolean): string | null {
  if (!enabled) {
    return null;
  }
  return `The final visible text of every completed or blocked execution report must end with exactly one of these markers: \`${REQUIRED_COMPLETION_MARKERS[0]}\` or \`${REQUIRED_COMPLETION_MARKERS[1]}\`.`;
}

function normalizeCompletionMarkerText(value: string): string {
  return String(value ?? '').replace(/\s+$/u, '');
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAnotherTailCompletionMarker(prefix: string): boolean {
  const markerAlternation = REQUIRED_COMPLETION_MARKERS.map((marker) => escapeRegexLiteral(marker)).join('|');
  const pattern = new RegExp(`(?:${markerAlternation})[\\s\\p{P}\\p{S}]*$`, 'u');
  return pattern.test(prefix);
}

export function resolveCompletionMarker(
  value: string
): (typeof REQUIRED_COMPLETION_MARKERS)[number] | null {
  const normalized = normalizeCompletionMarkerText(value);
  for (const marker of REQUIRED_COMPLETION_MARKERS) {
    if (!normalized.endsWith(marker)) {
      continue;
    }
    const prefix = normalized.slice(0, -marker.length);
    if (!hasAnotherTailCompletionMarker(prefix)) {
      return marker;
    }
  }
  return null;
}

export function hasRequiredCompletionMarker(value: string): boolean {
  return resolveCompletionMarker(value) !== null;
}

export function classifyCompletionMarkerIssue(value: string): CompletionMarkerStats['lastIssue'] {
  const normalized = normalizeCompletionMarkerText(value);
  for (const marker of REQUIRED_COMPLETION_MARKERS) {
    if (!normalized.endsWith(marker)) {
      continue;
    }
    const prefix = normalized.slice(0, -marker.length);
    if (hasAnotherTailCompletionMarker(prefix)) {
      return 'duplicate_tail_marker';
    }
  }
  return 'missing_tail_marker';
}
