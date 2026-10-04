import { useState } from 'react';
import { checkWatch, createWatch, listChanges } from '../api/client';
import { LOADER_TEXT, MESSAGE_TYPES, replaceTrailingLoader } from '../utils/messages';

// Watches the session's URL for changes and reports the result into the chat.
//
// Deliberately thin: it creates a watch for the current URL, runs a check now,
// and shows the newest change. Phase 1 step 7 replaces this with a real
// watchlist and timeline; this exists so the explainer can be seen working.
export function useWatchCheck({ currentSession, currentSessionId, updateSession, notify }) {
  const [checking, setChecking] = useState(false);

  const checkForChanges = async () => {
    if (!currentSession?.url || checking) return;
    const id = currentSessionId;

    const append = (...msgs) => updateSession(id, (s) => ({ ...s, messages: [...s.messages, ...msgs] }));
    const finish = (message) => updateSession(id, (s) => ({
      ...s,
      messages: replaceTrailingLoader(s.messages, LOADER_TEXT.explaining, message)
    }));

    append({ role: 'assistant', content: LOADER_TEXT.explaining, type: MESSAGE_TYPES.loader });
    setChecking(true);

    try {
      // Reuse the watch for this session if we already made one.
      let watchId = currentSession.watchId;
      if (!watchId) {
        const watch = await createWatch(currentSession.url);
        watchId = watch.id;
        updateSession(id, { watchId });
      }

      const result = await checkWatch(watchId);

      // First check only establishes a baseline; there is nothing to compare to.
      if (!result.change) {
        finish({
          role: 'assistant',
          content: result.changed
            ? 'Baseline saved. I will compare against this the next time you check.'
            : 'No changes since the last check.'
        });
        return;
      }

      const [newest] = await listChanges(watchId);
      finish({
        role: 'assistant',
        content: newest?.summary || 'This page changed.',
        type: MESSAGE_TYPES.changeExplanation,
        change: newest
      });
      notify('A change was detected on this page', { toast: true });
    } catch (err) {
      // Reported in the chat rather than via reportError's alert: a failed
      // check is ordinary (logins, bot protection) and should read as an
      // explanation, not an error popup.
      finish({ role: 'assistant', content: `Could not check this page: ${err.message}` });
    } finally {
      setChecking(false);
    }
  };

  return { checking, checkForChanges };
}
