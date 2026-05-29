import * as fs from 'fs';
import * as path from 'path';
import { getRuntimePlatformCapabilities } from '../runtime-platform.js';
import { skillLogger } from '../utils/logger.js';
import { parseSkillMarkdown, type ParsedSkillMarkdown } from './skill-markdown.js';

export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  skillDir?: string;
  source: 'native' | 'global' | 'agent' | 'workspace' | 'team_pack' | 'workspace_pack';
  content: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  triggers: string[];
  platforms: string[];
  toolsets: string[];
  reviewStatus?: string;
  version?: string;
  skillSource?: string;
  packName?: string;
  packVersion?: string;
  packUpdatedAt?: string;
}

interface SupplementalSkillDirectory {
  dir: string;
  source: 'team_pack' | 'workspace_pack';
  packName?: string;
  packVersion?: string;
  packUpdatedAt?: string;
}

export interface SkillPromptCapabilities {
  canListOrViewSkills: boolean;
  canManageSkills: boolean;
}

const SKILL_SOURCE_BOUNDARY_LINES = [
  'Skill source boundaries: workspace skills are project-local, agent skills are bundled with the selected agent profile, global skills are shared runtime skills, and native skills are package-bundled read-only baselines.',
];

const DEFAULT_NATIVE_SKILLS_DIR = path.resolve(__dirname, '..', '..', 'skills');

function compareVersionStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export class SkillLoader {
  private skillsDir: string | null = null;
  private nativeSkills: SkillCatalogEntry[] = this.scanDirectoryForSkills(DEFAULT_NATIVE_SKILLS_DIR, 'native');
  private globalSkills: SkillCatalogEntry[] = [];
  private supplementalDirectoriesResolver?: (workspaceDir?: string) => SupplementalSkillDirectory[];

  loadCodexSkills(skillsDir: string): SkillCatalogEntry[] {
    this.skillsDir = path.resolve(skillsDir);
    this.globalSkills = this.scanDirectoryForSkills(this.skillsDir, 'global');
    return [...this.globalSkills];
  }

  reload(): void {
    if (this.skillsDir) {
      this.loadCodexSkills(this.skillsDir);
    }
  }

  setSupplementalDirectoriesResolver(
    resolver: ((workspaceDir?: string) => SupplementalSkillDirectory[]) | undefined
  ): void {
    this.supplementalDirectoriesResolver = resolver;
  }

  getSkillCatalog(options: {
    workspaceDir?: string;
    agentSkillDir?: string;
    includeGlobalSkills?: boolean;
    includeNativeSkills?: boolean;
    includeWorkspaceSkills?: boolean;
    includePackSkills?: boolean;
    toolsetName?: string;
    includeDeprecated?: boolean;
  } = {}): SkillCatalogEntry[] {
    const agentSkills = options.agentSkillDir
      ? this.scanDirectoryForSkills(options.agentSkillDir, 'agent')
      : [];
    const workspaceSkills =
      options.includeWorkspaceSkills !== false && options.workspaceDir
        ? this.scanWorkspaceSkills(options.workspaceDir)
        : [];
    const supplementalSkills =
      options.includePackSkills !== false
        ? (this.supplementalDirectoriesResolver?.(options.workspaceDir) ?? []).flatMap((entry) =>
            this.scanDirectoryForSkills(entry.dir, entry.source, {
              packName: entry.packName,
              packVersion: entry.packVersion,
            })
          )
        : [];
    const all = [
      ...(options.includeNativeSkills === false ? [] : this.nativeSkills),
      ...(options.includeGlobalSkills === false ? [] : this.globalSkills),
      ...supplementalSkills,
      ...agentSkills,
      ...workspaceSkills,
    ];
    const deduped = new Map<string, SkillCatalogEntry>();
    for (const entry of all) {
      if (!options.includeDeprecated && this.isDeprecated(entry)) {
        continue;
      }
      if (!this.matchesPlatform(entry) || !this.matchesToolset(entry, options.toolsetName)) {
        continue;
      }
      const key = entry.name.trim().toLowerCase();
      const existing = deduped.get(key);
      if (!existing || this.compareSkillPrecedence(entry, existing) > 0) {
        deduped.set(key, entry);
      }
    }
    return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  getSkillByName(
    name: string,
    options: {
      workspaceDir?: string;
      agentSkillDir?: string;
      includeGlobalSkills?: boolean;
      includeNativeSkills?: boolean;
      includeWorkspaceSkills?: boolean;
      includePackSkills?: boolean;
      toolsetName?: string;
      includeDeprecated?: boolean;
    } = {}
  ): SkillCatalogEntry | undefined {
    const normalized = name.trim().toLowerCase();
    return this.getSkillCatalog(options).find((entry) => entry.name.trim().toLowerCase() === normalized);
  }

  getCodexSkills(): SkillCatalogEntry[] {
    return [...this.globalSkills];
  }

  getSkillCounts(): { native: number; global: number; total: number } {
    return {
      native: this.nativeSkills.length,
      global: this.globalSkills.length,
      total: this.nativeSkills.length + this.globalSkills.length,
    };
  }

  generateSkillCatalogPrompt(
    options: {
      workspaceDir?: string;
      agentSkillDir?: string;
      includeGlobalSkills?: boolean;
      includeNativeSkills?: boolean;
      includeWorkspaceSkills?: boolean;
      includePackSkills?: boolean;
      toolsetName?: string;
      capabilities?: SkillPromptCapabilities;
    } = {}
  ): string {
    const catalog = this.getSkillCatalog(options);
    const capabilities = options.capabilities ?? {
      canListOrViewSkills: true,
      canManageSkills: true,
    };

    if (!capabilities.canListOrViewSkills) {
      const lines: string[] = [
        '## Skills Runtime',
        'Skill discovery tools are unavailable in the active toolset.',
      ];
      if (catalog.length === 0) {
        lines.push('No approved skills are currently visible for this turn.');
        return lines.join('\n');
      }
      lines.push('Rely only on the catalog summary shown here, and do not assume full skill content is already loaded into context.');
      lines.push(...SKILL_SOURCE_BOUNDARY_LINES);
      lines.push('');
      lines.push('### Skill Catalog');
      for (const entry of catalog.slice(0, 24)) {
        const tags = entry.tags.length > 0 ? ` [tags: ${entry.tags.join(', ')}]` : '';
        lines.push(`- ${entry.name}: ${entry.description}${tags}`);
      }
      if (catalog.length > 24) {
        lines.push(`- ...(${catalog.length - 24} more skills available outside this toolset)`);
      }
      return lines.join('\n');
    }

    if (catalog.length === 0) {
      const lines = [
        '## Skills Runtime',
        'No approved skills are currently available.',
        'You can develop the workflow directly for this turn.',
        ...SKILL_SOURCE_BOUNDARY_LINES,
      ];
      if (capabilities.canManageSkills) {
        lines.push('Use `skill_manage` only to apply reusable workflow skill create/update writes, not to edit selected-agent bundled skills directly.');
        lines.push('If the resulting method proves reusable, capture or update it as an approved skill with `skill_manage`.');
      }
      return lines.join('\n');
    }
    const lines: string[] = [
      '## Skills Runtime',
      'Approved skills are available as on-demand references.',
      'Do not assume full skill content is already loaded into context.',
      'Inspect candidate skills before inventing a workflow.',
      ...SKILL_SOURCE_BOUNDARY_LINES,
      'Use `skills_list` to scan candidates. If one looks relevant, call `skills_view` and rely on the loaded procedure before improvising.',
      '',
      '### Skill Catalog',
    ];
    if (capabilities.canManageSkills) {
      lines.splice(
        5,
        0,
        'Use `skill_manage` only to apply reusable workflow skill create/update writes, not to edit selected-agent bundled skills directly.',
        'When a method proves reusable and `skill_manage` is available, capture or update it as an approved skill.'
      );
    }
    for (const entry of catalog.slice(0, 24)) {
      const tags = entry.tags.length > 0 ? ` [tags: ${entry.tags.join(', ')}]` : '';
      lines.push(`- ${entry.name}: ${entry.description}${tags}`);
    }
    if (catalog.length > 24) {
      lines.push(`- ...(${catalog.length - 24} more skills available via skills_list)`);
    }
    return lines.join('\n');
  }

  generateSkillPrompt(): string {
    return this.generateSkillCatalogPrompt();
  }

  private scanWorkspaceSkills(workspaceDir: string): SkillCatalogEntry[] {
    const skillsDir = path.join(path.resolve(workspaceDir), 'skills');
    return this.scanDirectoryForSkills(skillsDir, 'workspace');
  }

  private scanDirectoryForSkills(
    rootDir: string,
    source: SkillCatalogEntry['source'],
    injectedMetadata: {
      packName?: string;
      packVersion?: string;
      packUpdatedAt?: string;
    } = {}
  ): SkillCatalogEntry[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      if (source === 'global' || source === 'team_pack' || source === 'workspace_pack') {
        skillLogger.warn(`Skills directory not found: ${rootDir}`);
      }
      return [];
    }
    const out: SkillCatalogEntry[] = [];
    const stack = [rootDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) {
        continue;
      }
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const skillFile = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
      if (skillFile) {
        const skillPath = path.join(current, skillFile.name);
        const content = fs.readFileSync(skillPath, 'utf-8');
        const parsed = this.parseSkillMarkdown(content);
        const name = parsed.name || path.basename(current);
        const description =
          parsed.description ||
          (typeof parsed.metadata?.['short-description'] === 'string'
            ? String(parsed.metadata?.['short-description'])
            : '');
        out.push({
          name,
          description,
          path: skillPath,
          skillDir: current,
          source,
          content: parsed.body,
          metadata: parsed.metadata,
          tags: this.readStringArray(parsed.metadata?.tags),
          triggers: this.readStringArray(parsed.metadata?.triggers),
          platforms: this.readStringArray(parsed.metadata?.platforms),
          toolsets: this.readStringArray(parsed.metadata?.toolsets),
          reviewStatus:
            typeof parsed.metadata?.reviewStatus === 'string' ? String(parsed.metadata.reviewStatus) : undefined,
          version: typeof parsed.metadata?.version === 'string' ? String(parsed.metadata.version) : undefined,
          skillSource: typeof parsed.metadata?.source === 'string' ? String(parsed.metadata.source) : undefined,
          packName:
            typeof parsed.metadata?.packName === 'string'
              ? String(parsed.metadata.packName)
              : injectedMetadata.packName,
          packVersion:
            typeof parsed.metadata?.packVersion === 'string'
              ? String(parsed.metadata.packVersion)
              : injectedMetadata.packVersion,
          packUpdatedAt: injectedMetadata.packUpdatedAt,
        });
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name));
        }
      }
    }
    return out.sort((left, right) => left.name.localeCompare(right.name));
  }

  private matchesPlatform(entry: SkillCatalogEntry): boolean {
    if (entry.platforms.length === 0) {
      return true;
    }
    const runtime = getRuntimePlatformCapabilities().platform;
    const aliases =
      runtime === 'win32'
        ? ['windows', 'win32']
        : runtime === 'darwin'
          ? ['darwin', 'macos']
          : ['linux'];
    return entry.platforms.some((platform) => aliases.includes(platform.trim().toLowerCase()));
  }

  private matchesToolset(entry: SkillCatalogEntry, toolsetName?: string): boolean {
    if (entry.toolsets.length === 0 || !toolsetName) {
      return true;
    }
    const normalized = toolsetName.trim().toLowerCase();
    return entry.toolsets.some((item) => item.trim().toLowerCase() === normalized);
  }

  private isDeprecated(entry: SkillCatalogEntry): boolean {
    return String(entry.reviewStatus ?? '').trim().toLowerCase() === 'deprecated';
  }

  private compareSkillPrecedence(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
    const sourcePriorityDiff = this.getSourcePriority(left.source) - this.getSourcePriority(right.source);
    if (sourcePriorityDiff !== 0) {
      return sourcePriorityDiff;
    }
    if (
      (left.source === 'team_pack' || left.source === 'workspace_pack') &&
      (right.source === 'team_pack' || right.source === 'workspace_pack')
    ) {
      const updatedAtDiff = String(left.packUpdatedAt ?? '').localeCompare(String(right.packUpdatedAt ?? ''));
      if (updatedAtDiff !== 0) {
        return updatedAtDiff;
      }
      const versionDiff = compareVersionStrings(String(left.packVersion ?? ''), String(right.packVersion ?? ''));
      if (versionDiff !== 0) {
        return versionDiff;
      }
    }
    const pathDiff = left.path.localeCompare(right.path);
    if (pathDiff !== 0) {
      return pathDiff * -1;
    }
    return String(left.description ?? '').localeCompare(String(right.description ?? '')) * -1;
  }

  private getSourcePriority(source: SkillCatalogEntry['source']): number {
    switch (source) {
      case 'native':
        return 0;
      case 'global':
        return 1;
      case 'team_pack':
        return 2;
      case 'workspace_pack':
        return 3;
      case 'agent':
        return 4;
      case 'workspace':
        return 5;
      default:
        return 0;
    }
  }

  private parseSkillMarkdown(content: string): ParsedSkillMarkdown {
    return parseSkillMarkdown(content);
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => String(item ?? '').trim())
      .filter((item) => item.length > 0);
  }
}

export function createSkillLoader(): SkillLoader {
  return new SkillLoader();
}
