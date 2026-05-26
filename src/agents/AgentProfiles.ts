import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type {
  AgentProfileConfig,
  AgentProfileConfigView,
  AgentRuntimeOverrides,
  ReasoningPreset,
} from '../types.js';

export type AgentProfileSource = 'bundled' | 'global' | 'workspace';

export interface AgentProfile {
  name: string;
  normalizedName: string;
  description: string;
  mtime: string;
  path: string;
  configPath?: string;
  content: string;
  source: AgentProfileSource;
  config?: AgentProfileConfig;
  configWarnings?: string[];
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
  bundledAgentsDir?: string;
  globalAgentsDir?: string;
  workspaceDir?: string;
  includeBundled?: boolean;
  includeWorkspace?: boolean;
}

export const DEFAULT_BUNDLED_AGENTS_DIR = path.resolve(__dirname, '..', '..', 'agents');

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

const REASONING_PRESETS = new Set<ReasoningPreset>(['off', 'low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeAgentProfileConfig(raw: unknown): {
  config: AgentProfileConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const config: AgentProfileConfig = {};
  const data = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  if (raw !== undefined && Object.keys(data).length === 0 && raw !== null) {
    warnings.push('agent.yaml must contain an object');
  }
  if (data.version !== undefined && data.version !== 1) {
    warnings.push('version must be 1');
  } else if (data.version === 1) {
    config.version = 1;
  }
  for (const key of ['description', 'llmProfileId', 'llmModel', 'promptAppend'] as const) {
    if (data[key] === undefined) {
      continue;
    }
    if (typeof data[key] !== 'string') {
      warnings.push(`${key} must be a string`);
      continue;
    }
    const value = data[key].trim();
    if (value) {
      config[key] = value;
    }
  }
  if (data.toolsetName !== undefined) {
    if (typeof data.toolsetName !== 'string') {
      warnings.push('toolsetName must be a string');
    } else {
      const value = data.toolsetName.trim();
      if (value) {
        config.toolsetName = value;
      }
    }
  }
  if (data.allowedTools !== undefined) {
    if (!Array.isArray(data.allowedTools) || data.allowedTools.some((item) => typeof item !== 'string')) {
      warnings.push('allowedTools must be an array of strings');
    } else {
      const allowedTools = Array.from(
        new Set(data.allowedTools.map((item) => item.trim()).filter((item) => item.length > 0))
      );
      if (allowedTools.length > 0) {
        config.allowedTools = allowedTools;
      }
    }
  }
  for (const key of ['maxSteps', 'timeoutMs'] as const) {
    if (data[key] === undefined) {
      continue;
    }
    const value = data[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      warnings.push(`${key} must be a positive integer`);
      continue;
    }
    config[key] = value;
  }
  if (data.reasoningPreset !== undefined) {
    const value = String(data.reasoningPreset ?? '').trim() as ReasoningPreset;
    if (REASONING_PRESETS.has(value)) {
      config.reasoningPreset = value;
    } else {
      warnings.push('reasoningPreset must be one of off, low, medium, high, xhigh, max');
    }
  }
  if (data.loadGlobalSkills !== undefined) {
    if (typeof data.loadGlobalSkills === 'boolean') {
      config.loadGlobalSkills = data.loadGlobalSkills;
    } else {
      warnings.push('loadGlobalSkills must be a boolean');
    }
  }
  if (data.exposeAsSubagent !== undefined) {
    if (typeof data.exposeAsSubagent === 'boolean') {
      config.exposeAsSubagent = data.exposeAsSubagent;
    } else {
      warnings.push('exposeAsSubagent must be a boolean');
    }
  }
  return { config, warnings };
}

export function readAgentProfileConfig(agentDir: string): {
  config?: AgentProfileConfig;
  warnings: string[];
  path: string;
} {
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) {
    return { warnings: [], path: configPath };
  }
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
    const normalized = normalizeAgentProfileConfig(parsed);
    return {
      config: normalized.config,
      warnings: normalized.warnings,
      path: configPath,
    };
  } catch (error) {
    return {
      warnings: [`agent.yaml parse failed: ${error instanceof Error ? error.message : String(error)}`],
      path: configPath,
    };
  }
}

export function toAgentProfileConfigView(
  config: AgentProfileConfig | undefined,
  warnings: string[] | undefined,
  configPath?: string
): AgentProfileConfigView {
  return {
    ...(config ?? {}),
    warnings: warnings ?? [],
    ...(configPath ? { path: configPath } : {}),
  };
}

