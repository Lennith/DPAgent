import { messageTextContent } from '../llm/index.js';
import {
  buildPromptWithAgentProfileReference,
  parseAgentProfilePrompt,
  type AgentProfileReference,
} from '../agents/AgentProfiles.js';
import type { Message } from '../types.js';
import { CONTEXT_REDUCTION_MARKERS } from './context-reduction-policy.js';

export function joinOptionalSegments(...segments: Array<string | undefined>): string | undefined {
  const normalized = segments.map((segment) => String(segment ?? '').trim()).filter((segment) => segment.length > 0);
  return normalized.length > 0 ? normalized.join('\n\n') : undefined;
}

export function isContextPrecompressedMarkerText(text: string): boolean {
  return text.trim().startsWith(`[${CONTEXT_REDUCTION_MARKERS.contextPrecompressed}`);
}

export function normalizeReplayUserPrompt(
  prompt: string,
  activeProfileRef?: AgentProfileReference
): {
  text: string;
  activeProfileRef?: AgentProfileReference;
} {
  const parsed = parseAgentProfilePrompt(prompt);
  if (!parsed.matched || !parsed.reference) {
    return {
      text: prompt,
      activeProfileRef: undefined,
    };
  }

  const strippedPrompt = parsed.strippedPrompt.trim();
  const shouldKeepReference = !sameAgentProfileReference(activeProfileRef, parsed.reference);
  return {
    text: shouldKeepReference
      ? buildPromptWithAgentProfileReference(strippedPrompt, parsed.reference).trim()
      : strippedPrompt,
    activeProfileRef: parsed.reference,
  };
}

export function sameAgentProfileReference(
  left: AgentProfileReference | undefined,
  right: AgentProfileReference | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.source === right.source && left.name === right.name && left.path === right.path;
}

export function sanitizeCompressedHistoryUserContent(content: Message['content']): string {
  const normalized = normalizeReplayText(content);
  if (normalized.length === 0) {
    return normalized;
  }
  const parsed = parseAgentProfilePrompt(normalized);
  return parsed.matched ? parsed.strippedPrompt.trim() : normalized;
}

export function normalizeReplayText(content: Message['content']): string {
  return messageTextContent(content).replace(/\s+/g, ' ').trim();
}

export function truncateReplayText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
}
