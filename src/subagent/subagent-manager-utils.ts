import type { SubAgentArtifact } from '../types.js';

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}

export function emptyArtifacts(): SubAgentArtifact {
  return {
    files: [],
    commands: [],
    notes: [],
  };
}
