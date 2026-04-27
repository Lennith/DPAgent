const TOKEN_SPLIT_REGEX = /[^a-z0-9\u4e00-\u9fff]+/i;
const COMMAND_LINE_REGEX =
  /^(npm|pnpm|yarn|node|python|pip|uv|git|npx|powershell|pwsh|write-output|get-childitem|set-location|cd|mkdir|copy|move|del|rm|cat|type)\b/i;
const CHECKLIST_REGEX = /^(\d+[\.)]|[-*])\s+/;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'to',
  'of',
  'for',
  'in',
  'on',
  'with',
  'this',
  'that',
  'these',
  'those',
  'please',
  'need',
  'help',
  'from',
  'into',
  'your',
  'my',
  'our',
  'use',
  'using',
  'run',
  'make',
  'task',
  'workflow',
  'project',
  'workspace',
  'agent',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeWorkflowText(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export function tokenizeWorkflowText(value: string): string[] {
  return Array.from(
    new Set(
      normalizeWorkflowText(value)
        .split(TOKEN_SPLIT_REGEX)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 && !STOPWORDS.has(item))
    )
  );
}

export function containsAnyPhrase(value: string, phrases: string[]): boolean {
  const haystack = normalizeWorkflowText(value);
  return phrases.some((phrase) => haystack.includes(normalizeWorkflowText(phrase)));
}

export function extractCommandCandidates(value: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    const normalized = normalizeWhitespace(candidate);
    if (normalized.length < 4) {
      return;
    }
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) {
      return;
    }
    seen.add(lower);
    commands.push(normalized);
  };

  const fencedMatches = value.match(/`([^`\r\n]{4,200})`/g) ?? [];
  for (const raw of fencedMatches) {
    push(raw.slice(1, -1));
  }

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (COMMAND_LINE_REGEX.test(trimmed)) {
      push(trimmed);
    }
  }

  return commands.slice(0, 8);
}

export function extractChecklistItems(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!CHECKLIST_REGEX.test(trimmed)) {
      continue;
    }
    const normalized = normalizeWhitespace(trimmed.replace(CHECKLIST_REGEX, ''));
    const lower = normalized.toLowerCase();
    if (!normalized || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    out.push(normalized);
  }
  return out.slice(0, 8);
}

export function looksLikeFailure(value: string): boolean {
  return containsAnyPhrase(value, [
    'error',
    'failed',
    'failure',
    'unknown tool',
    'exception',
    'not found',
    'cannot',
    'traceback',
    '\u9519\u8bef',
    '\u5931\u8d25',
    '\u5f02\u5e38',
    '\u627e\u4e0d\u5230',
  ]);
}

export function slugifyWorkflowText(value: string, fallback = 'workflow', maxLength = 48): string {
  const slug = tokenizeWorkflowText(value)
    .slice(0, 8)
    .join('-')
    .replace(/^-+|-+$/g, '');
  const normalized = slug.length > 0 ? slug : fallback;
  return normalized.slice(0, maxLength).replace(/-+$/g, '') || fallback;
}

export function buildPromptFingerprint(prompt: string, commands: string[] = []): string {
  const tokens = tokenizeWorkflowText(prompt).slice(0, 8);
  const commandToken = commands.length > 0 ? slugifyWorkflowText(commands[0], 'cmd', 24) : '';
  const fingerprint = [...tokens, commandToken].filter((item) => item.length > 0).join('-');
  return fingerprint || 'workflow';
}
