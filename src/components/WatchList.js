import React from 'react';

const STATUS_LABELS = { active: 'Active', paused: 'Paused', broken: 'Broken' };

const BUSY_LABELS = { checking: 'Checking…', updating: 'Saving…', deleting: 'Deleting…' };

const formatTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// Raw scraper errors can run to many lines of browser logs; the first line
// says what went wrong.
const firstLine = (text) => String(text).split('\n')[0];

function WatchRow({ watch, busy, onCheck, onSetPaused, onDelete, onOpenChanges }) {
  const confirmDelete = () => {
    if (window.confirm(`Stop watching ${watch.url}? Its snapshots and changes are deleted too.`)) {
      onDelete(watch);
    }
  };

  return (
    <tr>
      <td className="watch-url">
        <a href={watch.url} target="_blank" rel="noopener noreferrer">{watch.url}</a>
        {watch.selector && <div className="watch-meta">Selector: <code>{watch.selector}</code></div>}
      </td>
      <td>{watch.frequency === 'weekly' ? 'Weekly' : 'Daily'}</td>
      <td><span className={`watch-status watch-status-${watch.status}`}>{STATUS_LABELS[watch.status] || watch.status}</span></td>
      <td>{formatTime(watch.lastCheckedAt)}</td>
      <td>{watch.status === 'active' ? formatTime(watch.nextCheckAt) : '—'}</td>
      <td>{watch.alertChannels.length ? watch.alertChannels.map((c) => (c === 'rss' ? 'RSS' : 'Email')).join(', ') : 'None'}</td>
      <td className="watch-last-error">{watch.lastError ? firstLine(watch.lastError) : ''}</td>
      <td className="watch-actions">
        {busy ? (
          <span role="status">{BUSY_LABELS[busy]}</span>
        ) : (
          <>
            <button type="button" onClick={() => onOpenChanges(watch)}>Changes</button>
            <button type="button" onClick={() => onCheck(watch)}>Check now</button>
            {watch.status === 'active' ? (
              <button type="button" onClick={() => onSetPaused(watch, true)}>Pause</button>
            ) : (
              <button type="button" onClick={() => onSetPaused(watch, false)}>Resume</button>
            )}
            <button type="button" className="watch-delete" onClick={confirmDelete}>Delete</button>
          </>
        )}
      </td>
    </tr>
  );
}

function WatchList({ watches, busy, onCheck, onSetPaused, onDelete, onOpenChanges }) {
  if (watches.length === 0) {
    return <p className="watch-empty">No pages are watched yet. Add one above.</p>;
  }

  return (
    <div className="watch-table-wrap">
      <table className="watch-table">
        <thead>
          <tr>
            <th>Page</th>
            <th>Checks</th>
            <th>Status</th>
            <th>Last checked</th>
            <th>Next check</th>
            <th>Alerts</th>
            <th>Last error</th>
            <th><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {watches.map((watch) => (
            <WatchRow
              key={watch.id}
              watch={watch}
              busy={busy[watch.id]}
              onCheck={onCheck}
              onSetPaused={onSetPaused}
              onDelete={onDelete}
              onOpenChanges={onOpenChanges}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default WatchList;
