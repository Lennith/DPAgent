import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type AgentProfileSource = 'global' | 'workspace';

export interface AgentProfile {
  name: string;
  normalizedName: string;
  description: string;
  mtime: string;
  path: string;
  content: string;
  source: AgentProfileSource;
}

export interface AgentProfileCatalog {
  profiles: AgentProfile[];
  duplicateOverrides: Array<{
    normalizedName: string;
    replacedPath: string;
    nextPath: string;
  }>;
}

export interface MentionParseResult {
  mentionName?: string;
  strippedPrompt: string;
}

export interface AgentProfileReference {
  source: AgentProfileSource;
  name: string;
  path: string;
}

export interface AgentProfilePromptParseResult {
  reference?: AgentProfileReference;
  strippedPrompt: string;
  matched: boolean;
  matchedKind?: 'block' | 'reference' | 'bootstrap';
}

export interface ResolveAgentPoolOptions {
  globalAgentsDir?: string;
  workspaceDir?: string;
  includeWorkspace?: boolean;
}

function toIsoSafe(value: Date): string {
  const time = value.getTime();
  if (Number.isFinite(time)) {
    return value.toISOString();
  }
  return new Date(0).toISOString();
}

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

function extractFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) {
    return {
      data: {},
      body: normalized,
    };
  }

  const raw = String(match[1] ?? '');
  const body = normalized.slice(match[0].length);
  try {
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        data: parsed as Record<string, unknown>,
        body,
      };
    }
  } catch {
    // ignore malformed frontmatter and fallback to body scan
  }

  return {
    data: {},
    body,
  };
}

