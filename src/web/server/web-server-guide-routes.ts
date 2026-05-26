import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const GUIDE_FILE = 'user-guide.md';
const GUIDE_ASSET_DIR = path.join('assets', 'user-guide');
const GUIDE_ROUTE = '/guide/user-guide';
const GUIDE_ASSET_ROUTE_PREFIX = '/guide/assets/user-guide';

function resolveGuideRoot(): string {
  return path.resolve(__dirname, '../../..', 'doc', 'guide');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugifyHeading(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .replace(/\s+/g, '-');
  return encodeURIComponent(normalized || 'section');
}

function renderInlineMarkdown(input: string): string {
  const code: string[] = [];
  let text = escapeHtml(input).replace(/`([^`]+)`/g, (_match, value: string) => {
    const token = `@@CODE_${code.length}@@`;
    code.push(`<code>${value}</code>`);
    return token;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      const safeHref = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#') || !href.includes(':')
        ? href
        : '#';
      return `<a href="${safeHref}">${label}</a>`;
    });
  code.forEach((value, index) => {
    text = text.replace(`@@CODE_${index}@@`, value);
  });
  return text;
}

function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let listMode: 'ul' | 'ol' | null = null;
  let inFence = false;
  let fenceLang = '';
  let fenceLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (!listMode) return;
    html.push(`</${listMode}>`);
    listMode = null;
  };
  const openList = (mode: 'ul' | 'ol'): void => {
    if (listMode === mode) return;
    closeList();
    html.push(`<${mode}>`);
    listMode = mode;
  };
  const flushFence = (): void => {
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
    html.push(`<pre><code${langClass}>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
    inFence = false;
    fenceLang = '';
    fenceLines = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (inFence) {
        flushFence();
      } else {
        flushParagraph();
        closeList();
        inFence = true;
        fenceLang = String(fence[1] ?? '').trim();
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      flushParagraph();
      closeList();
      html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" loading="lazy" /></figure>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      const title = String(heading[2] ?? '').trim();
      html.push(`<h${level} id="${slugifyHeading(title)}">${renderInlineMarkdown(title)}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      openList('ul');
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      openList('ol');
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  if (inFence) {
    flushFence();
  }
  flushParagraph();
  closeList();
  return html.join('\n');
}

function buildGuidePage(markdown: string): string {
  const body = renderMarkdownToHtml(markdown);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DPAgent 用户指南</title>
  <style>
    :root { color-scheme: light; --fg:#221815; --muted:#6f5d57; --border:#ead6d0; --bg:#fff7f4; --card:#fff; --accent:#e94c43; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif; color:var(--fg); background:linear-gradient(180deg,#fff7f4 0%,#fff 220px); line-height:1.72; }
    main { width:min(980px, calc(100% - 32px)); margin:0 auto; padding:42px 0 72px; }
    article { background:var(--card); border:1px solid var(--border); border-radius:18px; padding:clamp(22px,4vw,54px); box-shadow:0 18px 60px rgba(95,49,38,.08); }
    h1 { font-size:clamp(30px,5vw,46px); line-height:1.14; margin:0 0 22px; }
    h2 { font-size:clamp(23px,3vw,31px); margin:44px 0 14px; padding-top:8px; border-top:1px solid var(--border); }
    h3 { font-size:21px; margin:30px 0 10px; }
    h4 { font-size:18px; margin:24px 0 8px; }
    p { margin:12px 0; }
    a { color:var(--accent); text-decoration:none; border-bottom:1px solid rgba(233,76,67,.25); }
    a:hover { border-bottom-color:var(--accent); }
    ul, ol { padding-left:1.35rem; margin:10px 0 16px; }
    li { margin:6px 0; }
    code { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; font-size:.94em; background:#fff1ed; border:1px solid #ffd8cf; border-radius:6px; padding:.1em .35em; }
    pre { overflow:auto; background:#241815; color:#fff6f2; border-radius:12px; padding:16px; margin:16px 0; }
    pre code { background:transparent; border:0; padding:0; color:inherit; }
    figure { margin:22px 0; }
    img { display:block; max-width:100%; height:auto; border:1px solid var(--border); border-radius:14px; background:#fff; }
    .topbar { width:min(980px, calc(100% - 32px)); margin:0 auto; padding:18px 0 0; color:var(--muted); font-size:14px; }
    .topbar a { color:var(--muted); }
    @media (max-width: 640px) { main { width:min(100% - 18px, 980px); padding-top:20px; } article { border-radius:14px; padding:20px 16px 34px; } }
  </style>
</head>
<body>
  <div class="topbar"><a href="/">返回 DPAgent</a></div>
  <main><article>${body}</article></main>
</body>
</html>`;
}

function readUserGuideMarkdown(): string {
  const guidePath = path.join(resolveGuideRoot(), GUIDE_FILE);
  return fs.readFileSync(guidePath, 'utf8');
}

function sendGuideAsset(req: Request, res: Response): void {
  const filename = path.basename(String(req.params.file ?? ''));
  if (!filename || filename !== String(req.params.file ?? '') || !/^[A-Za-z0-9._-]+\.svg$/i.test(filename)) {
    res.status(404).send('Not found');
    return;
  }
  const assetPath = path.join(resolveGuideRoot(), GUIDE_ASSET_DIR, filename);
  if (!fs.existsSync(assetPath)) {
    res.status(404).send('Not found');
    return;
  }
  res.type('image/svg+xml').sendFile(assetPath);
}

export function registerGuideRoutes(app: express.Express): void {
  app.get('/guide', (_req: Request, res: Response) => {
    res.redirect(GUIDE_ROUTE);
  });
  app.get(GUIDE_ROUTE, (_req: Request, res: Response) => {
    try {
      res.type('html').send(buildGuidePage(readUserGuideMarkdown()));
    } catch (error) {
      res.status(500).type('text').send(error instanceof Error ? error.message : String(error));
    }
  });
  app.get(`${GUIDE_ASSET_ROUTE_PREFIX}/:file`, sendGuideAsset);
}