export function toAgentRuntimeOverrides(profile: AgentProfile | undefined): AgentRuntimeOverrides | undefined {
  if (!profile) {
    return undefined;
  }
  const config = profile.config ?? {};
  const overrides: AgentRuntimeOverrides = {
    agentProfile: {
      source: profile.source,
      name: profile.name,
      path: profile.path,
    },
  };
  if (config.llmProfileId) {
    overrides.llmProfileId = config.llmProfileId;
  }
  if (config.llmModel) {
    overrides.llmModel = config.llmModel;
  }
  if (config.reasoningPreset) {
    overrides.reasoningPreset = config.reasoningPreset;
  }
  if (config.toolsetName) {
    overrides.toolsetName = config.toolsetName;
  }
  if (config.allowedTools) {
    overrides.allowedTools = config.allowedTools;
  }
  if (config.maxSteps) {
    overrides.maxSteps = config.maxSteps;
  }
  if (config.timeoutMs) {
    overrides.timeoutMs = config.timeoutMs;
  }
  if (config.loadGlobalSkills === false) {
    overrides.loadGlobalSkills = false;
  }
  return overrides;
}

export function writeAgentProfileConfig(configPath: string, config: AgentProfileConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 100 }), 'utf-8');
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

function scanAgentProfiles(agentsDir: string, source: Exclude<AgentProfileSource, 'workspace'>): AgentProfileCatalog {
  const resolvedDir = path.resolve(agentsDir);
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
    const configResult = readAgentProfileConfig(path.join(resolvedDir, entry.name));
    const derivedDescription = descriptionFromFrontmatter(parsed.data);
    const profile: AgentProfile = {
      name: entry.name.trim(),
      normalizedName,
      description: ensureDescription(
        entry.name.trim(),
        configResult.config?.description || derivedDescription || firstEffectiveLine(parsed.body)
      ),
      mtime: toIsoSafe(stat.mtime),
      path: profilePath,
      configPath: configResult.path,
      content,
      source,
      config: configResult.config,
      configWarnings: configResult.warnings,
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

export function scanBundledAgentProfiles(bundledAgentsDir: string = DEFAULT_BUNDLED_AGENTS_DIR): AgentProfileCatalog {
  return scanAgentProfiles(bundledAgentsDir, 'bundled');
}

export function scanGlobalAgentProfiles(globalAgentsDir: string): AgentProfileCatalog {
  return scanAgentProfiles(globalAgentsDir, 'global');
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
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content' | 'config'>
): string {
  const profileHeader = `[AGENT_PROFILE_BEGIN source=${profile.source} name=${profile.name} path=${profile.path}]`;
  const profileFooter = '[AGENT_PROFILE_END]';
  const promptAppend = String(profile.config?.promptAppend ?? '').trim();
  const content = promptAppend ? `${profile.content.trimEnd()}\n\n${promptAppend}` : profile.content;
  return `${profileHeader}\n${content}\n${profileFooter}`;
}

const SYSTEM_SEGMENT_LINE_CAP = 150;

function applyPromptAppend(
  profile: Pick<AgentProfile, 'content' | 'config'>
): string {
  const promptAppend = String(profile.config?.promptAppend ?? '').trim();
  return promptAppend ? `${profile.content.trimEnd()}\n\n${promptAppend}` : profile.content;
}

function truncateLines(
  content: string,
  options: {
    maxLines?: number;
    notice: string;
  }
): string {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? SYSTEM_SEGMENT_LINE_CAP));
  const lines = String(content ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length <= maxLines) {
    return lines.join('\n').trimEnd();
  }
  return [
    ...lines.slice(0, maxLines),
    '',
    options.notice,
  ].join('\n').trimEnd();
}

export function buildAgentProfileSystemSegment(
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content' | 'config'>,
  options?: { maxLines?: number }
): string {
  const content = truncateLines(applyPromptAppend(profile), {
    maxLines: options?.maxLines,
    notice: `Agent profile truncated after ${Math.max(1, Math.floor(options?.maxLines ?? SYSTEM_SEGMENT_LINE_CAP))} lines. Full profile path: ${profile.path}`,
  });
  return [
    '## Active Agent Role',
    'Use this agent profile as role, persona, and task guidance for this turn.',
    'Core runtime, tool permission, and workspace instructions remain binding if they conflict with this role.',
    `[AGENT_PROFILE_BEGIN source=${profile.source} name=${profile.name} path=${profile.path}]`,
    content,
    '[AGENT_PROFILE_END]',
  ].join('\n');
}

export function buildWorkspaceInstructionsSystemSegment(
  profile: Pick<AgentProfile, 'path' | 'content' | 'config'>,
  options?: { maxLines?: number }
): string {
  const content = truncateLines(applyPromptAppend(profile), {
    maxLines: options?.maxLines,
    notice: `Workspace instructions truncated after ${Math.max(1, Math.floor(options?.maxLines ?? SYSTEM_SEGMENT_LINE_CAP))} lines. Full instructions path: ${profile.path}`,
  });
  return [
    '## Workspace Instructions',
    'These instructions apply to repository behavior, file edits, tests, commits, and project conventions.',
    'They do not define the assistant persona when an Active Agent Role is present.',
    'If they conflict with Core Runtime Rules, Core Runtime Rules win.',
    `[WORKSPACE_INSTRUCTIONS_BEGIN path=${profile.path}]`,
    content,
    '[WORKSPACE_INSTRUCTIONS_END]',
  ].join('\n');
}