function frontmatterString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function descriptionFromFrontmatter(data: Record<string, unknown>): string {
  const summary = frontmatterString(data, 'summary');
  if (summary.length > 0) {
    const first = firstEffectiveLine(summary);
    return first.length > 0 ? first : summary.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  const description = frontmatterString(data, 'description');
  if (description.length > 0) {
    const first = firstEffectiveLine(description);
    return first.length > 0 ? first : description.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  return '';
}

function firstEffectiveLine(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === '---' || trimmed === '...') {
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      continue;
    }
    const withoutHeading = trimmed.replace(/^#+\s*/, '').trim();
    if (withoutHeading.length > 0) {
      return withoutHeading.slice(0, 200);
    }
  }
  return '';
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

function ensureDescription(name: string, description: string): string {
  const normalized = description.trim();
  if (normalized.length > 0) {
    return normalized;
  }
  return `Agent profile: ${name}`;
}

export function scanGlobalAgentProfiles(globalAgentsDir: string): AgentProfileCatalog {
  const resolvedDir = path.resolve(globalAgentsDir);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) {
    return {
      profiles: [],
      duplicateOverrides: [],
    };
  }
  const entries = fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const byNormalizedName = new Map<string, AgentProfile>();
  const duplicateOverrides: AgentProfileCatalog['duplicateOverrides'] = [];

  for (const entry of entries) {
    const profilePath = path.join(resolvedDir, entry.name, 'AGENTS.md');
    if (!fs.existsSync(profilePath)) {
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(profilePath, 'utf-8');
    } catch {
      continue;
    }
    const normalizedName = normalizeAgentName(entry.name);
    if (!normalizedName) {
      continue;
    }
    const stat = fs.statSync(profilePath);
    const parsed = extractFrontmatter(content);
    const derivedDescription = descriptionFromFrontmatter(parsed.data);
    const profile: AgentProfile = {
      name: entry.name.trim(),
      normalizedName,
      description: ensureDescription(entry.name.trim(), derivedDescription || firstEffectiveLine(parsed.body)),
      mtime: toIsoSafe(stat.mtime),
      path: profilePath,
      content,
      source: 'global',
    };
    const existing = byNormalizedName.get(normalizedName);
    if (existing) {
      duplicateOverrides.push({
        normalizedName,
        replacedPath: existing.path,
        nextPath: profile.path,
      });
    }
    byNormalizedName.set(normalizedName, profile);
  }

  return {
    profiles: Array.from(byNormalizedName.values()).sort((a, b) => a.name.localeCompare(b.name)),
    duplicateOverrides,
  };
}

export function parseLeadingAgentMention(prompt: string): MentionParseResult {
  const match = prompt.match(/^@([A-Za-z0-9._-]+)(?=\s|$)/);
  if (!match) {
    return { strippedPrompt: prompt };
  }
  const mentionName = String(match[1] ?? '').trim();
  const strippedPrompt = prompt.slice(match[0].length).replace(/^\s+/, '');
  return {
    mentionName: mentionName || undefined,
    strippedPrompt,
  };
}

export function loadWorkspaceAgentProfile(workspaceDir: string): AgentProfile | null {
  const filePath = path.join(path.resolve(workspaceDir), 'AGENTS.md');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const stat = fs.statSync(filePath);
  const parsed = extractFrontmatter(content);
  const derivedDescription = descriptionFromFrontmatter(parsed.data);
  return {
    name: 'workspace',
    normalizedName: 'workspace',
    description: ensureDescription('workspace', derivedDescription || firstEffectiveLine(parsed.body)),
    mtime: toIsoSafe(stat.mtime),
    path: filePath,
    content,
    source: 'workspace',
  };
}

export function buildAgentProfileBlock(
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content'>
): string {
  const profileHeader = `[AGENT_PROFILE_BEGIN source=${profile.source} name=${profile.name} path=${profile.path}]`;
  const profileFooter = '[AGENT_PROFILE_END]';
  return `${profileHeader}\n${profile.content}\n${profileFooter}`;
}

export function buildPromptWithAgentProfile(prompt: string, profile: AgentProfile): string {
  return `${buildAgentProfileBlock(profile)}\n\n${prompt}`;
}

export function buildAgentProfileReferenceTag(
  profile: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
): string {
  return `[AGENT_PROFILE_REF source=${profile.source} name=${profile.name} path=${profile.path}]`;
}

export function buildPromptWithAgentProfileReference(
  prompt: string,
  profile: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
): string {
  return `${buildAgentProfileReferenceTag(profile)}\n\n${prompt}`;
}

export function buildAgentProfileBootstrapBlock(
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content'>
): string {
  return [
    buildAgentProfileReferenceTag(profile),
    '[AGENT_PROFILE_BODY_BEGIN]',
    profile.content,
    '[AGENT_PROFILE_BODY_END]',
  ].join('\n');
}

export function buildPromptWithAgentProfileBootstrap(
  prompt: string,
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content'>
): string {
  return `${buildAgentProfileBootstrapBlock(profile)}\n\n${prompt}`;
}

function parseAgentProfileTag(
  raw: string,
  marker: 'AGENT_PROFILE_BEGIN' | 'AGENT_PROFILE_REF'
): AgentProfileReference | undefined {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\[${escapedMarker}\\s+source=(global|workspace)\\s+name=([^\\s\\]]+)\\s+path=([^\\]]+)\\]`
  );
  const match = raw.match(pattern);
  if (!match) {
    return undefined;
  }
  const source = String(match[1] ?? '').trim();
  const name = String(match[2] ?? '').trim();
  const pathValue = String(match[3] ?? '').trim();
  if ((source !== 'global' && source !== 'workspace') || !name || !pathValue) {
    return undefined;
  }
  return {
    source,
    name,
    path: pathValue,
  };
}

export function parseAgentProfilePrompt(prompt: string): AgentProfilePromptParseResult {
  const raw = String(prompt ?? '');
  const bootstrapReference = parseAgentProfileTag(raw, 'AGENT_PROFILE_REF');
  if (bootstrapReference) {
    const bodyBegin = '[AGENT_PROFILE_BODY_BEGIN]';
    const bodyEnd = '[AGENT_PROFILE_BODY_END]';
    const bodyBeginIdx = raw.indexOf(bodyBegin);
    const bodyEndIdx = raw.indexOf(bodyEnd);
    if (bodyBeginIdx >= 0 && bodyEndIdx > bodyBeginIdx) {
      const after = raw.slice(bodyEndIdx + bodyEnd.length).replace(/^\s+/, '');
      return {
        reference: bootstrapReference,
        strippedPrompt: after,
        matched: true,
        matchedKind: 'bootstrap',
      };
    }
  }

  const blockRef = parseAgentProfileTag(raw, 'AGENT_PROFILE_BEGIN');
  if (blockRef) {
    const footer = '[AGENT_PROFILE_END]';
    const footerIdx = raw.indexOf(footer);
    if (footerIdx >= 0) {
      const after = raw.slice(footerIdx + footer.length).replace(/^\s+/, '');
      return {
        reference: blockRef,
        strippedPrompt: after,
        matched: true,
        matchedKind: 'block',
      };
    }
  }

  const reference = parseAgentProfileTag(raw, 'AGENT_PROFILE_REF');
  if (!reference) {
    return {
      strippedPrompt: raw,
      matched: false,
    };
  }

  const closingBracketIdx = raw.indexOf(']');
  if (closingBracketIdx < 0) {
    return {
      strippedPrompt: raw,
      matched: false,
    };
  }

  const after = raw.slice(closingBracketIdx + 1).replace(/^\s+/, '');
  return {
    reference,
    strippedPrompt: after,
    matched: true,
    matchedKind: 'reference',
  };
}

export function resolveAgentPool(options: ResolveAgentPoolOptions): AgentProfile[] {
  const includeWorkspace = options.includeWorkspace !== false;
  const globalDir = String(options.globalAgentsDir ?? '').trim();
  const workspaceDir = String(options.workspaceDir ?? '').trim();

  const globalProfiles = globalDir.length > 0 ? scanGlobalAgentProfiles(globalDir).profiles : [];
  const byNormalizedName = new Map<string, AgentProfile>();
  for (const profile of globalProfiles) {
    byNormalizedName.set(profile.normalizedName, profile);
  }

  if (includeWorkspace && workspaceDir.length > 0) {
    const workspaceProfile = loadWorkspaceAgentProfile(workspaceDir);
    if (workspaceProfile) {
      // Reserved workspace profile should override any same-name global profile.
      byNormalizedName.set(workspaceProfile.normalizedName, workspaceProfile);
    }
  }

  return Array.from(byNormalizedName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgentProfileByName(profiles: AgentProfile[], name: string): AgentProfile | undefined {
  const normalized = normalizeAgentName(name);
  if (!normalized) {
    return undefined;
  }
  return profiles.find((item) => item.normalizedName === normalized);
}
