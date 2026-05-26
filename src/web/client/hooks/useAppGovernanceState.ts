import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GovernanceAuditItem,
  MemoryPromotionStateView,
  TodoItem,
} from '../app-shell-types.js';

interface UseAppGovernanceStateOptions {
  currentSessionId: string | null;
  refreshSessions: () => Promise<void>;
}

export function useAppGovernanceState({
  currentSessionId,
  refreshSessions,
}: UseAppGovernanceStateOptions) {
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [auditItems, setAuditItems] = useState<GovernanceAuditItem[]>([]);
  const [memoryPromotionState, setMemoryPromotionState] = useState<MemoryPromotionStateView | null>(null);
  const [memoryOrganizeLoading, setMemoryOrganizeLoading] = useState(false);
  const [memoryOrganizeError, setMemoryOrganizeError] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  const governanceRequestSeqRef = useRef(0);

  const resetGovernanceState = useCallback(() => {
    setTodoItems([]);
    setAuditItems([]);
    setMemoryPromotionState(null);
    setMemoryOrganizeLoading(false);
    setMemoryOrganizeError(null);
  }, []);

  const loadGovernanceState = useCallback(async (sessionId: string) => {
    const requestSeq = governanceRequestSeqRef.current + 1;
    governanceRequestSeqRef.current = requestSeq;
    try {
      const [todoResult, auditResult, memoryResult] = await Promise.allSettled([
        fetch(`/api/todos?sessionId=${encodeURIComponent(sessionId)}`),
        fetch(`/api/audit?sessionId=${encodeURIComponent(sessionId)}&limit=20`),
        fetch(`/api/memory/state?sessionId=${encodeURIComponent(sessionId)}`),
      ]);
      if (governanceRequestSeqRef.current !== requestSeq || currentSessionIdRef.current !== sessionId) {
        return;
      }

      if (todoResult.status === 'fulfilled' && todoResult.value.ok) {
        try {
          const todoPayload = (await todoResult.value.json()) as { items?: TodoItem[] };
          if (governanceRequestSeqRef.current === requestSeq && currentSessionIdRef.current === sessionId) {
            setTodoItems(Array.isArray(todoPayload.items) ? todoPayload.items : []);
          }
        } catch (error) {
          console.error('Failed to parse todos payload:', error);
        }
      } else if (todoResult.status === 'rejected') {
        console.error('Failed to fetch todos:', todoResult.reason);
      } else if (todoResult.status === 'fulfilled') {
        console.error(`Failed to fetch todos: status=${todoResult.value.status}`);
      }

      if (auditResult.status === 'fulfilled' && auditResult.value.ok) {
        const auditPayload = (await auditResult.value.json().catch(() => ({}))) as { items?: GovernanceAuditItem[] };
        if (governanceRequestSeqRef.current === requestSeq && currentSessionIdRef.current === sessionId) {
          setAuditItems(auditPayload.items ?? []);
        }
      } else if (auditResult.status === 'rejected') {
        console.error('Failed to fetch governance audit:', auditResult.reason);
      } else if (auditResult.status === 'fulfilled') {
        console.error(`Failed to fetch governance audit: status=${auditResult.value.status}`);
      }

      if (memoryResult.status === 'fulfilled' && memoryResult.value.ok) {
        const memoryPayload = (await memoryResult.value.json().catch(() => ({}))) as {
          state?: MemoryPromotionStateView | null;
        };
        if (governanceRequestSeqRef.current === requestSeq && currentSessionIdRef.current === sessionId) {
          setMemoryPromotionState(memoryPayload.state ?? null);
          setMemoryOrganizeError(null);
        }
      } else if (memoryResult.status === 'rejected') {
        console.error('Failed to fetch memory state:', memoryResult.reason);
      } else if (memoryResult.status === 'fulfilled') {
        console.error(`Failed to fetch memory state: status=${memoryResult.value.status}`);
      }
    } catch (error) {
      console.error('Failed to fetch governance state:', error);
    }
  }, []);

  const fetchGovernanceState = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      resetGovernanceState();
      return;
    }
    await loadGovernanceState(sessionId);
  }, [loadGovernanceState, resetGovernanceState]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    if (!currentSessionId) {
      resetGovernanceState();
      return;
    }
    void loadGovernanceState(currentSessionId);
  }, [currentSessionId, loadGovernanceState, resetGovernanceState]);

  const handleOrganizeMemory = useCallback(async () => {
    const sessionId = currentSessionId;
    if (!sessionId || memoryOrganizeLoading) {
      return;
    }
    setMemoryOrganizeLoading(true);
    setMemoryOrganizeError(null);
    try {
      const response = await fetch('/api/memory/organize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
      await Promise.all([fetchGovernanceState(sessionId), refreshSessions()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryOrganizeError(message);
      console.error('Failed to organize memory:', error);
    } finally {
      setMemoryOrganizeLoading(false);
    }
  }, [currentSessionId, fetchGovernanceState, memoryOrganizeLoading, refreshSessions]);

  const handleTodoAction = useCallback(async (todoId: string, action: 'dismiss' | 'resume') => {
    const sessionId = currentSessionId;
    if (!sessionId || !todoId) {
      return;
    }
    try {
      const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sessionId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `status=${response.status}`);
      }
      await Promise.all([fetchGovernanceState(sessionId), refreshSessions()]);
    } catch (error) {
      console.error(`Failed to ${action} todo:`, error);
    }
  }, [currentSessionId, fetchGovernanceState, refreshSessions]);

  const handleDismissTodo = useCallback(
    async (todoId: string) => {
      await handleTodoAction(todoId, 'dismiss');
    },
    [handleTodoAction]
  );

  const handleResumeTodo = useCallback(
    async (todoId: string) => {
      await handleTodoAction(todoId, 'resume');
    },
    [handleTodoAction]
  );

  const memoryPendingCount = useMemo(
    () => memoryPromotionState?.pendingTurnCount ?? 0,
    [memoryPromotionState]
  );

  return {
    todoItems,
    auditItems,
    memoryPromotionState,
    memoryOrganizeLoading,
    memoryOrganizeError,
    memoryPendingCount,
    resetGovernanceState,
    fetchGovernanceState,
    handleOrganizeMemory,
    handleDismissTodo,
    handleResumeTodo,
  };
}
