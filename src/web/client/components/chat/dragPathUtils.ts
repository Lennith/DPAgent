export interface DroppedPathBuildInput {
  uriList?: string;
  filePath?: string | null;
  fileName?: string | null;
  isWindows?: boolean;
}

export interface DroppedPathBuildResult {
  text: string;
  resolved: boolean;
  source: 'uri' | 'file_path' | 'filename' | 'none';
}

function isLocalhost(hostname: string): boolean {
  return hostname.toLowerCase() === 'localhost' || hostname === '';
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractFirstFileUri(uriListRaw: string): string | null {
  const lines = String(uriListRaw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const first = lines[0];
  if (!first || !/^file:\/\//i.test(first)) {
    return null;
  }
  return first;
}

export function normalizeFileUriToNativePath(uri: string, isWindows: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') {
    return null;
  }

  const host = decodeUriComponentSafe(parsed.hostname);
  let pathname = decodeUriComponentSafe(parsed.pathname);
  if (!pathname && host) {
    return null;
  }

  if (isWindows) {
    if (!isLocalhost(host)) {
      const sharePath = pathname.replace(/\//g, '\\');
      return `\\\\${host}${sharePath}`;
    }
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    const nativePath = pathname.replace(/\//g, '\\');
    return nativePath || null;
  }

  return pathname || null;
}

function normalizeFilePath(filePath: string, isWindows: boolean): string {
  if (!isWindows) {
    return filePath;
  }
  return filePath.replace(/\//g, '\\');
}

export function buildDroppedPathInsertion(input: DroppedPathBuildInput): DroppedPathBuildResult {
  const isWindows = input.isWindows === true;

  const firstUri = extractFirstFileUri(String(input.uriList ?? ''));
  if (firstUri) {
    const uriPath = normalizeFileUriToNativePath(firstUri, isWindows);
    if (uriPath && uriPath.trim().length > 0) {
      return {
        text: `\`${uriPath}\``,
        resolved: true,
        source: 'uri',
      };
    }
  }

  const filePath = String(input.filePath ?? '').trim();
  if (filePath.length > 0) {
    const nativePath = normalizeFilePath(filePath, isWindows);
    return {
      text: `\`${nativePath}\``,
      resolved: true,
      source: 'file_path',
    };
  }

  const fileName = String(input.fileName ?? '').trim();
  if (fileName.length > 0) {
    return {
      text: `\`${fileName}\` [unresolved_path]`,
      resolved: false,
      source: 'filename',
    };
  }

  return {
    text: '',
    resolved: false,
    source: 'none',
  };
}
