import { useCallback, useEffect, useRef, useState } from 'react';
import { getShareTokenFromLocation } from '../../shared-access.js';
import { buildAgentMentionUrl } from './agent-mention-url.js';

export interface AgentCandidate {
  name: string;
  description: string;
  mtime: string;
}

const DRAFT_SESSION_KEY = '__draft__';

function extractLeadingMentionQuery(value: string): string | null {
  const match = value.match(/^@([^\s]*)/);
  if (!match) {
    return null;
  }
  return String(match[1] ?? '');
}

export function useAgentMention(options: {
  sessionId?: string | null;
  input: string;
  setInput: (value: string) => void;
  disabled: boolean;
}) {
  const { sessionId, input, setInput, disabled } = options;
  const [selectedAgentBySession, setSelectedAgentBySession] = useState<Record<string, AgentCandidate>>({});
  const [mentionError, setMentionError] = useState<string | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<AgentCandidate[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const activeSessionKey = sessionId ?? DRAFT_SESSION_KEY;
  const selectedAgent = selectedAgentBySession[activeSessionKey] ?? null;

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    setSelectedAgentBySession((prev) => {
      const draft = prev[DRAFT_SESSION_KEY];
      if (!draft || prev[sessionId]) {
        return prev;
      }
      const next = { ...prev, [sessionId]: draft };
      delete next[DRAFT_SESSION_KEY];
      return next;
    });
  }, [sessionId]);

  useEffect(() => {
    if (selectedAgent || disabled) {
      setMentionOpen(false);
      setMentionCandidates([]);
      setMentionLoading(false);
      return;
    }

    const query = extractLeadingMentionQuery(input);
    if (query === null) {
      setMentionOpen(false);
      setMentionCandidates([]);
      setMentionLoading(false);
      return;
    }

    const seq = fetchSeqRef.current + 1;
    fetchSeqRef.current = seq;
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;

    setMentionLoading(true);
    setMentionOpen(true);
    const url = buildAgentMentionUrl(query, getShareTokenFromLocation());
    void fetch(url, { signal: controller.signal })
      .then((response) => response.json())
      .then((payload: { agents?: AgentCandidate[] }) => {
        if (fetchSeqRef.current !== seq) {
          return;
        }
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        setMentionCandidates(agents);
        setActiveMentionIndex(0);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        console.error('Failed to load agents:', error);
        if (fetchSeqRef.current !== seq) {
          return;
        }
        setMentionCandidates([]);
      })
      .finally(() => {
        if (fetchSeqRef.current === seq) {
          setMentionLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [input, disabled, selectedAgent]);

  const clearSelectedAgentForCurrentSession = useCallback((): void => {
    setSelectedAgentBySession((prev) => {
      if (!prev[activeSessionKey]) {
        return prev;
      }
      const next = { ...prev };
      delete next[activeSessionKey];
      return next;
    });
  }, [activeSessionKey]);

  const applyAgentSelection = useCallback(
    (agent: AgentCandidate): void => {
      const stripped = input.replace(/^@\S*\s*/, '');
      setInput(stripped);
      setSelectedAgentBySession((prev) => ({
        ...prev,
        [activeSessionKey]: agent,
      }));
      setMentionCandidates([]);
      setMentionOpen(false);
      setActiveMentionIndex(0);
      setMentionError(null);
    },
    [activeSessionKey, input, setInput]
  );

  const closeMention = useCallback((): void => {
    setMentionCandidates([]);
    setMentionOpen(false);
    setActiveMentionIndex(0);
  }, []);

  return {
    selectedAgent,
    mentionError,
    setMentionError,
    mentionCandidates,
    mentionOpen,
    mentionLoading,
    activeMentionIndex,
    setActiveMentionIndex,
    hasMentionCandidate: mentionOpen && mentionCandidates.length > 0,
    clearSelectedAgentForCurrentSession,
    applyAgentSelection,
    closeMention,
  };
}
