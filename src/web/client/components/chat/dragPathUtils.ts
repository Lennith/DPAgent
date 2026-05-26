export interface DroppedPathBuildInput {
  uriList?: string;
  plainText?: string;
  filePath?: string | null;
  filePaths?: Array<string | null | undefined>;
  fileName?: string | null;
  fileNames?: Array<string | null | undefined>;
  isWindows?: boolean;
}

export interface DroppedPathBuildResult {
  text: string;
  resolved: boolean;
  source: 'uri' | 'file_path' | 'plain_text' | 'filename' | 'none';
  references: string[];
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

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function toFileReferenceLine(path: string): string {
  return `@file ${path}`;
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

function extractFileUris(uriListRaw: string): string[] {
  return String(uriListRaw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && /^file:\/\//i.test(line));
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

function isLikelyAbsolutePath(value: string, isWindows: boolean): boolean {
  if (!value) {
    return false;
  }
  if (isWindows) {
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }
  return value.startsWith('/');
}

function extractPlainTextPaths(plainText: string, isWindows: boolean): string[] {
  const lines = String(plainText ?? '')
    .split(/\r?\n/)
    .map((line) => stripWrappingQuotes(line.trim()))
    .filter((line) => line.length > 0);
  const results: string[] = [];
  for (const line of lines) {
    if (/^file:\/\//i.test(line)) {
      const normalized = normalizeFileUriToNativePath(line, isWindows);
      if (normalized) {
        results.push(normalized);
      }
      continue;
    }
    if (isLikelyAbsolutePath(line, isWindows)) {
      results.push(normalizeFilePath(line, isWindows));
    }
  }
  return results;
}

export function buildDroppedPathInsertion(input: DroppedPathBuildInput): DroppedPathBuildResult {
  const isWindows = input.isWindows === true;
  const references: string[] = [];
  const seen = new Set<string>();
  let firstSource: DroppedPathBuildResult['source'] = 'none';

  const pushReference = (pathLike: string, source: DroppedPathBuildResult['source']): void => {
    const trimmed = stripWrappingQuotes(String(pathLike ?? '').trim());
    if (!trimmed) {
      return;
    }
    const normalized = source === 'uri' ? trimmed : normalizeFilePath(trimmed, isWindows);
    const dedupeKey = isWindows ? normalized.toLowerCase() : normalized;
    if (seen.has(dedupeKey)) {
      return;
    }
    if (firstSource === 'none') {
      firstSource = source;
    }
    seen.add(dedupeKey);
    references.push(normalized);
  };

  const uriList = String(input.uriList ?? '');
  const uriCandidates = extractFileUris(uriList);
  for (const uri of uriCandidates) {
    const normalized = normalizeFileUriToNativePath(uri, isWindows);
    if (normalized) {
      pushReference(normalized, 'uri');
    }
  }

  const filePathCandidates = [
    ...(input.filePaths ?? []),
    input.filePath ?? null,
  ];
  for (const filePathCandidate of filePathCandidates) {
    const filePath = String(filePathCandidate ?? '').trim();
    if (filePath.length > 0) {
      pushReference(filePath, 'file_path');
    }
  }

  const plainTextCandidates = extractPlainTextPaths(String(input.plainText ?? ''), isWindows);
  for (const candidate of plainTextCandidates) {
    pushReference(candidate, 'plain_text');
  }

  if (references.length > 0) {
    return {
      text: references.map((path) => toFileReferenceLine(path)).join('\n'),
      resolved: true,
      source: firstSource,
      references,
    };
  }

  const fileNameCandidates = [
    ...(input.fileNames ?? []),
    input.fileName ?? null,
  ];
  const fallbackNames = fileNameCandidates
    .map((name) => stripWrappingQuotes(String(name ?? '').trim()))
    .filter((name) => name.length > 0)
    .filter((name, index, list) => list.indexOf(name) === index);

  if (fallbackNames.length > 0) {
    return {
      text: '',
      resolved: false,
      source: 'filename',
      references: [],
    };
  }

  return {
    text: '',
    resolved: false,
    source: 'none',
    references: [],
  };
}
