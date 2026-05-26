export interface AsrStatusView {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  state: 'unconfigured' | 'starting' | 'ready' | 'failed' | 'stopped';
  provider: 'local-process';
  modelId: string;
  maxAudioBytes: number;
  secureContextRequired: boolean;
  unavailableReason?: 'disabled';
  error?: {
    code: string;
    message: string;
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || response.statusText || `status=${response.status}`), payload);
  }
  return payload;
}

export async function fetchAsrStatus(): Promise<AsrStatusView> {
  const response = await fetch('/api/asr/status');
  return readJsonResponse<AsrStatusView>(response);
}
