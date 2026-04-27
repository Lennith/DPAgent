import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillCatalogEntry } from './SkillLoader.js';
import { upsertSkillMetadata } from './skill-markdown.js';

export type SkillPackScope = 'team' | 'workspace';

export interface SkillPackVersionRecord {
  version: string;
  description?: string;
  createdAt: string;
  skillCount: number;
  sourceSkillNames: string[];
  directory: string;
}

export interface SkillPackRecord {
  name: string;
  slug: string;
  scope: SkillPackScope;
  workspaceDir?: string;
  description?: string;
  activeVersion?: string;
  versions: SkillPackVersionRecord[];
  updatedAt: string;
}

export interface SkillPackDirectorySource {
  dir: string;
  source: 'team_pack' | 'workspace_pack';
  packName: string;
  packVersion: string;
  packUpdatedAt: string;
}

interface SkillPackRegistryState {
  packs: Record<string, SkillPackRecord>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill-pack';
}

function hashWorkspace(workspaceDir: string): string {
  return crypto.createHash('sha1').update(path.resolve(workspaceDir)).digest('hex').slice(0, 12);
}

function compareVersionStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export class SkillPackStore {
  private readonly baseDir: string;
  private readonly registryFilePath: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.registryFilePath = path.join(this.baseDir, 'registry.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.registryFilePath)) {
      this.saveState({ packs: {} });
    }
  }

  listPacks(filters: { workspaceDir?: string } = {}): SkillPackRecord[] {
    const state = this.loadState();
    return Object.values(state.packs)
      .filter((record) => {
        if (record.scope === 'team') {
          return true;
        }
        if (!filters.workspaceDir) {
          return false;
        }
        return path.resolve(record.workspaceDir ?? '') === path.resolve(filters.workspaceDir);
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  publishPack(input: {
    name: string;
    version: string;
    description?: string;
    scope: SkillPackScope;
    workspaceDir?: string;
    skills: SkillCatalogEntry[];
  }): SkillPackRecord {
    const name = input.name.trim();
    const version = input.version.trim();
    if (!name || !version) {
      throw new Error('name and version are required for pack publishing');
    }
    if (input.skills.length === 0) {
      throw new Error('at least one skill is required for pack publishing');
    }
    const slug = slugify(name);
    const state = this.loadState();
    const key = this.buildPackKey(input.scope, slug, input.workspaceDir);
    const record = state.packs[key] ?? {
      name,
      slug,
      scope: input.scope,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      versions: [],
      updatedAt: nowIso(),
    };
    if (record.versions.some((item) => item.version === version)) {
      throw new Error(`pack version already exists: ${version}`);
    }
    const versionDir = this.resolveVersionDirectory(input.scope, slug, version, input.workspaceDir);
    const skillsDir = path.join(versionDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const skill of input.skills) {
      const targetSkillDir = path.join(skillsDir, slugify(skill.name));
      fs.mkdirSync(targetSkillDir, { recursive: true });
      if (skill.skillDir && fs.existsSync(skill.skillDir)) {
        fs.cpSync(skill.skillDir, targetSkillDir, { recursive: true, force: true });
      } else {
        fs.writeFileSync(path.join(targetSkillDir, 'SKILL.md'), skill.content, 'utf-8');
      }
      const targetPath = path.join(targetSkillDir, 'SKILL.md');
      const nextContent = upsertSkillMetadata(fs.readFileSync(targetPath, 'utf-8'), {
        reviewStatus: 'approved',
        source: input.scope === 'team' ? 'team-pack' : 'workspace-pack',
        packName: name,
        packVersion: version,
      });
      fs.writeFileSync(targetPath, nextContent, 'utf-8');
    }
    const manifest = {
      name,
      scope: input.scope,
      workspaceDir: input.workspaceDir ? path.resolve(input.workspaceDir) : undefined,
      version,
      description: input.description?.trim() || undefined,
      createdAt: nowIso(),
      skillNames: input.skills.map((item) => item.name),
    };
    fs.writeFileSync(path.join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    const versionRecord: SkillPackVersionRecord = {
      version,
      description: input.description?.trim() || undefined,
      createdAt: manifest.createdAt,
      skillCount: input.skills.length,
      sourceSkillNames: manifest.skillNames,
      directory: versionDir,
    };
    record.description = input.description?.trim() || record.description;
    record.versions = [...record.versions, versionRecord].sort((left, right) =>
      compareVersionStrings(left.version, right.version)
    );
    record.activeVersion = version;
    record.updatedAt = nowIso();
    state.packs[key] = record;
    this.saveState(state);
    return this.cloneRecord(record);
  }

  activatePackVersion(input: {
    name: string;
    scope: SkillPackScope;
    version: string;
    workspaceDir?: string;
  }): SkillPackRecord | null {
    const state = this.loadState();
    const key = this.buildPackKey(input.scope, slugify(input.name), input.workspaceDir);
    const record = state.packs[key];
    if (!record || !record.versions.some((item) => item.version === input.version)) {
      return null;
    }
    record.activeVersion = input.version;
    record.updatedAt = nowIso();
    state.packs[key] = record;
    this.saveState(state);
    return this.cloneRecord(record);
  }

  rollbackPack(input: { name: string; scope: SkillPackScope; workspaceDir?: string }): SkillPackRecord | null {
    const state = this.loadState();
    const key = this.buildPackKey(input.scope, slugify(input.name), input.workspaceDir);
    const record = state.packs[key];
    if (!record || record.versions.length < 2) {
      return null;
    }
    const currentIndex = record.versions.findIndex((item) => item.version === record.activeVersion);
    const fallbackIndex = currentIndex <= 0 ? record.versions.length - 2 : currentIndex - 1;
    const fallback = record.versions[fallbackIndex];
    if (!fallback) {
      return null;
    }
    record.activeVersion = fallback.version;
    record.updatedAt = nowIso();
    state.packs[key] = record;
    this.saveState(state);
    return this.cloneRecord(record);
  }

  getActiveSkillDirectories(workspaceDir?: string): SkillPackDirectorySource[] {
    const out: SkillPackDirectorySource[] = [];
    for (const record of this.listPacks({ workspaceDir })) {
      const activeVersion = record.activeVersion;
      if (!activeVersion) {
        continue;
      }
      const version = record.versions.find((item) => item.version === activeVersion);
      if (!version) {
        continue;
      }
      out.push({
        dir: path.join(version.directory, 'skills'),
        source: record.scope === 'team' ? 'team_pack' : 'workspace_pack',
        packName: record.name,
        packVersion: version.version,
        packUpdatedAt: record.updatedAt,
      });
    }
    return out;
  }

  private buildPackKey(scope: SkillPackScope, slug: string, workspaceDir?: string): string {
    if (scope === 'workspace') {
      if (!workspaceDir) {
        throw new Error('workspaceDir is required for workspace skill packs');
      }
      return `${scope}:${hashWorkspace(workspaceDir)}:${slug}`;
    }
    return `${scope}:${slug}`;
  }

  private resolveVersionDirectory(
    scope: SkillPackScope,
    slug: string,
    version: string,
    workspaceDir?: string
  ): string {
    if (scope === 'workspace') {
      return path.join(this.baseDir, scope, hashWorkspace(String(workspaceDir)), slug, version);
    }
    return path.join(this.baseDir, scope, slug, version);
  }

  private loadState(): SkillPackRegistryState {
    if (!fs.existsSync(this.registryFilePath)) {
      return { packs: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryFilePath, 'utf-8')) as SkillPackRegistryState;
      return {
        packs: parsed.packs ?? {},
      };
    } catch {
      return { packs: {} };
    }
  }

  private saveState(state: SkillPackRegistryState): void {
    fs.writeFileSync(this.registryFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  private cloneRecord(record: SkillPackRecord): SkillPackRecord {
    return {
      ...record,
      versions: record.versions.map((item) => ({ ...item })),
    };
  }
}
