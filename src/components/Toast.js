import React from 'react';

function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="feedback-notification" role="status" style={{ position: 'fixed', top: 24, right: 24, background: '#222', color: '#fff', padding: '16px 28px', borderRadius: 8, fontSize: '1.1em', zIndex: 9999, boxShadow: '0 2px 12px rgba(0,0,0,0.18)', transition: 'opacity 0.3s' }}>
      {message}
    </div>
  );
}

export default Toast;
