import React from 'react';
import AddWatchForm from './AddWatchForm';
import WatchList from './WatchList';
import { useWatches } from '../hooks/useWatches';

// The watchdog's home screen: every watched page, and a form to add one.
function WatchesPage() {
  const w = useWatches();

  return (
    <main className="watches-page">
      <h1>Watched pages</h1>
      <AddWatchForm onAdd={w.addWatch} />
      {w.error && (
        <div className="watch-error" role="alert">
          {w.error} <button type="button" onClick={w.reload}>Reload</button>
        </div>
      )}
      {w.notice && <div className="watch-notice" role="status">{w.notice}</div>}
      {w.loading ? (
        <p>Loading watched pages…</p>
      ) : (
        <WatchList
          watches={w.watches}
          busy={w.busy}
          onCheck={w.checkNow}
          onSetPaused={w.setPaused}
          onDelete={w.remove}
        />
      )}
    </main>
  );
}

export default WatchesPage;
