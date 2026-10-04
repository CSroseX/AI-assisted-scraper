import React from 'react';

// Shows one detected change: what kind it is, what it means, and the text from
// the page that proves it.
//
// Deliberately minimal and disposable. Phase 1 step 7 replaces these screens
// with a proper watchlist and diff viewer; this exists so the explainer's
// output can be seen in a browser rather than only via curl.

const CATEGORY_LABELS = {
  price: 'Price',
  fees: 'Fees',
  cancellation: 'Cancellation',
  data_use: 'Data use',
  cosmetic: 'Cosmetic',
  layout_change: 'Layout change'
};

const CATEGORY_COLORS = {
  price: '#b4232a',
  fees: '#b4232a',
  cancellation: '#a85400',
  data_use: '#6b3fa0',
  cosmetic: '#5c6670',
  layout_change: '#5c6670'
};

function ChangeExplanation({ category, summary, quotes = [], explainError }) {
  // An unexplained change is still a real change, so say so plainly rather than
  // rendering nothing. The quoted text below remains the evidence either way.
  const unexplained = !summary;

  return (
    <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 16, background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span
          style={{
            background: CATEGORY_COLORS[category] || '#5c6670',
            color: '#fff',
            borderRadius: 12,
            padding: '2px 10px',
            fontSize: '0.78em',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em'
          }}
        >
          {CATEGORY_LABELS[category] || 'Uncategorised'}
        </span>
      </div>

      {unexplained ? (
        <p style={{ margin: '0 0 10px', color: '#5c6670', fontStyle: 'italic' }}>
          This page changed, but no verified explanation is available
          {explainError ? ' (the explainer could not be reached)' : ''}. The changed
          text is shown below.
        </p>
      ) : (
        <p style={{ margin: '0 0 10px', fontSize: '1.05em', lineHeight: 1.45 }}>{summary}</p>
      )}

      {quotes.length > 0 && (
        <div>
          <div style={{ fontSize: '0.8em', color: '#5c6670', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            From the page
          </div>
          {quotes.map((quote, i) => (
            <blockquote
              key={i}
              style={{
                margin: '0 0 8px',
                padding: '8px 12px',
                borderLeft: '3px solid #10a37f',
                background: '#fff',
                color: '#222',
                fontSize: '0.95em'
              }}
            >
              {quote}
            </blockquote>
          ))}
        </div>
      )}
    </div>
  );
}

export default ChangeExplanation;
