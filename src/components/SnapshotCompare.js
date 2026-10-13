import React, { useEffect, useState } from 'react';
import { getSnapshot, snapshotScreenshotUrl } from '../api/client';

function SnapshotSide({ watchId, label, snapshot }) {
  return (
    <div className="snapshot-side">
      <h4>{label}, captured {new Date(snapshot.createdAt).toLocaleString()}</h4>
      {snapshot.screenshotPath ? (
        // Full-page captures of long terms pages run to thousands of pixels,
        // so each one scrolls inside its own frame.
        <div className="snapshot-shot">
          <img src={snapshotScreenshotUrl(watchId, snapshot.id)} alt={`Screenshot ${label.toLowerCase()} the change`} />
        </div>
      ) : (
        <p className="snapshot-missing">No screenshot was captured.</p>
      )}
      <details>
        <summary>Full text</summary>
        <pre className="snapshot-text">{snapshot.content}</pre>
      </details>
    </div>
  );
}

// The page before and after a change: screenshot and full captured text.
// Loaded only when opened, since full texts can be long.
function SnapshotCompare({ watchId, fromSnapshotId, toSnapshotId }) {
  const [sides, setSides] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    Promise.all([getSnapshot(watchId, fromSnapshotId), getSnapshot(watchId, toSnapshotId)])
      .then(([before, after]) => { if (current) setSides({ before, after }); })
      .catch((err) => { if (current) setError(err.message); });
    return () => { current = false; };
  }, [watchId, fromSnapshotId, toSnapshotId]);

  if (error) return <p className="watch-error" role="alert">{error}</p>;
  if (!sides) return <p>Loading before and after…</p>;
  return (
    <div className="snapshot-compare">
      <SnapshotSide watchId={watchId} label="Before" snapshot={sides.before} />
      <SnapshotSide watchId={watchId} label="After" snapshot={sides.after} />
    </div>
  );
}

export default SnapshotCompare;
