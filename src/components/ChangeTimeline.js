import React, { useMemo } from 'react';
import ChangeCard from './ChangeCard';
import { useChangeTimeline } from '../hooks/useChangeTimeline';

// Every change detected on one watched page, newest first.
function ChangeTimeline({ watch, onBack }) {
  const t = useChangeTimeline(watch.id);

  // Change id -> its alerts, or null for every change when alerts didn't load.
  const alertsByChange = useMemo(() => {
    if (!t.alerts) return null;
    const grouped = {};
    for (const alert of t.alerts) {
      if (!grouped[alert.changeId]) grouped[alert.changeId] = [];
      grouped[alert.changeId].push(alert);
    }
    return grouped;
  }, [t.alerts]);

  return (
    <section className="change-timeline" aria-label={`Changes on ${watch.url}`}>
      <div className="change-timeline-nav">
        <button type="button" onClick={onBack}>← All pages</button>
        <button type="button" onClick={t.reload} disabled={t.loading}>Refresh</button>
      </div>
      <h2>Changes on <a href={watch.url} target="_blank" rel="noopener noreferrer">{watch.url}</a></h2>
      {t.error && <div className="watch-error" role="alert">{t.error}</div>}
      {t.loading && <p>Loading changes…</p>}
      {!t.loading && !t.error && t.changes.length === 0 && (
        <p className="watch-empty">
          No changes detected yet. A change appears here when a check finds the page&apos;s text changed in a way
          that isn&apos;t filtered as noise.
        </p>
      )}
      {t.changes.map((change) => (
        <ChangeCard
          key={change.id}
          watchId={watch.id}
          change={change}
          alerts={alertsByChange ? alertsByChange[change.id] || [] : null}
          saving={!!t.saving[change.id]}
          ratingError={t.ratingErrors[change.id]}
          onRate={t.rate}
        />
      ))}
    </section>
  );
}

export default ChangeTimeline;
