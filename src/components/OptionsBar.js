import React from 'react';

const buttonStyle = { display: 'flex', alignItems: 'center', gap: 8 };

function OptionsBar({ onShowScreenshot, onShowScrapedData, onShowHistory, hasHistory }) {
  return (
    <div className="options-area">
      <button onClick={onShowScreenshot} style={buttonStyle}>
        <span role="img" aria-label="screenshot">🖼️</span> See Screenshot
      </button>
      <button onClick={onShowScrapedData} style={buttonStyle}>
        <span role="img" aria-label="scraped-data">📄</span> See Scraped Data
      </button>
      {hasHistory && (
        <button onClick={onShowHistory} style={buttonStyle}>
          <span role="img" aria-label="history">🕑</span> Version History
        </button>
      )}
    </div>
  );
}

export default OptionsBar;
