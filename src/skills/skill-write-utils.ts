import * as crypto from 'node:crypto';
import { renderSkillMarkdown } from './skill-markdown.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

export function ensureSkillMarkdown(input: { name: string; description: string; content: string }): string {
  const trimmed = input.content.trim();
  if (trimmed.startsWith('---')) {
    return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
  }
  return renderSkillMarkdown({
    name: input.name,
    description: input.description,
    metadata: {
      reviewStatus: 'approved',
    },
    body: trimmed,
  });
}

export function hashContent(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

export function bumpVersion(value: string | undefined): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '1';
  }
  if (/^\d+$/.test(normalized)) {
    return String(Number.parseInt(normalized, 10) + 1);
  }
  const semverMatch = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (semverMatch) {
    return `${semverMatch[1]}.${semverMatch[2]}.${Number.parseInt(semverMatch[3], 10) + 1}`;
  }
  return `${normalized}.1`;
}
