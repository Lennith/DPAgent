import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  FALLBACK_WORKSPACE_DIR,
  loadDefaultWorkspaceFromStorage,
  normalizeWorkspaceDir,
  resolveDefaultWorkspaceDir,
  saveDefaultWorkspaceToStorage,
} from '../workspace-preferences.js';
import type { LlmProfilesConfigView } from '../app-shell-types.js';

export interface AppWorkspaceState {
  workspaceDir: string;
  setWorkspaceDir: Dispatch<SetStateAction<string>>;
  defaultWorkspaceDir: string;
  setDefaultWorkspaceDir: Dispatch<SetStateAction<string>>;
  saveAsDefaultWorkspace: boolean;
  setSaveAsDefaultWorkspace: Dispatch<SetStateAction<boolean>>;
  showWorkspaceModal: boolean;
  setShowWorkspaceModal: Dispatch<SetStateAction<boolean>>;
  showConfigModal: boolean;
  setShowConfigModal: Dispatch<SetStateAction<boolean>>;
  hasApiKey: boolean;
  setHasApiKey: Dispatch<SetStateAction<boolean>>;
  llmProfiles: LlmProfilesConfigView | null;
  contextWindowChars: number;
  refreshConfig: () => Promise<void>;
  openWorkspaceModal: () => void;
  confirmWorkspaceSelection: () => string;
}

export function useAppWorkspaceState(): AppWorkspaceState {
  const [initialWorkspaceBootstrap] = useState(
    () => loadDefaultWorkspaceFromStorage() ?? FALLBACK_WORKSPACE_DIR
  );
  const [workspaceDir, setWorkspaceDir] = useState(initialWorkspaceBootstrap);
  const [defaultWorkspaceDir, setDefaultWorkspaceDir] = useState(initialWorkspaceBootstrap);
  const [saveAsDefaultWorkspace, setSaveAsDefaultWorkspace] = useState(false);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [llmProfiles, setLlmProfiles] = useState<LlmProfilesConfigView | null>(null);
  const [contextWindowChars, setContextWindowChars] = useState(230000);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/config');
      const config = await response.json();
      setHasApiKey(Boolean(config?.hasApiKey));
      setLlmProfiles((config?.llmProfiles as LlmProfilesConfigView | undefined) ?? null);
      const nextContextWindowChars = Number(config?.agent?.contextWindowChars);
      setContextWindowChars(
        Number.isFinite(nextContextWindowChars) && nextContextWindowChars > 0
          ? Math.floor(nextContextWindowChars)
          : 230000
      );
      const storedDefaultWorkspaceDir = loadDefaultWorkspaceFromStorage();
      const configuredWorkspaceDir = String(config?.agent?.workspaceDir ?? '').trim();
      const preferredWorkspaceDir = resolveDefaultWorkspaceDir({
        storedWorkspaceDir: storedDefaultWorkspaceDir,
        configuredWorkspaceDir,
        fallbackWorkspaceDir: FALLBACK_WORKSPACE_DIR,
      });
      setDefaultWorkspaceDir(preferredWorkspaceDir);
      setWorkspaceDir((prev) => normalizeWorkspaceDir(prev) ?? preferredWorkspaceDir);
      if (!config?.hasApiKey) {
        setShowConfigModal(true);
      }
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  const openWorkspaceModal = useCallback(() => {
    setSaveAsDefaultWorkspace(false);
    setShowWorkspaceModal(true);
  }, []);

  const confirmWorkspaceSelection = useCallback(() => {
    const selectedWorkspaceDir =
      normalizeWorkspaceDir(workspaceDir) ??
      normalizeWorkspaceDir(defaultWorkspaceDir) ??
      FALLBACK_WORKSPACE_DIR;
    setWorkspaceDir(selectedWorkspaceDir);
    if (saveAsDefaultWorkspace) {
      setDefaultWorkspaceDir(selectedWorkspaceDir);
      saveDefaultWorkspaceToStorage(selectedWorkspaceDir);
    }
    setShowWorkspaceModal(false);
    setSaveAsDefaultWorkspace(false);
    return selectedWorkspaceDir;
  }, [defaultWorkspaceDir, saveAsDefaultWorkspace, workspaceDir]);

  return {
    workspaceDir,
    setWorkspaceDir,
    defaultWorkspaceDir,
    setDefaultWorkspaceDir,
    saveAsDefaultWorkspace,
    setSaveAsDefaultWorkspace,
    showWorkspaceModal,
    setShowWorkspaceModal,
    showConfigModal,
    setShowConfigModal,
    hasApiKey,
    setHasApiKey,
    llmProfiles,
    contextWindowChars,
    refreshConfig,
    openWorkspaceModal,
    confirmWorkspaceSelection,
  };
}
