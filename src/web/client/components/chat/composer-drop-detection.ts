function hasAbsolutePathLikeText(raw: string): boolean {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter((entry) => entry.length > 0);
  if (lines.length === 0) {
    return false;
  }
  return lines.some((line) => {
    if (/^file:\/\//i.test(line)) {
      return true;
    }
    if (/^[A-Za-z]:[\\/]/.test(line) || /^\\\\/.test(line)) {
      return true;
    }
    return line.startsWith('/');
  });
}

export function hasFileLikeDragData(
  transfer: Pick<DataTransfer, 'files' | 'types' | 'getData'>
): boolean {
  if (transfer.files.length > 0) {
    return true;
  }
  const types = Array.from(transfer.types ?? []);
  const hasFilesType = types.some((entry) =>
    entry === 'Files' ||
    entry === 'application/x-moz-file' ||
    entry === 'text/uri-list'
  );
  if (hasFilesType) {
    return true;
  }
  const uriList = transfer.getData('text/uri-list');
  if (String(uriList ?? '').trim().length > 0) {
    return true;
  }
  const plainText = transfer.getData('text/plain');
  return hasAbsolutePathLikeText(plainText);
}
