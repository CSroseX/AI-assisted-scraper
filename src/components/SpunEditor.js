import React from 'react';

// Replaces the AI Writer message while the user edits it.
function SpunEditor({ value, original, onChange, onSave, onCancel }) {
  const changed = value !== original;
  return (
    <div style={{ position: 'relative' }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', minHeight: 120, fontSize: '1em', borderRadius: 8, padding: 12 }}
      />
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button
          onClick={onSave}
          disabled={!changed}
          style={{
            background: changed ? '#10a37f' : '#ccc',
            color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '1em', cursor: changed ? 'pointer' : 'not-allowed',
            opacity: changed ? 1 : 0.7
          }}
        >Save</button>
        <button
          onClick={onCancel}
          style={{ background: '#eee', color: '#222', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '1em', cursor: 'pointer' }}
        >Cancel</button>
      </div>
    </div>
  );
}

export default SpunEditor;
