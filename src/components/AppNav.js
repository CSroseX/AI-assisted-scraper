import React from 'react';

const VIEWS = [['watches', 'Watched pages'], ['chat', 'Chat demo']];

function AppNav({ view, onChange }) {
  return (
    <nav className="app-nav" aria-label="Main">
      <span className="app-nav-title">Watchdog</span>
      {VIEWS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-current={view === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export default AppNav;
