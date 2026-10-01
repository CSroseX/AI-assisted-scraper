import React from 'react';

const backdropStyle = {
  position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
  background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
};

const closeStyle = {
  position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none',
  fontSize: 24, cursor: 'pointer'
};

// Full-screen overlay with a white panel and a close button (exposed as a dialog).
function Modal({ onClose, label, panelStyle, children }) {
  return (
    <div style={backdropStyle}>
      <div role="dialog" aria-modal="true" aria-label={label} style={{ background: '#fff', padding: 20, borderRadius: 8, position: 'relative', maxWidth: '90vw', maxHeight: '90vh', ...panelStyle }}>
        <button onClick={onClose} style={closeStyle} aria-label="Close">×</button>
        {children}
      </div>
    </div>
  );
}

export default Modal;
