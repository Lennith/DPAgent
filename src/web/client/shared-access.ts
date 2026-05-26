export function getShareTokenFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/dpagent-share\/([^/]+)/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1]?.trim() || null;
  }
}

export function appendShareToken(url: string, token: string | null): string {
  if (!token) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}shareToken=${encodeURIComponent(token)}`;
}
