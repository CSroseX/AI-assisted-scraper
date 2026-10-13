import React, { useState } from 'react';
import { isValidUrl } from '../utils/url';

const CHANNELS = [['email', 'Email'], ['rss', 'RSS']];

// "Add a page" form. The backend validates again (including the address
// safety checks), and any reason it gives is shown under the form.
function AddWatchForm({ onAdd }) {
  const [url, setUrl] = useState('');
  const [frequency, setFrequency] = useState('daily');
  const [selector, setSelector] = useState('');
  // Same defaults as the backend: RSS needs no setup, email does.
  const [channels, setChannels] = useState({ email: false, rss: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!isValidUrl(trimmed)) {
      setError('Enter a full address starting with http:// or https://');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        url: trimmed,
        frequency,
        selector: selector.trim() || null,
        alertChannels: CHANNELS.map(([id]) => id).filter((id) => channels[id])
      });
      setUrl('');
      setSelector('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="add-watch" onSubmit={submit} aria-label="Add a page">
      <div className="add-watch-fields">
        <label className="add-watch-url">
          Page URL
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/pricing"
          />
        </label>
        <label>
          Check
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label>
          CSS selector (optional)
          <input
            type="text"
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            placeholder="main"
          />
        </label>
        <fieldset>
          <legend>Alerts</legend>
          {CHANNELS.map(([id, label]) => (
            <label key={id} className="add-watch-channel">
              <input
                type="checkbox"
                checked={channels[id]}
                onChange={(e) => setChannels((c) => ({ ...c, [id]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add page'}</button>
      </div>
      {error && <p className="watch-error" role="alert">{error}</p>}
    </form>
  );
}

export default AddWatchForm;
