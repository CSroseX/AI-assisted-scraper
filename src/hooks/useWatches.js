import { useCallback, useEffect, useRef, useState } from 'react';
import { checkWatch, createWatch, deleteWatch, listWatches, updateWatch } from '../api/client';

// Plain words for what a manual check found. The API answers a first
// snapshot and a change filtered out as noise the same way, so one message
// covers both.
function describeCheck(result) {
  if (!result.changed) return 'No change since the last snapshot.';
  if (result.change) return 'A change was detected. It is now in this page\'s changes.';
  return 'Saved a new snapshot. Nothing to alert on: it is the first snapshot, or the change was only noise.';
}

// The watch list and every action on it. The backend owns each watch's state
// (status, next check, last error), so every action reloads the list instead
// of patching it locally.
export function useWatches() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Watch id -> the action running on it, so its row can show progress.
  const [busy, setBusy] = useState({});
  // Actions on different rows can overlap, and so can their reloads. Only the
  // newest reload may set the list, or an older reply could bring back a
  // watch that was just deleted.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    try {
      const list = await listWatches();
      if (id === latestLoad.current) setWatches(list);
    } catch (err) {
      if (id === latestLoad.current) setError(err.message);
    } finally {
      if (id === latestLoad.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const reload = () => {
    setError(null);
    return load();
  };

  // Runs one row action and reports its outcome, naming the page because
  // actions on several rows can run at once. A failure is kept on screen, not
  // swallowed: the list reloads first, then the error is set so the reload
  // can't clear it.
  const run = async (watch, action, work) => {
    setBusy((b) => ({ ...b, [watch.id]: action }));
    let message = null;
    let failure = null;
    try {
      message = await work();
    } catch (err) {
      failure = err.message;
    }
    await load();
    setError(failure && `${watch.url}: ${failure}`);
    setNotice(message && `${watch.url}: ${message}`);
    setBusy(({ [watch.id]: _done, ...rest }) => rest);
  };

  // Throws on failure so the form can show the API's reason next to itself.
  const addWatch = async ({ url, frequency, selector, alertChannels }) => {
    await createWatch(url, frequency, selector, alertChannels);
    setError(null);
    setNotice(`Added ${url}. The first snapshot is taken on the next scheduler pass.`);
    await load();
  };

  const checkNow = (watch) => run(watch, 'checking', async () => describeCheck(await checkWatch(watch.id)));

  const setPaused = (watch, paused) =>
    run(watch, 'updating', async () => {
      await updateWatch(watch.id, { status: paused ? 'paused' : 'active' });
      return paused ? 'Paused.' : 'Resumed. It is checked again on the next scheduler pass.';
    });

  const remove = (watch) =>
    run(watch, 'deleting', async () => {
      await deleteWatch(watch.id);
      return 'Deleted, with its snapshots and changes.';
    });

  return { watches, loading, error, notice, busy, reload, addWatch, checkNow, setPaused, remove };
}
