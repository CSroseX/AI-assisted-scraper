import { useCallback, useEffect, useState } from 'react';
import { clearFeedback, listAlerts, listChanges, setFeedback } from '../api/client';

// One watch's detected changes and the alerts each one queued, plus the
// useful/noise rating of each change.
export function useChangeTimeline(watchId) {
  const [changes, setChanges] = useState([]);
  // Alert status is a footnote on each change, so failing to load it must not
  // hide the changes: null means "couldn't load".
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Change id -> true while its rating is being saved.
  const [saving, setSaving] = useState({});
  // Change id -> why its rating couldn't be saved, shown on that change.
  const [ratingErrors, setRatingErrors] = useState({});
  // Bumped by reload(). An explanation lands on a change a few seconds after
  // it is detected, so a timeline opened in between can fetch it again.
  const [version, setVersion] = useState(0);

  // Another watch's changes must never show, or be rated, under this one.
  useEffect(() => {
    setChanges([]);
    setAlerts([]);
    setSaving({});
    setRatingErrors({});
  }, [watchId]);

  useEffect(() => {
    // A reply for a watch that is no longer shown must not land.
    let current = true;
    setLoading(true);
    setError(null);
    Promise.all([listChanges(watchId), listAlerts(watchId).catch(() => null)])
      .then(([loadedChanges, loadedAlerts]) => {
        if (!current) return;
        setChanges(loadedChanges);
        setAlerts(loadedAlerts);
      })
      .catch((err) => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [watchId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // Choosing the verdict a change already has clears it. The list only shows
  // a rating once the backend has stored it.
  const rate = async (change, vote) => {
    setSaving((s) => ({ ...s, [change.id]: true }));
    setRatingErrors(({ [change.id]: _old, ...rest }) => rest);
    try {
      const next = change.feedback === vote ? null : vote;
      if (next) await setFeedback(watchId, change.id, next);
      else await clearFeedback(watchId, change.id);
      setChanges((list) => list.map((c) => (c.id === change.id ? { ...c, feedback: next } : c)));
    } catch (err) {
      setRatingErrors((e) => ({ ...e, [change.id]: err.message }));
    } finally {
      setSaving(({ [change.id]: _done, ...rest }) => rest);
    }
  };

  return { changes, alerts, loading, error, saving, ratingErrors, reload, rate };
}
