function normalizeReference(value: string): string {
  return String(value ?? '').trim();
}

function buildReferenceDedupeKey(reference: string): string {
  if (/^[A-Za-z]:[\\/]/.test(reference) || /^\\\\/.test(reference)) {
    return reference.toLowerCase();
  }
  return reference;
}

export function mergeFileReferences(
  current: string[],
  incoming: string[],
  maxItems = 8
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  const appendReference = (reference: string): void => {
    const normalized = normalizeReference(reference);
    if (!normalized) {
      return;
    }
    const dedupeKey = buildReferenceDedupeKey(normalized);
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    merged.push(normalized);
  };
  for (const reference of current) {
    appendReference(reference);
  }
  for (const reference of incoming) {
    appendReference(reference);
  }
  if (maxItems > 0 && merged.length > maxItems) {
    return merged.slice(merged.length - maxItems);
  }
  return merged;
}

export function composePromptWithFileReferences(prompt: string, references: string[]): string {
  const normalizedPrompt = String(prompt ?? '').trim();
  const normalizedReferences = mergeFileReferences([], references, Number.MAX_SAFE_INTEGER);
  if (normalizedReferences.length === 0) {
    return normalizedPrompt;
  }
  const referenceBlock = [
    '<refs_file_for_this_turn>',
    ...normalizedReferences.map((reference) => `  <file path="${reference.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" />`),
    '</refs_file_for_this_turn>',
  ]
    .join('\n');
  if (!normalizedPrompt) {
    return referenceBlock;
  }
  return `${referenceBlock}\n\n${normalizedPrompt}`;
}
