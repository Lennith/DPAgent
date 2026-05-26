#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

function usage() {
  return [
    'Usage:',
    '  dpagent_share_client.mjs get_history --share-link <url> [--turns 3]',
    '  dpagent_share_client.mjs ask --share-link <url> --text <prompt> [--timeout-ms 120000] [--download-dir <dir>]',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[2] ?? '';
  const out = { command };
  for (let i = 3; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[name] = true;
      continue;
    }
    out[name] = value;
    i += 1;
  }
  return out;
}

function parseShareLink(shareLink) {
  if (!shareLink) {
    throw new Error('--share-link is required');
  }
  const url = new URL(shareLink);
  const marker = '/dpagent-share/';
  const markerIndex = url.pathname.indexOf(marker);
  const token = markerIndex >= 0 ? decodeURIComponent(url.pathname.slice(markerIndex + marker.length)) : '';
  if (!token) {
    throw new Error('Share link must contain /dpagent-share/<token>');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    token,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getHistory(options) {
  const { baseUrl, token } = parseShareLink(options.shareLink);
  const turns = parsePositiveInt(options.turns, 3);
  const response = await fetch(`${baseUrl}/api/share/${encodeURIComponent(token)}/text-history?turns=${turns}`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`history request failed (${response.status}): ${body}`);
  }
  return JSON.parse(body);
}

function buildWsUrl(shareLink) {
  const { baseUrl, token } = parseShareLink(shareLink);
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.searchParams.set('shareToken', token);
  url.searchParams.set('mode', 'text');
  return url.toString();
}

function ask(options) {
  const text = String(options.text ?? '').trim();
  if (!text) {
    throw new Error('--text is required');
  }
  const timeoutMs = parsePositiveInt(options.timeoutMs, 120000);
  const wsUrl = buildWsUrl(options.shareLink);
  const clientMessageId = `skill-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let accumulated = '';
    const fileLinks = [];
    const timer = setTimeout(() => {
      finish(new Error(`ask timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close races after timeout or completion.
      }
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'ask_text',
        data: {
          text,
          clientMessageId,
        },
      }));
    });
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const data = message && typeof message.data === 'object' && message.data !== null ? message.data : {};
      if (message.type === 'text_delta' && typeof data.content === 'string') {
        accumulated += data.content;
        return;
      }
      if (message.type === 'done') {
        const finalText = typeof data.content === 'string' ? data.content : accumulated;
        void downloadFileLinks(options.shareLink, options.downloadDir, fileLinks)
          .then((downloads) => finish(null, formatAnswer(finalText, fileLinks, downloads)))
          .catch((error) => finish(error));
        return;
      }
      if (message.type === 'file_link' && typeof data.href === 'string') {
        fileLinks.push({
          href: data.href,
          displayPath: typeof data.displayPath === 'string' ? data.displayPath : data.href,
          filename: typeof data.filename === 'string' ? data.filename : '',
        });
        return;
      }
      if (message.type === 'busy' || message.type === 'observe_only' || message.type === 'share_invalidated' || message.type === 'error') {
        finish(new Error(String(data.message ?? data.code ?? message.type)));
      }
    });
    ws.on('error', (error) => finish(error));
    ws.on('close', () => {
      if (!settled) {
        finish(new Error('WebSocket closed before DPAgent returned a text answer'));
      }
    });
  });
}

function safeFilename(value, fallback) {
  const candidate = String(value || fallback || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return candidate || 'download';
}

async function downloadFileLinks(shareLink, downloadDir, fileLinks) {
  const targetDir = String(downloadDir ?? '').trim();
  if (!targetDir || fileLinks.length === 0) {
    return [];
  }
  const { baseUrl, token } = parseShareLink(shareLink);
  fs.mkdirSync(targetDir, { recursive: true });
  const downloads = [];
  for (const link of fileLinks) {
    const href = new URL(link.href, baseUrl).toString();
    const response = await fetch(href, {
      headers: {
        'x-dpagent-share-token': token,
      },
    });
    if (!response.ok) {
      throw new Error(`download failed (${response.status}): ${href}`);
    }
    const filename = safeFilename(link.filename, path.basename(new URL(href).pathname) || 'download');
    const targetPath = path.join(targetDir, filename);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, bytes);
    downloads.push({
      href,
      path: targetPath,
      displayPath: link.displayPath,
    });
  }
  return downloads;
}

function formatAnswer(text, fileLinks, downloads = []) {
  const trimmedText = String(text ?? '').trimEnd();
  if (fileLinks.length === 0 && downloads.length === 0) {
    return trimmedText;
  }
  const lines = [
    trimmedText,
    '',
    'Files:',
    ...fileLinks.map((item) => `- ${item.displayPath}: ${item.href}`),
  ];
  if (downloads.length > 0) {
    lines.push(
      '',
      'Downloaded files:',
      ...downloads.map((item) => `- ${item.path}`)
    );
  }
  return lines.join('\n').trimEnd();
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.command !== 'get_history' && options.command !== 'ask') {
    throw new Error(usage());
  }
  if (options.command === 'get_history') {
    const history = await getHistory(options);
    process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
    return;
  }
  const answer = await ask(options);
  process.stdout.write(`${answer}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
