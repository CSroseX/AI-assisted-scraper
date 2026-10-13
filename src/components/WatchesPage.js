import React, { useState } from 'react';
import AddWatchForm from './AddWatchForm';
import ChangeTimeline from './ChangeTimeline';
import WatchList from './WatchList';
import { useWatches } from '../hooks/useWatches';

// The watchdog's home screen: every watched page, and a form to add one.
// Opening a page's changes shows its timeline in place of the list.
function WatchesPage() {
  const w = useWatches();
  const [openId, setOpenId] = useState(null);
  const open = w.watches.find((watch) => watch.id === openId);

  if (open) {
    return (
      <main className="watches-page">
        <ChangeTimeline watch={open} onBack={() => setOpenId(null)} />
      </main>
    );
  }

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
          onOpenChanges={(watch) => setOpenId(watch.id)}
        />
      )}
    </main>
  );
}

export default WatchesPage;
