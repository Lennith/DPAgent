import type {
  AgentProfileConfigView,
  ReasoningPreset,
} from '../app-shell-types.js';

export interface AgentConfigDraft {
  description: string;
  llmProfileId: string;
  llmModel: string;
  reasoningPreset: '' | ReasoningPreset;
  loadGlobalSkills: boolean;
  exposeAsSubagent: boolean;
  promptAppend: string;
}

export function createAgentConfigDraft(config?: AgentProfileConfigView): AgentConfigDraft {
  return {
    description: config?.description ?? '',
    llmProfileId: config?.llmProfileId ?? '',
    llmModel: config?.llmModel ?? '',
    reasoningPreset: config?.reasoningPreset ?? '',
    loadGlobalSkills: config?.loadGlobalSkills !== false,
    exposeAsSubagent: config?.exposeAsSubagent === true,
    promptAppend: config?.promptAppend ?? '',
  };
}

export function agentConfigDraftToPayload(draft: AgentConfigDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = { version: 1 };
  const description = draft.description.trim();
  if (description) payload.description = description;
  const llmProfileId = draft.llmProfileId.trim();
  if (llmProfileId) payload.llmProfileId = llmProfileId;
  const llmModel = draft.llmModel.trim();
  if (llmModel) payload.llmModel = llmModel;
  if (draft.reasoningPreset) payload.reasoningPreset = draft.reasoningPreset;
  if (draft.loadGlobalSkills === false) payload.loadGlobalSkills = false;
  if (draft.exposeAsSubagent === true) payload.exposeAsSubagent = true;
  const promptAppend = draft.promptAppend.trim();
  if (promptAppend) payload.promptAppend = promptAppend;
  return payload;
}
