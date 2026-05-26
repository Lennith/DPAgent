import * as os from 'node:os';

function resolveLocalShareHosts(): string[] {
  const hosts: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        hosts.push(address.address);
      }
    }
  }
  return hosts;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function parseHostHeader(hostHeader: string | undefined): { host: string; hostname: string; port: string } | null {
  const host = String(hostHeader ?? '').split(',')[0]?.trim() ?? '';
  if (!host) {
    return null;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return {
      host,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port,
    };
  } catch {
    return null;
  }
}

function buildHostWithPort(hostname: string, port: string): string {
  return port ? `${hostname}:${port}` : hostname;
}

function normalizePublicBaseUrl(value: string | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/g, '');
}

function extractSharePath(url: string): string {
  try {
    const parsed = new URL(url, 'http://dpagent.local');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

export function resolveShareUrlForRequest(input: {
  url: string;
  requestHost?: string;
  protocol?: string;
  configuredPublicBaseUrl?: string;
  localIpv4Addresses?: string[];
  localPort?: number | string;
}): {
  url: string;
  diagnostics: {
    requestHost: string;
    chosenHost: string;
    reason: 'config' | 'trusted_host' | 'lan_fallback' | 'loopback_fallback';
  };
} {
  const sharePath = extractSharePath(input.url);
  const configuredPublicBaseUrl = normalizePublicBaseUrl(input.configuredPublicBaseUrl);
  if (configuredPublicBaseUrl) {
    const configuredUrl = new URL(sharePath.replace(/^\/+/, ''), `${configuredPublicBaseUrl}/`).toString();
    const configuredHost = new URL(configuredUrl).host;
    return {
      url: configuredUrl,
      diagnostics: {
        requestHost: String(input.requestHost ?? ''),
        chosenHost: configuredHost,
        reason: 'config',
      },
    };
  }

  const parsedHost = parseHostHeader(input.requestHost);
  const requestHost = parsedHost?.host ?? String(input.requestHost ?? '');
  const port = parsedHost?.port || (input.localPort ? String(input.localPort) : '');
  const protocol = String(input.protocol ?? 'http').split(',')[0]?.trim() || 'http';
  const localIpv4Addresses = input.localIpv4Addresses ?? resolveLocalShareHosts();
  const normalizedLocalHosts = new Set(localIpv4Addresses.map((item) => item.toLowerCase()));

  if (parsedHost && !isLoopbackHostname(parsedHost.hostname) && normalizedLocalHosts.has(parsedHost.hostname.toLowerCase())) {
    return {
      url: `${protocol}://${parsedHost.host}${sharePath}`,
      diagnostics: {
        requestHost,
        chosenHost: parsedHost.host,
        reason: 'trusted_host',
      },
    };
  }

  const lanHost = localIpv4Addresses[0];
  if (lanHost) {
    const chosenHost = buildHostWithPort(lanHost, port);
    return {
      url: `${protocol}://${chosenHost}${sharePath}`,
      diagnostics: {
        requestHost,
        chosenHost,
        reason: 'lan_fallback',
      },
    };
  }

  const fallbackHost = parsedHost && isLoopbackHostname(parsedHost.hostname) ? parsedHost.host : '';
  return {
    url: fallbackHost ? `${protocol}://${fallbackHost}${sharePath}` : sharePath,
    diagnostics: {
      requestHost,
      chosenHost: fallbackHost,
      reason: 'loopback_fallback',
    },
  };
}
