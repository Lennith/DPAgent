export interface ChatDisplayFilters {
  showThinking: boolean;
  showToolCall: boolean;
  showToolResult: boolean;
}

export const CHAT_DISPLAY_FILTER_STORAGE_KEY = 'dpagent.chat.displayFilters.v1';

export const DEFAULT_CHAT_DISPLAY_FILTERS: ChatDisplayFilters = {
  showThinking: true,
  showToolCall: true,
  showToolResult: true,
};

export function normalizeChatDisplayFilters(value: unknown): ChatDisplayFilters {
  if (!value || typeof value !== 'object') {
    return DEFAULT_CHAT_DISPLAY_FILTERS;
  }
  const record = value as Partial<Record<keyof ChatDisplayFilters, unknown>>;
  return {
    showThinking:
      typeof record.showThinking === 'boolean'
        ? record.showThinking
        : DEFAULT_CHAT_DISPLAY_FILTERS.showThinking,
    showToolCall:
      typeof record.showToolCall === 'boolean'
        ? record.showToolCall
        : DEFAULT_CHAT_DISPLAY_FILTERS.showToolCall,
    showToolResult:
      typeof record.showToolResult === 'boolean'
        ? record.showToolResult
        : DEFAULT_CHAT_DISPLAY_FILTERS.showToolResult,
  };
}

export function loadChatDisplayFilters(): ChatDisplayFilters {
  if (typeof window === 'undefined') {
    return DEFAULT_CHAT_DISPLAY_FILTERS;
  }
  try {
    const raw = window.localStorage.getItem(CHAT_DISPLAY_FILTER_STORAGE_KEY);
    return normalizeChatDisplayFilters(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_CHAT_DISPLAY_FILTERS;
  }
}

export function saveChatDisplayFilters(filters: ChatDisplayFilters): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(CHAT_DISPLAY_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Ignore storage failures. The filters remain valid for the current render.
  }
}
