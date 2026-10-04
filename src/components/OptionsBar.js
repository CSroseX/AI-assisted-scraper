import React from 'react';

const buttonStyle = { display: 'flex', alignItems: 'center', gap: 8 };

function OptionsBar({ onShowScreenshot, onShowScrapedData, onCheckForChanges, checking }) {
  return (
    <div className="options-area">
      <button onClick={onShowScreenshot} style={buttonStyle}>
        <span role="img" aria-label="screenshot">🖼️</span> See Screenshot
      </button>
      <button onClick={onShowScrapedData} style={buttonStyle}>
        <span role="img" aria-label="scraped-data">📄</span> See Scraped Data
      </button>
      <button onClick={onCheckForChanges} disabled={checking} style={buttonStyle}>
        <span role="img" aria-label="watch">🔔</span> {checking ? 'Checking...' : 'Check for Changes'}
      </button>
    </div>
  );
}

export default OptionsBar;
