import * as yaml from 'js-yaml';

export interface ParsedSkillMarkdown {
  name?: string;
  description?: string;
  metadata: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

function normalizeMetadata(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const nested = frontmatter.metadata;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...(nested as Record<string, unknown>) };
  }
  const next = { ...frontmatter };
  delete next.name;
  delete next.description;
  return next;
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      metadata: {},
      body: content.trim(),
      hasFrontmatter: false,
    };
  }
  try {
    const frontmatter = ((yaml.load(match[1]) as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    return {
      name: typeof frontmatter.name === 'string' ? frontmatter.name : undefined,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
      metadata: normalizeMetadata(frontmatter),
      body: match[2].trim(),
      hasFrontmatter: true,
    };
  } catch {
    return {
      metadata: {},
      body: content.trim(),
      hasFrontmatter: false,
    };
  }
}

export function renderSkillMarkdown(input: {
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  body: string;
}): string {
  const frontmatter: Record<string, unknown> = {};
  if (input.name && input.name.trim().length > 0) {
    frontmatter.name = input.name.trim();
  }
  if (input.description && input.description.trim().length > 0) {
    frontmatter.description = input.description.trim();
  }
  const metadata = input.metadata ?? {};
  if (Object.keys(metadata).length > 0) {
    frontmatter.metadata = metadata;
  }
  if (Object.keys(frontmatter).length === 0) {
    return `${input.body.trim()}\n`;
  }
  return ['---', yaml.dump(frontmatter).trimEnd(), '---', '', input.body.trim(), ''].join('\n');
}

export function upsertSkillMetadata(
  content: string,
  patch: Record<string, unknown>,
  overrides: {
    name?: string;
    description?: string;
    body?: string;
  } = {}
): string {
  const parsed = parseSkillMarkdown(content);
  return renderSkillMarkdown({
    name: overrides.name ?? parsed.name,
    description: overrides.description ?? parsed.description,
    metadata: {
      ...parsed.metadata,
      ...patch,
    },
    body: overrides.body ?? parsed.body,
  });
}

export function readSkillVersion(content: string): string | undefined {
  const parsed = parseSkillMarkdown(content);
  const version = parsed.metadata.version;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : undefined;
}
