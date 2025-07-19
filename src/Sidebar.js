import React, { useState } from 'react';
import './Sidebar.css';

function Sidebar({ sessions, currentSessionId, onSelectSession, onDeleteSession }) {
  const [menuOpenId, setMenuOpenId] = useState(null);

  const handleMenuClick = (e, id) => {
    e.stopPropagation();
    setMenuOpenId(menuOpenId === id ? null : id);
  };

  const handleDelete = (e, id) => {
    e.stopPropagation();
    setMenuOpenId(null);
    onDeleteSession(id);
  };

  return (
    <div className="sidebar">
      <h2>Chats</h2>
      <ul>
        {sessions.map(session => (
          <li
            key={session.id}
            className={session.id === currentSessionId ? 'active' : ''}
            onClick={() => onSelectSession(session.id)}
            style={{ position: 'relative' }}
          >
            {session.title || `Chat ${session.id}`}
            <button
              className="dots-btn"
              onClick={e => handleMenuClick(e, session.id)}
              tabIndex={-1}
            >
              &#8942;
            </button>
            {menuOpenId === session.id && (
              <div className="chat-menu" onClick={e => e.stopPropagation()}>
                <button
                  className="delete-btn"
                  onClick={e => handleDelete(e, session.id)}
                  disabled={sessions.length === 1}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default Sidebar; 