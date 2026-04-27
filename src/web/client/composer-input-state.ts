export const COMPOSER_DRAFT_KEY = '__draft__';

export type ComposerInputBySession = Record<string, string>;

export function resolveComposerInputKey(sessionId: string | null | undefined): string {
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  return trimmed.length > 0 ? trimmed : COMPOSER_DRAFT_KEY;
}

export function getComposerInput(
  inputBySession: ComposerInputBySession,
  sessionId: string | null | undefined
): string {
  const key = resolveComposerInputKey(sessionId);
  return inputBySession[key] ?? '';
}

export function setComposerInput(
  inputBySession: ComposerInputBySession,
  sessionId: string | null | undefined,
  value: string
): ComposerInputBySession {
  const key = resolveComposerInputKey(sessionId);
  if (value.length === 0) {
    if (!(key in inputBySession)) {
      return inputBySession;
    }
    const next = { ...inputBySession };
    delete next[key];
    return next;
  }
  if (inputBySession[key] === value) {
    return inputBySession;
  }
  return {
    ...inputBySession,
    [key]: value,
  };
}

export function clearComposerInput(
  inputBySession: ComposerInputBySession,
  sessionId: string | null | undefined
): ComposerInputBySession {
  return setComposerInput(inputBySession, sessionId, '');
}

export function removeComposerInput(
  inputBySession: ComposerInputBySession,
  sessionId: string | null | undefined
): ComposerInputBySession {
  const key = resolveComposerInputKey(sessionId);
  if (!(key in inputBySession)) {
    return inputBySession;
  }
  const next = { ...inputBySession };
  delete next[key];
  return next;
}
