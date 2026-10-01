import { useCallback, useRef, useState } from 'react';

function createSession(id) {
  return { id, title: '', url: '', messages: [], awaitingUrl: true };
}

export function useSessions() {
  const [sessions, setSessions] = useState(() => [createSession(1)]);
  const [currentSessionId, setCurrentSessionId] = useState(1);
  const nextId = useRef(2);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // `changes` is either a partial object merged into the session, or a function
  // (session) => session for updates that depend on the latest state.
  const updateSession = useCallback((id, changes) => {
    setSessions((all) => all.map((s) => {
      if (s.id !== id) return s;
      return typeof changes === 'function' ? changes(s) : { ...s, ...changes };
    }));
  }, []);

  const addSession = useCallback(() => {
    const id = nextId.current++;
    setSessions((all) => [...all, createSession(id)]);
    setCurrentSessionId(id);
    return id;
  }, []);

  const deleteSession = useCallback((id) => {
    if (sessions.length === 1) return;
    const idx = sessions.findIndex((s) => s.id === id);
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (currentSessionId === id) {
      setCurrentSessionId(remaining[idx > 0 ? idx - 1 : 0].id);
    }
  }, [sessions, currentSessionId]);

  return {
    sessions,
    currentSession,
    currentSessionId,
    selectSession: setCurrentSessionId,
    updateSession,
    addSession,
    deleteSession
  };
}
