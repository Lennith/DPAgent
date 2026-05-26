import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findAgentProfileByName,
  scanBundledAgentProfiles,
  toAgentRuntimeOverrides,
  type AgentProfile,
} from '../../src/agents/AgentProfiles.js';
import { SkillLoader, type SkillCatalogEntry } from '../../src/skills/SkillLoader.js';
import type { AgentRuntimeOverrides } from '../../src/types.js';

const DPAGENT_ASSISTANT_AGENT_NAME = 'dpagent-assistant';

export function resolveDpAgentAssistantProfile(): AgentProfile {
  const profile = findAgentProfileByName(
    scanBundledAgentProfiles().profiles,
    DPAGENT_ASSISTANT_AGENT_NAME
  );
  if (!profile) {
    throw new Error(`Bundled agent not found: ${DPAGENT_ASSISTANT_AGENT_NAME}`);
  }
  return profile;
}

export function resolveDpAgentAssistantRuntimeOverrides(): AgentRuntimeOverrides {
  const overrides = toAgentRuntimeOverrides(resolveDpAgentAssistantProfile());
  if (!overrides) {
    throw new Error(`Failed to build runtime overrides for ${DPAGENT_ASSISTANT_AGENT_NAME}`);
  }
  return overrides;
}

export function resolveDpAgentAssistantSkill(skillName: string): SkillCatalogEntry {
  const profile = resolveDpAgentAssistantProfile();
  const agentSkillDir = path.join(path.dirname(profile.path), 'skill');
  const skill = new SkillLoader().getSkillByName(skillName, {
    agentSkillDir,
    includeGlobalSkills: false,
    includeWorkspaceSkills: false,
    includePackSkills: false,
  });
  if (!skill) {
    throw new Error(`Bundled ${DPAGENT_ASSISTANT_AGENT_NAME} skill not found: ${skillName}`);
  }
  return skill;
}

export function resolveDpAgentAssistantSkillScript(skillName: string, relativeScriptPath: string): string {
  const skill = resolveDpAgentAssistantSkill(skillName);
  const skillDir = path.resolve(skill.skillDir ?? path.dirname(skill.path));
  const scriptPath = path.resolve(skillDir, relativeScriptPath);
  const relative = path.relative(skillDir, scriptPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Skill script resolves outside skill directory: ${relativeScriptPath}`);
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Skill script not found: ${scriptPath}`);
  }
  return scriptPath;
}