export function buildPromptWithAgentProfile(prompt: string, profile: AgentProfile): string {
  return `${buildAgentProfileBlock(profile)}\n\n${prompt}`;
}

export function buildAgentProfileReferenceTag(
  profile: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
): string {
  return `[AGENT_PROFILE_REF source=${profile.source} name=${profile.name} path=${profile.path}]`;
}

const AGENT_PROFILE_REFERENCE_NOTICE = [
  '[AGENT_PROFILE_REF_NOTE]',
  'The path in AGENT_PROFILE_REF identifies the agent profile definition file only; it is not the current workspace. Use the Current Workspace system prompt for file operations and relative paths.',
  '[/AGENT_PROFILE_REF_NOTE]',
].join('\n');

function buildAgentProfileReferenceBlock(
  profile: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
): string {
  return `${buildAgentProfileReferenceTag(profile)}\n${AGENT_PROFILE_REFERENCE_NOTICE}`;
}

export function buildPromptWithAgentProfileReference(
  prompt: string,
  profile: Pick<AgentProfileReference, 'source' | 'name' | 'path'>
): string {
  return `${buildAgentProfileReferenceBlock(profile)}\n\n${prompt}`;
}

export function buildAgentProfileBootstrapBlock(
  profile: Pick<AgentProfile, 'source' | 'name' | 'path' | 'content' | 'config'>
): string {
  const promptAppend = String(profile.config?.promptAppend ?? '').trim();
  const content = promptAppend ? `${profile.content.trimEnd()}\n\n${promptAppend}` : profile.content;
  return [
    buildAgentProfileReferenceBlock(profile),
    '[AGENT_PROFILE_BODY_BEGIN]',
    content,
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
    `^\\[${escapedMarker}\\s+source=(bundled|global|workspace)\\s+name=([^\\s\\]]+)\\s+path=([^\\]]+)\\]`
  );
  const match = raw.match(pattern);
  if (!match) {
    return undefined;
  }
  const source = String(match[1] ?? '').trim();
  const name = String(match[2] ?? '').trim();
  const pathValue = String(match[3] ?? '').trim();
  if ((source !== 'bundled' && source !== 'global' && source !== 'workspace') || !name || !pathValue) {
    return undefined;
  }
  return {
    source,
    name,
    path: pathValue,
  };
}

function stripAgentProfileReferenceNotice(raw: string): string {
  const trimmed = raw.replace(/^\s+/, '');
  if (!trimmed.startsWith('[AGENT_PROFILE_REF_NOTE]')) {
    return trimmed;
  }
  const endMarker = '[/AGENT_PROFILE_REF_NOTE]';
  const endIdx = trimmed.indexOf(endMarker);
  if (endIdx < 0) {
    return trimmed;
  }
  return trimmed.slice(endIdx + endMarker.length).replace(/^\s+/, '');
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

  const after = stripAgentProfileReferenceNotice(raw.slice(closingBracketIdx + 1));
  return {
    reference,
    strippedPrompt: after,
    matched: true,
    matchedKind: 'reference',
  };
}

export function resolveAgentPool(options: ResolveAgentPoolOptions): AgentProfile[] {
  const includeBundled = options.includeBundled !== false;
  const includeWorkspace = options.includeWorkspace !== false;
  const bundledDir = String(options.bundledAgentsDir ?? DEFAULT_BUNDLED_AGENTS_DIR).trim();
  const globalDir = String(options.globalAgentsDir ?? '').trim();
  const workspaceDir = String(options.workspaceDir ?? '').trim();

  const byNormalizedName = new Map<string, AgentProfile>();
  const bundledProfiles = includeBundled && bundledDir.length > 0 ? scanBundledAgentProfiles(bundledDir).profiles : [];
  for (const profile of bundledProfiles) {
    byNormalizedName.set(profile.normalizedName, profile);
  }

  const resolvedBundledDir = bundledDir.length > 0 ? path.resolve(bundledDir) : '';
  const resolvedGlobalDir = globalDir.length > 0 ? path.resolve(globalDir) : '';
  const shouldScanGlobal = resolvedGlobalDir.length > 0 && resolvedGlobalDir !== resolvedBundledDir;
  const globalProfiles = shouldScanGlobal ? scanGlobalAgentProfiles(globalDir).profiles : [];
  for (const profile of globalProfiles) {
    // User-managed external agents intentionally override same-name bundled agents.
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

export function isAgentProfileVisibleToSubagentManager(profile: AgentProfile): boolean {
  return profile.source !== 'global' || profile.config?.exposeAsSubagent === true;
}

export function findAgentProfileByName(profiles: AgentProfile[], name: string): AgentProfile | undefined {
  const normalized = normalizeAgentName(name);
  if (!normalized) {
    return undefined;
  }
  return profiles.find((item) => item.normalizedName === normalized);
}
