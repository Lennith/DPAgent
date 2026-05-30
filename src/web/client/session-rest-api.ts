import type {
  SessionDetail,
  SessionInfo,
  ArenaConfigView,
  ArenaBranchDetailView,
  ArenaRunView,
  SessionLlmSelectionPatch,
  SessionLlmSelectionView,
} from './app-shell-types.js';
import { appendShareToken, getShareTokenFromLocation } from './shared-access.js';

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || response.statusText || `status=${response.status}`), payload);
  }
  return payload;
}

async function readStrictJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || response.statusText || `status=${response.status}`), payload);
  }
  return payload;
}

export async function fetchSessionList(): Promise<SessionInfo[]> {
  const response = await fetch(appendShareToken('/api/sessions', getShareTokenFromLocation()));
  const data = await readStrictJsonResponse<{ sessions: SessionInfo[] }>(response);
  return (data.sessions || []).map((session) => ({
    ...session,
    isLocalDraft: false,
  }));
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionDetail> {
  const response = await fetch(appendShareToken(`/api/sessions/${sessionId}`, getShareTokenFromLocation()));
  return readStrictJsonResponse<SessionDetail>(response);
}

export async function fetchMcpStatusPayload(): Promise<unknown> {
  const response = await fetch('/api/mcp/status');
  return readStrictJsonResponse<unknown>(response);
}

export async function uploadDroppedSessionFile(
  sessionId: string,
  file: File
): Promise<{ path: string; filename: string; size: number }> {
  const filename = encodeURIComponent(file.name || 'dropped-file');
  const response = await fetch(
    appendShareToken(`/api/sessions/${sessionId}/dropped-files?filename=${filename}`, getShareTokenFromLocation()),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    }
  );
  return readStrictJsonResponse<{ path: string; filename: string; size: number }>(response);
}

export async function patchSessionLlmSelection(
  sessionId: string,
  selection: SessionLlmSelectionPatch
): Promise<{ llmSelection?: SessionLlmSelectionView }> {
  const response = await fetch(appendShareToken(`/api/sessions/${sessionId}/llm-selection`, getShareTokenFromLocation()), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(selection),
  });
  return readStrictJsonResponse<{ llmSelection?: SessionLlmSelectionView }>(response);
}

export async function fetchSessionShareStatus(sessionId: string): Promise<{ active: boolean; expiresAt?: string }> {
  const response = await fetch(`/api/sessions/${sessionId}/share`);
  return readStrictJsonResponse<{ active: boolean; expiresAt?: string }>(response);
}

export async function createSessionShare(sessionId: string): Promise<{ url: string; share: { active: boolean; expiresAt?: string } }> {
  const response = await fetch(`/api/sessions/${sessionId}/share`, { method: 'POST' });
  return readStrictJsonResponse<{ url: string; share: { active: boolean; expiresAt?: string } }>(response);
}

export async function forkSession(sessionId: string): Promise<{ session: SessionInfo }> {
  const response = await fetch(`/api/sessions/${sessionId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return readStrictJsonResponse<{ session: SessionInfo }>(response);
}

export async function createSessionArena(
  sessionId: string,
  input: { prompt: string; config?: Partial<ArenaConfigView> }
): Promise<{ arena: ArenaRunView; lastConfig?: ArenaConfigView }> {
  const response = await fetch(`/api/sessions/${sessionId}/arena`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readStrictJsonResponse<{ arena: ArenaRunView; lastConfig?: ArenaConfigView }>(response);
}

export async function fetchSessionArena(sessionId: string): Promise<{ arena: ArenaRunView | null; lastConfig?: ArenaConfigView }> {
  const response = await fetch(`/api/sessions/${sessionId}/arena`);
  return readStrictJsonResponse<{ arena: ArenaRunView | null; lastConfig?: ArenaConfigView }>(response);
}

export async function fetchArenaBranchDetail(
  arenaId: string,
  branchId: string
): Promise<{ detail: ArenaBranchDetailView }> {
  const response = await fetch(`/api/arena/${arenaId}/branches/${branchId}/detail`);
  return readStrictJsonResponse<{ detail: ArenaBranchDetailView }>(response);
}

export async function postArenaAction(arenaId: string, action: string, body: Record<string, unknown> = {}): Promise<{ arena: ArenaRunView }> {
  const response = await fetch(`/api/arena/${arenaId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readStrictJsonResponse<{ arena: ArenaRunView }>(response);
}

export async function postArenaBranchAction(
  arenaId: string,
  branchId: string,
  action: string
): Promise<{ arena: ArenaRunView }> {
  const response = await fetch(`/api/arena/${arenaId}/branches/${branchId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return readStrictJsonResponse<{ arena: ArenaRunView }>(response);
}

export async function revokeSessionShare(sessionId: string): Promise<{ active: boolean }> {
  const response = await fetch(`/api/sessions/${sessionId}/share`, { method: 'DELETE' });
  return readStrictJsonResponse<{ active: boolean }>(response);
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await readJsonResponse<unknown>(response);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  await readJsonResponse<unknown>(response);
}

export async function exitPlanDraft(sessionId: string, reason?: string): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/plan-draft/exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(reason ? { reason } : {}),
    }),
  });
  await readJsonResponse<unknown>(response);
}

export async function exitPlanExecution(
  sessionId: string,
  mode: 'normal' | 'force',
  reason?: string
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}/plan-execution/exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode,
      ...(reason ? { reason } : {}),
    }),
  });
  await readJsonResponse<unknown>(response);
}
