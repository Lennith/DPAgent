import React, { useState, useEffect } from 'react';

interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      const response = await fetch('/api/sessions');
      const data = await response.json() as { sessions: string[] };
      setSessions((data.sessions || []).map(id => ({
        id,
        createdAt: '',
        updatedAt: '',
      })));
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!window.confirm('Are you sure you want to delete this session?')) return;

    try {
      await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      setSessions(sessions.filter((s) => s.id !== sessionId));
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        Loading sessions...
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">Sessions</h2>

      {sessions.length === 0 ? (
        <div className="text-gray-500 text-center py-8">No sessions found</div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="bg-gray-800 rounded-lg p-4 flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-white">{session.id}</div>
              </div>
              <button
                onClick={() => handleDelete(session.id)}
                className="px-3 py-1 text-sm bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={fetchSessions}
        className="mt-4 w-full py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}
