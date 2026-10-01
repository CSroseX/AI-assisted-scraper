import React, { useState } from 'react';
import { FaBell } from 'react-icons/fa';

const MAX_SHOWN = 5;

function NotificationBell({ notifications }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative', marginLeft: 16 }}>
      <FaBell
        style={{ fontSize: 24, cursor: 'pointer', color: notifications.length ? '#10a37f' : '#888' }}
        onClick={() => setOpen((v) => !v)}
        title="Show notifications"
      />
      {open && (
        <div style={{ position: 'absolute', top: 32, right: 0, background: '#fff', color: '#222', border: '1px solid #eee', borderRadius: 8, minWidth: 260, boxShadow: '0 2px 12px rgba(0,0,0,0.12)', zIndex: 10000 }}>
          <div style={{ padding: 12, borderBottom: '1px solid #eee', fontWeight: 600 }}>Notifications</div>
          {notifications.length === 0 && <div style={{ padding: 16, color: '#888' }}>No notifications yet.</div>}
          {notifications.slice(-MAX_SHOWN).reverse().map((n, i, shown) => (
            <div key={i} style={{ padding: 12, borderBottom: i < shown.length - 1 ? '1px solid #eee' : 'none', fontSize: '1em' }}>{n}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
