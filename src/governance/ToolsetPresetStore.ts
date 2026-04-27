import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolsetPresetRecord {
  scope: 'team' | 'workspace';
  toolsetName: string;
  workspaceDir?: string;
  updatedAt: string;
}

interface ToolsetPresetState {
  teamPreset?: ToolsetPresetRecord;
  workspacePresets: Record<string, ToolsetPresetRecord>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ToolsetPresetStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    const resolvedBaseDir = path.resolve(baseDir);
    fs.mkdirSync(resolvedBaseDir, { recursive: true });
    this.filePath = path.join(resolvedBaseDir, 'presets.json');
    if (!fs.existsSync(this.filePath)) {
      this.saveState({ workspacePresets: {} });
    }
  }

  list(): { teamPreset?: ToolsetPresetRecord; workspacePresets: ToolsetPresetRecord[] } {
    const state = this.loadState();
    return {
      teamPreset: state.teamPreset ? { ...state.teamPreset } : undefined,
      workspacePresets: Object.values(state.workspacePresets).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      ),
    };
  }

  getTeamPreset(): ToolsetPresetRecord | undefined {
    const state = this.loadState();
    return state.teamPreset ? { ...state.teamPreset } : undefined;
  }

  getWorkspacePreset(workspaceDir?: string): ToolsetPresetRecord | undefined {
    if (!workspaceDir) {
      return undefined;
    }
    const key = this.normalizeWorkspaceKey(workspaceDir);
    const state = this.loadState();
    const matched = state.workspacePresets[key];
    return matched ? { ...matched } : undefined;
  }

  resolveToolsetName(workspaceDir?: string): { scope: 'team' | 'workspace' | 'none'; toolsetName?: string } {
    const workspacePreset = this.getWorkspacePreset(workspaceDir);
    if (workspacePreset) {
      return {
        scope: 'workspace',
        toolsetName: workspacePreset.toolsetName,
      };
    }
    const teamPreset = this.getTeamPreset();
    if (teamPreset) {
      return {
        scope: 'team',
        toolsetName: teamPreset.toolsetName,
      };
    }
    return { scope: 'none' };
  }

  setTeamPreset(toolsetName: string): ToolsetPresetRecord {
    const normalizedToolsetName = toolsetName.trim();
    const state = this.loadState();
    state.teamPreset = {
      scope: 'team',
      toolsetName: normalizedToolsetName,
      updatedAt: nowIso(),
    };
    this.saveState(state);
    return { ...state.teamPreset };
  }

  clearTeamPreset(): boolean {
    const state = this.loadState();
    if (!state.teamPreset) {
      return false;
    }
    delete state.teamPreset;
    this.saveState(state);
    return true;
  }

  setWorkspacePreset(workspaceDir: string, toolsetName: string): ToolsetPresetRecord {
    const resolvedWorkspaceDir = path.resolve(workspaceDir);
    const state = this.loadState();
    const record: ToolsetPresetRecord = {
      scope: 'workspace',
      workspaceDir: resolvedWorkspaceDir,
      toolsetName: toolsetName.trim(),
      updatedAt: nowIso(),
    };
    state.workspacePresets[this.normalizeWorkspaceKey(resolvedWorkspaceDir)] = record;
    this.saveState(state);
    return { ...record };
  }

  clearWorkspacePreset(workspaceDir: string): boolean {
    const key = this.normalizeWorkspaceKey(workspaceDir);
    const state = this.loadState();
    if (!state.workspacePresets[key]) {
      return false;
    }
    delete state.workspacePresets[key];
    this.saveState(state);
    return true;
  }

  private normalizeWorkspaceKey(workspaceDir: string): string {
    return path.resolve(workspaceDir).toLowerCase();
  }

  private loadState(): ToolsetPresetState {
    if (!fs.existsSync(this.filePath)) {
      return { workspacePresets: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ToolsetPresetState;
      return {
        teamPreset: parsed.teamPreset,
        workspacePresets: parsed.workspacePresets ?? {},
      };
    } catch {
      return { workspacePresets: {} };
    }
  }

  private saveState(state: ToolsetPresetState): void {
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
