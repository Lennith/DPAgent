export interface LocalFileBrowserRootView {
  path: string;
  label: string;
}

export interface LocalFileBrowserEntryView {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

export interface LocalFileBrowserListView {
  path: string;
  parentPath: string | null;
  entries: LocalFileBrowserEntryView[];
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || response.statusText || `status=${response.status}`);
  }
  return payload;
}

export async function fetchLocalFileRoots(): Promise<LocalFileBrowserRootView[]> {
  const response = await fetch('/api/local-files/roots');
  const payload = await readJsonResponse<{ roots: LocalFileBrowserRootView[] }>(response);
  return payload.roots ?? [];
}

export async function fetchLocalDirectory(path: string): Promise<LocalFileBrowserListView> {
  const params = new URLSearchParams({ path });
  const response = await fetch(`/api/local-files/list?${params.toString()}`);
  return readJsonResponse<LocalFileBrowserListView>(response);
}
