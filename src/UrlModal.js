import React, { useState } from 'react';
import './UrlModal.css';

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function UrlModal({ onSubmit }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isValidUrl(input)) {
      setError('');
      onSubmit(input);
    } else {
      setError('Please insert a valid URL');
    }
  };

  return (
    <div className="url-modal-backdrop">
      <div className="url-modal">
        <h2>Enter Page URL</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="https://example.com"
            autoFocus
          />
          {error && <div className="error">{error}</div>}
          <button type="submit">Submit</button>
        </form>
      </div>
    </div>
  );
}

export default UrlModal; 