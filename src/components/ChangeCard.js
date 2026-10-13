import React, { useState } from 'react';
import SnapshotCompare from './SnapshotCompare';

// Same wording as the backend's alertContent.js, so a change reads the same
// in the UI, in email and in RSS. A test checks the two still match.
export const CATEGORY_TITLES = {
  price: 'Price change',
  fees: 'Fee change',
  cancellation: 'Cancellation terms changed',
  data_use: 'Data use terms changed',
  cosmetic: 'Wording change',
  layout_change: 'Page redesigned'
};
export const NO_SUMMARY = 'This page changed. No verified summary is available yet; the changed text is below.';

// Why there is no summary, when the change says.
function noSummaryReason(change) {
  if (change.category === 'layout_change') {
    return 'So much of the page changed that it looks like a redesign, so no summary was written.';
  }
  if (change.explainError) return 'The explainer failed, so no summary was written.';
  if (change.explainedAt) return 'The explanation could not be matched to the changed text, so it was not kept.';
  return null;
}

const CHANNEL_LABELS = { email: 'Email', rss: 'RSS' };
const ALERT_STATUS_LABELS = {
  sent: 'sent',
  pending: 'waiting to send',
  failed: 'failed',
  suppressed: 'not sent: same change as a recent alert'
};

// A redesign can change hundreds of paragraphs; the first few say enough
// until asked for the rest.
const PREVIEW_PARAGRAPHS = 6;

function ChangeCard({ watchId, change, alerts, saving, ratingError, onRate }) {
  const [showAll, setShowAll] = useState(false);
  const [compare, setCompare] = useState(false);
  // Once loaded, before/after stays mounted and is only hidden, so toggling
  // it doesn't fetch two full page texts again.
  const [compareOpened, setCompareOpened] = useState(false);
  const when = new Date(change.createdAt).toLocaleString();

  const paragraphs = showAll ? change.diff : change.diff.slice(0, PREVIEW_PARAGRAPHS);
  const hidden = change.diff.length - paragraphs.length;
  const reason = change.summary ? null : noSummaryReason(change);

  return (
    <article className="change-card" aria-label={`Change from ${when}`}>
      <header className="change-head">
        <span className={`change-category change-category-${change.category || 'none'}`}>
          {CATEGORY_TITLES[change.category] || 'Change detected'}
        </span>
        <span>{when}</span>
      </header>

      {change.summary ? (
        <p className="change-summary">{change.summary}</p>
      ) : (
        <p className="change-summary change-unexplained">
          {NO_SUMMARY}
          {reason && ` ${reason}`}
        </p>
      )}

      <h4>What changed ({change.diff.length} {change.diff.length === 1 ? 'paragraph' : 'paragraphs'})</h4>
      <ul className="change-diff">
        {paragraphs.map((p, i) => (
          <li key={i} className={`diff-${p.type}`}>
            <span className="diff-label">{p.type === 'removed' ? 'Removed' : 'Added'}</span>
            <span className="diff-text">{p.text}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setShowAll(true)}>Show all {change.diff.length} paragraphs</button>
      )}

      <div className="change-foot">
        <div className="change-rating" role="group" aria-label="Rate this change">
          {['useful', 'noise'].map((vote) => (
            <button
              key={vote}
              type="button"
              aria-pressed={change.feedback === vote}
              disabled={saving}
              onClick={() => onRate(change, vote)}
            >
              {vote === 'useful' ? 'Useful' : 'Noise'}
            </button>
          ))}
          {ratingError && <span className="watch-error" role="alert">{ratingError}</span>}
        </div>
        <div className="change-alerts">
          {alerts === null && 'Alert status could not be loaded.'}
          {alerts && alerts.length === 0 && 'No alerts were queued.'}
          {alerts && alerts.map((a) => (
            <span key={a.id} title={a.lastError || undefined}>
              {CHANNEL_LABELS[a.channel] || a.channel}: {ALERT_STATUS_LABELS[a.status] || a.status}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => { setCompareOpened(true); setCompare((open) => !open); }}
          aria-expanded={compare}
        >
          {compare ? 'Hide before and after' : 'Show before and after'}
        </button>
      </div>

      {compareOpened && (
        <div hidden={!compare}>
          <SnapshotCompare watchId={watchId} fromSnapshotId={change.fromSnapshotId} toSnapshotId={change.toSnapshotId} />
        </div>
      )}
    </article>
  );
}

export default ChangeCard;
