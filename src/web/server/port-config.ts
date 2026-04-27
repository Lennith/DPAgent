export const DEFAULT_WEB_PORT = 53721;

export function resolveWebServerPort(rawPort: string | undefined, fallback = DEFAULT_WEB_PORT): number {
  const trimmed = String(rawPort ?? '').trim();
  if (!trimmed) {
    return fallback;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid MINIMAX_PORT: ${trimmed}`);
  }
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MINIMAX_PORT: ${trimmed}`);
  }
  return port;
}
